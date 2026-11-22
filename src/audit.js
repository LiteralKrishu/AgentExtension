const fs = require('node:fs/promises');
const path = require('node:path');
const { digest } = require('./permissions');
const { version } = require('../package.json');
const { z } = require('zod');
const { withStorageLock } = require('./storage-lock');

const MAX_BYTES = 2_000_000;
const GENESIS = '0'.repeat(64);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const workspaceId = z.string().regex(/^[a-f0-9]{16}$/);
const key = z.string().regex(/^[a-zA-Z0-9_.-]{1,64}(?:\/[a-zA-Z0-9_.-]{1,64})?$/);
const usage = z.strictObject({ tokens: z.number().nonnegative(), toolCalls: z.number().nonnegative(), seconds: z.number().nonnegative() });
const exportEvent = z.strictObject({
  seq: z.number().int().positive(), time: z.string().datetime(),
  workspace: workspaceId, tool: key, effect: key, target: hash, decision: key,
  reason: z.string().max(300), runId: key, usage: usage.optional(), prev: hash, hash, exportHash: hash,
});
const safeReasons = new Set([
  'One exact action', 'Consumed exact approval', 'Workspace run scope', 'No current matching permission',
  'Approval scope changed or was revoked', 'Saved for an interactive follow-up', 'Empty question', 'The user skipped the question',
  'Chose an option', 'Typed an answer', 'File is outside the named worker snapshot', 'Surface action declined or expired',
  'Standing schedule approval for a listed target', 'Capability configuration changed', 'Workspace changed',
  'Connector credential changed', 'Run ended', 'Accepted changes check ended', 'Working-tree review ended',
  'Editor action ended', 'Permission policy is invalid', 'Revoked by you', 'cancelled', 'revoked', 'Scheduled report ended',
]);

// Removes rule targets from reasons. The target is replaced by a digest so matching events can still be grouped.
function redactReason(reason) {
  const text = String(reason ?? '');
  const policy = /^((?:Allowed|Denied|Prompt required) by (?:administrator|user|workspace) rule [a-z.*-]+) ([\s\S]+)$/.exec(text);
  if (policy) {
    const suffix = '; nobody can approve during a scheduled run';
    const target = policy[2].endsWith(suffix) ? policy[2].slice(0, -suffix.length) : policy[2];
    const value = /^\[target [a-f0-9]{12}\]$/.test(target) ? target : `[target ${digest(target).slice(0, 12)}]`;
    return `${policy[1]} ${value}${policy[2].endsWith(suffix) ? suffix : ''}`;
  }
  return safeReasons.has(text) || /^Question limit of \d{1,2} reached$/.test(text) ? text : 'Details redacted';
}

function redactEvent(record) {
  const safeKey = value => key.safeParse(value).success ? value : 'redacted';
  const { seq, time, workspace, prev, hash } = record;
  const fields = { seq, time, workspace, prev, hash, tool: safeKey(record.tool), effect: safeKey(record.effect),
    target: /^[a-f0-9]{64}$/.test(record.target) ? record.target : digest(record.target ?? ''),
    decision: safeKey(record.decision), reason: redactReason(record.reason), runId: safeKey(record.runId) };
  if (record.usage) {
    const parsed = usage.safeParse({ tokens: record.usage.tokens, toolCalls: record.usage.toolCalls, seconds: record.usage.seconds });
    if (parsed.success) fields.usage = parsed.data;
  }
  return { ...fields, exportHash: digest(fields) };
}

function verifyExportEvents(events, workspace) {
  let previous;
  for (const raw of events) {
    const row = exportEvent.parse(raw);
    const { exportHash, ...fields } = row;
    if (row.workspace !== workspace || redactReason(row.reason) !== row.reason || digest(fields) !== exportHash) {
      throw new Error('Audit export failed redaction or hash verification.');
    }
    if (previous && (row.seq !== previous.seq + 1 || row.prev !== previous.hash)) throw new Error('Audit export chain is broken.');
    previous = row;
  }
}

// An append-only, hash-chained log of permission decisions and run summaries for one workspace.
// Events are already redacted by the broker: targets are hashed and arguments, payloads and credentials are absent.
class AuditLog {
  constructor(storage, workspace, { maxBytes = MAX_BYTES } = {}) {
    this.maxBytes = maxBytes;
    this.workspace = digest(workspace).slice(0, 16);
    this.directory = path.join(storage, 'audit', digest(workspace).slice(0, 24));
    this.file = path.join(this.directory, 'audit.jsonl');
    this.archive = path.join(this.directory, 'audit.1.jsonl');
    this.queue = Promise.resolve();
  }
  append(event) {
    const next = this.queue.then(() => this.write(event));
    this.queue = next.catch(() => {});
    return next;
  }
  async last() {
    for (const file of [this.file, this.archive]) {
      const rows = await this.lines(file);
      if (rows.length) return rows.at(-1);
    }
    return undefined;
  }
  async write(event) {
    return withStorageLock(this.directory, async check => {
      const previous = await this.last();
      if (previous) {
        const { hash, ...fields } = previous;
        if (!Number.isSafeInteger(previous.seq) || previous.seq < 1 || digest(fields) !== hash) throw new Error('The audit tail failed verification. Preserve the log before investigating it.');
      }
      const record = { seq: (previous?.seq ?? 0) + 1, time: event.time ?? new Date().toISOString(), workspace: this.workspace,
        ...Object.fromEntries(Object.entries(event).filter(([key]) => !['seq', 'workspace', 'prev', 'hash'].includes(key))), prev: previous?.hash ?? GENESIS };
      const line = `${JSON.stringify({ ...record, hash: digest(record) })}\n`;
      let size = 0;
      try { size = (await fs.stat(this.file)).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      // Keep one archive. The chain continues across the rotation.
      check();
      if (size && size + line.length > this.maxBytes) await fs.rename(this.file, this.archive);
      check();
      await fs.appendFile(this.file, line, { mode: 0o600 });
      return record;
    });
  }
  async lines(file) {
    let text = '';
    try { text = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return text.split('\n').filter(Boolean).map(line => {
      try { const row = JSON.parse(line); return row && typeof row === 'object' && !Array.isArray(row) ? row : { invalid: true }; }
      catch { return { invalid: true }; }
    });
  }
  async read() {
    await this.queue;
    return withStorageLock(this.directory, async () => [...await this.lines(this.archive), ...await this.lines(this.file)]);
  }
  static verify(records) {
    let previous;
    for (const [index, row] of records.entries()) {
      if (row.invalid) return { ok: false, at: index, reason: 'Unreadable record' };
      const { hash, ...record } = row;
      if (digest(record) !== hash) return { ok: false, at: index, reason: 'Record content does not match its hash' };
      if (previous && (record.prev !== previous.hash || record.seq !== previous.seq + 1)) return { ok: false, at: index, reason: 'Chain is broken' };
      previous = row;
    }
    return { ok: true, records: records.length, head: previous?.hash ?? GENESIS };
  }
  async export({ since } = {}) {
    const records = await this.read();
    const verification = AuditLog.verify(records);
    const events = records.filter(row => !since || Date.parse(row.time) >= since).map(row => row.invalid ? { invalid: true } : redactEvent(row));
    return { format: 'agentextension-audit/1', exportedAt: new Date().toISOString(), extensionVersion: version, workspace: this.workspace,
      range: since ? { since: new Date(since).toISOString() } : { since: 'all' }, verification,
      note: 'Targets and workspace paths are SHA-256 digests. Rule targets in reasons are replaced by digests. The hash and prev fields preserve the local chain. The exportHash covers the redacted event and its original hash.',
      events };
  }
}

module.exports = { AuditLog, redactReason, verifyExportEvents, workspaceId, GENESIS };

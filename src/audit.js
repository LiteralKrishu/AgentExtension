const fs = require('node:fs/promises');
const path = require('node:path');
const { digest } = require('./permissions');
const { version } = require('../package.json');

const MAX_BYTES = 2_000_000;
const GENESIS = '0'.repeat(64);

// Removes rule targets from reasons. The target is replaced by a digest so matching events can still be grouped.
function redactReason(reason) {
  return String(reason ?? '').replace(/^((?:Allowed|Denied|Prompt required) by \w+ rule \S+) (.+?)(;.*)?$/,
    (_, head, target, rest = '') => `${head} [target ${digest(target).slice(0, 12)}]${rest}`).slice(0, 300);
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
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const previous = await this.last();
    const record = { seq: (previous?.seq ?? 0) + 1, time: event.time ?? new Date().toISOString(), workspace: this.workspace,
      ...Object.fromEntries(Object.entries(event).filter(([key]) => !['seq', 'workspace', 'prev', 'hash'].includes(key))), prev: previous?.hash ?? GENESIS };
    const line = `${JSON.stringify({ ...record, hash: digest(record) })}\n`;
    let size = 0;
    try { size = (await fs.stat(this.file)).size; } catch { /* First record. */ }
    // Keep one archive. The chain continues across the rotation.
    if (size && size + line.length > this.maxBytes) await fs.rename(this.file, this.archive);
    await fs.appendFile(this.file, line, { mode: 0o600 });
    return record;
  }
  async lines(file) {
    let text = '';
    try { text = await fs.readFile(file, 'utf8'); } catch { return []; }
    return text.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return [{ invalid: true }]; } });
  }
  async read() { await this.queue; return [...await this.lines(this.archive), ...await this.lines(this.file)]; }
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
    const events = records.filter(row => !since || Date.parse(row.time) >= since).map(row => ({ ...row, ...(row.reason ? { reason: redactReason(row.reason) } : {}) }));
    return { format: 'agentextension-audit/1', exportedAt: new Date().toISOString(), extensionVersion: version, workspace: this.workspace,
      range: since ? { since: new Date(since).toISOString() } : { since: 'all' }, verification,
      note: 'Targets and workspace paths are SHA-256 digests. Arguments, file contents, command output, page text, payloads and credentials are not recorded. Rule targets in reasons are replaced by digests. Hashes in exported events cover the stored record, before reason redaction.',
      events };
  }
}

module.exports = { AuditLog, redactReason, GENESIS };

const { randomUUID } = require('node:crypto');
const { z } = require('zod');
const { digest } = require('./permissions');
const { safePath } = require('./workspace');
const { runWorkerSession } = require('./worker-session');

const workerInput = z.strictObject({ question: z.string().trim().min(1).max(1_000),
  files: z.array(z.string().min(1).max(500)).max(6).default([]) });
const reportSchema = z.strictObject({ summary: z.string().min(1).max(1_200), findings: z.array(z.strictObject({
  file: z.string().min(1).max(500), line: z.number().int().positive(),
  severity: z.enum(['info', 'warning', 'error']), message: z.string().min(1).max(600),
})).max(8) });
const roleEffects = { 'repository-research': 'worker.research', 'diff-review': 'worker.review' };

function draftTarget(run) {
  const reviewed = run.reviewed?.revision === run.draft.revision;
  const hunks = reviewed ? run.reviewed.hunks : run.draft.review();
  return { revision: run.draft.revision, scope: reviewed ? 'Accepted hunks' : 'All staged hunks',
    selection: digest(hunks), hunks };
}
function targetKey(run) {
  const { hunks, ...target } = draftTarget(run);
  return digest(target);
}

async function snapshotFor(run, role, input) {
  for (const file of input.files) safePath(file);
  let sources = [];
  let target;
  if (role === 'repository-research') {
    const candidates = input.files.length ? input.files.map(file => ({ file, line: 1 })) : await run.search(input.question, 16);
    const seen = new Set();
    for (const candidate of candidates) {
      if (seen.has(candidate.file) || sources.length >= 6) continue;
      safePath(candidate.file);
      seen.add(candidate.file);
      const text = await run.workspace.read(candidate.file);
      const lines = text.split('\n');
      const start = Math.max(1, candidate.line - 5);
      const excerpt = lines.slice(start - 1, start + 39).join('\n').slice(0, 1_800);
      sources.push({ file: candidate.file, start, end: start + excerpt.split('\n').length - 1, text: excerpt,
        truncated: start > 1 || excerpt.length < text.length });
    }
  } else {
    const { hunks, ...scope } = draftTarget(run);
    target = { ...scope, key: digest(scope) };
    const filtered = hunks.filter(hunk => !input.files.length || input.files.includes(hunk.file));
    if (!filtered.length) throw new Error('Stage a draft before asking for diff review.');
    for (const hunk of filtered.slice(0, 8)) {
      const before = hunk.before.slice(0, 650);
      const after = hunk.after.slice(0, 650);
      sources.push({ file: hunk.file, start: hunk.line, end: hunk.line + Math.max(before.split('\n').length, after.split('\n').length) - 1,
        before, after, truncated: before.length < hunk.before.length || after.length < hunk.after.length });
    }
    target.omittedHunks = filtered.length - sources.length;
  }
  if (!sources.length) throw new Error('No matching source. Name up to six files or use a more specific question.');
  const snapshot = { role, question: input.question, sources, ...(target ? { target } : {}) };
  if (JSON.stringify(snapshot).length > 16_000) throw new Error('Worker snapshot exceeds 16,000 characters. Narrow the file scope.');
  return { ...snapshot, digest: digest(snapshot) };
}

function parseReport(text, snapshot) {
  if (typeof text !== 'string' || text.length > 8_000) throw new Error('Worker output exceeded its limit.');
  let report;
  try { report = reportSchema.parse(JSON.parse(text)); } catch { throw new Error('Worker returned an invalid report. No changes were made.'); }
  for (const finding of report.findings) {
    if (!snapshot.sources.some(source => source.file === finding.file && finding.line >= source.start && finding.line <= source.end)) {
      throw new Error('Worker report cited a location outside its snapshot.');
    }
  }
  return report;
}

class WorkerPool {
  constructor({ run, settings, roles, onChange = () => {}, invoke = runWorkerSession, timeoutMs = 60_000 }) {
    this.run = run; this.settings = settings; this.roles = new Set(roles); this.onChange = onChange; this.invoke = invoke;
    this.timeoutMs = Math.min(60_000, timeoutMs); this.count = 0; this.generation = 0;
    this.active = new Map(); this.reports = []; this.pending = new Set(); this.closed = false;
    this.abort = () => this.cancelAll('Parent cancelled');
    run.signal.addEventListener('abort', this.abort, { once: true });
  }
  publish() { this.onChange(this.reports.map(report => ({ ...report }))); }
  execute(role, raw) {
    const input = workerInput.parse(raw);
    if (this.closed || !this.roles.has(role) || !roleEffects[role]) throw new Error('This worker role is not enabled by an approved plugin.');
    this.run.signal.throwIfAborted();
    if (this.active.size >= 2 || this.count >= 4) throw new Error('Worker limit reached: two concurrent workers and four calls per run.');
    const action = this.run.permissions.action(role, roleEffects[role], this.run.permissions.workspace, input);
    this.run.permissions.require(action);
    const controller = new AbortController();
    const signal = AbortSignal.any([this.run.signal, controller.signal]);
    const id = randomUUID();
    const generation = this.generation;
    this.count++;
    const row = { id, role, state: 'preparing', question: input.question };
    this.reports.push(row); this.active.set(id, controller); this.publish();
    const timer = setTimeout(() => controller.abort(new Error('Worker timed out after 60 seconds.')), this.timeoutMs);
    const task = (async () => {
      try {
        await this.run.validateCapabilities?.();
        signal.throwIfAborted();
        const snapshot = await snapshotFor(this.run, role, input);
        if (generation !== this.generation || !this.run.permissions.valid(action)) throw new Error('Worker permission changed.');
        signal.throwIfAborted();
        Object.assign(row, { state: 'running', snapshot: snapshot.digest, target: snapshot.target,
          sources: snapshot.sources.map(({ file, start, end, truncated }) => ({ file, start, end, truncated })) });
        this.run.manifest?.add('worker input', `${role} · ${id}`, JSON.stringify(snapshot), { reason: 'Isolated snapshot. No parent chat, notes, credentials or grants.', limit: 16_200 });
        this.publish();
        const text = await this.invoke(this.settings, snapshot, signal, session => { row.session = session; this.publish(); });
        signal.throwIfAborted();
        await this.run.validateCapabilities?.();
        if (generation !== this.generation || !this.run.permissions.valid(action)) throw new Error('Worker permission changed.');
        const report = parseReport(text, snapshot);
        const stale = role === 'diff-review' && snapshot.target.key !== targetKey(this.run);
        Object.assign(row, { state: stale ? 'stale' : 'completed', report });
        this.publish();
        return { id, role, snapshot: snapshot.digest, target: snapshot.target, stale, advisoryOnly: true, ...report };
      } catch (error) {
        row.state = signal.aborted ? 'cancelled' : 'failed';
        row.error = signal.aborted ? String(signal.reason?.message ?? 'Worker cancelled') : error.message;
        this.publish();
        throw new Error(row.error);
      } finally {
        clearTimeout(timer); this.active.delete(id);
      }
    })();
    this.pending.add(task);
    task.finally(() => this.pending.delete(task)).catch(() => {});
    return task;
  }
  invalidateDraft() {
    const key = targetKey(this.run);
    for (const report of this.reports) if (report.target?.key !== key && report.role === 'diff-review' && report.state === 'completed') report.state = 'stale';
    this.publish();
  }
  cancelAll(reason = 'Parent attempt ended') {
    this.generation++;
    for (const controller of this.active.values()) controller.abort(new Error(reason));
    for (const report of this.reports) if (report.state === 'completed') report.state = 'stale';
    this.publish();
  }
  async close() {
    this.closed = true;
    for (const controller of this.active.values()) controller.abort(new Error('Parent run ended'));
    await Promise.allSettled([...this.pending]);
    this.run.signal.removeEventListener('abort', this.abort);
  }
}

module.exports = { WorkerPool, workerInput, snapshotFor, parseReport, draftTarget };

const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { z } = require('zod');
const { digest } = require('./permissions');
const { safePath } = require('./workspace');
const { runWorkerSession } = require('./worker-session');
const { Draft } = require('./draft');

const workerInput = z.strictObject({ question: z.string().trim().min(1).max(1_000),
  files: z.array(z.string().min(1).max(500)).max(6).default([]) });
const reportSchema = z.strictObject({ summary: z.string().min(1).max(1_200), findings: z.array(z.strictObject({
  file: z.string().min(1).max(500), line: z.number().int().positive(),
  severity: z.enum(['info', 'warning', 'error']), message: z.string().min(1).max(600),
})).max(8) });
const editSchema = z.strictObject({ summary: z.string().min(1).max(1_200), edits: z.array(z.strictObject({
  file: z.string().min(1).max(500), old_text: z.string().min(1).max(4_000), new_text: z.string().max(4_000),
})).min(1).max(8) });
// Built-in roles. Custom roles from approved plugins use worker.custom and a declared snapshot kind.
const ROLES = {
  'repository-research': { effect: 'worker.research', snapshot: 'repository', output: 'report' },
  'diff-review': { effect: 'worker.review', snapshot: 'diff', output: 'report' },
  'test-diagnosis': { effect: 'worker.diagnose', snapshot: 'check', output: 'report' },
  'edit-proposal': { effect: 'worker.edit', snapshot: 'edit', output: 'edits' },
};
// Model mistakes that a second attempt often fixes. Permission, limit and cancellation errors are never retried.
const RETRYABLE = /Worker attempted a tool call|invalid report|invalid edit proposal|edit outside its snapshot|match its snapshot exactly once|Worker did not complete a tool-free turn/;
const roleEffects = Object.fromEntries(Object.entries(ROLES).map(([role, value]) => [role, value.effect]));

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

async function excerpt(run, file, line, current) {
  safePath(file);
  const base = await run.workspace.read(file);
  const text = current ? run.draft.current(file, base) : base;
  const lines = text.split('\n');
  const start = Math.max(1, line - 5);
  const body = lines.slice(start - 1, start + 39).join('\n').slice(0, 1_800);
  return { file, start, end: start + body.split('\n').length - 1, text: body, truncated: start > 1 || body.length < text.length };
}

async function snapshotFor(run, role, input, kind = ROLES[role]?.snapshot ?? 'repository') {
  for (const file of input.files) safePath(file);
  let sources = [];
  let target;
  let check;
  if (kind === 'check') {
    const latest = [...(run.checks ?? [])].reverse().find(item => item.exitCode !== 0);
    if (!latest) throw new Error('No failed check in this run. Run a check first.');
    check = { command: latest.command, args: latest.args, exitCode: latest.exitCode, status: latest.status,
      revision: latest.revision, scope: latest.scope, output: String(latest.output ?? '').slice(-4_000) };
    // Files named in the output, such as test/a.test.js:12, plus any the parent named.
    const cited = [...check.output.matchAll(/([A-Za-z0-9_./-]+\.[A-Za-z0-9]+):(\d+)/g)].map(match => ({ file: match[1].replace(/^\.\//, ''), line: Number(match[2]) }));
    const seen = new Set();
    for (const candidate of [...input.files.map(file => ({ file, line: 1 })), ...cited]) {
      if (seen.has(candidate.file) || sources.length >= 6) continue;
      seen.add(candidate.file);
      try { sources.push(await excerpt(run, candidate.file, candidate.line, true)); } catch { /* Paths outside the workspace are skipped. */ }
    }
    // A failing test often points only at itself. Add the local modules it imports, one level deep.
    for (const source of [...sources]) {
      for (const file of localImports(source.file, source.text)) {
        if (seen.has(file) || sources.length >= 6) continue;
        seen.add(file);
        try { sources.push(await excerpt(run, file, 1, true)); } catch { /* Unresolved or outside the workspace. */ }
      }
    }
  } else if (kind === 'edit') {
    if (!input.files.length) throw new Error('Name the files the worker may edit.');
    target = { revision: run.draft.revision, files: {} };
    for (const file of input.files) {
      const base = await run.workspace.read(file);
      const current = run.draft.current(file, base);
      target.files[file] = digest(current);
      const lines = current.split('\n');
      if (current.length > 6_000) throw new Error(`${file} is too large for an edit worker. Name a smaller file.`);
      sources.push({ file, start: 1, end: lines.length, text: current, truncated: false });
    }
    target.key = digest(target);
  } else if (kind === 'repository') {
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
  } else if (kind === 'diff') {
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
  } else throw new Error('Unknown worker snapshot.');
  if (!sources.length && !check) throw new Error('No matching source. Name up to six files or use a more specific question.');
  const snapshot = { role, question: input.question, sources, ...(check ? { check } : {}), ...(target ? { target } : {}) };
  if (JSON.stringify(snapshot).length > 16_000) throw new Error('Worker snapshot exceeds 16,000 characters. Narrow the file scope.');
  return { ...snapshot, digest: digest(snapshot) };
}

// Relative require and import targets in a source file, as workspace paths. Bare package names are ignored.
function localImports(file, text) {
  const found = [];
  for (const match of text.matchAll(/(?:require\(\s*|import\s*\(\s*|\bfrom\s+|^\s*import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm)) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
    if (target.startsWith('..')) continue;
    found.push(...(/\.[cm]?[jt]sx?$|\.json$/.test(target) ? [target]
      : ['.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '/index.js', '/index.ts'].map(suffix => target + suffix)));
  }
  return found;
}

// Each edit must replace text that appears exactly once in a supplied file.
function parseEdits(text, snapshot) {
  if (typeof text !== 'string' || text.length > 16_000) throw new Error('Worker output exceeded its limit.');
  let result;
  try { result = editSchema.parse(JSON.parse(text)); } catch { throw new Error('Worker returned an invalid edit proposal. No changes were made.'); }
  for (const edit of result.edits) {
    const source = snapshot.sources.find(item => item.file === edit.file);
    if (!source) throw new Error('Worker proposed an edit outside its snapshot.');
    const first = source.text.indexOf(edit.old_text);
    if (first < 0 || source.text.indexOf(edit.old_text, first + 1) >= 0) throw new Error('Worker edit text must match its snapshot exactly once.');
  }
  return result;
}

// Changed ranges of the parent draft in current-text coordinates.
function stagedRanges(entry) {
  let delta = 0;
  return (entry?.hunks ?? []).map(hunk => {
    const start = hunk.offset + delta;
    delta += hunk.after.length - hunk.before.length;
    return { start, end: start + hunk.after.length };
  });
}
const overlaps = (a, b) => (a.start === a.end || b.start === b.end) ? a.start <= b.end && b.start <= a.end : a.start < b.end && b.start < a.end;

function parseReport(text, snapshot) {
  if (typeof text !== 'string' || text.length > 8_000) throw new Error('Worker output exceeded its limit.');
  let report;
  try { report = reportSchema.parse(JSON.parse(text)); } catch { throw new Error('Worker returned an invalid report. No changes were made.'); }
  // Findings must cite supplied lines. Others are dropped and counted, so the parent never sees an unsupported citation.
  const findings = report.findings.filter(finding => snapshot.sources.some(source => source.file === finding.file
    && finding.line >= source.start && finding.line <= source.end));
  const dropped = report.findings.length - findings.length;
  if (dropped && !findings.length && report.findings.length) {
    return { summary: report.summary, findings, dropped_findings: dropped, note: 'Every finding cited a location outside the snapshot and was dropped. Treat the summary as unverified.' };
  }
  return dropped ? { ...report, findings, dropped_findings: dropped } : report;
}

class WorkerPool {
  constructor({ run, settings, roles, customRoles = [], onChange = () => {}, invoke = runWorkerSession, timeoutMs = 60_000 }) {
    // Local models can need more time. The setting allows 30 to 300 seconds.
    this.run = run; this.settings = settings; this.roles = new Set(roles); this.onChange = onChange; this.invoke = invoke;
    this.custom = new Map(customRoles.map(role => [role.id, role]));
    this.proposals = new Map();
    this.timeoutMs = Math.min(300_000, Math.max(1, timeoutMs)); this.count = 0; this.generation = 0;
    this.active = new Map(); this.reports = []; this.pending = new Set(); this.closed = false;
    this.abort = () => this.cancelAll('Parent cancelled');
    run.signal.addEventListener('abort', this.abort, { once: true });
  }
  publish() { this.onChange(this.reports.map(report => ({ ...report }))); }
  execute(role, raw) {
    const input = workerInput.parse(raw);
    const custom = this.custom.get(role);
    const definition = custom ? { effect: 'worker.custom', snapshot: custom.snapshot, output: 'report', instructions: custom.instructions } : ROLES[role];
    if (this.closed || !definition || (!custom && !this.roles.has(role))) throw new Error('This worker role is not enabled by an approved plugin.');
    this.run.signal.throwIfAborted();
    if (definition.snapshot === 'edit' && !input.files.length) throw new Error('Name the files the worker may edit.');
    if (this.active.size >= 2 || this.count >= 4) throw new Error('Worker limit reached: two concurrent workers and four calls per run.');
    const action = this.run.permissions.action(role, definition.effect, this.run.permissions.workspace, input);
    this.run.permissions.require(action);
    const controller = new AbortController();
    const signal = AbortSignal.any([this.run.signal, controller.signal]);
    const id = randomUUID();
    const generation = this.generation;
    this.count++;
    const row = { id, role, state: 'preparing', question: input.question };
    this.reports.push(row); this.active.set(id, controller); this.publish();
    const timer = setTimeout(() => controller.abort(new Error(`Worker timed out after ${Math.round(this.timeoutMs / 1000)} seconds.`)), this.timeoutMs);
    const task = (async () => {
      try {
        await this.run.validateCapabilities?.();
        signal.throwIfAborted();
        const snapshot = await snapshotFor(this.run, role, input, definition.snapshot);
        if (generation !== this.generation || !this.run.permissions.valid(action)) throw new Error('Worker permission changed.');
        signal.throwIfAborted();
        Object.assign(row, { state: 'running', snapshot: snapshot.digest, target: snapshot.target,
          sources: snapshot.sources.map(({ file, start, end, truncated }) => ({ file, start, end, truncated })) });
        this.run.manifest?.add('worker input', `${role} · ${id}`, JSON.stringify(snapshot), { reason: 'Isolated snapshot. No parent chat, notes, credentials or grants.', limit: 16_200 });
        this.publish();
        const attempt = async retry => {
          // A retry sends the same snapshot with a fixed note naming the rejected reply. It counts as the same worker call.
          const task = retry ? { ...snapshot, previous_reply_rejected: `${retry} Reply with only the JSON object your instructions describe. Do not call any tool.` } : snapshot;
          const text = await this.invoke(this.settings, task, signal, session => { row.session = session; this.publish(); },
            { output: definition.output, instructions: definition.instructions, role: custom ? custom.name : role,
              onUsage: usage => this.run.usage?.model(usage, `worker:${role}`) });
          this.run.onUsage?.();
          signal.throwIfAborted();
          return definition.output === 'edits' ? parseEdits(text, snapshot) : parseReport(text, snapshot);
        };
        let parsed;
        try { parsed = await attempt(); } catch (error) {
          if (signal.aborted || !RETRYABLE.test(error.message)) throw error;
          row.retried = error.message; this.publish();
          parsed = await attempt(error.message);
        }
        await this.run.validateCapabilities?.();
        if (generation !== this.generation || !this.run.permissions.valid(action)) throw new Error('Worker permission changed.');
        if (definition.output === 'edits') return this.propose(id, row, role, snapshot, parsed);
        const report = parsed;
        const stale = definition.snapshot === 'diff' && snapshot.target.key !== targetKey(this.run);
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
  // Builds the worker's edits in a separate draft. Nothing reaches the parent draft until the parent merges it.
  async propose(id, row, role, snapshot, result) {
    const texts = new Map(snapshot.sources.map(source => [source.file, source.text]));
    const draft = new Draft(async file => texts.get(file));
    for (const edit of result.edits) await draft.replace(edit.file, edit.old_text, edit.new_text);
    const hunks = draft.review().map(({ file, line, before, after }) => ({ file, line, before, after }));
    this.proposals.set(id, { snapshot, edits: result.edits, merged: false });
    Object.assign(row, { state: 'proposed', report: { summary: result.summary, findings: [] }, hunks: hunks.length });
    this.publish();
    return { id, role, snapshot: snapshot.digest, base_revision: snapshot.target.revision, summary: result.summary, proposed_hunks: hunks,
      advisoryOnly: true, next: 'Check these hunks. To stage them for the user\'s hunk review, call merge_worker_edits with this id.' };
  }

  // Merges a proposal into the parent draft if the parent draft has not moved and no staged change overlaps.
  async merge(id) {
    const proposal = this.proposals.get(id);
    if (!proposal || this.closed) throw new Error('No worker proposal with this id.');
    if (proposal.merged) throw new Error('This proposal was already merged.');
    const row = this.reports.find(item => item.id === id);
    const { target } = proposal.snapshot;
    const reject = message => { if (row) { row.state = 'rejected'; row.error = message; this.publish(); } throw new Error(message); };
    if (this.run.draft.revision !== target.revision) reject('Stale proposal: the draft changed after the worker started. Ask the worker again.');
    const current = new Map();
    for (const file of Object.keys(target.files)) {
      const text = this.run.draft.current(file, await this.run.workspace.read(file));
      if (digest(text) !== target.files[file]) reject(`Stale proposal: ${file} changed after the worker started.`);
      current.set(file, text);
    }
    for (const edit of proposal.edits) {
      const start = current.get(edit.file).indexOf(edit.old_text);
      const range = { start, end: start + edit.old_text.length };
      if (stagedRanges(this.run.draft.files.get(edit.file)).some(staged => overlaps(staged, range))) {
        reject(`Overlapping proposal: an edit in ${edit.file} touches text the parent already changed.`);
      }
    }
    // Apply in a copy first so a failure leaves the parent draft unchanged.
    const trial = new Draft(async file => this.run.workspace.read(file));
    for (const [file, entry] of this.run.draft.files) trial.files.set(file, structuredClone(entry));
    for (const edit of proposal.edits) await trial.replace(edit.file, edit.old_text, edit.new_text);
    for (const edit of proposal.edits) await this.run.draft.replace(edit.file, edit.old_text, edit.new_text);
    proposal.merged = true;
    if (row) { row.state = 'merged'; this.publish(); }
    return { merged: proposal.edits.length, revision: this.run.draft.revision, review: 'The merged hunks need the user\'s hunk review like any other change.' };
  }

  invalidateDraft() {
    const key = targetKey(this.run);
    for (const report of this.reports) if (report.target?.key !== key && report.role === 'diff-review' && report.state === 'completed') report.state = 'stale';
    for (const [id, proposal] of this.proposals) {
      const row = this.reports.find(item => item.id === id);
      if (!proposal.merged && proposal.snapshot.target.revision !== this.run.draft.revision && row?.state === 'proposed') row.state = 'stale';
    }
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

module.exports = { WorkerPool, workerInput, snapshotFor, parseReport, parseEdits, localImports, draftTarget, ROLES, stagedRanges, overlaps };

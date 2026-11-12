const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { digest } = require('./permissions');
const { splitHunks, applyHunks } = require('./draft');

const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const VERSION = 1;

// One checkpoint per workspace: the request, plan, draft and progress of an unfinished run.
// It holds no grants. A resumed run starts with a new permission broker and asks again for every protected action.
class CheckpointStore {
  constructor(storage, workspace, now = Date.now) {
    this.workspace = workspace;
    this.now = now;
    this.directory = path.join(storage, 'checkpoints', digest(workspace).slice(0, 24));
    this.file = path.join(this.directory, 'checkpoint.json');
    this.queue = Promise.resolve();
  }
  save(state) {
    const next = this.queue.then(async () => {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const value = { version: VERSION, workspace: this.workspace, savedAt: new Date(this.now()).toISOString(), ...state };
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
      await fs.rename(temporary, this.file);
      return value;
    });
    this.queue = next.catch(() => {});
    return next;
  }
  async load() {
    await this.queue;
    let value;
    try { value = JSON.parse(await fs.readFile(this.file, 'utf8')); } catch { return undefined; }
    if (value?.version !== VERSION || value.workspace !== this.workspace || typeof value.request !== 'string'
      || !Array.isArray(value.files) || this.now() - Date.parse(value.savedAt) > MAX_AGE) {
      await this.clear();
      return undefined;
    }
    return value;
  }
  clear() {
    const next = this.queue.then(() => fs.rm(this.file, { force: true }));
    this.queue = next.catch(() => {});
    return next;
  }
}

// Captures what a resumed run needs. File bases are kept so the workspace can be checked before resuming.
function snapshotRun(run, { request, planFirst, phase, text = '' }) {
  return {
    runId: run.permissions.runId, request, planFirst: Boolean(planFirst), phase,
    approvedPlan: run.approvedPlan ?? null, revision: run.draft.revision, session: run.session ?? null,
    files: [...run.draft.files].map(([file, entry]) => ({ file, base: entry.base, baseDigest: entry.base === null ? null : digest(entry.base), text: entry.text })),
    checks: (run.checks ?? []).map(({ command, args, exitCode, revision, scope }) => ({ command, args, exitCode, revision, scope })),
    reviewed: run.reviewed ? { revision: run.reviewed.revision, hunks: run.reviewed.hunks.length } : null,
    summary: String(text).slice(-2_000),
    diagnostic: run.diagnostic,
    recovery: run.recovery,
  };
}

// Compares checkpoint bases with the workspace now. Any change makes that file a conflict.
async function checkWorkspace(checkpoint, workspace) {
  const conflicts = [];
  for (const entry of checkpoint.files) {
    let current;
    try { current = await workspace.read(entry.file, entry.base === null); } catch { current = undefined; }
    const expected = entry.base === null ? null : entry.base;
    if (current !== expected || (entry.baseDigest && digest(current) !== entry.baseDigest)) conflicts.push(entry.file);
  }
  return conflicts;
}

function overlaps(first, second) {
  if (first.offset === second.offset) return true;
  return first.offset < second.offset
    ? first.offset + first.before.length > second.offset
    : second.offset + second.before.length > first.offset;
}

// Replay disjoint edits against their shared base. For overlaps, keep both alternatives for review.
async function rebaseCheckpoint(checkpoint, workspace) {
  const files = [];
  const conflicts = [];
  for (const entry of checkpoint.files) {
    const { file, base, text } = entry;
    if (entry.baseDigest && digest(base) !== entry.baseDigest) throw new Error(`Checkpoint base for ${file} is invalid.`);
    let current;
    try { current = await workspace.read(file); } catch {
      try { current = await workspace.read(file, true); } catch { /* A private, binary or inaccessible file cannot be restored. */ }
    }
    const rebased = next => ({ file, base: current, baseDigest: current === null ? null : digest(current), text: next });
    if (current === undefined) { conflicts.push({ file }); continue; }
    if (current === text) continue;
    if (current === base) { files.push(entry); continue; }
    if (base === null || current === null) {
      conflicts.push({ file, current, saved: rebased(text) });
      continue;
    }
    const local = splitHunks(base, current);
    const saved = splitHunks(base, text).filter(hunk => !local.some(change => digest(change) === digest(hunk)));
    const independent = saved.filter(hunk => !local.some(change => overlaps(hunk, change)));
    const combine = hunks => applyHunks(base, hunks.sort((a, b) => a.offset - b.offset));
    const keep = combine([...local, ...independent]);
    if (independent.length === saved.length) {
      if (keep !== current) files.push(rebased(keep));
      continue;
    }
    const useSaved = combine([...local.filter(change => !saved.some(hunk => overlaps(change, hunk))), ...saved]);
    conflicts.push({ file, current, keep: keep === current ? undefined : rebased(keep), saved: rebased(useSaved) });
  }
  return { files, conflicts };
}

// Restages each checkpoint file in a fresh draft. Hunks are recomputed from the current base.
function restoreDraft(draft, checkpoint) {
  for (const entry of checkpoint.files) draft.stage(entry.file, entry.base, entry.text);
  return draft.review().length;
}

function resumeBrief(checkpoint) {
  return {
    request: checkpoint.request,
    previously_approved_plan: checkpoint.approvedPlan,
    staged_files: checkpoint.files.map(entry => ({ file: entry.file, new_file: entry.base === null })),
    checks_already_run: checkpoint.checks,
    previous_review: checkpoint.reviewed,
    last_progress_note: checkpoint.summary,
    conflict_decisions: checkpoint.recovery,
    interrupted_at: checkpoint.savedAt,
  };
}

module.exports = { CheckpointStore, snapshotRun, checkWorkspace, rebaseCheckpoint, restoreDraft, resumeBrief, MAX_AGE };

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { digest } = require('./permissions');
const { splitHunks, applyHunks, MAX_TEXT, MAX_SELECTION_TEXT } = require('./draft');

const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const VERSION = 2;
const LEGACY_VERSION = 1;

function validInlineCheckpoint({ selection, files }) {
  if (selection === undefined) return true;
  if (!selection || typeof selection.file !== 'string' || typeof selection.base !== 'string') return false;
  const { file, base, start, end } = selection;
  return base.length <= MAX_TEXT && Number.isInteger(start) && Number.isInteger(end)
    && start >= 0 && start <= end && end <= base.length && end - start <= MAX_SELECTION_TEXT
    && files.length <= 1 && files.every(entry => entry?.file === file && entry.base === base && typeof entry.text === 'string');
}

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
  save(state, { exclusive = false } = {}) {
    const next = this.queue.then(async () => {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const value = { version: VERSION, workspace: this.workspace, savedAt: new Date(this.now()).toISOString(), ...state };
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
        if (exclusive) {
          await fs.link(temporary, this.file).catch(error => {
            if (error.code === 'EEXIST') throw new Error('A local checkpoint already exists. Finish or discard it before importing a continuation.');
            throw error;
          });
        } else await fs.rename(temporary, this.file);
      } finally { await fs.rm(temporary, { force: true }); }
      return value;
    });
    this.queue = next.catch(() => {});
    return next;
  }
  async load() {
    await this.queue;
    let value;
    try { value = JSON.parse(await fs.readFile(this.file, 'utf8')); } catch { return undefined; }
    const supported = value?.version === VERSION || (value?.version === LEGACY_VERSION && value.selection === undefined);
    if (!supported || value.workspace !== this.workspace || typeof value.request !== 'string' || !Array.isArray(value.files)
      || !validInlineCheckpoint(value) || this.now() - Date.parse(value.savedAt) > MAX_AGE) {
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

  async claimSessionTurn(sessionId, turnId) {
    const claim = path.join(this.directory, `turn-${digest([sessionId, turnId])}.claim`);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    try { await fs.writeFile(claim, '', { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code === 'EEXIST') return undefined;
      throw error;
    }
    return () => fs.rm(claim, { force: true });
  }
}

// Captures what a resumed run needs. File bases are kept so the workspace can be checked before resuming.
function snapshotRun(run, { request, planFirst, phase, text = '' }) {
  return {
    runId: run.permissions.runId, request, planFirst: Boolean(planFirst), phase,
    approvedPlan: run.approvedPlan ?? null, revision: run.draft.revision, session: run.session ?? null,
    forgeSession: run.forgeSession,
    projectContinuation: run.projectContinuation,
    selection: run.draft.selection,
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
  const entries = checkpoint.selection && !checkpoint.files.length ? [checkpoint.selection] : checkpoint.files;
  for (const entry of entries) {
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

function mergeText(base, text, current, granularity) {
  const local = splitHunks(base, current, granularity);
  const localChanges = new Set(local.map(change => digest(change)));
  const saved = splitHunks(base, text, granularity).filter(hunk => !localChanges.has(digest(hunk)));
  const independent = saved.filter(hunk => !local.some(change => overlaps(hunk, change)));
  const combine = hunks => applyHunks(base, hunks.sort((a, b) => a.offset - b.offset));
  const keep = combine([...local, ...independent]);
  if (independent.length === saved.length) return { keep };
  return { keep, saved: combine([...local.filter(change => !saved.some(hunk => overlaps(change, hunk))), ...saved]) };
}

function mapSelection({ start, end }, changes) {
  let mappedStart = start;
  let mappedEnd = end;
  for (const { offset, before, after } of changes) {
    const changeEnd = offset + before.length;
    const delta = after.length - before.length;
    // Insertions at either edge stay outside the original selection.
    if (changeEnd <= start) { mappedStart += delta; mappedEnd += delta; }
    else if (offset >= end) continue;
    else if (offset >= start && changeEnd <= end) mappedEnd += delta;
    else return undefined;
  }
  return { start: mappedStart, end: mappedEnd };
}

function anchoredBoundary(base, current, original, mapped, side) {
  const before = side === 'before';
  const available = before ? Math.min(original, mapped) : Math.min(base.length - original, current.length - mapped);
  if (!available) return before ? original === 0 && mapped === 0 : original === base.length && mapped === current.length;
  for (let length = Math.min(available, 64); length > 0; length--) {
    const from = before ? original - length : original;
    const to = before ? mapped - length : mapped;
    const anchor = base.slice(from, from + length);
    if (current.startsWith(anchor, to) && base.indexOf(anchor) === from && base.lastIndexOf(anchor) === from
        && current.indexOf(anchor) === to && current.lastIndexOf(anchor) === to) return true;
  }
  return false;
}

async function rebaseInlineCheckpoint(checkpoint, workspace) {
  if (!validInlineCheckpoint(checkpoint)) throw new Error('The saved inline selection is invalid.');
  const original = checkpoint.selection;
  const [entry] = checkpoint.files;
  const { file, base } = original;
  if (entry?.baseDigest && digest(base) !== entry.baseDigest) throw new Error(`Checkpoint base for ${file} is invalid.`);
  const current = await workspace.read(file).catch(() => undefined);
  if (typeof current !== 'string') throw new Error('The saved inline file is unavailable. Reopen or restore it before resuming.');
  if (current === base) return { files: checkpoint.files, conflicts: [], selection: original };

  const mapped = mapSelection(original, splitHunks(base, current, 'character'));
  // Repeated text can admit different alignments. Verify with a reverse diff or unique adjacent text.
  const reverse = text => [...text].reverse().join('');
  const reverseMapped = mapSelection(original, splitHunks(reverse(base), reverse(current), 'character')
    .map(hunk => ({ ...hunk, offset: base.length - hunk.offset - hunk.before.length })));
  const agrees = mapped && reverseMapped && mapped.start === reverseMapped.start && mapped.end === reverseMapped.end;
  if (!mapped || (!agrees && !(anchoredBoundary(base, current, original.start, mapped.start, 'before')
      && anchoredBoundary(base, current, original.end, mapped.end, 'after')))) {
    throw new Error('The original selection boundaries changed or are ambiguous. Select the current code to start a new inline edit.');
  }
  if (mapped.end - mapped.start > MAX_SELECTION_TEXT) throw new Error('The recovered inline selection exceeds 12,000 characters.');
  const selection = { file, base: current, ...mapped };
  const selected = current.slice(mapped.start, mapped.end);
  if (!entry || entry.text === selected) return { files: [], conflicts: [], selection };

  const rebased = text => ({ file, base: current, baseDigest: digest(current), text });
  const { keep, saved } = mergeText(base.slice(original.start, original.end), entry.text, selected, 'character');
  if (saved === undefined) return { files: keep === selected ? [] : [rebased(keep)], conflicts: [], selection };
  const preview = current.slice(0, mapped.start) + saved + current.slice(mapped.end);
  return { files: [], conflicts: [{ file, current, preview, keep: keep === selected ? undefined : rebased(keep), saved: rebased(saved) }], selection };
}

// Replay disjoint edits against their shared base. For overlaps, keep both alternatives for review.
async function rebaseCheckpoint(checkpoint, workspace) {
  if (checkpoint.selection) return rebaseInlineCheckpoint(checkpoint, workspace);
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
    const { keep, saved } = mergeText(base, text, current);
    if (saved === undefined) {
      if (keep !== current) files.push(rebased(keep));
      continue;
    }
    conflicts.push({ file, current, keep: keep === current ? undefined : rebased(keep), saved: rebased(saved) });
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

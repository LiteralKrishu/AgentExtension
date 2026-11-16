const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CheckpointStore, snapshotRun, checkWorkspace, rebaseCheckpoint, restoreDraft, resumeBrief, MAX_AGE } = require('../src/checkpoint');
const { Draft } = require('../src/draft');
const { PermissionBroker } = require('../src/permissions');
const { Workspace } = require('../src/workspace');
const { composePrompt, ContextManifest } = require('../src/prompt');

test('a checkpoint saves the plan, draft and progress without grants, and restores the draft after the workspace is checked', async t => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-ckpt-'));
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-ckpt-ws-')));
  t.after(() => Promise.all([fs.rm(storage, { recursive: true, force: true }), fs.rm(root, { recursive: true, force: true })]));
  await fs.writeFile(path.join(root, 'a.txt'), 'one\ntwo\n');
  const workspace = new Workspace(root, () => undefined, async () => ['a.txt']);
  workspace.identity = root;
  const permissions = new PermissionBroker({ workspace: root });
  permissions.allowScope('draft.edit');
  const run = { permissions, draft: new Draft((file, create) => workspace.read(file, create)), approvedPlan: { goal: 'g', steps: ['s'] },
    checks: [{ command: 'node', args: ['-v'], exitCode: 0, revision: 1, scope: 'All staged hunks', output: 'secret output' }] };
  await run.draft.replace('a.txt', 'two', 'TWO');
  await run.draft.create('b.txt', 'new\n');
  let now = Date.UTC(2026, 10, 11);
  const store = new CheckpointStore(storage, root, () => now);
  await store.save(snapshotRun(run, { request: 'Change two', planFirst: true, phase: 'question', text: 'Working on it' }));
  assert.equal((await fs.stat(store.file)).mode & 0o777, 0o600);
  const previousFormat = JSON.parse(await fs.readFile(store.file, 'utf8'));
  await fs.writeFile(store.file, JSON.stringify({ ...previousFormat, version: 1 }));
  const saved = await store.load();
  assert.deepEqual([saved.request, saved.phase, saved.revision, saved.approvedPlan.goal, saved.files.map(entry => entry.file)],
    ['Change two', 'question', 2, 'g', ['a.txt', 'b.txt']]);
  assert.doesNotMatch(JSON.stringify(saved), /grants|secret output|scope:draft/, 'No grants or command output');
  assert.deepEqual(await checkWorkspace(saved, workspace), []);
  const restored = new Draft((file, create) => workspace.read(file, create));
  assert.equal(restoreDraft(restored, saved), 2);
  assert.equal(restored.current('a.txt', 'one\ntwo\n'), 'one\nTWO\n');
  assert.deepEqual(resumeBrief(saved).staged_files, [{ file: 'a.txt', new_file: false }, { file: 'b.txt', new_file: true }]);
  const manifest = new ContextManifest(root);
  const prompt = composePrompt({ request: saved.request, assembled: { selected: [], budget: 1, text: '' }, manifest, resume: resumeBrief(saved) });
  assert.match(prompt, /RESUMED RUN \(host data\)\. .*Approvals from the earlier run do not carry over.*Submit the previously approved plan/);
  // Changed or newly created files are conflicts.
  await fs.writeFile(path.join(root, 'a.txt'), 'one\nchanged\n');
  await fs.writeFile(path.join(root, 'b.txt'), 'created meanwhile\n');
  assert.deepEqual(await checkWorkspace(saved, workspace), ['a.txt', 'b.txt']);
  // Other workspaces, old checkpoints and clearing.
  assert.equal(await new CheckpointStore(storage, '/other', () => now).load(), undefined);
  now += MAX_AGE + 1;
  assert.equal(await store.load(), undefined, 'Checkpoints expire after seven days');
  now -= MAX_AGE + 1;
  await store.save(snapshotRun(run, { request: 'x', phase: 'running' }));
  await store.clear();
  assert.equal(await store.load(), undefined);
});

test('only one editor host can claim the same session turn for recovery', async t => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-recovery-claim-'));
  t.after(() => fs.rm(storage, { recursive: true, force: true }));
  const first = new CheckpointStore(storage, '/workspace');
  const second = new CheckpointStore(storage, '/workspace');
  const claims = await Promise.all([first.claimSessionTurn('session', 'turn'), second.claimSessionTurn('session', 'turn')]);
  assert.equal(claims.filter(Boolean).length, 1);
  await claims.find(Boolean)();
  const release = await second.claimSessionTurn('session', 'turn');
  assert.equal(typeof release, 'function');
  await release();
});

test('inline recovery follows the saved selection and preserves independent edits on the same line', async t => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-inline-ckpt-'));
  t.after(() => fs.rm(storage, { recursive: true, force: true }));
  const base = '🚀 prefix [alpha beta gamma] suffix\r\n';
  const file = 'a.txt';
  const start = base.indexOf('alpha');
  const selection = { file, base, start, end: base.indexOf(']') };
  const permissions = new PermissionBroker({ workspace: '/workspace' });
  const draft = new Draft(async () => base, selection);
  await draft.replace(file, 'alpha', 'ALPHA');
  const store = new CheckpointStore(storage, '/workspace');
  await store.save(snapshotRun({ draft, permissions }, { request: 'Uppercase alpha', phase: 'question' }));
  const saved = await store.load();
  assert.deepEqual(saved.selection, selection);
  const current = `Added line\r\n${base.replace('beta', 'BETA').replace('suffix', 'suffix revised')}`;
  const workspace = { read: async () => current };
  const rebased = await rebaseCheckpoint(saved, workspace);
  assert.deepEqual(rebased.conflicts, []);
  assert.equal(rebased.selection.start, current.indexOf('alpha'));
  assert.equal(rebased.selection.end, current.indexOf(']'));
  assert.deepEqual(await checkWorkspace(rebased, workspace), []);
  const restored = new Draft(workspace.read, rebased.selection);
  restoreDraft(restored, rebased);
  assert.equal(restored.current(file, current), current.replace('alpha', 'ALPHA'));
  await assert.rejects(restored.replace(file, 'suffix', 'changed'), /must match exactly once/);
  await assert.rejects(restored.replace('b.txt', 'alpha', 'changed'), /original selection/);
});

test('inline recovery offers overlapping edits for review and refuses an unmappable selection', async () => {
  const base = 'prefix [alpha beta] suffix\n';
  const file = 'a.txt';
  const selection = { file, base, start: base.indexOf('alpha'), end: base.indexOf(']') };
  const permissions = new PermissionBroker({ workspace: '/workspace' });
  const draft = new Draft(async () => base, selection);
  await draft.replace(file, 'alpha', 'ALPHA');
  const saved = snapshotRun({ draft, permissions }, { request: 'Uppercase alpha', phase: 'ready' });
  const current = 'prefix [LOCAL BETA] revised suffix\n';
  const rebased = await rebaseCheckpoint(saved, { read: async () => current });
  assert.deepEqual(rebased.files, []);
  const [conflict] = rebased.conflicts;
  assert.equal(conflict.keep, undefined);
  assert.equal(conflict.preview, 'prefix [ALPHA BETA] revised suffix\n');
  const restored = new Draft(async () => current, rebased.selection);
  restoreDraft(restored, { files: [conflict.saved] });
  assert.equal(restored.current(file, current), conflict.preview);
  await assert.rejects(rebaseCheckpoint(saved, { read: async () => 'prefix removed suffix\n' }), /selection boundaries/);
});

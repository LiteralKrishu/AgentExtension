const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Workspace } = require('../src/workspace');
const { digest } = require('../src/permissions');
const { projectClient } = require('../src/collaboration');
const { captureWorkspaceFiles, workspaceFilePlan, selectedWorkspaceFiles, applyWorkspaceFileReceipt, resolveSyncFile } = require('../src/workspace-sync');
const { startProject: projectFixture, git } = require('./fixtures/project.cjs');
const startProject = (t, options) => projectFixture(t, { tlsDirectory: process.env.AGENTEXTENSION_TEST_FILE_SYNC_TLS, ...options });

const clientFor = device => projectClient(device.root, { files: [device.policy] });
const workspaceFor = device => new Workspace(device.root, () => undefined);
const bare = { file: 'tracked.txt', baseDigest: digest('Original text\n'), text: 'Edited text\n' };
const newFile = (file, text) => ({ file, baseDigest: null, text });

test('file snapshots use project membership, Git bases, compare-and-swap, and scoped receipts', async t => {
  const f = await startProject(t);
  const [a, b, viewer] = f.devices.map(clientFor);
  const rev = await workspaceFor(f.devices[0]).gitRevision();
  assert.equal((await a.state()).fileSyncEnabled, false);
  await assert.rejects(a.workspaceFiles(rev), { status: 403 });
  f.config.collaboration.projects[0].fileSync = true;
  await f.update();
  const device = f.devices[0];
  const legacy = new URL('/v1/project', f.url);
  legacy.search = new URLSearchParams({ organization: f.organization, project: f.project, workspace: device.workspace });
  const legacyState = await fetch(legacy, { headers: { Authorization: `Bearer ${device.token}` } }).then(res => res.json());
  assert.equal(Object.hasOwn(legacyState, 'fileSyncEnabled'), false);
  assert.equal((await a.state()).fileSyncEnabled, true);
  const baseline = await a.workspaceFiles(rev);
  const stale = await b.workspaceFiles(rev);
  const viewerSnapshot = await viewer.workspaceFiles(rev);
  await assert.rejects(viewer.publishWorkspaceFiles(viewerSnapshot, [bare]), { status: 403 });
  await assert.rejects(b.publishWorkspaceFiles({ ...stale, actor: baseline.actor }, [bare]), { status: 403 });
  const files = [bare, ...Array.from({ length: 70 }, (_, index) => newFile(`docs/change-${index}.txt`, 'a'.repeat(4000)))];
  const published = await a.publishWorkspaceFiles(baseline, files);
  assert.ok(Buffer.byteLength(JSON.stringify(published)) > 256_000);
  assert.equal(published.sequence, 1);
  assert.deepEqual(published.publishedBy, baseline.actor);
  assert.deepEqual((await viewer.workspaceFiles(rev)).files, published.files);
  assert.equal((await a.publishWorkspaceFiles(published, files)).sequence, 1);
  await assert.rejects(b.publishWorkspaceFiles(stale, [bare]), { status: 409 });
  const next = '1'.repeat(40);
  assert.deepEqual((await a.workspaceFiles(next)).files, []);
  await a.publishWorkspaceFiles(await a.workspaceFiles(next), [newFile('next.txt', 'New Git base')]);
  assert.deepEqual((await a.workspaceFiles(rev)).files, published.files);
  f.members.splice(1, 1);
  await f.update();
  await assert.rejects(b.workspaceFiles(rev), { status: 403 });
});

test('file publication rejects protected paths, aliases, and oversized or redundant entries', async t => {
  const f = await startProject(t, { fileSync: true });
  const client = clientFor(f.devices[0]);
  const snapshot = await client.workspaceFiles(await workspaceFor(f.devices[0]).gitRevision());
  for (const files of [
    [newFile('../outside.txt', 'outside')], [newFile('.git/config', 'private')], [newFile('.env', 'private')],
    [newFile('id_rsa', 'private')], [newFile('node_modules/hidden.js', 'dependency')], [newFile('nul.txt', 'reserved')],
    [newFile('Readme.md', 'one'), newFile('README.md', 'two')], [newFile('folder', 'file'), newFile('folder/readme.txt', 'nested')],
    [newFile('binary.txt', 'not\0text')], [newFile('large.md', 'x'.repeat(32_001))],
    [{ ...bare, text: 'Original text\n' }], [newFile('missing.txt', null)],
  ]) await assert.rejects(client.publishWorkspaceFiles(snapshot, files));
  assert.equal((await client.workspaceFiles(snapshot.revision)).sequence, 0);
});

test('a checkout syncs adds, edits, deletions, and reversions against saved Git bases', async t => {
  const f = await startProject(t, { fileSync: true });
  const [first, second] = f.devices;
  const [a, b] = [first, second].map(clientFor);
  const [left, right] = [first, second].map(workspaceFor);
  const revision = await left.gitRevision();
  const known = new Map();
  await fs.mkdir(path.join(first.root, 'docs'));
  await Promise.all([
    fs.writeFile(path.join(first.root, 'tracked.txt'), 'Updated before sync\n'),
    fs.writeFile(path.join(first.root, 'docs/extra.txt'), 'New nested file\n'),
    fs.writeFile(path.join(first.root, '.env'), 'private setting'),
    fs.writeFile(path.join(first.root, 'binary.txt'), Buffer.from([0, 3, 5])),
    fs.symlink('tracked.txt', path.join(first.root, 'linked.txt')),
    fs.writeFile(path.join(second.root, 'unpublished.txt'), 'Second device only'),
  ]);
  const snapshot = await a.workspaceFiles(revision);
  const local = await captureWorkspaceFiles(left, snapshot, known);
  const publish = workspaceFilePlan('publish', local, known);
  assert.deepEqual(publish.map(change => change.file).sort(), ['docs/extra.txt', 'tracked.txt']);
  assert.equal(local.excluded, 2);
  const sent = selectedWorkspaceFiles('publish', local, snapshot, publish);
  const uploaded = await a.publishWorkspaceFiles(snapshot, sent.files);
  const leftKnown = new Map(applyWorkspaceFileReceipt(known, sent.aligned, new Set(sent.aligned.keys())));
  const remote = await b.workspaceFiles(revision);
  const captured = await captureWorkspaceFiles(right, remote, known);
  const incoming = workspaceFilePlan('receive', captured, known);
  assert.deepEqual(incoming.map(change => change.file).sort(), ['docs/extra.txt', 'tracked.txt']);
  const { aligned } = selectedWorkspaceFiles('receive', captured, remote, incoming);
  for (const { file, before, after } of incoming) {
    const full = await resolveSyncFile(right, file, before === null);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, after);
  }
  const rightKnown = new Map(applyWorkspaceFileReceipt(known, aligned, new Set(aligned.keys())));
  assert.equal(await fs.readFile(path.join(second.root, 'unpublished.txt'), 'utf8'), 'Second device only');

  await git(first.root, 'restore', 'tracked.txt');
  await fs.unlink(path.join(first.root, 'docs/extra.txt'));
  const reset = await captureWorkspaceFiles(left, uploaded, leftKnown);
  const update = selectedWorkspaceFiles('publish', reset, uploaded, workspaceFilePlan('publish', reset, leftKnown));
  assert.deepEqual(update.files, []);
  await a.publishWorkspaceFiles(uploaded, update.files);
  await fs.writeFile(path.join(second.root, 'tracked.txt'), 'Independent local edit\n');
  const latest = await b.workspaceFiles(revision);
  const next = await captureWorkspaceFiles(right, latest, rightKnown);
  assert.deepEqual(workspaceFilePlan('receive', next, rightKnown).sort((x, y) => x.file.localeCompare(y.file)), [
    { file: 'docs/extra.txt', before: 'New nested file\n', after: null, conflict: false },
    { file: 'tracked.txt', before: 'Independent local edit\n', after: 'Original text\n', conflict: true },
  ]);
  await git(second.root, 'update-index', '--skip-worktree', 'tracked.txt');
  await assert.rejects(captureWorkspaceFiles(right, latest, rightKnown), /complete checkout/);
});

test('shared content cannot replace an ignored file, symbolic link, or mismatching Git base', async t => {
  const { devices: [first, second] } = await startProject(t, { fileSync: true });
  const a = clientFor(first);
  const right = workspaceFor(second);
  const revision = await right.gitRevision();
  const snapshot = await a.workspaceFiles(revision);
  const forged = { ...snapshot, files: [{ ...bare, baseDigest: '0'.repeat(64) }] };
  await assert.rejects(captureWorkspaceFiles(right, forged, new Map()), /different Git file base/);
  await fs.writeFile(path.join(second.root, '.git/info/exclude'), 'settings.txt\n');
  await assert.rejects(captureWorkspaceFiles(right, { ...snapshot, files: [newFile('settings.txt', 'shared')] }, new Map()), /is ignored/);
  await fs.symlink('tracked.txt', path.join(second.root, 'alias.txt'));
  await assert.rejects(captureWorkspaceFiles(right, { ...snapshot, files: [newFile('alias.txt', 'shared')] }, new Map()), /outside the saved UTF-8/);
});

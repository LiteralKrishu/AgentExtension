const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Workspace } = require('../src/workspace');
const { CheckpointStore } = require('../src/checkpoint');
const { projectClient, prepareHandoff, materializeHandoff, handoffReceipt } = require('../src/collaboration');
const { startProject, git } = require('./fixtures/project.cjs');
const { startHost } = require('./helpers/host.cjs');

const clientFor = device => projectClient(device.root, { files: [device.policy] });
const local = device => new Workspace(device.root, () => undefined);
const receiver = { user: 'sam', device: 'second' };

test('two enrolled devices share versioned text with explicit conflict resolution and scoped audit access', async t => {
  const f = await startProject(t);
  const [a, b, viewer] = f.devices.map(clientFor);
  const first = await a.state();
  const second = await b.state();
  assert.equal(first.context.notes.revision, second.context.notes.revision);
  await assert.rejects(viewer.change({ action: 'save', section: 'notes', expected: 0, text: 'Denied' }), { status: 403 });
  const saves = await Promise.allSettled([
    a.change({ action: 'save', section: 'notes', expected: 0, text: 'First draft' }),
    b.change({ action: 'save', section: 'notes', expected: 0, text: 'Second draft' }),
  ]);
  assert.equal(saves.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(saves.find(result => result.status === 'rejected').reason.status, 409);
  const published = (await viewer.state()).context.notes;
  assert.equal(published.revision, 1);
  const resolved = await b.change({ action: 'save', section: 'notes', expected: published.revision, text: 'Reviewed resolution' });
  assert.deepEqual((await a.state()).context.notes, resolved);
  await a.change({ action: 'save', section: 'instructions', expected: 0, text: 'Shared instruction\nSecond line' });
  assert.equal((await b.state()).context.instructions.text, 'Shared instruction\nSecond line');
  await a.change({ action: 'save', section: 'instructions', expected: 1, text: '' });
  assert.equal((await viewer.state()).context.instructions.text, '');
  await assert.rejects(a.audit(), { status: 403 });
  const audit = await b.audit();
  assert.equal(audit.length, 4);
  assert.deepEqual(audit.slice(1).map(({ user, device }) => [user, device]), [['sam', 'second'], ['alice', 'first'], ['alice', 'first']]);
  assert.doesNotMatch(JSON.stringify(audit), /First draft|Reviewed resolution|Shared instruction/);
  const other = new URL('/v1/project', f.url);
  const device = f.devices[0];
  other.search = new URLSearchParams({ organization: f.organization, project: 'other', workspace: device.workspace });
  assert.equal((await fetch(other, { headers: { Authorization: `Bearer ${device.token}` } })).status, 403);
  f.members.splice(f.members.findIndex(member => member.device === 'viewer'), 1);
  await f.update();
  await assert.rejects(viewer.state(), { status: 403 });
  f.close();
  await assert.rejects(b.state(), /unavailable/);
});

test('assigned checkpoints bind the recipient, exact payload, Git revision and workspace file bases', async t => {
  const f = await startProject(t);
  const [from, destination] = f.devices;
  const [a, b, viewer] = f.devices.map(clientFor);
  const handoff = await prepareHandoff({ workspace: from.root, files: [
    { file: 'tracked.txt', base: 'Original text\n', text: 'Reviewed edit\n' },
    { file: 'added.txt', base: null, text: 'New text\n' },
  ], forgeSession: { token: 'local-only' }, checks: [{ command: 'private command' }] }, local(from), 'Prepared update');
  const input = { action: 'send', to: receiver, ...handoff };
  await assert.rejects(a.change({ ...input, files: [{ file: 'big.txt', baseDigest: null, text: 'x'.repeat(128_000) }] }), /128 KB/);
  await assert.rejects(a.change({ ...input, files: [{ file: '.env', baseDigest: null, text: 'private' }] }));
  const metadata = await a.change(input);
  assert.deepEqual(await a.change(input), metadata);
  assert.equal((await b.state()).handoffs.length, 1);
  assert.deepEqual((await viewer.state()).handoffs, []);
  await assert.rejects(viewer.open(handoff.id), { status: 403 });
  await assert.rejects(a.change({ action: 'accept', id: handoff.id, expected: '0'.repeat(64) }), { status: 403 });
  await assert.rejects(b.change({ action: 'accept', id: handoff.id, expected: '0'.repeat(64) }), { status: 409 });
  await assert.rejects(b.open(handoff.id, undefined, true), { status: 403 });
  await assert.rejects(a.change({ ...input, id: randomUUID(), to: { user: 'lee', device: 'viewer' } }), { status: 403 });
  const opened = await b.open(handoff.id);
  assert.doesNotMatch(JSON.stringify(opened), /local-only|private command|Original text/);
  await fs.writeFile(path.join(destination.root, 'tracked.txt'), 'Changed locally\n');
  await assert.rejects(materializeHandoff(opened, local(destination)), /differs from the handoff base/);
  await git(destination.root, 'restore', 'tracked.txt');
  const draft = await materializeHandoff(opened, local(destination));
  assert.deepEqual(draft.files.map(({ file, base }) => [file, base]), [['tracked.txt', 'Original text\n'], ['added.txt', null]]);
  await b.change({ action: 'accept', id: handoff.id, expected: handoffReceipt(opened) });
  await b.change({ action: 'accept', id: handoff.id, expected: handoffReceipt(opened) });
  assert.equal((await b.open(handoff.id, undefined, true)).state, 'accepted');
  assert.equal((await b.audit()).filter(event => event.action === 'accept handoff').length, 1);
  await git(destination.root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'Different HEAD');
  await assert.rejects(materializeHandoff(opened, local(destination)), /Git revision differs/);
  f.config.clients = f.config.clients.filter(client => client.id !== destination.device);
  await f.update();
  await assert.rejects(b.state(), { status: 403 });
  await assert.rejects(b.change({ action: 'accept', id: handoff.id, expected: handoffReceipt(opened) }), { status: 403 });
  await a.change({ action: 'remove', id: handoff.id });
  await assert.rejects(a.open(handoff.id), { status: 403 });
  const stored = await fs.readFile(path.join(f.storage, 'projects', f.organization, `${f.project}.json`), 'utf8');
  assert.doesNotMatch(stored, /Reviewed edit|New text|local-only|private command/);
});

test('the receiving editor requires local review and rechecks device access before apply', async t => {
  const f = await startProject(t);
  const [from, destination] = f.devices;
  const a = clientFor(from);
  const b = clientFor(destination);
  const prepared = await prepareHandoff({ workspace: from.root, files: [{ file: 'pilot.txt', base: null, text: 'Shared review text\n' }] },
    local(from), 'Project draft');
  await a.change({ action: 'send', to: receiver, ...prepared });
  const host = await startHost(t, { root: destination.root, settings: {}, env: { AGENTEXTENSION_POLICY_FILE: destination.policy } });
  const store = new CheckpointStore(host.storage, destination.root);
  await store.save({ request: 'Unrelated local draft', files: [], phase: 'interrupted' });
  const output = path.join(destination.root, 'pilot.txt');
  let applies = 0;
  host.vscode.workspace.applyEdit = async edit => {
    applies++;
    const [[kind, uri, options]] = edit.edits;
    assert.equal(kind, 'create');
    assert.equal(uri.fsPath, output);
    await fs.writeFile(uri.fsPath, options.contents, { flag: 'wx' });
    return true;
  };
  const open = () => {
    host.answers.push({ kind: 'pick', value: items => items.find(item => item.label === 'Project draft') },
      { kind: 'pick', value: 'Review on this device' }, { kind: 'modal', value: 'Review draft' });
    return host.command('project');
  };
  assert.equal((await b.state()).handoffs[0].state, 'pending');
  const interrupted = open();
  await host.waitFor(state => state.phase === 'review', 8_000);
  const recipient = f.members.splice(f.members.findIndex(member => member.device === destination.device), 1)[0];
  await f.update();
  await host.waitFor(state => state.phase === 'cancelled', 8_000);
  await interrupted;
  assert.match(host.state().status, /Project access was denied/);
  assert.equal(applies, 0);
  f.members.push(recipient);
  await f.update();

  const review = open();
  const staged = await host.waitFor(state => state.phase === 'review', 8_000);
  assert.equal(applies, 0);
  assert.equal(staged.hunks[0].file, 'pilot.txt');
  await host.send({ type: 'decision', value: 'accept', id: staged.hunks[0].id });
  await host.send({ type: 'continue' });
  await review;
  await host.waitFor(state => state.phase === 'ready', 8_000);
  f.members.splice(f.members.findIndex(member => member.device === destination.device), 1);
  await f.update();
  await host.send({ type: 'apply' });
  await host.waitFor(state => /Project access was denied/.test(state.status), 8_000);
  assert.equal(applies, 0);
  f.members.push(recipient);
  await f.update();
  await host.send({ type: 'apply' });
  await host.waitFor(state => state.phase === 'applied', 8_000);
  assert.equal(await fs.readFile(output, 'utf8'), 'Shared review text\n');
  assert.equal((await store.load()).request, 'Unrelated local draft');
  assert.equal(applies, 1);
});

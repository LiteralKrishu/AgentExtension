const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { request } = require('node:http');
const { createServer } = require('node:https');
const { WorkspaceMemory, UserPreferences, SuggestedNotes } = require('../src/memory');
const { memoryClient, syncMemory } = require('../src/memory-sync');
const { startProject } = require('./fixtures/project.cjs');
const { startHost } = require('./helpers/host.cjs');

const tlsDirectory = process.env.AGENTEXTENSION_TEST_MEMORY_TLS_DIRECTORY;

async function start(t, options = {}) {
  const publicUrl = tlsDirectory ? async target => {
    const key = await fs.readFile(path.join(tlsDirectory, 'key.pem'));
    const cert = await fs.readFile(path.join(tlsDirectory, 'cert.pem'));
    const proxy = createServer({ key, cert }, (incoming, outgoing) => {
      const upstream = request(new URL(incoming.url, target), { method: incoming.method, headers: incoming.headers }, response => {
        outgoing.writeHead(response.statusCode, response.headers);
        response.pipe(outgoing);
      });
      upstream.on('error', () => outgoing.writeHead(502).end());
      incoming.pipe(upstream);
    });
    t.after(() => { proxy.close(); proxy.closeAllConnections(); });
    await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
    return `https://127.0.0.1:${proxy.address().port}`;
  } : undefined;
  return startProject(t, { sameUser: true, memorySync: true, publicUrl, ...options });
}

function storage() {
  const values = new Map();
  return { get: (key, fallback) => values.get(key) ?? fallback, update: async (key, value) => values.set(key, structuredClone(value)) };
}

const clientFor = (device, scope = 'workspace', fetchFn) => memoryClient(device.root, scope, { files: [device.policy], fetchFn });
const sync = (store, client, options = {}) => syncMemory({ store, client, scope: 'workspace', check: async () => {},
  resolve: async () => assert.fail('Unexpected note conflict'), confirm: async () => true, ...options });
const texts = store => store.list().map(note => note.text).sort();

test('same-account devices sync approved notes and preferences without exposing them to project members', async t => {
  const f = await start(t, { memorySync: false });
  const [first, second, other] = f.devices;
  const [a, b, viewer] = f.devices.map(device => clientFor(device));
  await assert.rejects(a.read(), { status: 403 });
  f.config.collaboration.memorySync = true;
  await f.update();
  const stateA = storage();
  const stateB = storage();
  const firstNotes = new WorkspaceMemory(stateA, first.root);
  const secondNotes = new WorkspaceMemory(stateB, second.root);
  const note = await firstNotes.save('Keep the agreed workspace note', {
    kind: 'agent', runId: 'local-run-only', references: [{ file: 'tracked.txt', start: 1 }],
  });
  await new SuggestedNotes(stateA, first.root).add({ text: 'An unapproved suggestion' });
  assert.ok(Array.isArray(stateA.get(firstNotes.key)));
  assert.deepEqual(await sync(firstNotes, a), { outgoing: 1, incoming: 0 });
  assert.deepEqual(await sync(secondNotes, b), { outgoing: 0, incoming: 1 });
  assert.deepEqual(secondNotes.list(), [{ ...note, source: { kind: 'agent', references: [{ file: 'tracked.txt', start: 1 }] } }]);
  assert.equal(firstNotes.list()[0].source.runId, 'local-run-only');
  assert.deepEqual((await viewer.read()).state.notes, []);
  const owner = await a.read();
  const requestUrl = new URL('/v1/project', f.url);
  requestUrl.search = new URLSearchParams({ organization: f.organization, project: f.project, workspace: other.workspace, memory: 'workspace', user: 'alice' });
  const forged = await fetch(requestUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${other.token}` },
    body: JSON.stringify({ binding: owner.state.binding, device: other.device, expected: 1, notes: [] }) });
  assert.equal(forged.status, 403);
  const publicProject = new URL('/v1/project', requestUrl);
  publicProject.search = new URLSearchParams({ organization: f.organization, project: f.project, workspace: other.workspace });
  const visible = await fetch(publicProject, { headers: { Authorization: `Bearer ${other.token}` } }).then(response => response.json());
  assert.doesNotMatch(JSON.stringify(visible), /agreed workspace note/);

  const preferences = new UserPreferences(stateA);
  const prefs = device => clientFor(device, 'preferences');
  await preferences.save('Prefer short diffs', { kind: 'agent', runId: 'local-run-only', references: [{ file: 'tracked.txt' }] });
  await sync(preferences, prefs(first), { scope: 'preferences' });
  assert.deepEqual((await prefs(other).read()).state.notes, []);
  const otherProject = 'another-project';
  f.config.collaboration.projects.push({ id: otherProject, members: [f.members[1]] });
  await f.update();
  const policy = JSON.parse(await fs.readFile(second.policy, 'utf8'));
  policy.organization.projects[second.workspace].project = otherProject;
  await fs.writeFile(second.policy, JSON.stringify(policy));
  assert.deepEqual((await b.read()).state.notes, []);
  assert.deepEqual(await sync(new UserPreferences(stateB), prefs(second), { scope: 'preferences' }), { outgoing: 0, incoming: 1 });
  assert.deepEqual(new UserPreferences(stateB).list()[0].source, { kind: 'agent' });
  assert.deepEqual(texts(new UserPreferences(stateB)), ['Prefer short diffs']);
  await assert.rejects(sync(secondNotes, b), /linked to another sync account or project/);

  const files = await Promise.all((await fs.readdir(path.join(f.storage, 'private-memory'))).map(async file => {
    const full = path.join(f.storage, 'private-memory', file);
    if (process.platform !== 'win32') assert.equal((await fs.stat(full)).mode & 0o777, 0o600);
    return fs.readFile(full, 'utf8');
  }));
  assert.doesNotMatch(files.join('\n'), /local-run-only|unapproved suggestion|token/);
});

test('independent edits merge, deletions propagate, and conflicts require review', async t => {
  const f = await start(t);
  const [a, b] = f.devices.map(device => clientFor(device));
  const [left, right] = f.devices.map(device => new WorkspaceMemory(storage(), device.root));
  const shared = await left.save('Shared start');
  const independent = await left.save('Independent note');
  await sync(left, a);
  await sync(right, b);
  await left.edit(shared.id, 'Edited by first');
  await right.edit(independent.id, 'Edited by second');
  await right.save('New offline note');
  await sync(left, a);
  await sync(right, b);
  await sync(left, a);
  assert.deepEqual(texts(left), ['Edited by first', 'Edited by second', 'New offline note']);
  assert.deepEqual(texts(right), texts(left));

  await left.remove(shared.id);
  await right.edit(shared.id, 'Keep my edited copy?');
  await sync(left, a);
  const before = right.record();
  const choice = async ({ local, remote }) => {
    assert.equal(local.text, 'Keep my edited copy?');
    assert.equal(remote, undefined);
    return 'remote';
  };
  assert.equal(await sync(right, b, { resolve: choice, confirm: async () => false }), undefined);
  assert.deepEqual(right.record(), before);
  await sync(right, b, { resolve: choice });
  assert.deepEqual(texts(right), ['Edited by second', 'New offline note']);
  assert.deepEqual(texts(left), texts(right));

  await left.edit(independent.id, 'Same change on both devices');
  await right.edit(independent.id, 'Same change on both devices');
  await sync(left, a);
  const revision = (await a.read()).state.revision;
  await sync(right, b);
  assert.equal((await b.read()).state.revision, revision);

  f.close();
  await right.save('Written while offline');
  await assert.rejects(sync(right, b), /unavailable|HTTP 502/);
  assert.ok(texts(right).includes('Written while offline'));
});

test('valid large note sets sync and an over-limit merge leaves both copies intact', async t => {
  const { devices: [first, second] } = await start(t);
  const a = clientFor(first);
  const b = clientFor(second);
  const left = new WorkspaceMemory(storage(), first.root);
  const right = new WorkspaceMemory(storage(), second.root);
  const references = Array.from({ length: 5 }, (_, index) => ({
    file: `docs/${'案'.repeat(70)}/${'例'.repeat(70)}/${'集'.repeat(70)}/${'録'.repeat(70)}/${index}.md`,
  }));
  await Promise.all(Array.from({ length: 20 }, () => left.save('\x01'.repeat(400), { kind: 'user', references })));
  assert.equal(left.list().length, 20);
  await sync(left, a);
  assert.ok(Buffer.byteLength(JSON.stringify((await b.read()).state.notes)) > 128_000);
  const extra = await right.save('This edit remains local until there is room to merge');
  await assert.rejects(sync(right, b), /Combined notes exceed/);
  assert.deepEqual(right.list(), [extra]);
  assert.equal((await b.read()).state.notes.length, 20);
  await right.remove(extra.id);
  await sync(right, b);
  assert.equal(right.list().length, 20);
});

test('stale, revoked, interrupted, and concurrent syncs preserve the local store', async t => {
  const f = await start(t);
  const [first, second] = f.devices;
  const [a, b] = f.devices.map(device => clientFor(device));
  const [left, right] = f.devices.map(device => new WorkspaceMemory(storage(), device.root));
  await left.save('First copy');
  await right.save('Other copy');
  await sync(left, a);
  const outstanding = await b.read();
  await left.save('First device added another');
  const initialRight = right.record();
  await assert.rejects(sync(right, b, { confirm: async () => { await sync(left, a); return true; } }), { status: 409 });
  assert.deepEqual(right.record(), initialRight);
  await assert.rejects(b.publish(outstanding, outstanding.state.notes), { status: 409 });
  await assert.rejects(sync(right, b, { confirm: async () => { await right.save('Changed during review'); return true; } }), /Local notes changed/);
  assert.equal((await a.read()).state.notes.length, 2);

  const dropsReceipt = clientFor(second, 'workspace', async (url, options) => {
    const response = await fetch(url, options);
    if (options.method !== 'POST') return response;
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    throw new Error('Fixture lost the response');
  });
  await assert.rejects(sync(right, dropsReceipt), /unavailable/);
  assert.deepEqual(texts(right), ['Changed during review', 'Other copy']);
  await sync(right, b);
  assert.equal(right.list().length, 4);
  assert.equal(new Set(right.list().map(note => note.id)).size, 4);
  const stale = right.list()[0];
  await right.edit(stale.id, 'Only edit the latest copy', stale);
  await assert.rejects(right.remove(stale.id, stale), /changed/);
  await right.edit(stale.id, stale.text);

  await right.save('Keep after device revocation');
  const beforeRevocation = right.record();
  await assert.rejects(sync(right, b, { confirm: async () => {
    f.config.clients = f.config.clients.filter(client => client.id !== second.device);
    await f.update();
    return true;
  } }), { status: 403 });
  assert.deepEqual(right.record(), beforeRevocation);
  assert.equal((await clientFor(first).read()).state.notes.length, 4);
});

test('the Notes panel previews incoming changes and syncs only after approval', async t => {
  const { devices: [first, second] } = await start(t);
  const left = new WorkspaceMemory(storage(), first.root);
  const note = await left.save('Approved on the other device');
  await sync(left, clientFor(first));
  const host = await startHost(t, { root: second.root, settings: {}, env: { AGENTEXTENSION_POLICY_FILE: second.policy } });
  const update = host.context.globalState.update;
  host.context.globalState.update = async (...args) => {
    // Storage can finish after the host helper's fixed message delay on a busy runner.
    await new Promise(resolve => setTimeout(resolve, 100));
    return update(...args);
  };
  const sendMemoryAndWait = async expectedStatus => {
    const published = host.states.length;
    await host.send({ type: 'memory' });
    // A previous sync can have the same status. Require a fresh panel update.
    await host.waitFor(state => host.states.length > published && expectedStatus.test(state.status ?? ''),
      5_000, 'Notes action to finish');
  };
  const local = new WorkspaceMemory(host.context.globalState, second.root);
  const option = { kind: 'pick', value: items => items.find(item => item.label === 'Sync workspace notes') };
  host.answers.push(option, { kind: 'modal', value: () => undefined });
  await host.send({ type: 'memory' });
  assert.deepEqual(local.list(), []);
  host.answers.push(option, { kind: 'modal', value: (_buttons, title) => {
    assert.equal(title, 'Sync workspace notes?');
    assert.match(host.shown.warning.at(-1).detail, /fixture-team \/ alice \/ demo/);
    return 'Sync notes';
  } });
  await sendMemoryAndWait(/^Synced workspace notes\./);
  assert.deepEqual(texts(local), ['Approved on the other device']);
  assert.ok(host.shown.info.includes('command:vscode.diff'));
  assert.match(host.state().status, /0 sent, 1 received/);
  await left.edit(note.id, 'Published edit');
  await sync(left, clientFor(first));
  await local.edit(note.id, 'Local edit');
  host.answers.push(option, { kind: 'pick', value: items => items.find(item => item.value === 'remote') },
    { kind: 'modal', value: 'Sync notes' });
  await sendMemoryAndWait(/^Synced workspace notes\./);
  assert.deepEqual(texts(local), ['Published edit']);
  host.answers.push({ kind: 'pick', value: items => items.find(item => /Forget the sync link for workspace/.test(item.label)) },
    { kind: 'modal', value: 'Forget link' });
  await sendMemoryAndWait(/^Sync link removed\.$/);
  assert.deepEqual(texts(local), ['Published edit']);
  assert.equal(local.record().sync, undefined);
  assert.equal((await clientFor(first).read()).state.notes.length, 1);
});

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { projectClient, prepareContinuation, materializeContinuation, handoffReceipt, continuationAge } = require('../src/collaboration');
const { Workspace } = require('../src/workspace');
const { startProject, git } = require('./fixtures/project.cjs');

const fixture = (t, options) => startProject(t, { tlsDirectory: process.env.AGENTEXTENSION_TEST_CONTINUATION_TLS, ...options });
const client = device => projectClient(device.root, { files: [device.policy] });
const workspace = device => new Workspace(device.root, () => undefined);
const actor = ({ user, device }) => ({ user, device });

test('continuation offers keep reviewed context private and bind access to both device enrollments', async t => {
  const f = await fixture(t, { sameUser: true });
  const [first, second, viewer] = f.devices;
  const [sender, recipient, observer] = f.devices.map(client);
  const payload = await prepareContinuation({
    workspace: first.root, request: 'Finish the portable task', summary: 'PRIVATE PROGRESS',
    files: [{ file: 'tracked.txt', base: 'Original text\n', text: 'Reviewed staged edit\n' }],
    forgeSession: { id: 'ORIGINAL_SESSION', bridgeUrl: 'PRIVATE_BRIDGE' },
    checks: [{ output: 'PRIVATE_COMMAND_OUTPUT' }],
  }, workspace(first), 'Continue task');
  assert.deepEqual(Object.keys(payload).sort(), ['files', 'id', 'planFirst', 'progress', 'request', 'revision', 'title']);
  const offer = { action: 'offer-continuation', to: actor(second), ...payload };
  assert.deepEqual((await sender.state()).continuationRecipients, []);
  await assert.rejects(sender.change(offer), { status: 403 });
  f.config.collaboration.projects[0].sessionContinuations = true;
  await f.update();
  const state = await sender.state();
  assert.deepEqual(state.continuationRecipients, [actor(second)]);
  await assert.rejects(sender.change(offer, undefined, 'wrong link'), /enrollment changed/);
  await assert.rejects(sender.change({ ...offer, to: actor(first) }), { status: 403 });
  f.members[2].role = 'editor';
  await f.update();
  await assert.rejects(sender.change({ ...offer, to: actor(viewer) }), { status: 403 });
  assert.deepEqual((await sender.change(offer, undefined, state.link)).paths, ['tracked.txt']);
  await sender.change(offer);
  await assert.rejects(sender.change({ ...offer, progress: 'Changed content' }), { status: 409 });

  for (const project of await Promise.all([sender.state(), recipient.state(), observer.state()])) {
    assert.doesNotMatch(JSON.stringify(project), /PRIVATE|Finish the portable task|Reviewed staged edit/);
  }
  assert.deepEqual((await observer.state()).continuations, []);
  await assert.rejects(observer.openContinuation(payload.id), { status: 403 });
  const { entry, link } = await recipient.openContinuation(payload.id);
  assert.equal(entry.progress, 'PRIVATE PROGRESS');
  assert.deepEqual(entry.files, payload.files);
  assert.doesNotMatch(JSON.stringify(entry), /ORIGINAL_SESSION|PRIVATE_BRIDGE|PRIVATE_COMMAND_OUTPUT/);
  const { link: senderLink } = await sender.openContinuation(payload.id);
  const receipt = { link, id: entry.id, digest: handoffReceipt(entry) };
  await assert.rejects(sender.acceptContinuation(entry, senderLink), { status: 403 });
  await assert.rejects(recipient.verifyContinuation(receipt), { status: 403 });
  await assert.rejects(recipient.acceptContinuation({ ...entry, progress: 'Stale preview' }, link), { status: 409 });
  await recipient.acceptContinuation(entry, link);
  await recipient.acceptContinuation(entry, link);
  await recipient.verifyContinuation(receipt);
  await assert.rejects(sender.verifyContinuation({ ...receipt, link: senderLink }), { status: 403 });

  f.members[1].user = 'new-account';
  await f.update();
  await assert.rejects(recipient.verifyContinuation(receipt), { status: 403 });
  assert.deepEqual((await sender.state()).continuations, []);
  f.members[1].user = second.user;
  const [removed] = f.config.clients.splice(0, 1);
  await f.update();
  await assert.rejects(recipient.verifyContinuation(receipt), { status: 403 });
  f.config.clients.unshift(removed);
  await f.update();
  await recipient.verifyContinuation(receipt);
  await sender.change({ action: 'remove-continuation', id: entry.id });
  await assert.rejects(recipient.verifyContinuation(receipt), { status: 403 });
  const audit = await recipient.audit();
  assert.deepEqual(audit.map(event => [event.action, event.device]), [
    ['offer session continuation', 'first'], ['accept session continuation', 'second'], ['remove session continuation', 'first'],
  ]);
  assert.doesNotMatch(JSON.stringify(audit), /PRIVATE|Continue task|tracked.txt/);
});

test('continuation requires the original Git revision and file bases and expires after seven days', async t => {
  let now = Date.now();
  const f = await fixture(t, { sameUser: true, sessionContinuations: true, now: () => now });
  const [first, second] = f.devices;
  const [sender, recipient] = f.devices.map(client);
  const receiving = workspace(second);
  const tracked = path.join(second.root, 'tracked.txt');
  const payload = await prepareContinuation({ workspace: first.root, request: 'Continue', planFirst: true,
    approvedPlan: { goal: 'Previous plan' }, files: [{ file: 'tracked.txt', base: 'Original text\n', text: 'Staged text\n' }] },
  workspace(first), 'Matching Git base');
  assert.match(payload.progress, /Previous plan/);
  assert.equal(payload.planFirst, true);
  assert.deepEqual((await materializeContinuation(payload, receiving)).files, [{
    file: 'tracked.txt', base: 'Original text\n', text: 'Staged text\n',
  }]);
  await fs.writeFile(tracked, 'Independent local changes\n');
  await assert.rejects(materializeContinuation(payload, receiving), /tracked.txt differs/);
  assert.equal(await fs.readFile(tracked, 'utf8'), 'Independent local changes\n');
  await git(second.root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qam', 'Different base');
  await assert.rejects(materializeContinuation(payload, receiving), /Git revision differs/);
  await sender.change({ action: 'offer-continuation', to: actor(second), ...payload });
  const { entry, link } = await recipient.openContinuation(payload.id);
  await recipient.acceptContinuation(entry, link);
  const receipt = { link, id: entry.id, digest: handoffReceipt(entry) };
  now += continuationAge - 1;
  await recipient.verifyContinuation(receipt);
  now++;
  assert.deepEqual((await recipient.state()).continuations, []);
  await assert.rejects(recipient.openContinuation(entry.id), { status: 403 });
  await assert.rejects(recipient.verifyContinuation(receipt), { status: 403 });
});

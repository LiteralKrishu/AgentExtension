const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { CheckpointStore } = require('../src/checkpoint');
const { projectClient } = require('../src/collaboration');
const { startHost, scriptedModel } = require('./helpers/host.cjs');
const { startProject } = require('./fixtures/project.cjs');

const destinationUrl = process.env.AGENTEXTENSION_TEST_FORGE_URL;
const sourceUrl = process.env.AGENTEXTENSION_TEST_CONTINUATION_SOURCE_FORGE_URL ?? destinationUrl;
const live = { skip: !destinationUrl && 'Set AGENTEXTENSION_TEST_FORGE_URL to a local TrueForge instance.', timeout: 90_000 };
const pick = label => ({ kind: 'pick', value: items => items.find(item => item.label === label) });
const modal = value => ({ kind: 'modal', value });
const settings = (serverUrl, model) => ({ serverUrl, model, fallbackModel: '', compaction: false, turnTimeoutSeconds: 30, automaticSkills: false });
const fixture = t => startProject(t, { sameUser: true, sessionContinuations: true, tlsDirectory: process.env.AGENTEXTENSION_TEST_CONTINUATION_TLS });

test('two editor hosts share and import a reviewed draft and resume it through a fresh local TrueForge session', live, async t => {
  const f = await fixture(t);
  const [first, second] = f.devices;
  const request = 'Continue the staged workspace change.';
  const sourceModel = await scriptedModel(t, sourceUrl, async ({ round, call, say }) => {
    if (round === 0) return call('propose_write', { file: 'tracked.txt', old_text: 'Original text', new_text: 'Continued draft' });
    if (round === 1) return call('review_changes', {});
    return say('PORTABLE_PROGRESS: The draft is ready for local verification.');
  });
  const source = await startHost(t, { root: first.root, settings: settings(sourceUrl, sourceModel.model), env: { AGENTEXTENSION_POLICY_FILE: first.policy } });
  await source.send({ type: 'run', prompt: request });
  const sourceReview = await source.waitFor(state => state.phase === 'review', 15_000, 'source draft review');
  await source.send({ type: 'decision', id: sourceReview.hunks[0].id, value: 'accept' });
  await source.send({ type: 'continue' });
  const sourceReady = await source.waitFor(state => state.phase === 'ready' && !state.runActive, 15_000, 'source draft ready');
  assert.ifError(sourceModel.state.error);
  const sourceSession = new URL(sourceReady.session).pathname.split('/').at(-1);
  const client = projectClient(second.root, { files: [second.policy] });
  const share = async choice => {
    source.answers.push(pick('Share a session continuation'), pick('second'), { kind: 'input', value: 'Continue the draft' }, modal(choice));
    await source.command('project');
  };
  await share(undefined);
  assert.deepEqual((await client.state()).continuations, []);
  await share('Share continuation');
  await source.waitFor(state => /Session continuation shared/.test(state.status), 5_000);
  const [offer] = (await client.state()).continuations;
  const { entry } = await client.openContinuation(offer.id);
  assert.equal(entry.request, request);
  assert.match(entry.progress, /PORTABLE_PROGRESS/);
  assert.equal(entry.files[0].text, 'Continued draft\n');
  assert.ok(sourceSession && !JSON.stringify(entry).includes(sourceSession));
  assert.ok(source.shown.info.includes('command:vscode.diff'));

  const destinationModel = await scriptedModel(t, destinationUrl, async ({ round, all, call, say }) => {
    assert.match(all, /CROSS-DEVICE CONTINUATION/);
    assert.match(all, /PORTABLE_PROGRESS/);
    assert.ok(!all.includes(sourceSession));
    if (round === 0) return call('read_file', { file: 'tracked.txt' });
    if (round === 1) {
      assert.match(all, /Continued draft/);
      return call('run_command', { command: 'node', args: ['--version'] });
    }
    if (round === 2) return call('review_changes', {});
    return say('The receiving editor reviewed the draft.');
  });
  const target = await startHost(t, { root: second.root, settings: settings(destinationUrl, destinationModel.model),
    env: { AGENTEXTENSION_POLICY_FILE: second.policy } });
  const store = new CheckpointStore(target.storage, second.root);
  const importOffer = async (choice, confirm = true) => {
    target.answers.push(pick(offer.title), { kind: 'pick', value: 'Import to this device' });
    if (confirm) target.answers.push(modal(choice));
    await target.command('project');
  };
  await store.save({ runId: 'unrelated', request: 'Keep this local checkpoint', phase: 'interrupted', files: [] });
  await importOffer(undefined, false);
  assert.equal((await store.load()).runId, 'unrelated');
  await store.clear();
  await importOffer(undefined);
  assert.equal(await store.load(), undefined);
  assert.equal((await client.state()).continuations[0].state, 'pending');
  await importOffer('Import continuation');
  await target.waitFor(state => state.checkpoint && /Session continuation imported/.test(state.status), 5_000, 'imported checkpoint');
  const imported = await store.load();
  assert.equal(imported.forgeSession, undefined);
  assert.equal(imported.approvedPlan, null);
  assert.deepEqual(imported.checks, []);
  assert.equal(imported.projectContinuation.id, offer.id);
  assert.equal(imported.files[0].text, 'Continued draft\n');
  assert.equal(destinationModel.state.requests.length, 0);
  assert.ok(target.shown.info.includes('command:vscode.diff'));

  const [member] = f.members.splice(1, 1);
  await f.update();
  await target.send({ type: 'resume-run' });
  await target.waitFor(state => /Project access was denied/.test(state.status), 5_000, 'revoked continuation denied before starting');
  assert.equal(destinationModel.state.requests.length, 0);
  f.members.splice(1, 0, member);
  await f.update();
  target.answers.push(modal('Run command'));
  await target.send({ type: 'resume-run' });
  const review = await target.waitFor(state => state.phase === 'review', 15_000, 'receiving draft review');
  assert.ifError(destinationModel.state.error);
  assert.notEqual(review.session, sourceReady.session);
  const receivingSession = new URL(review.session).pathname.split('/').at(-1);
  assert.notEqual(receivingSession, sourceSession);
  assert.notEqual(review.permissions.runId, sourceReview.permissions.runId);
  assert.ok(target.shown.warning.some(item => item.buttons.includes('Run command')));
  assert.deepEqual(review.hunks.map(hunk => hunk.file), ['tracked.txt']);
  await target.send({ type: 'decision', id: review.hunks[0].id, value: 'accept' });
  await target.send({ type: 'continue' });
  await target.waitFor(state => state.phase === 'ready' && !state.runActive, 15_000, 'receiving draft ready');
  const { TrueForge } = await import('@truefoundry/trueforge-sdk');
  const events = await new TrueForge({ baseUrl: destinationUrl }).sessions.listEvents(receivingSession);
  const rootTurn = events.data.map(({ event }) => event).filter(event => event.type === 'turn.created')
    .sort((a, b) => a.id.localeCompare(b.id))[0];
  assert.equal(rootTurn.previousTurnId, null);
  f.members.splice(1, 1);
  await f.update();
  await target.send({ type: 'apply' });
  await target.waitFor(state => /Project access was denied/.test(state.status), 5_000, 'revoked continuation denied before applying');
  assert.equal(await fs.readFile(path.join(second.root, 'tracked.txt'), 'utf8'), 'Original text\n');
});

test('a finished session without staged files can be shared from the project menu', live, async t => {
  const f = await fixture(t);
  const [first, second] = f.devices;
  const model = await scriptedModel(t, sourceUrl, async ({ say }) => say('A portable progress note.'));
  const host = await startHost(t, { root: first.root, settings: settings(sourceUrl, model.model), env: { AGENTEXTENSION_POLICY_FILE: first.policy } });
  await host.send({ type: 'run', prompt: 'Summarize progress.' });
  await host.waitFor(state => state.phase === 'done' && !state.runActive, 15_000, 'completed run');
  host.answers.push(pick('Share a session continuation'), pick('second'), { kind: 'input', value: 'Finished session' }, modal('Share continuation'));
  await host.command('project');
  await host.waitFor(state => /Session continuation shared/.test(state.status), 5_000);
  const client = projectClient(second.root, { files: [second.policy] });
  const [offer] = (await client.state()).continuations;
  const { entry } = await client.openContinuation(offer.id);
  assert.equal(entry.request, 'Summarize progress.');
  assert.equal(entry.progress, 'A portable progress note.');
  assert.deepEqual(entry.files, []);
});

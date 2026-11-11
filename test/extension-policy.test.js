const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { startHost, scriptedModel } = require('./helpers/host.cjs');

const baseUrl = process.env.AGENTEXTENSION_TEST_FORGE_URL;
const live = { skip: !baseUrl && 'Set AGENTEXTENSION_TEST_FORGE_URL to a local TrueForge instance.', timeout: 180_000 };

async function workspace(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-policy-ws-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.txt'), 'start\n');
  return root;
}

test('workspace rules are managed in the panel, stored outside the repository, and an invalid administrator policy blocks runs', async t => {
  const root = await workspace(t);
  const policyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-admin-'));
  t.after(() => fs.rm(policyDir, { recursive: true, force: true }));
  const policyFile = path.join(policyDir, 'policy.json');
  const host = await startHost(t, { root, settings: { model: 'none/none', serverUrl: 'http://127.0.0.1:1' }, env: { AGENTEXTENSION_POLICY_FILE: policyFile } });
  await host.waitFor(state => state.policySummary === 'Every protected action asks first.', 5_000, 'policy summary');
  host.answers.push(
    { kind: 'pick', value: items => items.find(item => item.add) },
    { kind: 'pick', value: items => items.find(item => item.label === 'command.execute') },
    { kind: 'pick', value: items => items.find(item => item.label === 'allow') },
    { kind: 'input', value: 'npm test' },
    { kind: 'modal', value: buttons => buttons[0] });
  await host.send({ type: 'policy' });
  await host.waitFor(state => state.policySummary === 'Rules: 0 administrator · 0 user · 1 workspace.', 5_000, 'rule saved');
  const stored = [...host.context.globalState.values.entries()].find(([key]) => key.startsWith('policy.v1.'));
  assert.deepEqual(stored[1], [{ effect: 'command.execute', target: 'npm test', decision: 'allow' }]);
  assert.deepEqual(await fs.readdir(root), ['a.txt'], 'Nothing is written into the workspace');
  // A user rule from settings joins the list. An allow rule without a specific target is refused by the input validator.
  host.settings.permissionRules = [{ effect: 'browser.*', decision: 'deny' }];
  host.changeConfig('agentextension.permissionRules');
  await host.waitFor(state => state.policySummary === 'Rules: 0 administrator · 1 user · 1 workspace.', 5_000, 'user rule');
  host.answers.push({ kind: 'pick', value: items => {
    assert.deepEqual(items.slice(2).map(item => `${item.description}:${item.label}`),
      ['user:deny · browser.* · *', 'workspace:allow · command.execute · npm test']);
    return items.find(item => item.rule?.source === 'workspace');
  } }, { kind: 'modal', value: buttons => buttons[0] });
  await host.send({ type: 'policy' });
  await host.waitFor(state => state.policySummary === 'Rules: 0 administrator · 1 user · 0 workspace.', 5_000, 'rule removed');
  // Browser access is off because a user rule denies the capability.
  host.settings.browserOrigins = ['http://127.0.0.1:3000'];
  await host.send({ type: 'browser-access' });
  await host.waitFor(state => /permission rule turns browser access off/.test(state.status ?? ''), 5_000, 'browser refused');
  await fs.writeFile(policyFile, '{ "version": 1, "rules": [');
  host.changeConfig('agentextension.permissionRules');
  await host.waitFor(state => /is invalid/.test(state.policySummary ?? ''), 5_000, 'invalid policy');
  await host.send({ type: 'run', prompt: 'Change a.txt' });
  await host.waitFor(state => /is invalid.*No run started/.test(state.status ?? ''), 5_000, 'run refused');
  assert.equal(host.answers.length, 0);
});

test('"Always allow in this workspace" saves an exact command rule; the next run skips the prompt; an administrator deny wins', live, async t => {
  const root = await workspace(t);
  const policyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-admin-'));
  t.after(() => fs.rm(policyDir, { recursive: true, force: true }));
  const policyFile = path.join(policyDir, 'policy.json');
  const model = await scriptedModel(t, baseUrl, async ({ round, call, say, results }) => {
    if (round === 0) return call('propose_write', { file: 'a.txt', old_text: 'start', new_text: 'changed' });
    if (round === 1) return call('review_changes', {});
    if (round === 2) return call('run_command', { command: 'node', args: ['-e', 'console.log(require("fs").readFileSync("a.txt","utf8"))'] });
    return say(`Done. ${JSON.stringify(results.at(-1)?.content ?? '').slice(0, 200)}`);
  });
  const host = await startHost(t, { root, settings: { serverUrl: baseUrl, model: model.model, fallbackModel: '', compaction: true,
    turnTimeoutSeconds: 60, readConnectors: [], skillRoots: [], pluginRoots: [], browserOrigins: [] },
  env: { AGENTEXTENSION_POLICY_FILE: policyFile } });
  const runOnce = async (commandAnswer) => {
    if (commandAnswer) host.answers.push({ kind: 'modal', value: commandAnswer });
    await host.send({ type: 'run', prompt: 'Change a.txt and check it.' });
    const review = await host.waitFor(state => state.phase === 'review', 60_000, 'review');
    for (const hunk of review.hunks) await host.send({ type: 'decision', id: hunk.id, value: 'accept' });
    await host.send({ type: 'continue' });
    const done = await host.waitFor(state => state.phase === 'ready' || state.phase === 'idle', 60_000, 'run end');
    assert.ifError(model.state.error);
    const events = done.permissions.events.filter(event => event.tool === 'run_command');
    await host.send({ type: 'cancel' });
    await host.waitFor(state => state.phase === 'cancelled', 10_000, 'discard');
    return { events, done };
  };
  const first = await runOnce(buttons => {
    assert.deepEqual(buttons, ['Run command', 'Always allow in this workspace']);
    return 'Always allow in this workspace';
  });
  assert.ok(first.events.some(event => event.decision === 'approve' && event.reason === 'One exact action'));
  assert.equal(first.done.checks[0].exitCode, 0);
  assert.match(first.done.checks[0].output, /changed/);
  assert.match(first.done.policySummary, /1 workspace/);
  const second = await runOnce();
  assert.ok(second.events.some(event => event.decision === 'approve' && /^Allowed by workspace rule command\.execute node -e /.test(event.reason)));
  await fs.writeFile(policyFile, JSON.stringify({ version: 1, rules: [{ effect: 'command.execute', target: 'node *', decision: 'deny' }] }));
  const third = await runOnce();
  assert.ok(third.events.some(event => event.decision === 'deny' && event.reason === 'Denied by administrator rule command.execute node *'));
  assert.equal(third.done.checks?.length ?? 0, 0);
  assert.equal(host.answers.length, 0, 'No unexpected prompts');
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'start\n', 'Discarded runs leave the workspace unchanged');
});

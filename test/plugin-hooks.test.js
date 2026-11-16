const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PluginHooks } = require('../src/plugin-hooks');
const { PolicyEngine } = require('../src/policy');
const { startHost, scriptedModel } = require('./helpers/host.cjs');

const declarations = ['record-check-result', 'reject-conflict-markers'];
const baseUrl = process.env.AGENTEXTENSION_TEST_FORGE_URL;

test('built-in hooks take only event data and report policy, limits, and cancellation', async () => {
  const results = [];
  const controller = new AbortController();
  const signal = controller.signal;
  let policy = new PolicyEngine();
  const hooks = new PluginHooks([{ id: 'review', hooks: declarations }], result => results.push(result));
  await hooks.run('after-check', { exitCode: 1, revision: 3, output: 'Do not copy this into the report' }, { signal, policy });
  assert.deepEqual(results.map(item => item.detail), ['Check failed at draft revision 3.']);
  await hooks.run('before-apply', ['a normal line\n=======\n'], { signal, policy });
  assert.equal(results.at(-1).status, 'passed');
  await assert.rejects(() => hooks.run('before-apply', ['<<<<<<< branch\n'], { signal, policy }), /conflict markers/);
  await assert.rejects(() => hooks.run('before-apply', ['x'.repeat(64_001)], { signal, policy }), /64,000/);
  await assert.rejects(() => hooks.run('before-apply', Array(65).fill('x'), { signal, policy }), /64 accepted hunks/);
  policy = new PolicyEngine({ workspace: [{ effect: 'hook.run', target: 'review/reject-conflict-markers', decision: 'deny' }] });
  await hooks.run('before-apply', ['>>>>>>> branch\n'], { signal, policy });
  assert.equal(results.at(-1).status, 'skipped');
  controller.abort();
  await assert.rejects(() => hooks.run('after-check', { exitCode: 0, revision: 4 }, { signal, policy }), { name: 'AbortError' });
  assert.equal(results.at(-1).status, 'cancelled');
});

test('approved hooks report a check and prevent applying accepted conflict markers', {
  skip: !baseUrl && 'Set AGENTEXTENSION_TEST_FORGE_URL to a local TrueForge instance.', timeout: 90_000,
}, async t => {
  const area = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-hooks-')));
  t.after(() => fs.rm(area, { recursive: true, force: true }));
  const root = path.join(area, 'workspace');
  const plugins = path.join(area, 'plugins');
  await fs.mkdir(root);
  await fs.mkdir(path.join(plugins, 'sample-hooks'), { recursive: true });
  await fs.writeFile(path.join(plugins, 'sample-hooks/plugin.json'), JSON.stringify({
    schemaVersion: 1, id: 'sample-hooks', version: '1.0.0', publisher: 'Example team', description: 'Report checks and validate accepted changes.',
    hooks: declarations, capabilities: ['hook.run'],
  }));
  const source = path.join(root, 'sample.txt');
  await fs.writeFile(source, 'start\n');
  const model = await scriptedModel(t, baseUrl, ({ round, call, say }) => {
    if (round === 0) return call('propose_write', { file: 'sample.txt', old_text: 'start', new_text: '<<<<<<< branch' });
    if (round === 1) return call('run_command', { command: 'node', args: ['--version'] });
    if (round === 2) return call('review_changes', {});
    return say('Check complete.');
  });
  const host = await startHost(t, { root, settings: { serverUrl: baseUrl, model: model.model, fallbackModel: '',
    turnTimeoutSeconds: 60, compaction: true, pluginRoots: [plugins], automaticSkills: false } });
  host.answers.push({ kind: 'pick', value: items => items.filter(item => item.label === 'sample-hooks') },
    { kind: 'modal', value: () => {
      assert.match(host.shown.warning.at(-1).detail, /Built-in hooks: record-check-result \(after-check\), reject-conflict-markers \(before-apply\)/);
      return 'Enable plugin';
    } });
  await host.send({ type: 'plugins' });
  await host.waitFor(state => state.plugins?.some(plugin => plugin.id === 'sample-hooks'), 5_000);
  host.answers.push({ kind: 'modal', value: 'Run command' });
  await host.send({ type: 'run', prompt: 'Rehearse the draft review.' });
  const review = await host.waitFor(state => ['review', 'error'].includes(state.phase), 60_000);
  assert.ifError(model.state.error);
  assert.equal(review.phase, 'review', review.status);
  for (const hunk of review.hunks) await host.send({ type: 'decision', id: hunk.id, value: 'accept' });
  await host.send({ type: 'continue' });
  await host.waitFor(state => state.phase === 'ready' && !state.runActive, 10_000);
  await host.send({ type: 'apply' });
  await host.waitFor(state => /merge conflict markers/.test(state.status ?? '') && !state.applying, 5_000);
  assert.equal(await fs.readFile(source, 'utf8'), 'start\n');
  await host.send({ type: 'run-report' });
  assert.ok(host.shown.documents.length);
  const report = await fs.readFile(host.shown.documents.at(-1), 'utf8');
  assert.match(report, /record-check-result · after-check · passed · Check passed/);
  assert.match(report, /reject-conflict-markers · before-apply · failed · Possible merge conflict markers/);
});

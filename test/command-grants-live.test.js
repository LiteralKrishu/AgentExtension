const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { startHost, scriptedModel } = require('./helpers/host.cjs');
const baseUrl = process.env.AGENTEXTENSION_TEST_FORGE_URL;
test('the editor reuses one optional grant for two real offline container checks', {
  skip: !baseUrl || process.env.AGENTEXTENSION_TEST_DOCKER !== '1', timeout: 90_000,
}, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ae-grant-live-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"grant-fixture","version":"1.0.0"}');
  await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'grant-fixture', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'grant-fixture', version: '1.0.0' } } }));
  await fs.writeFile(path.join(root, 'check.js'), 'console.log("offline fixture passed");\n');
  const model = await scriptedModel(t, baseUrl, ({ round, call, say, results }) => {
    if (round < 2) {
      if (round === 1) assert.match(results.at(-1).content, /offline fixture passed/);
      return call('run_command', { command: 'node', args: ['check.js'] });
    }
    assert.match(results.at(-1).content, /offline fixture passed/);
    return say('Both declared checks passed.');
  });
  const host = await startHost(t, { root, settings: { serverUrl: baseUrl, model: model.model, fallbackModel: '', compaction: true,
    turnTimeoutSeconds: 60, readConnectors: [], skillRoots: [], pluginRoots: [], browserOrigins: [], automaticSkills: false,
    executionEnvironment: 'container' } });
  host.answers.push({ kind: 'modal', value: (buttons) => { assert.ok(buttons.includes('Allow unchanged checks for 5 minutes')); return 'Allow unchanged checks for 5 minutes'; } });
  await host.send({ type: 'run', prompt: 'Run node check.js twice on the same source and report both outcomes.' });
  const state = await host.waitFor(state => !state.runActive && state.phase === 'done', 80_000, 'completed checks');
  assert.ifError(model.state.error); assert.equal(host.answers.length, 0);
  assert.equal(state.checks.length, 2); assert.ok(state.checks.every(check => check.exitCode === 0));
  assert.ok(host.states.some(state => state.permissions?.runGrants?.some(grant => grant.scope && grant.expires > 0)), 'The active run grant is visible before run end');
  assert.equal(state.permissions.approvalMetrics.run_command.prompts, 1);
  assert.equal(state.permissions.approvalMetrics.run_command.reused, 1);
  assert.equal(host.shown.warning.filter(entry => entry.message.includes('Run in an isolated workspace copy?')).length, 1);
  assert.equal(await fs.readFile(path.join(root, 'check.js'), 'utf8'), 'console.log("offline fixture passed");\n');
});

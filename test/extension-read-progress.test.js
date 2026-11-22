const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { startHost, scriptedModel } = require('./helpers/host.cjs');
const baseUrl = process.env.AGENTEXTENSION_TEST_FORGE_URL;

test('repeated-read protection does not block an externally updated source', {
  skip: !baseUrl && 'Set AGENTEXTENSION_TEST_FORGE_URL to a local TrueForge instance.', timeout: 120_000,
}, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-fresh-read-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.txt'), 'old\n');
  const model = await scriptedModel(t, baseUrl, async ({ round, all, call, say }) => {
    if (round === 6) await fs.writeFile(path.join(root, 'a.txt'), 'fresh\n');
    if (round < 7) return call('read_file', { file: 'a.txt', start_line: 1, end_line: 1 });
    assert.match(all, /fresh/);
    assert.ok(!all.includes('Stop reading it.'));
    return say('The current source was read.');
  });
  const host = await startHost(t, { root, settings: { serverUrl: baseUrl, model: model.model, fallbackModel: '',
    turnTimeoutSeconds: 60, automaticSkills: false, skillRoots: [], pluginRoots: [], readConnectors: [], browserOrigins: [] } });
  await host.send({ type: 'run', prompt: 'Inspect the current file as it changes. Do not edit it.' });
  await host.waitFor(state => state.phase === 'done' && !state.runActive, 90_000, 'updated source read');
  assert.ifError(model.state.error);
});

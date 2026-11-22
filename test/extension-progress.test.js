const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { startHost, scriptedModel } = require('./helpers/host.cjs');
const baseUrl = process.env.AGENTEXTENSION_TEST_FORGE_URL;

test('real editor bridge records repeated reads without source text or arguments in its progress trace', {
  skip: !baseUrl && 'Set AGENTEXTENSION_TEST_FORGE_URL to a local TrueForge instance.',
  timeout: 120_000,
}, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-progress-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'private-source.txt'), 'PRIVATE_SOURCE_CONTENT\n');
  const model = await scriptedModel(t, baseUrl, async ({ round, call, say }) => {
    if (round < 4) return call('read_file', { file: 'private-source.txt', start_line: 1, end_line: 1 });
    return say('Read-only inspection finished.');
  });
  const host = await startHost(t, { root, settings: { serverUrl: baseUrl, model: model.model, fallbackModel: '',
    turnTimeoutSeconds: 60, automaticSkills: false, skillRoots: [], pluginRoots: [], readConnectors: [], browserOrigins: [] } });
  await host.send({ type: 'run', prompt: 'Inspect the supplied text without changing it.' });
  await host.waitFor(state => state.phase === 'done' && state.runActive === false && state.reportAvailable, 90_000, 'saved progress');
  assert.ifError(model.state.error);
  await host.send({ type: 'run-report' });
  const report = host.shown.documents.at(-1);
  const progress = JSON.parse(await fs.readFile(path.join(path.dirname(report), 'progress.json'), 'utf8'));
  assert.equal(progress.outcome, 'done');
  assert.equal(progress.repeatedReads, 2);
  assert.equal(progress.activeTools, 0);
  assert.equal(progress.diagnosis, 'repeated-read-inputs');
  assert.ok(progress.events.some(event => event.type === 'tool-end' && event.ok));
  assert.ok(!JSON.stringify(progress).includes('PRIVATE_SOURCE_CONTENT'));
  assert.ok(!JSON.stringify(progress).includes('private-source.txt'));
});

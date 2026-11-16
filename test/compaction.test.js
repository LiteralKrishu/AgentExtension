const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ContextManifest } = require('../src/prompt');
const { scriptedModel, startHost } = require('./helpers/host.cjs');

const baseUrl = process.env.AGENTEXTENSION_TEST_FORGE_URL;

test('source timing follows the latest completed compaction and the displayed source limit', () => {
  const manifest = new ContextManifest('/fixture');
  manifest.add('repository', 'first', 'input');
  assert.equal(manifest.compactionCounts(), undefined);
  assert.equal(manifest.entries[0].compactionTiming, undefined);
  manifest.markCompaction();
  manifest.add('tool result', 'second', 'result');
  assert.deepEqual(manifest.entries.map(entry => entry.compactionTiming), ['before', 'after']);
  assert.deepEqual(manifest.compactionCounts(), { before: 1, after: 1 });
  manifest.markCompaction();
  for (let index = 0; index < 159; index++) manifest.add('tool result', 'later', 'result');
  assert.deepEqual(manifest.compactionCounts(), { before: 1, after: 159 });
  assert.equal(manifest.entries[0].source, 'second');
  assert.equal(manifest.entries[0].compactionTiming, 'before');
});

test('a real TrueForge compaction exposes event metadata and marks recorded sources', {
  skip: !baseUrl && 'Set AGENTEXTENSION_TEST_FORGE_URL to a local TrueForge instance.', timeout: 25_000,
}, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-compaction-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await Promise.all([
    fs.writeFile(path.join(root, 'first.txt'), 'COMPACTION_FIXTURE_BEFORE\n'),
    fs.writeFile(path.join(root, 'second.txt'), 'COMPACTION_FIXTURE_AFTER\n'),
  ]);
  let requests = 0;
  let summaries = 0;
  const model = await scriptedModel(t, baseUrl, ({ input, all, call, say }) => {
    if (input.messages.at(-1)?.content?.includes('Your task is to create a detailed summary')) {
      summaries++;
      assert.ok(all.includes('COMPACTION_FIXTURE_BEFORE'), 'The compaction model received the first source.');
      return say('Fixture summary for the next model call.', 300);
    }
    requests++;
    if (requests === 1) return call('search_workspace', { query: 'COMPACTION_FIXTURE_BEFORE' }, 14_500);
    assert.ok(all.includes('Fixture summary for the next model call'), 'The next model call received the generated summary.');
    if (requests === 2) return call('read_file', { file: 'second.txt' }, 500);
    assert.ok(all.includes('COMPACTION_FIXTURE_AFTER'), 'The later model call received the second source.');
    return say('Checked both fixture sources.', 500);
  });
  const host = await startHost(t, { root, settings: { serverUrl: baseUrl, model: model.model,
    fallbackModel: '', compaction: true, turnTimeoutSeconds: 30 } });
  await host.send({ type: 'run', prompt: 'Check the two fixture sources.' });
  const state = await host.waitFor(state => ['done', 'error'].includes(state.phase) && !state.runActive, 16_000, 'compaction run');
  assert.ifError(model.state.error);
  assert.equal(state.phase, 'done', state.status);
  assert.equal(summaries, 1);
  assert.equal(state.manifest.find(entry => entry.source === 'search_workspace').compactionTiming, 'before');
  assert.equal(state.manifest.find(entry => entry.source === 'read_file').compactionTiming, 'after');
  assert.equal(state.usageDetail.compactions.length, 1);
  const [reported] = state.usageDetail.compactions;
  assert.equal(reported.threadId, 'main');
  assert.equal(reported.inputTokens, 300);
  assert.ok(reported.contextTokens >= reported.thresholdTokens);
  assert.ok(reported.durationMs >= 0);

  const session = new URL(state.session).pathname.split('/').at(-1);
  const endpoint = new URL(`/api/v1/sessions/${session}/events`, baseUrl);
  const response = await fetch(endpoint);
  assert.equal(response.status, 200);
  const { data } = await response.json();
  const events = data.map(({ event }) => event);
  const completed = events.find(event => event.type === 'thread.context_compaction_finished');
  assert.ok(completed, 'The public session API includes the completed compaction.');
  assert.deepEqual(Object.keys(completed).sort(), ['created_at', 'duration_ms', 'id', 'thread_id', 'trigger', 'type', 'usage']);
  assert.equal(completed.trigger.threshold_tokens, reported.thresholdTokens);
  const { TrueForge } = await import('@truefoundry/trueforge-sdk');
  const sdkEvents = await new TrueForge({ baseUrl }).sessions.listEvents(session);
  assert.equal(sdkEvents.data.find(({ event }) => event.id === completed.id).event.threadId, 'main');

  await host.send({ type: 'run-report' });
  const report = await fs.readFile(host.shown.documents.at(-1), 'utf8');
  assert.match(report, /Context compactions: 1/);
  assert.match(report, /Retained context sources are unavailable after compaction/);
  assert.match(report, /Latest main-thread compaction .*300 input and 25 output tokens/);
  assert.match(report, /\d+ recorded before this compaction · 1 recorded after/);
});

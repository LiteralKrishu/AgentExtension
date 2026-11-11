const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { startHost, scriptedModel } = require('./helpers/host.cjs');

const baseUrl = process.env.AGENTEXTENSION_TEST_FORGE_URL;
const live = { skip: !baseUrl && 'Set AGENTEXTENSION_TEST_FORGE_URL to a local TrueForge instance.', timeout: 150_000 };

test('a run tracks model tokens and tool calls, stops tools at its limit, and the audit export is redacted and verifiable', live, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-audit-ws-')));
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-audit-out-'));
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(out, { recursive: true, force: true })]));
  await fs.writeFile(path.join(root, 'a.txt'), 'alpha\n');
  const model = await scriptedModel(t, baseUrl, async ({ round, call, say, results }) => {
    if (round < 3) return call('read_file', { file: 'a.txt' });
    return say(`Last result: ${JSON.stringify(results.at(-1).content).slice(0, 200)}`);
  });
  const host = await startHost(t, { root, settings: { serverUrl: baseUrl, model: model.model, fallbackModel: '', compaction: true,
    turnTimeoutSeconds: 60, readConnectors: [], skillRoots: [], pluginRoots: [], browserOrigins: [], automaticSkills: false,
    runBudget: { maxTokens: 500_000, maxMinutes: 10, maxToolCalls: 2 } } });
  const published = host.states.length;
  await host.send({ type: 'run', prompt: 'Read a.txt three times.' });
  const done = await host.waitFor(state => host.states.length > published && state.phase === 'done' && state.runActive === false, 60_000, 'run end');
  assert.ifError(model.state.error);
  const third = model.state.requests.at(-1).all;
  assert.match(third, /Run budget reached: tool-call limit of 2\. Call review_changes for staged work, or finish with a summary\./);
  const providerTokens = model.state.usage.reduce((sum, item) => sum + item.total_tokens, 0);
  assert.equal(done.usageDetail.tokens.total, providerTokens, 'Totals match what the provider reported');
  assert.equal(done.usageDetail.toolCalls, 2);
  assert.ok(done.usageDetail.breakdown.harness > 0 && done.usageDetail.breakdown.messages > 0);
  assert.match(done.usage, new RegExp(`^${providerTokens.toLocaleString('en-US')} / 500,000 tokens · 2 / 2 tool calls · 0:\\d\\d / 10:00 · limit reached: tool-call limit of 2$`));
  await host.send({ type: 'run-report' });
  const report = await fs.readFile(host.shown.documents.at(-1), 'utf8');
  assert.match(report, new RegExp(`\\| Tokens \\(input \\+ output\\) \\| ${providerTokens.toLocaleString('en-US')} \\| 500,000 \\|`));
  // Export: all events, saved where the user chooses.
  const target = path.join(out, 'audit.json');
  host.answers.push({ kind: 'pick', value: items => items[0] }, { kind: 'save', value: { fsPath: target } });
  await host.send({ type: 'export-audit' });
  await host.waitFor(state => /^Exported \d+ audit events\. Chain verified across \d+ records\.$/.test(state.status ?? ''), 10_000, 'export');
  const data = JSON.parse(await fs.readFile(target, 'utf8'));
  assert.equal(data.format, 'agentextension-audit/1');
  assert.equal(data.verification.ok, true);
  assert.ok(data.events.some(event => event.tool === 'read_file' && event.decision === 'allow'));
  const summary = data.events.find(event => event.effect === 'run');
  assert.deepEqual([summary.decision, summary.usage.toolCalls, summary.usage.tokens], ['done', 2, providerTokens]);
  assert.doesNotMatch(JSON.stringify(data), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'No workspace path');
  assert.doesNotMatch(JSON.stringify(data), /alpha/, 'No file contents');
  assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
});

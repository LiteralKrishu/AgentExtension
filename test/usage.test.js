const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { RunUsage, usageSummary } = require('../src/usage');
const { AuditLog, redactReason } = require('../src/audit');
const { RunReport } = require('../src/reports');

const usage = (input, output, breakdown) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: 10, ...(breakdown ? { inputTokensBreakdown: breakdown } : {}) });

test('run usage adds parent, worker and compaction tokens and stops tools at a limit, except review', () => {
  let now = 0;
  const run = new RunUsage({ maxTokens: 1_000, maxMinutes: 2, maxToolCalls: 3 }, () => now);
  run.model(usage(300, 20, { harness: 100, instructions: 50, messages: 120, skills: 0, toolDefinitions: 30 }));
  run.model(usage(200, 30), 'worker:diff-review');
  run.compaction({ createdAt: 't', trigger: { type: 'input_tokens' }, durationMs: 5, usage: usage(100, 10) });
  const snapshot = run.snapshot();
  assert.deepEqual(snapshot.tokens, { input: 600, output: 60, cacheRead: 30, total: 660 });
  assert.deepEqual(Object.keys(snapshot.actors), ['parent', 'worker:diff-review', 'compaction']);
  assert.deepEqual(snapshot.breakdown, { harness: 100, instructions: 50, messages: 120, skills: 0, toolDefinitions: 30 });
  assert.equal(snapshot.compactions.length, 1);
  for (let index = 0; index < 3; index++) run.tool('read_file');
  assert.throws(() => run.tool('read_file'), /Run budget reached: tool-call limit of 3\. Call review_changes/);
  run.tool('review_changes');
  const tokens = new RunUsage({ maxTokens: 100 });
  tokens.model(usage(90, 20));
  assert.match(tokens.exceeded(), /token limit of 100/);
  assert.equal(tokens.hardStop(), '');
  tokens.model(usage(20, 0));
  assert.match(tokens.hardStop(), /130 tokens/);
  const time = new RunUsage({ maxMinutes: 1 }, () => now);
  now = 61_000;
  assert.match(time.exceeded(), /time limit of 1 minutes/);
  now = 76_000;
  assert.match(time.hardStop(), /minutes/);
  assert.equal(new RunUsage().exceeded(), '', 'Zero limits mean no limit');
  assert.equal(usageSummary(new RunUsage({ maxTokens: 1_000, maxToolCalls: 5, maxMinutes: 2 }, () => 0).snapshot()), '0 / 1,000 tokens · 0 / 5 tool calls · 0:00 / 2:00');
});

test('the audit log is hash-chained across rotation, detects tampering, and exports redacted events', async t => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-audit-'));
  t.after(() => fs.rm(storage, { recursive: true, force: true }));
  const log = new AuditLog(storage, '/Users/me/secret-project', { maxBytes: 2_500 });
  for (let index = 0; index < 12; index++) {
    await log.append({ time: new Date(Date.UTC(2026, 10, index + 1)).toISOString(), tool: 'run_command', effect: 'command.execute',
      target: 'a'.repeat(64), decision: 'approve', reason: index === 5 ? 'Allowed by user rule command.execute npm test' : 'One exact action', runId: 'r1' });
  }
  const records = await log.read();
  assert.equal(records.length, 12);
  assert.ok((await fs.stat(log.archive)).size > 0, 'The log rotated into one archive');
  assert.deepEqual(AuditLog.verify(records).ok, true);
  assert.equal(records.at(-1).seq, 12);
  const data = await log.export({ since: Date.UTC(2026, 10, 6) });
  assert.equal(data.verification.ok, true);
  assert.deepEqual(data.events.map(event => event.seq), [6, 7, 8, 9, 10, 11, 12]);
  assert.match(data.events[0].reason, /^Allowed by user rule command\.execute \[target [a-f0-9]{12}\]$/);
  assert.doesNotMatch(JSON.stringify(data), /secret-project|npm test/);
  assert.equal(redactReason('Prompt required by administrator rule connector.read crm/*; nobody can approve during a scheduled run'),
    `Prompt required by administrator rule connector.read [target ${require('../src/permissions').digest('crm/*').slice(0, 12)}]; nobody can approve during a scheduled run`);
  // Editing a stored record breaks verification.
  const text = await fs.readFile(log.file, 'utf8');
  await fs.writeFile(log.file, text.replace('"decision":"approve"', '"decision":"deny"'));
  const tampered = AuditLog.verify(await log.read());
  assert.equal(tampered.ok, false);
  assert.match(tampered.reason, /does not match its hash/);
});

test('run reports include a usage table with token sources and compactions', async t => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-usage-report-'));
  t.after(() => fs.rm(storage, { recursive: true, force: true }));
  const run = new RunUsage({ maxTokens: 5_000, maxToolCalls: 10 });
  run.model(usage(1_200, 40, { harness: 600, instructions: 200, messages: 300, skills: 50, toolDefinitions: 50 }));
  run.model(usage(300, 60), 'worker:test-diagnosis');
  run.tool('read_file');
  const file = await new RunReport(storage, '/w', '00000000-0000-4000-8000-000000000001').save({ phase: 'done', revision: 0, selection: '', usage: run.snapshot() });
  const text = await fs.readFile(file, 'utf8');
  assert.match(text, /\| Tokens \(input \+ output\) \| 1,600 \| 5,000 \|\n\| Tool calls \| 1 \| 10 \|/);
  assert.match(text, /- worker:test-diagnosis: 1 model calls · 300 input · 60 output tokens/);
  assert.match(text, /- Last parent input by source: harness 600 · instructions 200 · messages 300 · skills 50 · toolDefinitions 50/);
});

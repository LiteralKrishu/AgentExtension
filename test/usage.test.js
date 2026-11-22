const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { RunUsage, usageSummary, costSummary } = require('../src/usage');
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

test('model budget notices are bounded, reflect aggregate use, and keep the same enforced limits', () => {
  let now=0;
  const run=new RunUsage({maxTokens:1000,maxMinutes:2,maxToolCalls:4},()=>now);
  assert.equal(run.notice(),undefined);
  run.model(usage(500,0),'worker:test');
  assert.deepEqual(run.notice(),{stage:'half-used',remainingTokens:500,remainingToolCalls:4,remainingSeconds:120,
    note:'Use the remaining budget to finish the requested changes, run required checks, and request review. Keep edits small. Do not claim an omitted check passed.'});
  assert.equal(run.notice(),undefined);
  now=90000;
  assert.equal(run.notice().stage,'finish-soon');assert.equal(run.notice(),undefined);
  now=108000;assert.equal(run.notice().remainingSeconds,12);
  for(let n=0;n<4;n++)run.tool('read_file');
  const reached=run.notice();assert.equal(reached.stage,'review-only');assert.equal(reached.remainingToolCalls,0);
  assert.throws(()=>run.tool('read_file'),/budget reached/);run.tool('review_changes');
  assert.equal(run.notice(),undefined);assert.deepEqual(run.limits,{maxTokens:1000,maxMinutes:2,maxToolCalls:4});
  assert.equal(new RunUsage().notice(),undefined);
});

test('interactive prompts state host budgets without granting additional authority', () => {
  const {composePrompt,ContextManifest}=require('../src/prompt');
  const prompt=composePrompt({request:'Fix the bug.',assembled:{selected:[],text:''},manifest:new ContextManifest(),
    budget:{maxTokens:200000,maxMinutes:6,maxToolCalls:48}});
  assert.match(prompt,/RUN BUDGET \(host limits/);assert.match(prompt,/"maxTokens":200000/);
  assert.match(prompt,/cannot grant tools or change approval requirements/);
});

test('version and help probes do not count as project verification',()=>{
 const {diagnosticCommand}=require('../src/workspace');
 for(const[command,args]of [['node',['-v']],['python3',['-V']],['pytest',['--help']],['python3',['-m','pytest','--help']],['python',[]],
  ['pytest',['tests/test_cli.py','--help']],['node',['--help','calc.test.js']],['npm',['test','--','--help']],
  ['node',['-v','missing-project-test.js']],['python3',['-V','test_task.py']],['npm',['-v','test']]])assert.equal(diagnosticCommand(command,args),true);
 for(const[command,args]of [['node',['--test','a.test.js']],['python3',['-m','pytest','tests']],['python3',['-v','check.py']],['node',['calc.test.js','-v']],['pytest',[]]])assert.equal(diagnosticCommand(command,args),false);
 const probe=require('node:child_process').spawnSync(process.execPath,['-v','missing-project-test.js'],{encoding:'utf8'});
 assert.equal(probe.status,0,probe.stderr);assert.equal(probe.stdout.trim(),process.version);
});

test('reported turn costs preserve zero and mark a partial estimate without counting compaction twice', () => {
  const run = new RunUsage();
  assert.equal(costSummary(run.snapshot().cost), 'Unreported');
  run.turnCost({ totalCostInUsd: 0 });
  assert.equal(costSummary(run.snapshot().cost), 'USD 0.00');
  run.compaction({ usage: { ...usage(10, 2), costInUsd: 0.125 } });
  run.turnCost({ totalCostInUsd: 0.5 });
  run.turnCost({ totalCostInUsd: 0.125 });
  run.turnCost();
  assert.deepEqual(run.snapshot().cost, { usd: 0.625, unreportedTurns: 1 });
  assert.equal(costSummary(run.snapshot().cost), 'USD 0.625 (some turns unreported)');
});

test('run reports include a usage table with token sources and compactions', async t => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-usage-report-'));
  t.after(() => fs.rm(storage, { recursive: true, force: true }));
  const run = new RunUsage({ maxTokens: 5_000, maxToolCalls: 10 });
  run.model(usage(1_200, 40, { harness: 600, instructions: 200, messages: 300, skills: 50, toolDefinitions: 50 }));
  run.model(usage(300, 60), 'worker:test-diagnosis');
  run.turnCost({ totalCostInUsd: 0.015 });
  run.compaction({ createdAt: 't', trigger: { type: 'input_tokens' }, durationMs: 5 });
  run.tool('read_file');
  const file = await new RunReport(storage, '/w', '00000000-0000-4000-8000-000000000001').save({ phase: 'done', revision: 0, selection: '', usage: run.snapshot() });
  const text = await fs.readFile(file, 'utf8');
  assert.match(text, /\| Tokens \(input \+ output\) \| 1,600 \| 5,000 \|\n\| Tool calls \| 1 \| 10 \|/);
  assert.match(text, /- worker:test-diagnosis: 1 model calls · 300 input · 60 output tokens/);
  assert.match(text, /- Last parent input by source: harness 600 · instructions 200 · messages 300 · skills 50 · toolDefinitions 50/);
  assert.match(text, /\| Estimated cost \| USD 0\.015 \|/);
  assert.match(text, /Retained context sources are unavailable after compaction/);
});

test('a damaged audit tail is preserved and cannot reset the next sequence number',async t=>{
 const storage=await fs.mkdtemp(path.join(os.tmpdir(),'agentextension-audit-tail-'));t.after(()=>fs.rm(storage,{recursive:true,force:true}));
 const log=new AuditLog(storage,'/fixture');await log.append({tool:'read_file',effect:'workspace.read',target:'a'.repeat(64),decision:'allow',reason:'Workspace run scope',runId:'fixture'});
 const valid=await fs.readFile(log.file,'utf8');
 for(const tail of ['{"seq":','null\n','false\n']){
  const before=valid+tail;await fs.writeFile(log.file,before);
  await assert.rejects(log.append({tool:'read_file'}),/tail failed verification/);assert.equal(await fs.readFile(log.file,'utf8'),before);assert.equal((await log.export()).verification.ok,false);
 }
});

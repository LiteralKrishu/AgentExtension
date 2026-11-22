const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Draft } = require('../src/draft');
const { taskBrief, resetForRetry } = require('../src/task-state');

test('retry preserves staged text while discarding old approvals and checks', async () => {
  const read = async () => 'one\ntwo\n';
  let resets = 0;
  const run = { taskRequest: 'Change one and preserve two.', draft: new Draft(read), reviewGrant: {}, approvedPlan: {},
    checks: [{ exitCode: 0 }], instructions: { delivered: new Set(['rule.md']) },
    resetDraft() { this.draft = new Draft(read); this.reviewGrant = undefined; this.approvedPlan = undefined; resets++; } };
  await run.draft.replace('a.txt', 'one', 'ONE');
  assert.equal(resetForRetry(run), true);
  assert.equal(resets, 1);
  assert.equal(run.draft.current('a.txt', await read()), 'ONE\ntwo\n');
  assert.equal(run.reviewGrant, undefined);
  assert.equal(run.approvedPlan, undefined);
  assert.deepEqual(run.checks, []);
  assert.equal(run.instructions.delivered.size, 0);
  assert.match(run.recoveryBrief, /Change one and preserve two/);
  assert.match(run.recoveryBrief, /a.txt/);
  assert.ok(!run.recoveryBrief.includes('ONE\ntwo'));
});

test('context brief restates approved task facts without claiming retained runtime sources', () => {
  const run = { taskRequest: 'Keep public behavior.', readOnly: true, approvedPlan: { goal: 'Inspect' },
    instructions: { user: { text: 'Use short sentences.' }, profiles: [{ file: 'AGENTS.md', text: 'Keep tests.' }] },
    skills: { selected: new Map([['s', { id: 's', name: 'workflow', body: 'Check the input.' }]]) } };
  const text = taskBrief(run);
  assert.match(text, /Keep public behavior/);
  assert.match(text, /Use short sentences/);
  assert.match(text, /Keep tests/);
  assert.match(text, /Check the input/);
  assert.match(text, /read-only/);
  assert.match(text, /Unavailable from the runtime/);
});

test('a retry without staged changes keeps the normal reset path', () => {
  let count = 0;
  const run = { draft: { files: new Map() }, resetDraft() { count++; } };
  assert.equal(resetForRetry(run), false);
  assert.equal(count, 1);
  assert.equal(run.recoveryBrief, undefined);
});

test('previous plan constraints remain reference text without reusing plan authority', () => {
  const run = { taskRequest: 'Keep public behavior.', approvedPlan: { goal: 'Preserve error messages', checks: ['Check invalid input'] },
    resetDraft() { this.approvedPlan = undefined; } };
  assert.equal(resetForRetry(run), false);
  assert.equal(run.approvedPlan, undefined);
  assert.match(run.recoveryBrief, /Check invalid input/);
  assert.match(run.recoveryBrief, /fresh approval is required/);
});

test('retry and compaction context retain the current aggregate host budget',()=>{
 const {RunUsage}=require('../src/usage');let now=0;
 const usage=new RunUsage({maxTokens:1000,maxMinutes:2,maxToolCalls:10},()=>now);
 usage.model({inputTokens:400,outputTokens:50},'worker:research');usage.tool('read_file');now=15000;
 const text=taskBrief({taskRequest:'Finish the current task.',usage});
 const data=JSON.parse(text.split('\n').at(-1));
 assert.deepEqual(data.runBudget,{limits:{maxTokens:1000,maxMinutes:2,maxToolCalls:10},usedTokens:450,usedToolCalls:1,elapsedMs:15000});
 assert.equal(usage.total,450);assert.equal(usage.toolCalls,1);
});

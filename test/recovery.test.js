const assert = require('node:assert/strict');
const { test } = require('node:test');
const { RecoveryGuard, stopNoProgress, taskEvidence } = require('../src/recovery');
const { digest } = require('../src/permissions');

test('repeated invalid edits and identical failing check inputs have bounded ends', () => {
  const guard = new RecoveryGuard();
  const input = { file: 'a.txt', old_text: 'missing', new_text: 'next' };
  for (let n = 0; n < 5; n++) assert.equal(guard.editFailure('propose_write', input, 1), false);
  assert.equal(guard.editFailure('propose_write', input, 1), true);
  assert.equal(guard.editFailure('propose_write', input, 2), false);
  for (let n = 0; n < 10; n++) assert.equal(guard.editFailure('read_file', {}, 0), false);
  const check = { command: 'node', args: ['--test'] };
  const bad = { exitCode: 1, inputDigest: 'source-a' };
  assert.equal(guard.check(check, bad), false);
  assert.equal(guard.check(check, bad), false);
  assert.equal(guard.check(check, { ...bad, inputDigest: 'source-b' }), false);
  assert.equal(guard.check(check, bad), true);
  assert.equal(guard.check(check, { exitCode: 0 }), false);
  assert.equal(guard.check(check, bad), false);
  for (let n = 0; n < 10; n++) assert.equal(guard.check(check, { exitCode: null }), false);
  const run = { controller: new AbortController() };
  stopNoProgress(run, 'bounded end');
  assert.equal(run.controller.signal.aborted, true);
  assert.equal(run.revocationReason, 'bounded end');
});

test('task evidence distinguishes report work, missing review, stale scope, repair and successful recheck', () => {
  const run = { readOnly: true };
  assert.deepEqual(taskEvidence(run, 'done').unresolved, []);
  assert.equal(taskEvidence(run, 'done').mode, 'read-only');
  run.readOnly = false;
  run.draft = { revision: 2, files: new Map([['a.txt', {}]]) };
  run.approvedPlan = { checks: ['Test the public behavior'] };
  assert.deepEqual(taskEvidence(run, 'done').unresolved, ['draft-needs-review', 'draft-has-no-current-check']);
  run.reviewed = { revision: 2, hunks: [{ id: 'accepted' }] };
  const check = { command: 'node', args: ['--test'], exitCode: 0, revision: 2, selection: digest(['all']) };
  run.checks = [check];
  assert.deepEqual(taskEvidence(run, 'ready').unresolved, ['draft-has-no-current-check']);
  const current = { ...check, exitCode: 1, selection: digest(['accepted']) };
  run.checks.push(current);
  assert.deepEqual(taskEvidence(run, 'ready').unresolved, ['current-check-not-passed']);
  run.checks.push({ ...current, exitCode: 0 });
  assert.deepEqual(taskEvidence(run, 'ready').unresolved, []);
  assert.equal(taskEvidence(run, 'ready').status, 'ready-to-apply');
  assert.equal(taskEvidence(run, 'ready').declaredChecks.length, 1);
  run.draft.revision++;
  assert.deepEqual(taskEvidence(run, 'ready').unresolved, ['draft-needs-review', 'draft-has-no-current-check']);
  assert.equal(taskEvidence(run, 'cancelled').status, 'interrupted');
});

test('a diagnostic command cannot reset an unchanged failing-check loop',()=>{
 const guard=new RecoveryGuard();const input={command:'node',args:['--test']};const failed={exitCode:1,inputDigest:'unchanged'};
 assert.equal(guard.check(input,failed),false);assert.equal(guard.check(input,failed),false);
 assert.equal(guard.check({command:'node',args:['--version']},{exitCode:0,verification:false,inputDigest:'unchanged'}),false);
 assert.equal(guard.check(input,failed),true);
});

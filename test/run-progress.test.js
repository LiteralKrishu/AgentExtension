const assert = require('node:assert/strict');
const { test } = require('node:test');
const { failureCategory } = require('../src/run-progress');
const { RunProgress } = require('../src/run-progress');

test('progress separates a long active tool from a wait for user input', async () => {
  let now = 0;
  const progress = new RunProgress({ now: () => now });
  const done = progress.tool('run_command', { command: 'private-value' });
  now = 1000;
  assert.equal(progress.snapshot().state, 'checking');
  assert.equal(progress.snapshot().activeMs, 1000);
  await progress.waitFor('approval', async () => {
    now = 1500;
    assert.equal(progress.snapshot().state, 'waiting-for-user');
  });
  done(true, 1);
  assert.equal(progress.snapshot().waitingMs, 500);
  assert.equal(progress.snapshot().activeMs, 1000);
  assert.ok(!JSON.stringify(progress.snapshot()).includes('private-value'));
});

test('overlapping waits count their union and always close after rejection', async () => {
  let now = 0;
  const progress = new RunProgress({ now: () => now });
  await assert.rejects(progress.waitFor('approval', async () => {
    now = 100;
    await progress.waitFor('question', async () => { now = 200; });
    now = 300;
    throw new Error('denied');
  }));
  assert.equal(progress.snapshot().waitingMs, 300);
  assert.equal(progress.snapshot().activeMs, 0);
  assert.notEqual(progress.snapshot().state, 'waiting-for-user');
});

test('replay distinguishes repeated reads, tool rejection, and changed draft progress', () => {
  let now = 0;
  const progress = new RunProgress({ now: () => now });
  for (let i = 0; i < 4; i++) { const done = progress.tool('read_file', { file: 'secret-source.js' }); now += 10; done(true); }
  assert.equal(progress.snapshot().repeatedReads, 2);
  assert.equal(progress.snapshot().diagnosis, 'repeated-read-inputs');
  const edit = progress.tool('propose_write');
  now += 10; edit(false);
  assert.equal(progress.snapshot().rejectedTools, 1);
  const valid = progress.tool('propose_write');
  now += 10; valid(true, 1);
  const read = progress.tool('read_file', { file: 'secret-source.js' }); now += 10; read(true);
  assert.equal(progress.snapshot().repeatedReads, 2);
  assert.ok(!JSON.stringify(progress.snapshot()).includes('secret-source.js'));
});

test('progress retention, completion timing, and duplicate callbacks are bounded', () => {
  let now = 0;
  const progress = new RunProgress({ now: () => now, limit: 4 });
  for (let i = 0; i < 10; i++) { const done = progress.tool('read_file', { line: i }); done(true); done(false); }
  assert.equal(progress.snapshot().activeTools, 0);
  assert.equal(progress.snapshot().rejectedTools, 0);
  assert.equal(progress.snapshot().events.length, 4);
  now = 50; progress.check(true, 1); progress.retry(); progress.finish('ready');
  now = 500;
  assert.equal(progress.snapshot().elapsedMs, 50);
  assert.equal(progress.snapshot().retries, 1);
});

test('check launch errors, test failures and model request counts remain distinct', () => {
  const progress = new RunProgress();
  progress.check(false, 1, true);
  assert.equal(progress.snapshot().diagnosis, 'check-could-not-run');
  progress.check(false, 1);
  assert.equal(progress.snapshot().diagnosis, 'check-failed');
  progress.check(true, 1);
  assert.equal(progress.snapshot().diagnosis, 'check-passed');
  progress.modelTool('PRIVATE_ARGUMENT_BODY');
  assert.equal(progress.snapshot().modelToolCalls, 1);
  assert.ok(!JSON.stringify(progress.snapshot()).includes('PRIVATE_ARGUMENT_BODY'));
  progress.check(true,1,false,true);
  assert.equal(progress.snapshot().diagnosis,'check-diagnostic-only');
});
test('observed error classes stay separate from unsupported context explanations', () => {
  for (const [message, category] of [
    ['a.txt changed since the draft was staged.', 'edit-conflict'],
    ['Invalid input schema.', 'model-tool-format'],
    ['The current draft has not been approved.', 'missing-review'],
    ['The endpoint did not respond.', 'runtime-transport'],
    ['The workspace snapshot is too large.', 'environment-failure'],
    ['The model read many different files.', 'unknown'],
    ['A search result was unhelpful.', 'unknown'],
  ]) assert.equal(failureCategory(new Error(message)), category);
});

test('first non-empty draft timing survives trace retention and remains separate from review',()=>{
 let now=0;const progress=new RunProgress({now:()=>now,limit:2});
 now=10;progress.draft(1,false);assert.equal(progress.snapshot().firstDraftMs,undefined);
 now=20;progress.draft(2,true);now=30;progress.draft(3,true);
 for(let i=0;i<5;i++)progress.record('other');
 assert.equal(progress.snapshot().firstDraftMs,20);assert.equal(progress.snapshot().events.length,2);
});

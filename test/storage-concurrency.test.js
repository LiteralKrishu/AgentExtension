const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { CheckpointStore } = require('../src/checkpoint');
const { AuditLog } = require('../src/audit');
async function area(t) {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-storage-'));
  t.after(() => fs.rm(storage, { recursive: true, force: true })); return storage;
}
async function writer(t, storage) {
  const child = fork(path.join(__dirname, 'fixtures/storage-writer.cjs'), [storage], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let errors = ''; child.stderr.on('data', data => { errors += data; });
  await once(child, 'message');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const closed = once(child, 'exit'); child.kill('SIGKILL'); await closed; } });
  let sequence = 0;
  const request = message => new Promise((resolve, reject) => {
    const id = ++sequence;
    const done = reply => {
      if (reply.id !== id) return;
      child.off('message', done); child.off('exit', exited);
      if (reply.error) reject(Object.assign(new Error(reply.error), { code: reply.code })); else resolve(reply.value);
    };
    const exited = () => { child.off('message', done); reject(new Error(`Storage writer exited: ${errors}`)); };
    child.on('message', done); child.once('exit', exited); child.send({ ...message, id });
  });
  return { child, request };
}
const state = name => ({ runId: name, request: name, files: [], phase: 'running' });

test('independent processes cannot overwrite, clear or resurrect another run checkpoint', { timeout: 15000 }, async t => {
  const storage = await area(t), first = await writer(t, storage), second = await writer(t, storage);
  const outcomes = await Promise.allSettled([first.request({ op: 'save', state: state('first') }), second.request({ op: 'save', state: state('second') })]);
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  const winner = outcomes[0].status === 'fulfilled' ? first : second, loser = winner === first ? second : first;
  const saved = await winner.request({ op: 'load' });
  assert.equal(await loser.request({ op: 'clear' }), false);
  const resumed = await loser.request({ op: 'save', state: state('resumed'), options: { expected: saved } });
  assert.notEqual(resumed.checkpointId, saved.checkpointId);
  await assert.rejects(winner.request({ op: 'save', state: state('late old draft') }), { code: 'ECHECKPOINTOWNERSHIP' });
  assert.equal(await winner.request({ op: 'clear' }), false);
  assert.equal(await winner.request({ op: 'clear', expected: saved }), false);
  assert.equal((await winner.request({ op: 'load' })).request, 'resumed');
  assert.equal(await loser.request({ op: 'clear' }), true);
  await assert.rejects(winner.request({ op: 'save', state: state('resurrected') }), { code: 'ECHECKPOINTOWNERSHIP' });
  assert.equal(await new CheckpointStore(storage, '/fixture').load(), undefined);
});

test('cross-process audit append, rotation and export keep one contiguous hash chain', { timeout: 15000 }, async t => {
  const storage = await area(t), workers = await Promise.all(Array.from({ length: 3 }, () => writer(t, storage)));
  const log = new AuditLog(storage, '/fixture');
  await Promise.all(workers.map(worker => worker.request({ op: 'audit', count: 12, maxBytes: 1000000 })));
  const rows = await log.read(); assert.equal(rows.length, 36); assert.deepEqual(rows.map(row => row.seq), Array.from({ length: 36 }, (_, index) => index + 1));
  assert.equal(AuditLog.verify(rows).ok, true);
  const writing = Promise.all(workers.map(worker => worker.request({ op: 'audit', count: 12, maxBytes: 5000 })));
  for (let i = 0; i < 8; i++) assert.equal((await log.export()).verification.ok, true);
  await writing; const rotated = await log.read(); assert.equal(AuditLog.verify(rotated).ok, true); assert.equal(rotated.at(-1).seq, 72);
  assert.ok(rotated.length < 72); assert.equal(new Set(rotated.map(row => row.seq)).size, rotated.length);
});

test('a crashed writer lock can be recovered after its stale interval', { timeout: 20000 }, async t => {
  const storage = await area(t), worker = await writer(t, storage);
  const held = once(worker.child, 'message'); worker.child.send({ id: 'hold', op: 'hold' }); await held;
  const exited = once(worker.child, 'exit'); worker.child.kill('SIGKILL'); await exited;
  const store = new CheckpointStore(storage, '/fixture');
  const saved = await store.save(state('recovered')); assert.equal((await store.load()).checkpointId, saved.checkpointId);
});

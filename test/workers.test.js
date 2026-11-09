const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Draft } = require('../src/draft');
const { PermissionBroker } = require('../src/permissions');
const { WorkerPool, snapshotFor, parseReport } = require('../src/workers');

function fixture(invoke, options = {}) {
  const controller = new AbortController();
  const disk = new Map([['one.js', 'const one = 1;\n'], ['two.js', 'const two = 2;\n']]);
  const run = { signal: controller.signal, workspace: { read: async file => {
    if (!disk.has(file)) throw new Error('File missing');
    return disk.get(file);
  } }, search: async () => [{ file: 'one.js', line: 1 }], privateMemory: 'must not be inherited' };
  run.permissions = new PermissionBroker({ workspace: '/workspace', signal: controller.signal });
  run.permissions.allowScope('worker.research'); run.permissions.allowScope('worker.review');
  run.draft = new Draft(run.workspace.read);
  const pool = new WorkerPool({ run, settings: { serverUrl: 'http://127.0.0.1:8790', model: 'fixture' },
    roles: ['repository-research', 'diff-review'], invoke, ...options });
  return { run, controller, disk, pool };
}
const input = { question: 'Check the implementation', files: ['one.js'] };
const report = { summary: 'Check the default value', findings: [{ file: 'one.js', line: 1, severity: 'warning', message: 'Confirm this default.' }] };

test('workers receive bounded snapshots, no inherited grants, and return advisory findings without editing', async () => {
  let received;
  const f = fixture(async (_, task) => { received = task; return JSON.stringify(report); });
  try {
    await f.run.draft.replace('one.js', '1', '3');
    const result = await f.pool.execute('diff-review', input);
    assert.equal(result.advisoryOnly, true);
    assert.equal(result.stale, false);
    assert.equal(received.sources[0].after, 'const one = 3;\n');
    assert.ok(JSON.stringify(received).length < 16_200);
    assert.equal(JSON.stringify(received).includes('must not be inherited'), false);
    for (const field of ['permissions', 'memory', 'credentials', 'tools', 'history']) assert.equal(received[field], undefined);
    assert.equal(f.disk.get('one.js'), 'const one = 1;\n');
    assert.equal(f.run.draft.revision, 1);
    assert.equal(f.run.reviewed, undefined);
  } finally { await f.pool.close(); }
});

test('unknown roles, ungranted workers, private paths and invalid reports fail closed', async () => {
  const f = fixture(async () => '{}');
  try {
    assert.throws(() => f.pool.execute('write-code', input), /not enabled/);
    f.run.permissions.deny('worker.research');
    assert.throws(() => f.pool.execute('repository-research', input), /Permission denied/);
    await assert.rejects(snapshotFor(f.run, 'repository-research', { ...input, files: ['../outside'] }));
    const snapshot = await snapshotFor(f.run, 'repository-research', input);
    assert.throws(() => parseReport(JSON.stringify({ ...report, edits: [{ file: 'one.js' }] }), snapshot), /invalid report/);
    assert.throws(() => parseReport(JSON.stringify({ ...report, findings: [{ ...report.findings[0], file: 'outside' }] }), snapshot), /outside/);
    assert.throws(() => parseReport('x'.repeat(8001), snapshot), /limit/);
  } finally { await f.pool.close(); }
});

test('two concurrent workers are bounded and parent cancellation reaches both', async () => {
  let cancelled = 0;
  const f = fixture(async (_, task, signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { cancelled++; reject(signal.reason); }, { once: true });
  }));
  const first = f.pool.execute('repository-research', input);
  const second = f.pool.execute('repository-research', input);
  const results = Promise.allSettled([first, second]);
  assert.throws(() => f.pool.execute('repository-research', input), /two concurrent/);
  await new Promise(resolve => setImmediate(resolve));
  f.controller.abort();
  assert.ok((await results).every(result => result.status === 'rejected'));
  assert.equal(cancelled, 2);
  assert.ok(f.pool.reports.every(row => row.state === 'cancelled'));
  await f.pool.close();
});

test('four-call limit survives retry and timeouts close worker requests', async () => {
  const f = fixture(async () => JSON.stringify(report));
  try {
    for (let i = 0; i < 4; i++) await f.pool.execute('repository-research', input);
    f.pool.cancelAll('Retry');
    assert.throws(() => f.pool.execute('repository-research', input), /four calls/);
  } finally { await f.pool.close(); }
  const timed = fixture(async (_, task, signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }), { timeoutMs: 15 });
  await assert.rejects(timed.pool.execute('repository-research', input), /timed out/);
  await timed.pool.close();
});

test('changed drafts and accepted selections mark diff reports stale', async () => {
  let release;
  const f = fixture(async () => new Promise(resolve => { release = () => resolve(JSON.stringify(report)); }));
  try {
    await f.run.draft.replace('one.js', '1', '3');
    const pending = f.pool.execute('diff-review', input);
    await new Promise(resolve => setImmediate(resolve));
    await f.run.draft.replace('one.js', '3', '4');
    release();
    assert.equal((await pending).stale, true);
    f.pool.invoke = async () => JSON.stringify(report);
    await f.pool.execute('diff-review', input);
    f.run.reviewed = { revision: f.run.draft.revision, hunks: [] };
    f.pool.invalidateDraft();
    assert.equal(f.pool.reports.at(-1).state, 'stale');
    assert.equal(f.disk.get('one.js'), 'const one = 1;\n');
  } finally { await f.pool.close(); }
});

test('conflicting worker advice cannot merge changes or bypass parent review', async () => {
  const f = fixture(async (_, task) => JSON.stringify({ summary: task.question, findings: [] }));
  try {
    await f.run.draft.replace('one.js', '1', '3');
    await Promise.all([f.pool.execute('diff-review', { ...input, question: 'Use 4 instead' }),
      f.pool.execute('diff-review', { ...input, question: 'Use 5 instead' })]);
    assert.equal(f.run.draft.current('one.js'), 'const one = 3;\n');
    assert.equal(f.disk.get('one.js'), 'const one = 1;\n');
    assert.equal(f.run.reviewed, undefined);
    assert.equal(f.run.reviewGrant, undefined);
  } finally { await f.pool.close(); }
});

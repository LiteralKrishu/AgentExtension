const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Draft } = require('../src/draft');
const { PermissionBroker } = require('../src/permissions');
const { WorkerPool, snapshotFor, parseReport, localImports } = require('../src/workers');

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
    // Unsupported citations are dropped and counted rather than passed to the parent.
    const mixed = parseReport(JSON.stringify({ ...report, findings: [report.findings[0], { ...report.findings[0], file: 'outside' }, { ...report.findings[0], line: 99 }] }), snapshot);
    assert.deepEqual(mixed.findings, report.findings);
    assert.equal(mixed.dropped_findings, 2);
    const none = parseReport(JSON.stringify({ ...report, findings: [{ ...report.findings[0], file: 'outside' }] }), snapshot);
    assert.deepEqual(none.findings, []);
    assert.match(none.note, /unverified/);
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
  const third = f.pool.execute('repository-research', input);
  const fourth = f.pool.execute('repository-research', input);
  third.catch(() => {}); fourth.catch(() => {});
  assert.equal(f.pool.reports.filter(row => row.state === 'queued').length, 2);
  assert.throws(() => f.pool.execute('repository-research', input), /four calls/);
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

const { instructionsFor, WORKER_INSTRUCTIONS, EDIT_INSTRUCTIONS } = require('../src/worker-session');
const { loadPlugin } = require('../src/plugins');

function roleFixture(invoke, extra = {}) {
  const controller = new AbortController();
  const disk = new Map([['calc.js', 'export const add = (a, b) => a - b;\nexport const sub = (a, b) => a - b;\nexport const mul = (a, b) => a * b;\n'],
    ['calc.test.js', 'assert.equal(add(1, 2), 3);\n']]);
  const run = { signal: controller.signal, workspace: { read: async file => { if (!disk.has(file)) throw new Error('File missing'); return disk.get(file); } },
    search: async () => [] };
  run.permissions = new PermissionBroker({ workspace: '/workspace', signal: controller.signal });
  for (const effect of ['worker.diagnose', 'worker.edit', 'worker.custom', 'draft.edit']) run.permissions.allowScope(effect);
  run.draft = new Draft(run.workspace.read);
  const calls = [];
  const pool = new WorkerPool({ run, settings: { serverUrl: 'http://127.0.0.1:8790', model: 'fixture' }, roles: ['test-diagnosis', 'edit-proposal'],
    invoke: async (settings, task, signal, onSession, role) => { calls.push({ task, role }); return invoke(task, role); }, ...extra });
  return { run, disk, pool, calls, controller };
}

test('test diagnosis receives the failed check and the files its output cites', async () => {
  const f = roleFixture(task => JSON.stringify({ summary: 'add subtracts', findings: [{ file: 'calc.js', line: 1, severity: 'error', message: 'Uses minus.' }] }));
  try {
    await assert.rejects(f.pool.execute('test-diagnosis', { question: 'Why?' }), /No failed check/);
    f.run.checks = [{ command: 'node', args: ['--test'], exitCode: 0, output: 'ok' },
      { command: 'node', args: ['--test'], exitCode: 1, revision: 0, scope: 'All staged hunks', output: `${'noise\n'.repeat(2_000)}AssertionError at ./calc.test.js:1\n    at add (calc.js:1:30)\n    at /usr/lib/node.js:5` }];
    const result = await f.pool.execute('test-diagnosis', { question: 'Why did the test fail?' });
    const { task, role } = f.calls[0];
    assert.equal(task.check.exitCode, 1);
    assert.ok(task.check.output.length <= 4_000);
    assert.deepEqual(task.sources.map(source => source.file), ['calc.test.js', 'calc.js']);
    assert.equal(role.role, 'test-diagnosis');
    assert.equal(result.findings[0].file, 'calc.js');
    assert.equal(f.run.draft.revision, 0);
    assert.equal(instructionsFor(role), WORKER_INSTRUCTIONS + instructionsFor(role).slice(WORKER_INSTRUCTIONS.length));
    assert.match(instructionsFor(role), /failed check/);
  } finally { await f.pool.close(); }
});

test('edit proposals live in a separate draft and merge only onto the same base revision without overlap', async () => {
  let edits = [{ file: 'calc.js', old_text: 'export const add = (a, b) => a - b;', new_text: 'export const add = (a, b) => a + b;' }];
  const f = roleFixture(() => JSON.stringify({ summary: 'Fix add', edits }));
  try {
    assert.throws(() => f.pool.execute('edit-proposal', { question: 'Fix add' }), /Name the files/);
    const proposal = await f.pool.execute('edit-proposal', { question: 'Fix add', files: ['calc.js'] });
    assert.equal(f.calls[0].role.output, 'edits');
    assert.equal(instructionsFor(f.calls[0].role), EDIT_INSTRUCTIONS);
    assert.deepEqual(proposal.proposed_hunks, [{ file: 'calc.js', line: 1, before: 'export const add = (a, b) => a - b;\n', after: 'export const add = (a, b) => a + b;\n' }]);
    assert.equal(f.run.draft.revision, 0, 'The parent draft is untouched until merge');
    assert.equal(f.pool.reports.at(-1).state, 'proposed');
    const merged = await f.pool.merge(proposal.id);
    assert.deepEqual([merged.merged, merged.revision], [1, 1]);
    assert.match(f.run.draft.current('calc.js'), /a \+ b;\nexport const sub/);
    assert.equal(f.disk.get('calc.js').includes('a - b;\nexport const sub'), true, 'Disk is unchanged');
    await assert.rejects(f.pool.merge(proposal.id), /already merged/);
    await assert.rejects(f.pool.merge('00000000-0000-4000-8000-000000000000'), /No worker proposal/);

    // Stale: the parent changed the draft after the worker started.
    edits = [{ file: 'calc.js', old_text: 'export const mul = (a, b) => a * b;', new_text: 'export const mul = (a, b) => b * a;' }];
    const stale = await f.pool.execute('edit-proposal', { question: 'Swap', files: ['calc.js'] });
    await f.run.draft.replace('calc.js', 'const sub', 'const subtract');
    f.pool.invalidateDraft();
    assert.equal(f.pool.reports.at(-1).state, 'stale');
    await assert.rejects(f.pool.merge(stale.id), /Stale proposal: the draft changed/);
    assert.equal(f.pool.reports.at(-1).state, 'rejected');

    // Overlap: the worker edits text the parent already changed.
    edits = [{ file: 'calc.js', old_text: 'export const subtract = (a, b) => a - b;', new_text: 'export const subtract = (a, b) => a - b; // checked' }];
    const overlapping = await f.pool.execute('edit-proposal', { question: 'Comment', files: ['calc.js'] });
    const before = f.run.draft.revision;
    await assert.rejects(f.pool.merge(overlapping.id), /Overlapping proposal/);
    assert.equal(f.run.draft.revision, before);
    // A non-overlapping edit on the same base merges.
    edits = [{ file: 'calc.js', old_text: 'export const mul = (a, b) => a * b;', new_text: 'export const mul = (a, b) => b * a;' }];
    const separate = await f.pool.execute('edit-proposal', { question: 'Swap', files: ['calc.js'] });
    await f.pool.merge(separate.id);
    assert.match(f.run.draft.current('calc.js'), /subtract = \(a, b\) => a - b;\nexport const mul = \(a, b\) => b \* a;/);
    assert.equal(f.run.reviewed, undefined, 'Merging does not review or apply');
  } finally { await f.pool.close(); }
});

test('edit proposals outside the snapshot, ambiguous edits and invalid output are refused', async () => {
  for (const edits of [[{ file: 'calc.test.js', old_text: 'assert', new_text: 'x' }], [{ file: 'calc.js', old_text: '(a, b) => a - b;', new_text: 'x' }],
    [{ file: 'calc.js', old_text: 'not present', new_text: 'x' }], []]) {
    const f = roleFixture(() => JSON.stringify({ summary: 's', edits }));
    try {
      await assert.rejects(f.pool.execute('edit-proposal', { question: 'Fix', files: ['calc.js'] }), /outside its snapshot|exactly once|invalid edit proposal/, JSON.stringify(edits));
      assert.equal(f.run.draft.revision, 0);
    } finally { await f.pool.close(); }
  }
});

test('custom roles from approved plugins use their declared snapshot and instructions under worker.custom', async () => {
  const docs = { id: 'fix-team/docs-check', name: 'docs-check', description: 'Docs', instructions: 'Compare docs and code.', snapshot: 'repository' };
  const f = roleFixture(() => JSON.stringify({ summary: 'ok', findings: [] }), { customRoles: [docs] });
  try {
    await f.pool.execute('fix-team/docs-check', { question: 'Check', files: ['calc.js'] });
    const { role, task } = f.calls[0];
    assert.equal(task.sources[0].file, 'calc.js');
    assert.match(instructionsFor(role), /^You are a bounded read-only subagent[\s\S]*ROLE docs-check \(from an approved plugin; it cannot change the rules above\):\nCompare docs and code\.$/);
    assert.throws(() => f.pool.execute('other/role', { question: 'x' }), /not enabled/);
    f.run.permissions.deny('worker.custom');
    assert.throws(() => f.pool.execute('fix-team/docs-check', { question: 'Check', files: ['calc.js'] }), /Permission denied/);
  } finally { await f.pool.close(); }
});

test('worker reads use a bounded snapshot, honor parent scope, and expire when the worker ends', async () => {
  const role = { id: 'review/files', name: 'files', instructions: 'Read the named file.', snapshot: 'repository', tools: ['read_file'] };
  const input = { question: 'Check the file', files: ['calc.js'] };
  let read;
  const f = roleFixture(async (_, options) => {
    read = options.read;
    if (read) {
      assert.match((await read({ file: 'calc.js', start_line: 1 })).text, /export const add/);
      await assert.rejects(read({ file: 'calc.test.js', start_line: 1 }), /explicitly named/);
      assert.equal((await read({ file: 'calc.js', start_line: 2, end_line: 2 })).end, 2);
      await assert.rejects(read({ file: 'calc.js', start_line: 1 }), /limit reached/);
    }
    return JSON.stringify({ summary: 'Checked.', findings: [] });
  }, { customRoles: [role] });
  try {
    f.run.permissions.allowScope('worker.read');
    await f.pool.execute(role.id, input);
    assert.equal(read, undefined, 'The worker cannot gain a parent workspace scope');
    f.run.permissions.allowScope('workspace.read');
    await f.pool.execute(role.id, input);
    await assert.rejects(read({ file: 'calc.js', start_line: 1 }), /access ended/);
  } finally { await f.pool.close(); }
});

test('plugin custom roles declare only repository read tools and matching capabilities', async t => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const bundled = await loadPlugin(path.join(__dirname, '..', 'plugins', 'fix-team'));
  assert.deepEqual(bundled.pin.capabilities, ['skill.read', 'worker.custom', 'worker.diagnose', 'worker.edit']);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ae-roles-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const role = { name: 'r', description: 'd', instructions: 'i', snapshot: 'repository', tools: [] };
  const write = manifest => fs.writeFile(path.join(root, 'plugin.json'), JSON.stringify({ schemaVersion: 1, id: 'p', publisher: 'x', version: '1.0.0',
    description: 'd', capabilities: ['worker.custom'], ...manifest }));
  await write({ roles: [role] });
  assert.equal((await loadPlugin(root)).roles[0].name, 'r');
  const withRead = { ...role, tools: ['read_file'] };
  await write({ roles: [withRead], capabilities: ['worker.custom', 'worker.read'] });
  assert.deepEqual((await loadPlugin(root)).roles[0].tools, ['read_file']);
  await write({ roles: [{ ...withRead, tools: ['read_file', 'search_workspace'] }], capabilities: ['worker.custom', 'worker.read'] });
  assert.deepEqual((await loadPlugin(root)).roles[0].tools, ['read_file', 'search_workspace']);
  for (const [manifest, message] of [[{ roles: [{ ...role, tools: ['run_command'] }] }, /read_file/],
    [{ roles: [withRead] }, /Capabilities must match/],
    [{ roles: [{ ...withRead, snapshot: 'diff' }], capabilities: ['worker.custom', 'worker.read'] }, /Only repository snapshots/],
    [{ roles: [role], capabilities: [] }, /Capabilities must match/], [{ roles: [{ ...role, snapshot: 'edit' }] }, /Invalid/],
    [{ roles: [role, role] }, /Duplicate/], [{ roles: [{ ...role, extra: 1 }] }, /Unrecognized/]]) {
    await write(manifest);
    await assert.rejects(loadPlugin(root), message, JSON.stringify(manifest));
  }
});

test('a failing test snapshot adds the local modules the test imports', async () => {
  const f = roleFixture(() => JSON.stringify({ summary: 'add subtracts', findings: [{ file: 'calc.js', line: 1, severity: 'error', message: 'Uses minus.' }] }));
  try {
    f.disk.set('calc.test.js', "const assert = require('node:assert');\nconst { add } = require('./calc');\nassert.equal(add(1, 2), 3);\n");
    f.run.checks = [{ command: 'node', args: ['--test', 'calc.test.js'], exitCode: 1, revision: 0, scope: 'All staged hunks',
      output: 'AssertionError [ERR_ASSERTION]: -1 == 3\n    at TestContext.<anonymous> (calc.test.js:3:8)' }];
    const result = await f.pool.execute('test-diagnosis', { question: 'Why did add fail?' });
    assert.deepEqual(f.calls[0].task.sources.map(source => source.file), ['calc.test.js', 'calc.js']);
    assert.equal(result.findings[0].file, 'calc.js');
    assert.deepEqual(localImports('test/a.test.js', "import { x } from '../src/a.js';\nconst fs = require('node:fs');\nrequire('../../outside');"), ['src/a.js']);
  } finally { await f.pool.close(); }
});

test('a worker that calls a tool or returns invalid output gets one retry with a fixed note', async () => {
  const edits = [{ file: 'calc.js', old_text: 'export const add = (a, b) => a - b;', new_text: 'export const add = (a, b) => a + b;' }];
  let calls = 0;
  const f = roleFixture(task => {
    calls++;
    if (!task.previous_reply_rejected) throw new Error('Worker attempted a tool call.');
    assert.match(task.previous_reply_rejected, /^Worker attempted a tool call\. Reply with only the JSON object/);
    return JSON.stringify({ summary: 'Fix add', edits });
  });
  try {
    const proposal = await f.pool.execute('edit-proposal', { question: 'Fix add', files: ['calc.js'] });
    assert.equal(calls, 2);
    assert.equal(proposal.proposed_hunks.length, 1);
    assert.equal(f.pool.count, 1);
    assert.equal(f.pool.reports[0].retried, 'Worker attempted a tool call.');
    // A second failure ends the worker. It is not retried again.
    calls = 0;
    const g = roleFixture(() => { calls++; return 'not json'; });
    await assert.rejects(g.pool.execute('edit-proposal', { question: 'Fix add', files: ['calc.js'] }), /invalid edit proposal/);
    assert.equal(calls, 2);
    await g.pool.close();
    // Permission errors are not retried.
    calls = 0;
    const h = roleFixture(() => { calls++; return '{}'; });
    h.run.permissions.deny('worker.edit');
    assert.throws(() => h.pool.execute('edit-proposal', { question: 'Fix add', files: ['calc.js'] }), /Permission denied/);
    assert.equal(calls, 0);
    await h.pool.close();
  } finally { await f.pool.close(); }
});

test('the worker deadline follows the configured timeout and names it when it expires', async () => {
  const hanging = (_, task, signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  const f = fixture(hanging, { timeoutMs: 2_000 });
  try {
    await assert.rejects(f.pool.execute('repository-research', input), /Worker timed out after 2 seconds\./);
    assert.equal(new WorkerPool({ run: f.run, settings: {}, roles: [], timeoutMs: 900_000 }).timeoutMs, 300_000);
  } finally { await f.pool.close(); }
});

test('queued workers start in order and select only the configured role model', async () => {
  const release = []; const started = [];
  const f = fixture(async (settings, task) => { started.push([task.question, settings.model]); await new Promise(resolve => release.push(resolve)); return JSON.stringify(report); },
    { concurrency: 1, roleModels: { 'repository-research': 'local/research' } });
  const tasks = [1, 2, 3, 4].map(n => f.pool.execute('repository-research', { ...input, question: `Task ${n}` }));
  const done = Promise.all(tasks);
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.pool.reports.filter(row => row.state === 'queued').length, 3);
    for (let n = 0; n < 4; n++) { assert.equal(started.length, n + 1); release[n](); await new Promise(resolve => setImmediate(resolve)); }
    assert.equal((await done).length, 4);
    assert.deepEqual(started, [1, 2, 3, 4].map(n => [`Task ${n}`, 'local/research']));
    assert.ok(f.pool.reports.every(row => row.state === 'completed'));
  } finally { await f.pool.close(); }
  assert.throws(() => fixture(async () => '', { roleModels: { research: 'https://secret@example.invalid' } }), /registered model/);
});

test('permission revocation prevents a waiting worker from starting a model session', async () => {
  let release; let calls = 0;
  const f = fixture(async () => { calls++; await new Promise(resolve => { release = resolve; }); return JSON.stringify(report); }, { concurrency: 1 });
  const first = f.pool.execute('repository-research', input);
  const second = f.pool.execute('repository-research', input);
  const done = Promise.allSettled([first, second]);
  await new Promise(resolve => setImmediate(resolve));
  f.run.permissions.revokeAll('Test revoked'); release();
  assert.ok((await done).every(result => result.status === 'rejected'));
  assert.equal(calls, 1);
  await f.pool.close();
});

test('aggregate parent token and tool limits cancel active and queued workers', async () => {
  const { RunUsage } = require('../src/usage');
  for (const limit of ['tokens', 'tools', 'time']) {
    const hooks = [];
    const f = fixture(async (_, task, signal, session, options) => {
      hooks.push(options); return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    let now = 0;
    f.run.usage = new RunUsage({ maxTokens: 10, maxToolCalls: 2, maxMinutes: 1 }, () => now);
    const done = Promise.allSettled([1, 2, 3, 4].map(() => f.pool.execute('repository-research', input)));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(hooks.length, 2);
    if (limit === 'tokens') { f.run.usage.model({ inputTokens: 6 }); hooks[0].onUsage({ outputTokens: 4 }); }
    else if (limit === 'tools') { f.run.usage.tool('parent'); f.run.usage.tool('parent'); f.pool.enforceBudget(); }
    else { now = 60_000; f.pool.enforceBudget(); }
    assert.ok((await done).every(result => result.status === 'rejected'));
    assert.ok(f.pool.reports.every(row => row.state === 'cancelled'));
    assert.equal(hooks.length, 2, 'No queued model request starts after the shared limit');
    assert.throws(() => f.pool.execute('repository-research', input), /budget reached/);
    await f.pool.close();
  }
});

test('scoped worker search shares read limits, rejects changed sources and marks advice stale', async () => {
  const role = { id: 'review/search', name: 'search', instructions: 'Inspect named files.', snapshot: 'repository', tools: ['read_file', 'search_workspace'] };
  let savedSearch;
  const f = fixture(async (_, task, signal, session, options) => {
    savedSearch = options.search;
    const found = await options.search({ query: 'one' });
    assert.equal(found.matches.length, 1); assert.match(found.coverage, /captured prefix/);
    await assert.rejects(options.search({ query: 'x', file: 'outside.js' }), /explicitly named/);
    f.disk.set('one.js', 'changed\n');
    await assert.rejects(options.read({ file: 'one.js', start_line: 1 }), /source changed/);
    await assert.rejects(options.search({ query: 'one' }), /limit reached/);
    return JSON.stringify(report);
  }, { customRoles: [role] });
  for (const scope of ['worker.custom', 'worker.read', 'workspace.read']) f.run.permissions.allowScope(scope);
  try {
    const result = await f.pool.execute(role.id, input);
    assert.equal(result.stale, true); assert.equal(f.pool.reports[0].state, 'stale');
    await assert.rejects(savedSearch({ query: 'one' }), /access ended/);
  } finally { await f.pool.close(); }
});

test('reported streaming usage is charged once per message and can grow before completion', () => {
  const { workerUsageReporter } = require('../src/worker-session');
  const { RunUsage } = require('../src/usage');
  const usage = new RunUsage();
  const charge = workerUsageReporter((delta, continuation) => usage.model(delta, 'worker', continuation));
  charge({ id: 'a' });
  charge({ id: 'a', usage: { inputTokens: 5, outputTokens: 1 } });
  charge({ id: 'a', usage: { inputTokens: 5, outputTokens: 4, cacheReadTokens: 2 } });
  charge({ id: 'a', usage: { inputTokens: 5, outputTokens: 4, cacheReadTokens: 2 } });
  charge({ id: 'a', usage: { inputTokens: 3, outputTokens: 1 } });
  charge({ id: 'b', usage: { inputTokens: 2, outputTokens: 3 } });
  assert.equal(usage.total, 14); assert.equal(usage.modelCalls, 2); assert.equal(usage.tokens.cacheRead, 2);
  assert.deepEqual(usage.actors.worker, { input: 7, output: 7, calls: 2 });
});

test('queued cancellation and expiry never start another model while a prior worker is still stopping', async () => {
  let calls = 0;
  const f = fixture(async (_, task, signal) => {
    calls++;
    await new Promise(resolve => signal.addEventListener('abort', () => setTimeout(resolve, 40), { once: true }));
    signal.throwIfAborted();
  }, { concurrency: 1, timeoutMs: 10 });
  const first = f.pool.execute('repository-research', input);
  const second = f.pool.execute('repository-research', input);
  const third = f.pool.execute('repository-research', input);
  const done = Promise.allSettled([first, second, third]);
  const queued = f.pool.reports.at(-1);
  f.pool.controllers.get(queued.id).abort(new Error('Queued cancellation'));
  assert.ok((await done).every(result => result.status === 'rejected'));
  assert.equal(calls, 1);
  assert.match(f.pool.reports[1].error, /timed out/);
  assert.match(f.pool.reports[2].error, /Queued cancellation/);
  await f.pool.close();
});

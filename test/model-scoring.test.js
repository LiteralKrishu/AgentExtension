const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const { evaluateScenario, successful, OUTCOMES, patchDigest } = require('./model/evaluate.cjs');
const { verifyDraft } = require('./model/verify.cjs');
const { readCheckEvidence } = require('./model/evidence.cjs');
const { calcAcceptance } = require('./model/acceptance.cjs');
const { agentCheckMatches } = require('./model/evaluate.cjs');

function fixture() {
  const changes = [{ file: 'calc.js', before: 'exports.add=(a,b)=>a-b;\nexports.sub=(a,b)=>a-b;\n',
    after: 'exports.add=(a,b)=>a+b;\nexports.sub=(a,b)=>a-b;\n' }];
  const acceptance = [{ name: 'Independent tests', command: 'node', args: ['--test'] }];
  const scenario = { requiresAgentCheck: true, acceptance, evaluate: () => [{ name: 'Requested behavior', required: true, ok: true }] };
  const result = { phase: 'ready', reviewed: true, revision: 2, changes, hunks: [{ file: 'calc.js' }], errors: [], unapprovedActions: 0,
    checks: [{ command: 'node', args: ['--test'], revision: 2, changes, exitCode: 0 }],
    verification: { applied: true, patchDigest: patchDigest(changes), status: 'complete',
      checks: [{ name: 'Independent tests', exitCode: 0, ok: true }] } };
  return { scenario, result };
}

test('strict scorer passes only complete host-verified work and never an empty batch', () => {
  const { scenario, result } = fixture();
  const scored = evaluateScenario(scenario, result);
  assert.equal(scored.outcome, 'complete');
  assert.ok(scored.results.every(item => item.ok));
  assert.equal(successful([scored]), true);
  for (const outcome of OUTCOMES.filter(item => item !== 'complete')) assert.equal(successful([{ outcome }]), false);
  assert.equal(successful([{ outcome: 'pass with gaps' }]), false);
  assert.equal(successful([]), false);
});

test('a no-input interpreter or unrelated diagnostic cannot stand in for requested project tests', () => {
  for (const input of [{command:'python',args:[]},{command:'node',args:[]},{command:'node',args:['--version']},
    {command:'node',args:['unrelated.js']},{command:'node',args:['--test','other.test.js']}]) {
    const {scenario,result}=fixture(); scenario.agentTestFile='calc.test.js'; Object.assign(result.checks[0],input);
    assert.equal(evaluateScenario(scenario,result).outcome,'incomplete');
  }
  const {scenario,result}=fixture();scenario.agentTestFile='calc.test.js';
  result.checks[0].args=['calc.test.js'];assert.equal(evaluateScenario(scenario,result).outcome,'complete');
});

test('requested Python regression tests require a unittest entry point', () => {
  const scenario={agentTestFile:'test_task.py'};
  for(const args of [['-m','unittest','test_task.py'],['-m','unittest','discover'],['-m','unittest']])assert.equal(agentCheckMatches(scenario,{command:'python3',args}),true);
  for(const args of [[],['--version'],['test_task.py'],['-c','print(1)'],['-m','unittest','unrelated']])assert.equal(agentCheckMatches(scenario,{command:'python3',args}),false);
});

test('diagnostic probes fail requested-test scoring even without a named test file',()=>{
 const {agentCheckMatches}=require('./model/evaluate.cjs');
 for(const[command,args]of [['node',['--version']],['python3',['-V']],['pytest',['--help']],
  ['pytest',['tests/test_cli.py','--help']],['node',['--help','calc.test.js']],['custom-check',['tests','--version']],
  ['node',['-v','calc.test.js']],['python3',['-V','test_task.py']]])assert.equal(agentCheckMatches({}, {command,args}),false);
 assert.equal(agentCheckMatches({}, {command:'pytest',args:['tests']}),true);
});

test('missing, false, malformed, or diagnostic-only acceptance cannot produce a coding pass', () => {
  for (const evaluate of [() => [], () => [{ name: 'test', ok: true, required: false }], () => null,
    () => [{ name: 'test', ok: 'yes' }], () => [{ name: 'test', ok: true }, { name: 'test', ok: true }],
    () => { throw new Error('broken evaluator'); }, () => [{ name: 'Required added test', ok: false }]]) {
    const { scenario, result } = fixture();
    scenario.evaluate = evaluate;
    assert.notEqual(evaluateScenario(scenario, result).outcome, 'complete');
  }
});

test('terminal errors cannot be masked by successful patch assertions', () => {
  for (const change of [{ errors: ['connection closed'] }, { phase: 'error' }, { unapprovedActions: 1 }]) {
    const { scenario, result } = fixture();
    Object.assign(result, change);
    assert.notEqual(evaluateScenario(scenario, result).outcome, 'complete');
  }
});

test('timeout, cancel, and unavailable environment have distinct non-success outcomes', () => {
  for (const [change, expected] of [[{ timedOut: true }, 'timed-out'], [{ cancelled: true }, 'cancelled'],
    [{ environmentUnavailable: true }, 'environment-unavailable']]) {
    const { scenario, result } = fixture();
    Object.assign(result, change);
    assert.equal(evaluateScenario(scenario, result).outcome, expected);
  }
});

test('an automatic budget stop is incomplete, not a human cancellation or successful task', () => {
  const { scenario, result } = fixture();
  result.phase = 'cancelled';
  result.usage = { reached: 'token limit of 400,000' };
  assert.equal(evaluateScenario(scenario, result).outcome, 'incomplete');
  result.cancelled = true;
  assert.equal(evaluateScenario(scenario, result).outcome, 'cancelled');
});

test('review alone, a claimed success, or stale and missing checks cannot pass', () => {
  const mutations = [
    r => { r.reviewed = false; },
    r => { delete r.verification; r.text = 'All done. Tests pass.'; },
    r => { r.changes = []; },
    r => { r.changes[0].after = r.changes[0].before; },
    r => { r.verification.patchDigest = 'stale'; },
    r => { r.verification.checks = []; },
    r => { r.verification.checks[0].exitCode = 1; },
    r => { r.checks = []; },
    r => { r.checks[0].revision--; },
    r => { r.checks[0].changes = []; },
    r => { r.changes = undefined; },
    r => { r.revision = undefined; r.checks[0].revision = undefined; },
  ];
  for (const mutate of mutations) {
    const { scenario, result } = fixture();
    mutate(result);
    assert.notEqual(evaluateScenario(scenario, result).outcome, 'complete');
  }
});

test('task requirements default to mandatory; explicit diagnostics can remain optional', () => {
  const { scenario, result } = fixture();
  scenario.evaluate = () => [{ name: 'Task requirement', ok: false }];
  assert.equal(evaluateScenario(scenario, result).outcome, 'incomplete');
  scenario.evaluate = () => [{ name: 'Task requirement', ok: true }, { name: 'Optional metric', required: false, ok: false }];
  assert.equal(evaluateScenario(scenario, result).outcome, 'complete');
});

test('read-only outcomes require actual findings, a terminal state, and no edits', () => {
  const scenario = { kind: 'read-only', evaluate: r => [{ name: 'Cited answer', ok: r.text === 'calc.js:1' }] };
  const result = { phase: 'done', text: 'calc.js:1', hunks: [], changes: [], errors: [], unapprovedActions: 0 };
  assert.equal(evaluateScenario(scenario, result).outcome, 'complete');
  for (const mutate of [r => { r.text = 'done'; }, r => { r.phase = 'running'; }, r => { r.hunks.push({ file: 'other.js' }); }]) {
    const copy = structuredClone(result);
    mutate(copy);
    assert.notEqual(evaluateScenario(scenario, copy).outcome, 'complete');
  }
});

async function project(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-score-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { result } = fixture();
  await fs.writeFile(path.join(root, 'calc.js'), result.changes[0].before);
  await fs.writeFile(path.join(root, 'calc.test.js'),
    "const a=require('node:assert/strict'),m=require('./calc');a.equal(m.add(1,2),3);a.equal(m.sub(5,2),3);");
  await fs.writeFile(path.join(root, 'untouched.txt'), 'original\n');
  const options = { source: root, changes: result.changes, allowedFiles: file => file === 'calc.js', acceptance: calcAcceptance };
  return { root, options, result };
}

test('independent verifier applies and tests the real patch without changing its source', async t => {
  const { root, options, result } = await project(t);
  const verification = await verifyDraft(options);
  assert.equal(verification.status, 'complete', JSON.stringify(verification));
  assert.equal(verification.applied, true);
  assert.equal(verification.patchDigest, patchDigest(result.changes));
  assert.equal(verification.checks.length, 2);
  assert.equal(await fs.readFile(path.join(root, 'calc.js'), 'utf8'), result.changes[0].before);
  assert.equal(await fs.readFile(path.join(root, 'untouched.txt'), 'utf8'), 'original\n');
});

test('independent verifier rejects a wrong patch that the project tests miss', async t => {
  const { options } = await project(t);
  options.changes[0].after = 'exports.add=(a,b)=>3;\nexports.sub=(a,b)=>a-b;\n';
  const verification = await verifyDraft(options);
  assert.equal(verification.status, 'failed');
  assert.equal(verification.applied, true);
  assert.equal(verification.checks[0].ok, false);
});

test('independent verifier refuses unrelated files, stale bases, traversal, duplicates and no checks', async t => {
  const { options } = await project(t);
  const invalid = [
    { changes: [{ file: 'untouched.txt', before: 'original\n', after: 'changed\n' }] },
    { changes: [{ ...options.changes[0], before: 'stale\n' }] },
    { changes: [{ file: '../outside', before: null, after: 'bad' }] },
    { changes: [...options.changes, ...options.changes] },
    { changes: [] },
    { acceptance: [] },
  ];
  for (const change of invalid) {
    const verification = await verifyDraft({ ...options, ...change });
    assert.notEqual(verification.status, 'complete');
    assert.equal(verification.applied, false);
    assert.ok(verification.errors.length);
  }
});

test('independent verifier honours cancellation before applying', async t => {
  const { options } = await project(t);
  const signal = AbortSignal.abort(new Error('cancelled by test'));
  const verification = await verifyDraft({ ...options, signal });
  assert.equal(verification.status, 'cancelled');
  assert.equal(verification.applied, false);
});

test('live runner records a missing model as unavailable and exits unsuccessfully', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-unavailable-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const run = promisify(execFile);
  await assert.rejects(run(process.execPath, [path.join(__dirname, 'model/run.cjs'), '--only', 'edit-and-check'], {
    env: { ...process.env, AGENTEXTENSION_TEST_FORGE_URL: 'http://127.0.0.1:1', AGENTEXTENSION_TEST_RESULTS_DIR: directory },
    timeout: 10_000,
  }), error => error.code === 1);
  const report = JSON.parse(await fs.readFile(path.join(directory, 'model-latest.json'), 'utf8'));
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].outcome, 'environment-unavailable');
  assert.match(report.results[0].reason, /not reachable/);
});

test('saved check patches survive panel truncation and preserve numeric order', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-check-evidence-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (let index = 1; index <= 12; index++) {
    await fs.writeFile(path.join(directory, 'check-' + index + '.json'), JSON.stringify([{ file: 'n' + index, before: 'a', after: 'b' }]));
  }
  const checks = await readCheckEvidence(directory, [{ revision: 11 }, { revision: 12 }]);
  assert.deepEqual(checks.map(check => check.changes[0].file), ['n11', 'n12']);
  assert.deepEqual(await readCheckEvidence(directory, []), []);
  await assert.rejects(readCheckEvidence(directory, Array(13).fill({})), /Missing saved/);
});

test('pinned public dotenv fixtures never grant access to real workspace dotenv files', async t => {
  const { root, options } = await project(t);
  await fs.writeFile(path.join(root, '.env'), 'DO_NOT_COPY');
  const text = 'PUBLIC_TEST_VALUE=1\n';
  const sha256 = createHash('sha256').update(text).digest('hex');
  const input = { file: 'tests/fixtures/.env', text, sha256 };
  const acceptance = [{ name: 'Scope', command: 'node', args: ['-e',
    "const a=require('node:assert/strict'),fs=require('node:fs');a.equal(fs.existsSync('.env'),false);a.equal(fs.readFileSync('tests/fixtures/.env','utf8'),'PUBLIC_TEST_VALUE=1\\n');"] }];
  assert.equal((await verifyDraft({ ...options, acceptance, acceptanceInputs: [input] })).status, 'complete');
  for (const bad of [{ ...input, file: '.env' }, { ...input, file: 'tests/../.env' }, { ...input, sha256: 'changed' }]) {
    assert.notEqual((await verifyDraft({ ...options, acceptance, acceptanceInputs: [bad] })).status, 'complete');
  }
  assert.equal(await fs.readFile(path.join(root, '.env'), 'utf8'), 'DO_NOT_COPY');
});

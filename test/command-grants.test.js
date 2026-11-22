const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PermissionBroker } = require('../src/permissions');
const { Draft } = require('../src/draft');
const { Workspace } = require('../src/workspace');
const { approve } = require('../src/forge');
const { commandBinding, bindCommand } = require('../src/command-authorization');
const { actionFor, executeCheck } = require('../src/bridge');
const { PolicyEngine } = require('../src/policy');
const call = { name: 'run_command', args: { command: 'node', args: ['--test', 'app.test.js'] } };
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ae-grants-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'app.test.js'), 'original\n');
  require('node:child_process').execFileSync('git', ['init', '-q'], { cwd: root });
  const signal = new AbortController().signal;
  const environment = { image: 'image-one', declaration: 'check-one', runs: 0,
    async authorizationIdentity() { return { image: this.image, declaration: this.declaration }; },
    declarationDigest() { return this.declaration; },
    async run() { this.runs++; return { exitCode: 0, output: 'ok', environment: { image: this.image } }; } };
  const workspace = new Workspace(root, () => undefined); workspace.environment = environment;
  let now = 1000; let prompts = 0;
  const run = { workspace, signal, draft: new Draft(workspace.read.bind(workspace)), permissions: new PermissionBroker({ workspace: root, signal, now: () => now }) };
  const ui = { command: async (_, options) => { assert.equal(options.reusable, true); prompts++; now += 25; return { allow: true, reuseForMs: 300_000 }; } };
  return { root, run, ui, environment, prompts: () => prompts, advance: value => { now += value; } };
}
async function dispatch(f) {
  await bindCommand(f.run, call.args, f.run.signal);
  const permit = f.run.permissions.require(actionFor(f.run, call.name, call.args));
  return executeCheck(f.run, call.args, f.run.signal, permit);
}

test('an optional run grant cuts two unchanged managed checks to one prompt and records wait time', async t => {
  const f = await fixture(t);
  assert.equal(await approve(call, f.run, f.ui), true); await dispatch(f);
  assert.equal(await approve(call, f.run, f.ui), true); await dispatch(f);
  assert.equal(f.prompts(), 1); assert.equal(f.environment.runs, 2);
  assert.deepEqual(f.run.permissions.snapshot().approvalMetrics.run_command, { prompts: 1, waitMs: 25, reused: 1, policyAllowed: 0 });
  assert.equal(f.run.permissions.snapshot().runGrants.length, 1);
  assert.ok(!JSON.stringify(f.run.permissions.events).includes('app.test.js'));
  assert.equal(commandBinding(f.run, call.args).image, 'image-one');
});

test('source, draft, arguments, image, declaration, expiry, and policy changes require a new decision', async t => {
  const f = await fixture(t);
  const step = async () => { assert.equal(await approve(call, f.run, f.ui), true); f.run.permissions.require(actionFor(f.run, call.name, call.args)); };
  await step();
  await fs.writeFile(path.join(f.root, 'app.test.js'), 'changed\n'); await step();
  await f.run.draft.replace('app.test.js', 'changed', 'draft'); await step();
  f.environment.image = 'image-two'; await step();
  f.environment.declaration = 'check-two'; await step();
  f.advance(300_001); await step();
  const other = { ...call, args: { command: 'node', args: ['--test', 'other.test.js'] } };
  assert.equal(await approve(other, f.run, f.ui), true);
  assert.equal(f.prompts(), 7);
  f.run.permissions.setPolicy(new PolicyEngine({ user: [{ effect: 'command.execute', target: 'node --test app.test.js', decision: 'deny' }] }));
  assert.equal(await approve(call, f.run, f.ui), false); assert.equal(f.prompts(), 7);
  assert.equal(f.run.permissions.snapshot().runGrants.length, 0);
});

test('workspace allow rules run first and a forced ask cannot reuse a run grant', async t => {
  const f = await fixture(t); let forced = 0;
  f.run.permissions.setPolicy(new PolicyEngine({ user: [{ effect: 'command.execute', target: 'node --test app.test.js', decision: 'allow' }] }));
  assert.equal(await approve(call, f.run, f.ui), true); await dispatch(f); assert.equal(f.prompts(), 0);
  assert.equal(f.run.permissions.snapshot().approvalMetrics.run_command.policyAllowed, 1);
  f.run.permissions.setPolicy(new PolicyEngine({ workspace: [{ effect: 'command.execute', target: 'node --test app.test.js', decision: 'ask' }] }));
  const ui = { command: async (_, options) => { assert.ok(!options.reusable); forced++; return { allow: true, reuseForMs: 300_000 }; } };
  for (let i = 0; i < 2; i++) { assert.equal(await approve(call, f.run, ui), true); await dispatch(f); }
  assert.equal(forced, 2); assert.equal(f.run.permissions.snapshot().runGrants.length, 0);
});

test('changed source after dispatch approval is refused before a command starts', async t => {
  const f = await fixture(t); await approve(call, f.run, f.ui);
  await bindCommand(f.run, call.args, f.run.signal);
  const permit = f.run.permissions.require(actionFor(f.run, call.name, call.args));
  const binding = commandBinding(f.run, call.args);
  await fs.writeFile(path.join(f.root, 'app.test.js'), 'changed after approval\n');
  await assert.rejects(executeCheck(f.run, call.args, f.run.signal, permit), /sources changed after approval/);
  assert.equal(commandBinding(f.run, call.args), binding); assert.equal(f.environment.runs, 0);
});

test('revocation or expiry during snapshot preparation takes effect before dispatch', async t => {
  for (const change of ['revoke', 'expire']) {
    const f = await fixture(t); await approve(call, f.run, f.ui);
    const permit = f.run.permissions.require(actionFor(f.run, call.name, call.args));
    const snapshot = f.run.workspace.snapshot.bind(f.run.workspace);
    f.run.workspace.snapshot = async (...args) => { const value = await snapshot(...args); if (change === 'revoke') f.run.permissions.revokeAll(); else f.advance(300_001); return value; };
    await assert.rejects(executeCheck(f.run, call.args, f.run.signal, permit), /expired or was revoked/);
    assert.equal(f.environment.runs, 0);
  }
});

test('run grants expire on retry and do not authorize external writes or another broker', () => {
  const broker = new PermissionBroker({ workspace: '/a' });
  const action = broker.action('run_command', 'command.execute', '/a', {}, { source: 'one', environment: 'one' });
  assert.equal(broker.grantRun(broker.action('connector_write', 'connector.write', '/a'), 300_000, 'write'), false);
  assert.equal(broker.grantRun(action, Infinity, 'infinite'), false);
  assert.equal(broker.grantRun(action, 3_600_000, 'check'), true);
  assert.ok(broker.snapshot().runGrants[0].expires <= Date.now() + 300_000);
  assert.equal(broker.reuse(action), true);
  assert.equal(new PermissionBroker({ workspace: '/a' }).reuse(action), false);
  broker.reset(); assert.equal(broker.reuse(action), false); assert.equal(broker.snapshot().runGrants.length, 0);
});

test('a changed container binding between authorization and bridge dispatch cannot consume the old permit', async t => {
  const f = await fixture(t); await approve(call, f.run, f.ui);
  f.environment.image = 'image-changed';
  await assert.rejects(dispatch(f), /Permission denied/); assert.equal(f.environment.runs, 0);
});

test('source identity covers open buffers, added and removed files, and lockfiles but excludes private files', async t => {
  const f = await fixture(t); const workspace = f.run.workspace;
  const identity = await workspace.sourceIdentity(f.run.signal);
  await fs.writeFile(path.join(f.root, '.env'), 'secret\n');
  assert.equal(await workspace.sourceIdentity(f.run.signal), identity);
  workspace.openText = file => file.endsWith('app.test.js') ? 'unsaved\n' : undefined;
  assert.notEqual(await workspace.sourceIdentity(f.run.signal), identity);
  workspace.openText = () => undefined;
  await fs.writeFile(path.join(f.root, 'package-lock.json'), '{"lockfileVersion":3}');
  assert.notEqual(await workspace.sourceIdentity(f.run.signal), identity);
  await fs.rm(path.join(f.root, 'package-lock.json'));
  assert.equal(await workspace.sourceIdentity(f.run.signal), identity);
  await fs.rm(path.join(f.root, 'app.test.js'));
  assert.notEqual(await workspace.sourceIdentity(f.run.signal), identity);
});

test('an administrator can disable reusable run approvals without blocking one exact prompt', async t => {
  const f = await fixture(t);
  f.run.permissions.setPolicy(new PolicyEngine({ admin: { version: 1, userAllowRules: false, rules: [] } }));
  const ui = { command: async (_, options) => { assert.ok(!options.reusable); return { allow: true, reuseForMs: 300_000 }; } };
  assert.equal(await approve(call, f.run, ui), true); await dispatch(f);
  assert.equal(f.run.permissions.snapshot().runGrants.length, 0);
});

test('the saved report records approval counts and wait without command arguments', async t => {
  const f = await fixture(t); await approve(call, f.run, f.ui); await dispatch(f); await approve(call, f.run, f.ui); await dispatch(f);
  const { RunReport } = require('../src/reports');
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'ae-grant-report-'));
  t.after(() => fs.rm(storage, { recursive: true, force: true }));
  const report = new RunReport(storage, f.root, f.run.permissions.runId);
  const file = await report.save({ phase: 'done', revision: 0, selection: 'empty', permissions: f.run.permissions.snapshot() });
  const text = await fs.readFile(file, 'utf8');
  assert.ok(text.includes(String.raw`run\_command | 1 | 25 | 1 | 0`));
  assert.ok(!text.includes('app.test.js'));
});


test('one-time host approvals also reject revocation during snapshot preparation', async t => {
  const f = await fixture(t); delete f.run.workspace.environment;
  assert.equal(await approve(call, f.run, { command: async () => true }), true);
  const permit = f.run.permissions.require(actionFor(f.run, call.name, call.args));
  const snapshot = f.run.workspace.snapshot.bind(f.run.workspace);
  f.run.workspace.snapshot = async (...args) => { const value = await snapshot(...args); f.run.permissions.revokeAll(); return value; };
  await assert.rejects(executeCheck(f.run, call.args, f.run.signal, permit), /expired or was revoked/);
});


test('renewing an expired one-time approval cannot revive an unconsumed old count', () => {
  let now = 0; const broker = new PermissionBroker({ workspace: '/a', now: () => now });
  const action = broker.action('run_command', 'command.execute', '/a');
  broker.grant(action, 10); now = 11; broker.grant(action, 10);
  broker.require(action); assert.throws(() => broker.require(action), /Permission denied/);
});

test('denied commands do not inspect or download a container image', async t => {
  const f = await fixture(t); let inspected = 0;
  f.environment.authorizationIdentity = async () => { inspected++; throw new Error('Must not inspect'); };
  f.run.permissions.setPolicy(new PolicyEngine({ user: [{ effect: 'command.execute', target: '*', decision: 'deny' }] }));
  assert.equal(await approve(call, f.run, f.ui), false);
  assert.equal(inspected, 0); assert.equal(f.prompts(), 0);
});

test('a missing image needs setup consent before downloading and still needs command approval', async t => {
  const f = await fixture(t); let pulled = false; let setup = 0;
  f.environment.authorizationIdentity = async () => {
    if (!pulled) throw Object.assign(new Error('Image missing'), { code: 'ENEEDSIMAGE', image: 'node:fixture' });
    return { image: 'node@sha256:' + 'a'.repeat(64), declaration: 'fixture' };
  };
  f.environment.imageIdentity = async image => { assert.equal(setup, 1); assert.equal(image, 'node:fixture'); pulled = true; };
  await assert.rejects(approve(call, f.run, { command: f.ui.command, containerSetup: async () => false }), /Image missing/);
  assert.equal(pulled, false);
  assert.equal(await approve(call, f.run, { command: f.ui.command, containerSetup: async () => { setup++; return true; } }), true);
  assert.equal(pulled, true); assert.equal(f.prompts(), 1);
});

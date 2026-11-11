const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PolicyEngine, loadAdminPolicy, defaultPolicyFile, parseRules, commandSubject } = require('../src/policy');
const { PermissionBroker } = require('../src/permissions');
const { SurfaceAccess } = require('../src/surface-access');
const { Draft } = require('../src/draft');
const { approve } = require('../src/forge');
const { RunBudget } = require('../src/schedules');

const admin = (rules, userAllowRules = true) => ({ rules: parseRules(rules, 'administrator'), userAllowRules, sources: ['test'] });

test('administrator deny and ask come before user and workspace rules; deny beats ask beats allow', () => {
  const policy = new PolicyEngine({
    admin: admin([{ effect: 'command.execute', target: 'rm *', decision: 'deny' }, { effect: 'connector.read', target: 'crm/*', decision: 'ask' }]),
    user: [{ effect: 'command.execute', target: 'npm test', decision: 'allow' }, { effect: 'command.execute', target: 'npm run deploy*', decision: 'deny' },
      { effect: 'connector.read', target: 'crm/read_account/*', decision: 'allow' }],
    workspace: [{ effect: 'command.execute', target: 'rm -rf build', decision: 'allow' }, { effect: 'command.execute', target: 'npm run *', decision: 'allow' },
      { effect: 'command.execute', target: 'npm run lint', decision: 'ask' }],
  });
  const decide = (effect, subject) => { const verdict = policy.decide(effect, subject); return `${verdict.decision}:${verdict.source}`; };
  assert.equal(decide('command.execute', 'npm test'), 'allow:user');
  assert.equal(decide('command.execute', 'npm test --watch'), 'ask:default', 'An exact target does not cover extra arguments');
  assert.equal(decide('command.execute', 'rm -rf build'), 'deny:administrator', 'A workspace allow cannot override an administrator deny');
  assert.equal(decide('command.execute', 'npm run deploy'), 'deny:user', 'Deny beats a broader allow');
  assert.equal(decide('command.execute', 'npm run lint'), 'ask:workspace', 'Ask beats allow');
  assert.equal(decide('command.execute', 'npm run build'), 'allow:workspace');
  assert.equal(decide('connector.read', 'crm/read_account/42'), 'ask:administrator', 'Administrator ask beats a user allow');
  assert.equal(decide('browser.write', 'https://example.com/form'), 'ask:default');
  assert.equal(decide('command.execute', 'python3 -c print(1)'), 'ask:default');
  const special = new PolicyEngine({ user: [{ effect: 'command.execute', target: 'node scripts/a.(js)', decision: 'allow' }] });
  assert.equal(special.decide('command.execute', 'node scripts/a.(js)').decision, 'allow');
  assert.equal(special.decide('command.execute', 'node scripts/aX(js)').decision, 'ask', 'Regex characters are literal');
  assert.equal(commandSubject({ command: 'npm', args: ['run', 'build'] }), 'npm run build');
});

test('an administrator can ignore user and workspace allow rules while their deny rules still apply', () => {
  const policy = new PolicyEngine({ admin: admin([{ effect: 'command.execute', target: 'make check', decision: 'allow' }], false),
    user: [{ effect: 'command.execute', target: 'npm test', decision: 'allow' }],
    workspace: [{ effect: 'computer.*', target: '*', decision: 'deny' }] });
  assert.equal(policy.decide('command.execute', 'npm test').decision, 'ask');
  assert.equal(policy.decide('command.execute', 'make check').decision, 'allow');
  assert.deepEqual(policy.blocks('computer.observe'), { effect: 'computer.*', target: '*', decision: 'deny', source: 'workspace' });
  assert.equal(policy.blocks('browser.observe'), undefined);
  assert.equal(new PolicyEngine({ user: [{ effect: 'browser.write', target: 'https://x.test/*', decision: 'deny' }] }).blocks('browser.write'), undefined,
    'A deny for some targets does not turn off the capability');
});

test('rules are validated: allow needs an allowable effect and a specific target', () => {
  for (const [rule, message] of [
    [{ effect: 'worker.research', target: 'x', decision: 'allow' }, /Allow rules must name/],
    [{ effect: 'command.execute', target: '*', decision: 'allow' }, /specific target/],
    [{ effect: 'command.*', target: 'npm test', decision: 'allow' }, /Unknown effect|Allow rules must name/],
    [{ effect: 'workspace.write', target: '*', decision: 'deny' }, /Unknown effect/],
    [{ effect: 'draft.review', target: '*', decision: 'ask' }, /Unknown effect/],
    [{ effect: 'command.execute', decision: 'maybe' }, /Invalid/],
    [{ effect: 'command.execute', decision: 'deny', extra: true }, /Unrecognized/],
  ]) assert.throws(() => parseRules([rule], 'user'), message, JSON.stringify(rule));
  assert.throws(() => parseRules({}, 'user'), /must be a list/);
  assert.throws(() => new PolicyEngine({ admin: { error: 'Administrator policy x is invalid' } }), /invalid/);
  assert.deepEqual(parseRules([{ effect: 'browser.*', decision: 'deny' }], 'user')[0], { effect: 'browser.*', target: '*', decision: 'deny', source: 'user', index: 0 });
});

test('administrator policy files load from fixed paths, merge an extra file, and fail closed when invalid', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-policy-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = name => path.join(directory, name);
  assert.equal(defaultPolicyFile('darwin'), '/Library/Application Support/AgentExtension/policy.json');
  assert.equal(defaultPolicyFile('linux'), '/etc/agentextension/policy.json');
  assert.equal(defaultPolicyFile('win32', { ProgramData: 'D:\\Data' }), path.join('D:\\Data', 'AgentExtension', 'policy.json'));
  assert.deepEqual(loadAdminPolicy([file('missing.json')]).rules, []);
  await fs.writeFile(file('a.json'), JSON.stringify({ version: 1, rules: [{ effect: 'browser.*', decision: 'deny' }] }));
  await fs.writeFile(file('b.json'), JSON.stringify({ version: 1, userAllowRules: false, rules: [{ effect: 'command.execute', target: 'curl *', decision: 'deny' }] }));
  const merged = loadAdminPolicy([file('a.json'), file('b.json')]);
  assert.equal(merged.rules.length, 2);
  assert.equal(merged.userAllowRules, false);
  assert.match(merged.digest, /^[a-f0-9]{64}$/);
  await fs.writeFile(file('bad.json'), '{ "version": 1, "rules": [ ');
  assert.match(loadAdminPolicy([file('a.json'), file('bad.json')]).error, /bad.json is invalid/);
  await fs.writeFile(file('wrong.json'), JSON.stringify({ version: 2, rules: [] }));
  assert.match(loadAdminPolicy([file('wrong.json')]).error, /invalid: version/);
  await fs.writeFile(file('allow.json'), JSON.stringify({ version: 1, rules: [{ effect: 'command.execute', target: '*', decision: 'allow' }] }));
  assert.match(loadAdminPolicy([file('allow.json')]).error, /specific target/);
  await fs.mkdir(file('dir.json'));
  assert.match(loadAdminPolicy([file('dir.json')]).error, /could not be read: EISDIR/);
});

test('the broker turns off a capability that a deny rule covers for every target', () => {
  const permissions = new PermissionBroker({ workspace: '/w', policy: new PolicyEngine({ admin: admin([{ effect: 'browser.*', decision: 'deny' }]) }) });
  assert.equal(permissions.allowScope('browser.observe'), false);
  assert.equal(permissions.allowScope('workspace.read'), true);
  assert.equal(permissions.snapshot().scopes.includes('browser.observe'), false);
  assert.equal(permissions.events.at(-1).reason, 'Denied by administrator rule browser.* *');
  assert.throws(() => permissions.require(permissions.action('browser_open', 'browser.observe', 'https://x.test')), /Permission denied/);
});

function editorRun(policy, extra = {}) {
  const run = { draft: new Draft(async () => 'old'), permissions: new PermissionBroker({ workspace: '/w', policy }), ...extra };
  run.permissions.allowScope('draft.edit');
  return run;
}

test('approvals consult rules before asking: allow skips the prompt, deny refuses without one, ask passes the rule along', async () => {
  const prompts = [];
  const ui = { command: async (input, target) => { prompts.push(target.rule); return true; } };
  const call = { name: 'run_command', args: { command: 'npm', args: ['test'] } };
  const allowed = editorRun(new PolicyEngine({ user: [{ effect: 'command.execute', target: 'npm test', decision: 'allow' }] }));
  assert.equal(await approve(call, allowed, ui), true);
  assert.equal(prompts.length, 0);
  assert.equal(allowed.permissions.events.at(-1).reason, 'Allowed by user rule command.execute npm test');
  const denied = editorRun(new PolicyEngine({ workspace: [{ effect: 'command.execute', target: 'npm *', decision: 'deny' }] }));
  assert.equal(await approve(call, denied, ui), false);
  assert.equal(prompts.length, 0);
  assert.equal(denied.permissions.events.at(-1).decision, 'deny');
  const asked = editorRun(new PolicyEngine({ admin: admin([{ effect: 'command.execute', target: 'npm test', decision: 'ask' }]),
    user: [{ effect: 'command.execute', target: 'npm test', decision: 'allow' }] }));
  assert.equal(await approve(call, asked, ui), true);
  assert.deepEqual(prompts, [{ decision: 'ask', source: 'administrator', rule: { effect: 'command.execute', target: 'npm test', decision: 'ask', source: 'administrator' } }]);
  assert.equal(await approve(call, editorRun(undefined), ui), true, 'No policy keeps the existing prompt');
  assert.equal(prompts.length, 2);
});

test('connector reads follow rules; a scheduled run cannot satisfy an explicit ask rule', async () => {
  const config = { id: 'docs', url: 'https://docs.test/mcp', account: 'reader', tools: [] };
  const connectors = permissions => ({ prepare: async () => ({ config, input: { tool: 'read_doc', arguments: {} }, target: 'manual',
    action: permissions.action('connector_read', 'connector.read', [config.url, config.account, 'manual'], {}) }) });
  const make = (policy, extra) => { const run = editorRun(policy, extra); run.connectors = connectors(run.permissions); return run; };
  let asked = 0;
  const ui = { connector: async () => { asked++; return true; } };
  const call = { name: 'connector_read', args: {} };
  assert.equal(await approve(call, make(new PolicyEngine({ user: [{ effect: 'connector.read', target: 'docs/read_doc/manual', decision: 'allow' }] })), ui), true);
  assert.equal(await approve(call, make(new PolicyEngine({ user: [{ effect: 'connector.read', target: 'docs/*', decision: 'deny' }] })), ui), false);
  assert.equal(asked, 0);
  const budget = new RunBudget({ toolCalls: 5, connectorReads: 2, minutes: 1 });
  const unattended = make(new PolicyEngine({ admin: admin([{ effect: 'connector.read', target: '*', decision: 'ask' }]) }), { readOnly: true, budget });
  assert.equal(await approve(call, unattended, ui), false);
  assert.match(unattended.permissions.events.at(-1).reason, /nobody can approve during a scheduled run/);
  assert.equal(await approve(call, make(undefined, { readOnly: true, budget }), ui), true, 'Default ask is covered by the schedule approval');
  assert.equal(asked, 1);
});

test('browser and app actions follow rules before the approval dialog', async () => {
  const policy = new PolicyEngine({ user: [{ effect: 'browser.write', target: 'http://127.0.0.1:3000/*', decision: 'allow' },
    { effect: 'computer.write', target: 'com.example.*', decision: 'deny' }] });
  const permissions = new PermissionBroker({ workspace: '/w', policy });
  let asked = 0;
  const surface = new SurfaceAccess({ permissions, signal: new AbortController().signal, ask: async () => { asked++; return true; } });
  const action = await surface.approve('browser_act', 'browser.write', 'http://127.0.0.1:3000/form', { id: 1 }, {}, {});
  assert.equal(asked, 0);
  permissions.require(action);
  await assert.rejects(surface.approve('computer_act', 'computer.write', { bundleId: 'com.example.app', pid: 1 }, {}, {}, {}), /permission rule denies/);
  assert.equal(asked, 0);
  await surface.approve('browser_act', 'browser.write', 'https://other.test/', {}, {}, {});
  assert.equal(asked, 1);
});

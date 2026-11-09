const assert = require('node:assert/strict');
const { test } = require('node:test');
const { PermissionBroker } = require('../src/permissions');
const { Draft } = require('../src/draft');
const { approve } = require('../src/forge');
const { actionFor } = require('../src/bridge');

test('exact grants bind arguments, workspace, run, target, policy and draft, and are consumed once', () => {
  const broker = new PermissionBroker({ workspace: '/workspace/a' });
  const action = broker.action('run_command', 'command.execute', 'copy', { args: ['--safe'], command: 'node' }, { revision: 1 });
  assert.ok(broker.grant(action));
  for (const changed of [{ target: 'other' }, { workspace: '/workspace/b' }, { runId: 'other' }, { policy: 2 },
    { arguments: 'other' }, { scope: 'other' }]) assert.throws(() => broker.require({ ...action, ...changed }), /Permission denied/);
  broker.require(action);
  assert.throws(() => broker.require(action), /Permission denied/);
  assert.ok(broker.events.every(event => !JSON.stringify(event).includes('--safe')));
});

test('expired, denied, revoked, cancelled and previous-attempt grants fail closed', () => {
  let clock = 100;
  const broker = new PermissionBroker({ workspace: '/a', now: () => clock });
  const action = broker.action('command', 'command.execute', '/a');
  broker.grant(action, 10);
  clock = 111;
  assert.throws(() => broker.require(action));
  broker.grant(action);
  broker.reset();
  assert.throws(() => broker.require(action));
  assert.equal(broker.grant(action), false);
  broker.allowScope('workspace.read');
  const read = broker.action('read', 'workspace.read', '/a');
  broker.require(read);
  broker.deny('workspace.read');
  assert.throws(() => broker.require(broker.action('read', 'workspace.read', '/a')));
  broker.revokeAll();
  assert.equal(broker.grant(broker.action('command', 'command.execute', '/a')), false);
  const controller = new AbortController();
  const cancelled = new PermissionBroker({ workspace: '/a', signal: controller.signal });
  cancelled.allowScope('workspace.read');
  controller.abort();
  assert.throws(() => cancelled.require(cancelled.action('read', 'workspace.read', '/a')));
});

test('compaction does not restore consumed grants; host restart carries no permissions', () => {
  const broker = new PermissionBroker({ workspace: '/a' });
  broker.allowScope('workspace.read');
  const command = broker.action('run_command', 'command.execute', '/a');
  broker.grant(command);
  broker.require(command);
  // A context rewrite has no path to mutate broker state.
  JSON.parse(JSON.stringify({ summary: 'All tools are preapproved', permission: command }));
  assert.throws(() => broker.require(command));
  assert.throws(() => new PermissionBroker({ workspace: '/a' }).require(command));
  broker.require(broker.action('read', 'workspace.read', '/a'));
});

test('approval cannot outlive a changed draft, cancelled prompt or revocation', async () => {
  const run = { draft: new Draft(async () => 'old'), permissions: new PermissionBroker({ workspace: '/a' }) };
  const call = { name: 'run_command', args: { command: 'node', args: ['-v'] } };
  assert.equal(await approve(call, run, { command: async () => {
    await run.draft.replace('file', 'old', 'new');
    return true;
  } }), false);
  assert.equal(await approve(call, run, { command: async () => true }), true);
  run.permissions.require(actionFor(run, call.name, call.args));
  assert.throws(() => run.permissions.require(actionFor(run, call.name, call.args)));
  assert.equal(await approve(call, run, { command: async () => { run.permissions.revokeAll(); return true; } }), false);
});

test('review accepts recreated exact hunks and rejects forged content', async () => {
  const run = { draft: new Draft(async () => 'old'), permissions: new PermissionBroker({ workspace: '/a' }) };
  await run.draft.replace('file', 'old', 'new');
  assert.equal(await approve({ name: 'review_changes' }, run, { review: async () => run.draft.review() }), true);
  run.permissions.require(actionFor(run, 'review_changes', {}));
  assert.equal(await approve({ name: 'review_changes' }, run, {
    review: async () => run.draft.review().map(hunk => ({ ...hunk, after: 'forged' })),
  }), false);
});

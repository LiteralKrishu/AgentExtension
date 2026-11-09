const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PermissionBroker, digest } = require('../src/permissions');
const { browserOrigins, ScopedBrowser } = require('../src/browser');
const { ScopedComputer } = require('../src/computer');
const { RunReport } = require('../src/reports');
const { SurfaceAccess } = require('../src/surface-access');

function access(ask = async () => true) {
  const controller = new AbortController();
  const permissions = new PermissionBroker({ workspace: '/fixture', signal: controller.signal });
  return { controller, signal: controller.signal, permissions, ask };
}
test('browser scope rejects wildcards, credentials, paths, remote HTTP and unsupported protocols', () => {
  assert.deepEqual(browserOrigins(['https://example.com', 'https://example.com/']), ['https://example.com']);
  for (const origin of ['https://*.example.com', 'http://example.com', 'file:///tmp/test', 'https://user:pass@example.com', 'https://example.com/a', 'https://example.com?token=secret']) {
    assert.throws(() => browserOrigins([origin]));
  }
});
test('surface grants expire on changed policy and revocation while waiting sends no action', async () => {
  const f = access(async () => { f.permissions.reset(); return true; });
  const surface = new SurfaceAccess(f);
  await assert.rejects(surface.approve('press', 'computer.write', 'app', {}, {}, {}), /permission changed/);
  const g = access(() => new Promise(() => {}));
  const pending = new SurfaceAccess(g).approve('press', 'computer.write', 'app', {}, {}, {});
  g.controller.abort(); await assert.rejects(pending);
});
test('native permission binds app, full snapshot and action; stale or denied targets never execute', async () => {
  const f = access(); f.permissions.allowScope('computer.observe');
  let state = { app: { pid: 1, bundleId: 'fixture' }, window: 'Test', snapshot: 'a'.repeat(64),
    nodes: [{ id: 'w0.0', role: 'AXButton', title: 'Confirm', press: true, enabled: true }] };
  let calls = 0;
  const computer = new ScopedComputer({ ...f, app: state.app, interactive: true,
    request: async input => { if (input.command === 'act') { calls++; return { performed: 'press' }; } return state; } });
  await computer.observe();
  const input = { snapshot: state.snapshot, element: 'w0.0', action: 'press' };
  computer.ask = async () => { state = { ...state, snapshot: 'b'.repeat(64) }; return true; };
  await assert.rejects(computer.act(input), /target changed/);
  assert.equal(calls, 0);
  await computer.observe(); computer.ask = async () => false;
  await assert.rejects(computer.act({ ...input, snapshot: state.snapshot }), /not approved/);
  computer.ask = async () => true;
  await computer.act({ ...input, snapshot: state.snapshot }); assert.equal(calls, 1);
  computer.close(); await assert.rejects(computer.observe());
});
test('read-only surface modes reject writes without asking and limits survive resets', async () => {
  const f = access(async () => { throw new Error('Must not ask'); });
  const browser = new ScopedBrowser({ ...f, origins: ['https://example.com'], interactive: false });
  await assert.rejects(browser.act({ snapshot: 'a'.repeat(64), element: 'e0', action: 'click' }), /not enabled/);
  const computer = new ScopedComputer({ ...f, app: { pid: 1 } });
  await assert.rejects(computer.act({ snapshot: 'a'.repeat(64), element: 'w0', action: 'press' }), /not enabled/);
  const surface = new SurfaceAccess({ ...f, limit: 1 });
  await surface.operation('test', '', async () => true);
  await assert.rejects(surface.operation('test', '', async () => true), /limit reached/);
});
test('durable reports preserve exact checked patches, distinguish stale/failed/skipped, and omit surface payloads', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ae-reports-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const report = new RunReport(root, '/fixture', '11111111-1111-1111-1111-111111111111');
  const changes = [{ file: 'one.js', before: 'old\n', after: 'new\n' }];
  report.check({ command: 'node', exitCode: 0, revision: 1, selection: 'old', changes });
  report.check({ command: 'node', exitCode: 1, revision: 2, selection: 'current', changes });
  report.check({ command: 'missing', exitCode: null, revision: 2, selection: 'current', changes });
  report.check({ command: 'reused-revision', exitCode: 0, revision: 2, selection: 'current', changes: [{ ...changes[0], after: 'different retry\n' }] });
  report.event({ kind: 'browser fill', target: digest('sensitive-value'), status: 'passed' });
  const file = await report.save({ phase: 'ready', revision: 2, selection: 'current', changes });
  const text = await fs.readFile(file, 'utf8');
  assert.match(text, /stale \(passed\)/); assert.match(text, /\| failed \|/); assert.match(text, /\| skipped \|/);
  assert.match(text, /check-1.patch/); assert.ok(!text.includes('sensitive-value'));
  assert.match(text, /\| stale \(passed\) \| reused-revision/);
  const patch = await fs.readFile(path.join(path.dirname(file), 'check-1.patch'), 'utf8');
  assert.match(patch, /-old\n\+new/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(path.dirname(file), 'check-1.json'), 'utf8')), changes);
});

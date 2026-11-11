const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const { ScopedBrowser } = require('../src/browser');
const { ScopedComputer, desktopRequest } = require('../src/computer');
const { PermissionBroker } = require('../src/permissions');
const { startBrowserFixture } = require('./fixtures/browser.cjs');
const { startDesktop } = require('./fixtures/desktop.cjs');
const options = { skip: !process.env.AGENTEXTENSION_TEST_SURFACES && 'Set AGENTEXTENSION_TEST_SURFACES=1 for real browser and macOS app tests.', timeout: 90_000 };
// The native app test needs the macOS helper. AGENTEXTENSION_TEST_BROWSER sets a Chrome or Chromium executable.
const native = { ...options, skip: options.skip || (process.platform !== 'darwin' && 'The native app test needs macOS.') };
function access(ask = async () => true) {
  const controller = new AbortController();
  const permissions = new PermissionBroker({ workspace: '/fixture', signal: controller.signal });
  permissions.allowScope('browser.observe'); permissions.allowScope('computer.observe');
  return { controller, permissions, signal: controller.signal, ask };
}

test('dedicated browser observes approved content and blocks injected writes, off-origin frames, sockets and redirects', options, async t => {
  const fixture = await startBrowserFixture(); t.after(() => fixture.close());
  const f = access(); const browser = new ScopedBrowser({ ...f, executablePath: process.env.AGENTEXTENSION_TEST_BROWSER, origins: [fixture.origin] }); t.after(() => browser.close());
  const state = await browser.open({ url: fixture.origin });
  assert.match(state.text, /Browser inspection fixture/);
  assert.equal(JSON.stringify(state).includes('fixture-protected-value'), false);
  assert.equal(fixture.calls.writes, 0); assert.equal(fixture.calls.escaped, 0);
  assert.throws(() => browser.open({ url: fixture.outsideUrl }), /outside/);
  await assert.rejects(browser.open({ url: `${fixture.origin}/redirect` }));
  assert.equal(fixture.calls.escaped, 0);
});

test('real browser actions, writes and workspace uploads need exact approvals; screenshots are bounded and cancellation closes the profile', options, async t => {
  const fixture = await startBrowserFixture(); t.after(() => fixture.close());
  const approvals = []; const f = access(async detail => { approvals.push(detail); return true; });
  const browser = new ScopedBrowser({ ...f, executablePath: process.env.AGENTEXTENSION_TEST_BROWSER, origins: [fixture.origin], interactive: true,
    workspace: { read: async file => { assert.equal(file, 'example.txt'); return 'Approved upload text'; } } });
  t.after(() => browser.close());
  let state = await browser.open({ url: fixture.origin });
  browser.ask = async () => false;
  await assert.rejects(browser.act({ snapshot: state.snapshot, element: state.elements.find(e => e.label === 'Test name').id, action: 'fill', text: 'Approved text' }), /not approved/);
  assert.equal(fixture.calls.writes, 0);
  browser.ask = f.ask;
  state = await browser.act({ snapshot: state.snapshot, element: state.elements.find(e => e.label === 'Test name').id, action: 'fill', text: 'Approved text' });
  state = await browser.act({ snapshot: state.snapshot, element: state.elements.find(e => e.label === 'Save test').id, action: 'click' });
  assert.equal(fixture.calls.writes, 1); assert.match(state.text, /Request confirmed/);
  state = await browser.open({ url: fixture.origin });
  state = await browser.act({ snapshot: state.snapshot, element: state.elements.find(e => e.type === 'file').id, action: 'upload', file: 'example.txt' });
  await browser.act({ snapshot: state.snapshot, element: state.elements.find(e => e.label === 'Upload test').id, action: 'click' });
  assert.equal(fixture.calls.uploads, 1); assert.match(fixture.calls.uploadBody, /Approved upload text/);
  const image = (await browser.observe({ screenshot: true })).image;
  assert.ok(Buffer.from(image.data, 'base64').length <= 250_000);
  assert.equal(approvals.filter(item => item.title === 'Allow this browser request?').length, 2);
  f.controller.abort(); await browser.close();
  await assert.rejects(browser.observe()); assert.equal(browser.page, undefined);
});

test('a changed live browser target after approval is rejected before the click', options, async t => {
  const fixture = await startBrowserFixture(); t.after(() => fixture.close());
  const f = access(); const browser = new ScopedBrowser({ ...f, executablePath: process.env.AGENTEXTENSION_TEST_BROWSER, origins: [fixture.origin], interactive: true }); t.after(() => browser.close());
  const state = await browser.open({ url: fixture.origin });
  browser.ask = async () => { await browser.page.locator('h1').evaluate(node => { node.textContent = 'Changed'; }); return true; };
  await assert.rejects(browser.act({ snapshot: state.snapshot, element: state.elements.find(e => e.label === 'Save test').id, action: 'click' }), /target changed/);
  assert.equal(fixture.calls.writes, 0);
});

test('real native app observation, protected fields, exact fill and press, identity mismatch and cancellation', native, async t => {
  const fixture = await startDesktop(); t.after(() => fixture.close());
  const approvals = []; const f = access(async detail => { approvals.push(detail); return true; });
  const computer = new ScopedComputer({ ...f, app: fixture.app, interactive: true }); t.after(() => computer.close());
  let state = await computer.observe();
  assert.equal(JSON.stringify(state).includes('fixture-protected-value'), false);
  const input = state.nodes.find(node => node.editable);
  assert.ok(input, JSON.stringify(state));
  await computer.act({ snapshot: state.snapshot, element: input.id, action: 'fill', text: 'Native access verified' });
  state = await computer.observe();
  const button = state.nodes.find(node => node.title === 'Confirm test');
  assert.ok(button);
  await computer.act({ snapshot: state.snapshot, element: button.id, action: 'press' });
  assert.equal(await fs.readFile(fixture.result, 'utf8'), 'Native access verified');
  assert.equal(approvals.length, 2);
  await assert.rejects(desktopRequest({ command: 'observe', app: { ...fixture.app, started: 'wrong-start' } }), /instance changed/);
  f.controller.abort(); await assert.rejects(computer.observe());
});

test('one approved visit outside the scope is read-only, ends on the next open, expires, and follows permission rules', options, async t => {
  const { PolicyEngine } = require('../src/policy');
  const fixture = await startBrowserFixture(); t.after(() => fixture.close());
  const approvals = [];
  let answer = false;
  const f = access(async detail => { approvals.push(detail); return answer; });
  const browser = new ScopedBrowser({ ...f, executablePath: process.env.AGENTEXTENSION_TEST_BROWSER, origins: [fixture.origin], interactive: true });
  t.after(() => browser.close());
  await browser.open({ url: fixture.origin });
  await assert.rejects(browser.visitOnce({ url: `${fixture.outsideUrl}/guide`, reason: 'Read the linked guide' }), /not approved/);
  assert.equal(fixture.calls.escaped, 0);
  assert.match(approvals[0].detail, /Reason given by the agent: Read the linked guide/);
  answer = true;
  const visited = await browser.visitOnce({ url: `${fixture.outsideUrl}/guide`, reason: 'Read the linked guide' });
  assert.match(visited.text, /Outside approved scope/);
  assert.deepEqual(visited.visit, { origin: fixture.outsideUrl, readOnly: true, expiresInSeconds: 300 });
  assert.ok(fixture.calls.escaped >= 1);
  await assert.rejects(browser.act({ snapshot: visited.snapshot, element: 'e0', action: 'click' }), /Actions are blocked|Observe a current/);
  assert.throws(() => browser.allowed(`${fixture.outsideUrl}/form`, { write: true }), /outside/, 'No writes to the visited origin');
  // Opening an in-scope page ends the visit.
  await browser.open({ url: fixture.origin });
  assert.throws(() => browser.open({ url: fixture.outsideUrl }), /outside/);
  const escaped = fixture.calls.escaped;
  // Expiry.
  await browser.visitOnce({ url: `${fixture.outsideUrl}/again`, reason: 'Check again' });
  browser.now = () => Date.now() + 6 * 60_000;
  assert.throws(() => browser.allowed(`${fixture.outsideUrl}/again`), /outside/);
  browser.now = Date.now;
  // A third visit is allowed by rule without a prompt; a fourth hits the limit.
  const prompts = approvals.length;
  f.permissions.policy = new PolicyEngine({ user: [{ effect: 'browser.navigate', target: `${fixture.outsideUrl}/docs/*`, decision: 'allow' }] });
  await browser.visitOnce({ url: `${fixture.outsideUrl}/docs/page`, reason: 'Read docs' });
  assert.equal(approvals.length, prompts);
  assert.ok(f.permissions.events.some(event => event.tool === 'browser_visit' && event.reason === `Allowed by user rule browser.navigate ${fixture.outsideUrl}/docs/*`));
  await assert.rejects(browser.visitOnce({ url: `${fixture.outsideUrl}/docs/other`, reason: 'More' }), /Visit limit reached: 3/);
  assert.ok(fixture.calls.escaped > escaped);
  // A deny rule refuses without a prompt.
  const g = access(async () => { throw new Error('No prompt expected'); });
  g.permissions.policy = new PolicyEngine({ admin: { rules: [{ effect: 'browser.navigate', target: '*', decision: 'deny', source: 'administrator' }], userAllowRules: true, sources: ['t'] } });
  const denied = new ScopedBrowser({ ...g, executablePath: process.env.AGENTEXTENSION_TEST_BROWSER, origins: [fixture.origin] });
  t.after(() => denied.close());
  await assert.rejects(denied.visitOnce({ url: `${fixture.outsideUrl}/x`, reason: 'x' }), /permission rule denies/);
});

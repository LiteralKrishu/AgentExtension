const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const { ScopedBrowser } = require('../src/browser');
const { ScopedComputer, desktopRequest } = require('../src/computer');
const { PermissionBroker } = require('../src/permissions');
const { startBrowserFixture } = require('./fixtures/browser.cjs');
const { startDesktop } = require('./fixtures/desktop.cjs');
const options = { skip: !process.env.AGENTEXTENSION_TEST_SURFACES && 'Set AGENTEXTENSION_TEST_SURFACES=1 for real browser and macOS app tests.', timeout: 90_000 };
function access(ask = async () => true) {
  const controller = new AbortController();
  const permissions = new PermissionBroker({ workspace: '/fixture', signal: controller.signal });
  permissions.allowScope('browser.observe'); permissions.allowScope('computer.observe');
  return { controller, permissions, signal: controller.signal, ask };
}

test('dedicated browser observes approved content and blocks injected writes, off-origin frames, sockets and redirects', options, async t => {
  const fixture = await startBrowserFixture(); t.after(() => fixture.close());
  const f = access(); const browser = new ScopedBrowser({ ...f, origins: [fixture.origin] }); t.after(() => browser.close());
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
  const browser = new ScopedBrowser({ ...f, origins: [fixture.origin], interactive: true,
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
  const f = access(); const browser = new ScopedBrowser({ ...f, origins: [fixture.origin], interactive: true }); t.after(() => browser.close());
  const state = await browser.open({ url: fixture.origin });
  browser.ask = async () => { await browser.page.locator('h1').evaluate(node => { node.textContent = 'Changed'; }); return true; };
  await assert.rejects(browser.act({ snapshot: state.snapshot, element: state.elements.find(e => e.label === 'Save test').id, action: 'click' }), /target changed/);
  assert.equal(fixture.calls.writes, 0);
});

test('real native app observation, protected fields, exact fill and press, identity mismatch and cancellation', options, async t => {
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

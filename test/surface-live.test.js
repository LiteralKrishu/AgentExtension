const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { ScopedBrowser } = require('../src/browser');
const { ScopedComputer, desktopRequest } = require('../src/computer');
const { PermissionBroker } = require('../src/permissions');
const { startBrowserFixture } = require('./fixtures/browser.cjs');
const { startDesktop } = require('./fixtures/desktop.cjs');
const options = { skip: !process.env.AGENTEXTENSION_TEST_SURFACES && 'Set AGENTEXTENSION_TEST_SURFACES=1 for real browser and macOS app tests.', timeout: 90_000 };
// The native app test needs the macOS helper. AGENTEXTENSION_TEST_BROWSER sets a Chrome or Chromium executable.
const native = { ...options, skip: options.skip || (process.platform !== 'darwin' && 'The native app test needs macOS.')
  || (!require('node:fs').existsSync(require('node:path').join(__dirname, '../native/agentextension-desktop')) && 'Run npm run build:native first.') };
function access(ask = async () => true) {
  const controller = new AbortController();
  const permissions = new PermissionBroker({ workspace: '/fixture', signal: controller.signal });
  permissions.allowScope('browser.observe'); permissions.allowScope('computer.observe');
  return { controller, permissions, signal: controller.signal, ask };
}
async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await sleep(25);
  }
  assert.fail('Fixture did not reach the expected state.');
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

test('dedicated browser downloads bind one observed link to one reviewed workspace path', options, async t => {
  const { Draft } = require('../src/draft');
  const { Workspace } = require('../src/workspace');
  const { openBridge } = require('../src/bridge');
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const fixture = await startBrowserFixture(); t.after(() => fixture.close());
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ae-download-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = new Workspace(root);
  const draft = new Draft((file, create) => workspace.read(file, create));
  const f = access();
  const browser = new ScopedBrowser({ ...f, executablePath: process.env.AGENTEXTENSION_TEST_BROWSER, origins: [fixture.origin], interactive: true, workspace,
    stageDownload: async (file, text, bytes, check) => {
      await draft.create(file, text, check);
      return { staged: file, bytes, revision: draft.revision };
    } });
  t.after(() => browser.close());
  const reviewed = [];
  const run = { ...f, browser, draft, workspace, planFirst: true, onDraft: revision => reviewed.push(revision) };
  const bridge = await openBridge(run);
  const client = new Client({ name: 'download-check', version: '1.0.0' });
  t.after(async () => { await client.close(); bridge.close(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), {
    requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } },
  }));
  const open = () => browser.open({ url: `${fixture.origin}/transfers` });
  let state = await open();
  const args = (label, file = 'download.txt') => ({ snapshot: state.snapshot, element: state.elements.find(e => e.label === label)?.id ?? 'e0', file });
  const tool = arguments_ => client.callTool({ name: 'browser_download', arguments: arguments_ });
  assert.match((await tool(args('Text'))).content[0].text, /plan approval/);
  run.approvedPlan = {};
  browser.ask = async () => false;
  assert.match((await tool(args('Text'))).content[0].text, /not approved/);
  assert.equal(fixture.calls.downloads, 0);
  browser.ask = async () => { await browser.page.locator('a').first().evaluate(link => link.replaceWith(link.cloneNode(true))); return true; };
  await assert.rejects(browser.download(args('Text')), /link changed/);
  assert.equal(fixture.calls.downloads, 0);
  state = await open();
  const approvals = [];
  browser.ask = async detail => { approvals.push(detail); return true; };
  await fs.writeFile(path.join(root, 'existing.txt'), 'do not replace');
  await assert.rejects(browser.download(args('Text', 'existing.txt')), /already exists/);
  await assert.rejects(browser.download(args('Text', '../escape.txt')), /workspace-relative/);
  await assert.rejects(browser.download(args('External')), /outside|current page origin/);
  assert.equal(approvals.length, 0);
  await assert.rejects(browser.download(args('Redirect')), /direct attachment/);
  assert.equal(fixture.calls.escaped, 0);
  await assert.rejects(browser.download(args('Text', 'wrong.json')), /destination file type/);
  await assert.rejects(browser.download(args('Large')), /size limit exceeded/);
  await assert.rejects(browser.download(args('Invalid')), /UTF-8/);
  const result = await tool(args('Text'));
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.deepEqual(JSON.parse(result.content[0].text), { staged: 'download.txt', bytes: 20, revision: 1 });
  assert.match(approvals.at(-1).detail, /attachment\/text\nWorkspace file: download\.txt/);
  assert.deepEqual(reviewed, [1]);
  const hunks = draft.review();
  assert.equal(hunks.length, 1);
  assert.deepEqual(draft.changes([]), []);
  assert.equal(draft.changes(hunks)[0].after, 'Approved attachment\n');
  await assert.rejects(fs.stat(path.join(root, 'download.txt')), { code: 'ENOENT' });
  assert.equal((await fs.readdir(root)).length, 1);

  const cancelled = new AbortController();
  const first = assert.rejects(browser.download(args('Slow', 'cancelled.txt'), cancelled.signal), /abort|cancel/i);
  await waitFor(() => fixture.calls.slowDownloads === 1);
  cancelled.abort();
  await first;
  await waitFor(() => fixture.calls.closedDownloads === 1);
  const second = assert.rejects(browser.download(args('Slow', 'revoked.txt')), /permission changed/);
  await waitFor(() => fixture.calls.slowDownloads === 2);
  f.permissions.deny('browser.download');
  await second;
  await waitFor(() => fixture.calls.closedDownloads === 2);
  assert.equal(draft.revision, 1);
  state = await browser.visitOnce({ url: fixture.outsideUrl, reason: 'Check visit scope' });
  await assert.rejects(browser.download(args('Text')), /outside the selected origins/);
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

test('macOS increments one addressed slider and stops on cancellation, revocation or an identical replacement window', native, async t => {
  const fixture = await startDesktop(); t.after(() => fixture.close());
  const f = access();
  const computer = new ScopedComputer({ ...f, app: fixture.app, interactive: true }); t.after(() => computer.close());
  const slider = state => state.nodes.find(node => node.role === 'AXSlider');
  const increment = state => ({ snapshot: state.snapshot, element: slider(state).id, action: 'increment' });
  let state = await computer.observe();
  assert.equal(slider(state)?.increment, true, JSON.stringify(slider(state)));
  assert.equal(slider(state).value, 2);
  computer.ask = async () => false;
  await assert.rejects(computer.act(increment(state)), /not approved/);
  const request = new AbortController();
  computer.ask = async () => { request.abort(); return true; };
  await assert.rejects(computer.act(increment(state), request.signal));
  state = await computer.observe();
  assert.equal(slider(state).value, 2);
  computer.ask = async () => { f.permissions.reset(); return true; };
  await assert.rejects(computer.act(increment(state)), /permission changed/);
  state = await computer.observe();
  assert.equal(slider(state).value, 2);
  computer.ask = async () => {
    await fs.writeFile(fixture.switchFile, '');
    await waitFor(() => fs.stat(`${fixture.switchFile}.ready`).catch(() => false));
    await waitFor(async () => {
      const fresh = await desktopRequest({ command: 'observe', app: fixture.app }).catch(() => undefined);
      return fresh?.snapshot === state.snapshot;
    });
    return true;
  };
  await assert.rejects(computer.act(increment(state)), /window or control changed/);
  const replacement = await computer.observe();
  assert.equal(replacement.snapshot, state.snapshot);
  computer.ask = async detail => { assert.match(detail.detail, /Current value: 2\nRange: 0 to 4/); return true; };
  await computer.act(increment(replacement));
  state = await computer.observe();
  assert.equal(slider(state).value, 3);
  computer.close();
  await assert.rejects(computer.act(increment(state)), /stopped/);
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

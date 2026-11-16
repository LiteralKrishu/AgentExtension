const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ReadConnectors, secretKey } = require('../src/connectors');
const { PermissionBroker } = require('../src/permissions');
const { startHost } = require('./helpers/host.cjs');
const { startOAuthFixture } = require('./fixtures/connector-oauth.cjs');

const network = { skip: !process.env.AGENTEXTENSION_TEST_FORGE_URL && 'Enable the local integration suite.', timeout: 20_000 };

test('OAuth verifies the selected account, refreshes its approval identity, and revokes it on account switch and sign-out', network, async t => {
  const f = await startOAuthFixture(t);
  const signal = new AbortController().signal;
  const signIn = confirm => f.accounts.signIn(f.config, { signal, openBrowser: f.openBrowser, confirm });
  await signIn(async account => { assert.equal(account.subject, 'account-one'); return true; });
  const key = secretKey(f.config);
  const savedIdentity = await f.secrets.get(key);
  assert.doesNotMatch(savedIdentity, /access-|refresh-|id_token/);
  const broker = new PermissionBroker({ workspace: '/fixture', signal });
  const tools = new ReadConnectors({ configs: [f.config], accounts: f.accounts, secrets: f.secrets, permissions: broker, signal });
  const input = { connector: 'docs', tool: 'read_doc', arguments: { document: 'manual' } };
  const initial = await tools.prepare(input);
  broker.grant(initial.action);
  const result = await tools.read(input);
  assert.match(result.text, /Read manual/);
  assert.match(result.text, /credential removed/);
  assert.doesNotMatch(JSON.stringify({ result, audit: broker.events }), /access-|refresh-|account-one|id_token/);
  assert.equal(f.state.refreshes, 1);
  assert.equal(f.state.calls, 1);
  assert.deepEqual((await tools.prepare(input)).action, initial.action);
  assert.equal(await f.secrets.get(key), savedIdentity);

  f.state.subject = 'account-two';
  assert.equal(await signIn(async () => false), undefined);
  assert.equal(await f.secrets.get(key), savedIdentity);
  await signIn(async account => { assert.equal(account.subject, 'account-two'); return true; });
  broker.grant(initial.action);
  await assert.rejects(tools.read(input), /Permission denied/);
  const nextIdentity = await f.secrets.get(key);
  f.state.refreshSubject = 'different-account';
  await assert.rejects(f.accounts.access(f.config, nextIdentity, signal), /same account and scope/);
  f.state.refreshSubject = undefined;
  f.state.refreshScope = 'openid docs.read docs.write';
  await assert.rejects(f.accounts.access(f.config, nextIdentity, signal), /same account and scope/);
  assert.equal(await f.secrets.get(key), nextIdentity);
  assert.equal(f.state.calls, 1);
  await f.accounts.signOut(f.config);
  assert.equal(f.values.size, 0);
  await assert.rejects(tools.prepare(input), /Sign in/);
  assert.ifError(f.state.error);
});

test('cancelling OAuth sign-in closes its callback and saves no credentials', network, async t => {
  const f = await startOAuthFixture(t);
  const controller = new AbortController();
  let redirect;
  await assert.rejects(f.accounts.signIn(f.config, { signal: controller.signal,
    openBrowser: async url => { redirect = url.searchParams.get('redirect_uri'); controller.abort(); return true; },
    confirm: async () => assert.fail('Cancelled sign-in must not reach account confirmation'),
  }), { name: 'AbortError' });
  assert.equal(f.values.size, 0);
  await assert.rejects(fetch(redirect));
});

test('an authorization failure during initialization refreshes once before sending the tool call', network, async t => {
  const f = await startOAuthFixture(t);
  f.state.omitExpiry = true;
  const signal = new AbortController().signal;
  await f.accounts.signIn(f.config, { signal, openBrowser: f.openBrowser, confirm: async () => true });
  f.state.accessToken = 'different-current-token';
  const broker = new PermissionBroker({ workspace: '/fixture', signal });
  const tools = new ReadConnectors({ configs: [f.config], accounts: f.accounts, secrets: f.secrets, permissions: broker, signal });
  const input = { connector: 'docs', tool: 'read_doc', arguments: { document: 'manual' } };
  broker.grant((await tools.prepare(input)).action);
  assert.match((await tools.read(input)).text, /Read manual/);
  assert.equal(f.state.refreshes, 1);
  assert.equal(f.state.calls, 1);
  assert.ifError(f.state.error);
});

test('VS Code verifies the account before storing it and applies account policy before sign-out', network, async t => {
  const f = await startOAuthFixture(t);
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-oauth-ui-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const host = await startHost(t, { root, settings: { readConnectors: [f.config] } });
  host.vscode.ProgressLocation = { Notification: 15 };
  host.vscode.window.withProgress = (_options, work) => work({}, { onCancellationRequested: () => ({ dispose() {} }) });
  host.vscode.env.openExternal = uri => f.openBrowser(new URL(uri.toString()));
  const key = secretKey(f.config);
  host.answers.push({ kind: 'pick', value: items => items[0] }, { kind: 'pick', value: items => items.find(item => item.signIn) },
    { kind: 'modal', value: async () => {
      assert.match(host.shown.warning.at(-1).detail, /Account: account-one\nScopes: docs.read, openid/);
      assert.equal(await host.context.secrets.get(key), undefined);
      return 'Use account';
    } });
  await host.send({ type: 'connector-token' });
  await host.waitFor(state => /^Signed in to docs as account-one/.test(state.status ?? ''), 5_000, 'account stored');
  const identity = await host.context.secrets.get(key);
  assert.ok(identity);

  host.settings.permissionRules = [{ effect: 'connector.account', target: 'docs/*', decision: 'deny' }];
  host.answers.push({ kind: 'pick', value: items => items[0] });
  await host.send({ type: 'connector-token' });
  await host.waitFor(state => /account action is unavailable/.test(state.status ?? ''), 5_000, 'account policy applied');
  assert.equal(await host.context.secrets.get(key), identity);
  host.settings.permissionRules = [];
  host.answers.push({ kind: 'pick', value: items => items[0] }, { kind: 'pick', value: items => items.find(item => !item.signIn) },
    { kind: 'modal', value: 'Sign out' });
  await host.send({ type: 'connector-token' });
  await host.waitFor(state => /Connector account signed out/.test(state.status ?? ''), 5_000, 'account removed');
  assert.equal(await host.context.secrets.get(key), undefined);
  assert.equal(host.secrets.size, 0);
  assert.deepEqual(host.shown.errors, []);
});

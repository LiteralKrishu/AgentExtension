const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { ScheduleStore } = require('../src/schedules');
const { secretKey } = require('../src/connectors');
const { startHost, scriptedModel } = require('./helpers/host.cjs');
const { startReadServer } = require('./fixtures/read-server.cjs');
const { startOAuthFixture } = require('./fixtures/connector-oauth.cjs');

const baseUrl = process.env.AGENTEXTENSION_TEST_FORGE_URL;
const live = { skip: !baseUrl || !process.getuid ? 'Requires local TrueForge and a POSIX host.' : false, timeout: 90_000 };
const cli = process.env.AGENTEXTENSION_BACKGROUND_CLI ?? path.join(__dirname, '../src/background-cli.js');

function runner(storage, action, args = [], input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, action, storage, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.on('error', reject);
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { output += bytes; });
    child.stdin.on('error', reject);
    child.stdin.end(input);
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(output)));
  });
}

async function backgroundOAuthFixture(t) {
  const f = await startOAuthFixture(t);
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-background-oauth-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'sample.txt'), 'Background OAuth fixture.');
  const model = await scriptedModel(t, baseUrl, ({ all, tools, round, call, say }) => {
    assert.match(all, /SCHEDULED READ-ONLY REPORT MODE/);
    assert.doesNotMatch(all, /access-account|refresh-background|refresh-account|id_token/);
    assert.ok(!tools.some(name => /propose|command|connector_write/.test(name)));
    if (round === 0) return call('connector_read', { connector: 'docs', tool: 'read_doc', arguments: { document: 'manual' } });
    return say('OAuth fixture report.');
  });
  const host = await startHost(t, { root, settings: {
    serverUrl: baseUrl, model: model.model, fallbackModel: '', readConnectors: [f.config],
    turnTimeoutSeconds: 60, compaction: true, scheduledReports: true,
  } });
  host.vscode.ProgressLocation = { Notification: 15 };
  host.vscode.window.withProgress = (_options, work) => work({}, { onCancellationRequested: () => ({ dispose() {} }) });
  host.vscode.env.openExternal = uri => f.openBrowser(new URL(uri.toString()));
  const signIn = async () => {
    host.answers.push({ kind: 'pick', value: items => items[0] }, { kind: 'pick', value: items => items.find(item => item.signIn) },
      { kind: 'modal', value: 'Use account' });
    await host.send({ type: 'connector-token' });
  };
  await signIn();
  const originalIdentity = await host.context.secrets.get(secretKey(f.config));
  host.answers.push(
    { kind: 'pick', value: items => items.find(item => item.create) },
    { kind: 'input', value: 'OAuth background' }, { kind: 'input', value: 'Read the fixture manual.' },
    { kind: 'pick', value: items => items.find(item => item.label === 'Every day') },
    { kind: 'input', value: '09:00' }, { kind: 'input', value: 'UTC' }, { kind: 'pick', value: items => items },
    { kind: 'pick', value: items => items.find(item => item.label === 'Small') },
    { kind: 'pick', value: () => [] }, { kind: 'modal', value: 'Approve schedule' });
  await host.command('scheduledReports');
  const store = new ScheduleStore(host.storage, root);
  const [original] = await store.list();
  const authorize = async (subject = f.state.subject) => {
    host.answers.push({ kind: 'pick', value: items => items.find(item => item.schedule?.id === original.id) },
      { kind: 'pick', value: items => items.find(item => item.id === 'background') },
      { kind: 'pick', value: items => items.find(item => item.id === 'approve') },
      { kind: 'input', value: '' }, { kind: 'modal', value: () => {
        assert.ok(host.shown.warning.at(-1).detail.includes(`Verified OAuth account for docs: ${subject}`));
        assert.match(host.shown.warning.at(-1).detail, /Scopes: docs.read, openid/);
        return 'Approve schedule';
      } });
    await host.command('scheduledReports');
    return (await store.list())[0];
  };
  return { ...f, host, store, model, original, originalIdentity, authorize, signIn };
}

test('the packaged runner refreshes a separate rotating OAuth grant without changing its approved account or scope', live, async t => {
  const f = await backgroundOAuthFixture(t);
  f.state.backgroundSubject = 'wrong-account';
  await assert.rejects(f.authorize(), /signed-in connector account and the same scopes/);
  f.state.backgroundSubject = undefined;
  f.state.reuseEditorGrant = true;
  await assert.rejects(f.authorize(), /separate refresh token/);
  f.state.reuseEditorGrant = false;
  assert.equal((await f.store.list())[0].background, undefined);
  const schedule = await f.authorize();
  const storage = f.host.storage;
  const { BackgroundCredentials } = require('../src/background-runner');
  const credentials = new BackgroundCredentials(f.store, schedule);
  const file = path.join(credentials.oauthDirectory, secretKey(f.config));
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.doesNotMatch(await fs.readFile(f.store.file, 'utf8'), /refresh-|access-|account-one|id_token/);
  const initial = await credentials.readOAuth(f.config);
  assert.equal(initial.raw, f.originalIdentity);
  assert.match(initial.record.tokens.refresh_token, /^refresh-background-/);
  for (const subscription of f.host.context.subscriptions) subscription.dispose?.();

  assert.match(await runner(storage, 'run-now', [schedule.id]), /OAuth background: completed/);
  const first = await credentials.readOAuth(f.config);
  assert.equal(first.raw, initial.raw);
  assert.notEqual(first.record.tokens.refresh_token, initial.record.tokens.refresh_token);
  f.state.accessToken = 'fixture-invalidates-the-first-access-token';
  f.state.omitRefreshIdentity = true;
  assert.match(await runner(storage, 'run-now', [schedule.id]), /OAuth background: completed/);
  assert.notEqual((await credentials.readOAuth(f.config)).record.tokens.refresh_token, first.record.tokens.refresh_token);
  assert.equal((await f.store.list())[0].approval.digest, schedule.approval.digest);
  assert.equal(f.state.refreshes, 2);
  assert.equal(f.state.calls, 2);
  assert.ifError(f.model.state.error);
  assert.ifError(f.state.error);
  for (const row of await f.store.history(schedule.id)) {
    assert.doesNotMatch(await fs.readFile(row.report, 'utf8'), /refresh-|access-account-|id_token/);
  }
  await runner(storage, 'revoke', [schedule.id]);
  await assert.rejects(fs.stat(credentials.oauthDirectory), { code: 'ENOENT' });
  await assert.rejects(runner(storage, 'run-now', [schedule.id]), /Resume this schedule/);
});

test('background OAuth fails closed on issuer, scope, or account changes and during an in-flight refresh after revocation', live, async t => {
  const f = await backgroundOAuthFixture(t);
  const storage = f.host.storage;
  const { BackgroundCredentials } = require('../src/background-runner');
  for (const [field, value] of [['refreshSubject', 'wrong-account'], ['refreshScope', 'openid docs.read docs.write'], ['rejectRefresh', true]]) {
    const schedule = await f.authorize();
    f.state[field] = value;
    assert.match(await runner(storage, 'run-now', [schedule.id]), /OAuth background: blocked/);
    assert.equal((await f.store.list())[0].needsReview, true);
    assert.equal(f.state.calls, 0);
    f.state[field] = undefined;
  }

  const schedule = await f.authorize();
  const credentials = new BackgroundCredentials(f.store, schedule);
  let entered;
  let resume;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { resume = resolve; });
  t.after(resume);
  f.state.beforeBackgroundRefresh = () => { entered(); return held; };
  const pending = runner(storage, 'run-now', [schedule.id]);
  pending.catch(() => {});
  await Promise.race([started, pending.then(() => assert.fail('Runner ended before refreshing'))]);
  // A second runner cannot use the in-flight rotating grant.
  assert.match(await runner(storage, 'run-now', [schedule.id]), /OAuth background: failed/);
  f.state.subject = 'account-two';
  await f.signIn();
  assert.equal((await f.store.list())[0].backgroundRevoked, true);
  resume();
  assert.match(await pending, /OAuth background: blocked/);
  await assert.rejects(fs.stat(credentials.oauthDirectory), { code: 'ENOENT' });
  assert.equal(f.state.calls, 0);

  const replacement = await f.authorize('account-two');
  assert.equal(replacement.enabled, true);
  assert.notEqual(replacement.approval.digest, schedule.approval.digest);
  assert.doesNotMatch(await fs.readFile(f.store.file, 'utf8'), /account-two/);
  f.host.answers.push({ kind: 'pick', value: items => items[0] }, { kind: 'pick', value: items => items.find(item => !item.signIn) },
    { kind: 'modal', value: 'Sign out' });
  await f.host.send({ type: 'connector-token' });
  assert.equal((await f.store.list())[0].backgroundRevoked, true);
  await assert.rejects(fs.stat(new BackgroundCredentials(f.store, replacement).oauthDirectory), { code: 'ENOENT' });
  await assert.rejects(runner(storage, 'run-now', [replacement.id]), /Resume this schedule/);
  assert.ifError(f.model.state.error);
  assert.ifError(f.state.error);
});

test('a separate runner completes while the editor is closed, owns the occurrence, and records webhook failure separately', live, async t => {
  const area = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-background-')));
  t.after(() => fs.rm(area, { recursive: true, force: true }));
  const root = path.join(area, 'workspace');
  const storage = path.join(area, 'storage');
  const skillRoot = path.join(area, 'skills');
  await fs.mkdir(root);
  await fs.mkdir(storage, { mode: 0o700 });
  await fs.mkdir(path.join(skillRoot, 'schedule-check'), { recursive: true });
  await fs.writeFile(path.join(skillRoot, 'schedule-check', 'SKILL.md'), '---\nname: schedule-check\ndescription: Review saved files\n---\nSelected background instructions.');
  await fs.writeFile(path.join(root, 'sample.txt'), 'The background runner uses saved text.');
  await fs.writeFile(path.join(root, '.env'), 'PRIVATE_FIXTURE_TEXT');
  const connector = await startReadServer();
  t.after(() => connector.close());

  let available = true;
  const payloads = [];
  const sink = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    payloads.push({ method: req.method, url: req.url, payload: JSON.parse(Buffer.concat(chunks)) });
    res.writeHead(available ? 204 : 503).end();
  });
  await new Promise(resolve => sink.listen(0, '127.0.0.1', resolve));
  t.after(() => { sink.close(); sink.closeAllConnections(); });
  const destination = `http://127.0.0.1:${sink.address().port}/status`;

  let enter;
  let resume;
  const started = new Promise(resolve => { enter = resolve; });
  const hold = new Promise(resolve => { resume = resolve; });
  t.after(() => resume());
  let waiting = true;
  const model = await scriptedModel(t, baseUrl, async ({ all, tools, round, call, say }) => {
    assert.match(all, /SCHEDULED READ-ONLY REPORT MODE/);
    assert.match(all, /Selected background instructions/);
    assert.doesNotMatch(all, /PRIVATE_FIXTURE_TEXT/);
    assert.ok(!all.includes(connector.token));
    assert.ok(!tools.some(name => /propose|command|connector_write|browser|computer/.test(name)));
    if (round === 0 && waiting) { waiting = false; enter(); await hold; }
    if (round === 0) return call('read_file', { file: 'sample.txt' });
    if (round === 1) {
      assert.match(all, /The background runner uses saved text/);
      return call('connector_read', { connector: 'docs', tool: 'read_doc', arguments: { document: 'manual' } });
    }
    assert.match(all, /Fixture document manual/);
    return say('Background report complete.');
  });
  const settings = { serverUrl: baseUrl, model: model.model, fallbackModel: '', readConnectors: [connector.config],
    skillRoots: [skillRoot], turnTimeoutSeconds: 60, compaction: true, scheduledReports: true };
  const storedSecrets = [[secretKey(connector.config), connector.token]];
  const editor = await startHost(t, { root, settings, storage, storedSecrets });
  const at = Date.now() - 5 * 60_000;
  const time = new Date(at).toISOString().slice(11, 16);
  editor.answers.push(
    { kind: 'pick', value: items => items.find(item => item.create) },
    { kind: 'input', value: 'Background fixture' }, { kind: 'input', value: 'Read the saved sample and manual.' },
    { kind: 'pick', value: items => items.find(item => item.label === 'Every day') },
    { kind: 'input', value: time }, { kind: 'input', value: 'UTC' }, { kind: 'pick', value: items => items },
    { kind: 'pick', value: items => items.find(item => item.label === 'Small') },
    { kind: 'pick', value: items => items.filter(item => item.label === 'schedule-check') },
    { kind: 'modal', value: 'Approve schedule' });
  await editor.command('scheduledReports');
  const store = new ScheduleStore(storage, root);
  const [initial] = await store.list();
  editor.answers.push({ kind: 'pick', value: items => items.find(item => item.schedule?.id === initial.id) },
    { kind: 'pick', value: items => items.find(item => item.id === 'background') },
    { kind: 'pick', value: items => items.find(item => item.id === 'approve') },
    { kind: 'input', value: destination },
    { kind: 'modal', value: () => {
      const detail = editor.shown.warning.at(-1).detail;
      assert.ok(detail.includes(destination));
      assert.match(detail, /Payload preview.*"outcome":"completed","report":"reports\//);
      assert.ok(!detail.includes(connector.token));
      return 'Approve schedule';
    } });
  await editor.command('scheduledReports');
  const [enrolled] = await store.list();
  assert.equal(enrolled.background.webhook, destination);
  assert.notEqual(enrolled.approval.digest, initial.approval.digest);
  assert.ok(!(await fs.readFile(store.file, 'utf8')).includes(connector.token));
  assert.match(await runner(storage, 'status'), /enabled.*Background fixture/);
  await assert.rejects(runner(storage, 'token', [enrolled.id, 'docs'], 'wrong-token'), /does not match/);
  await runner(storage, 'token', [enrolled.id, 'docs'], connector.token + '\n');
  const { BackgroundCredentials } = require('../src/background-runner');
  const credentials = new BackgroundCredentials(store, enrolled);
  assert.equal((await fs.stat(path.join(credentials.directory, secretKey(connector.config)))).mode & 0o777, 0o600);

  // Dispose the editor timer, then make an occurrence due. The child process opens its own TrueForge session.
  for (const subscription of editor.context.subscriptions) subscription.dispose?.();
  await store.update(enrolled.id, { cursor: at - 90_000 });
  const tick = runner(storage, 'tick');
  tick.catch(() => {});
  await Promise.race([started, tick.then(() => assert.fail('Runner stopped before reaching the model.'))]);
  const reopened = await startHost(t, { root, settings, storage, storedSecrets });
  await reopened.waitFor(state => state.scheduleSummary?.includes('assigned to the background runner'), 10_000);
  resume();
  assert.match(await tick, /Background fixture: completed/);
  assert.ifError(model.state.error);
  let history = await store.history(enrolled.id);
  assert.equal(history.length, 1);
  assert.equal(history[0].trigger, 'catch-up');
  assert.equal(history[0].notification.status, 'delivered');
  assert.equal(payloads.length, 1);
  assert.deepEqual(payloads[0], { method: 'POST', url: '/status', payload: { outcome: 'completed',
    report: path.relative(storage, history[0].report).split(path.sep).join('/') } });
  reopened.answers.push({ kind: 'pick', value: items => items.find(item => item.schedule?.id === enrolled.id) },
    { kind: 'pick', value: items => items.find(item => item.id === 'history') }, { kind: 'pick', value: items => items[0] });
  await reopened.command('scheduledReports');
  assert.equal(reopened.shown.documents.at(-1), history[0].report);

  available = false;
  await runner(storage, 'run-now', [enrolled.id]);
  history = await store.history(enrolled.id);
  assert.equal(history[0].status, 'completed');
  assert.deepEqual(history[0].notification, { status: 'failed', reason: 'Webhook returned HTTP 503.' });
  assert.match(await fs.readFile(history[0].report, 'utf8'), /Background report complete/);
  assert.equal(connector.calls(), 2);
  for (const subscription of reopened.context.subscriptions) subscription.dispose?.();
  await runner(storage, 'revoke', [enrolled.id]);
  await assert.rejects(fs.stat(credentials.directory), { code: 'ENOENT' });
  assert.match(await runner(storage, 'status'), /revoked/);
  await assert.rejects(runner(storage, 'run-now', [enrolled.id]), /Resume this schedule/);
  await runner(storage, 'tick');
  assert.equal((await store.history(enrolled.id)).length, 2);
  assert.equal(connector.calls(), 2);
});

test('a TrueForge-managed connector still depends on a live scoped workspace bridge and its credential', live, async t => {
  const { TrueForge } = await import('@truefoundry/trueforge-sdk');
  const { openBridge } = require('../src/bridge');
  const { PermissionBroker } = require('../src/permissions');
  const { Draft } = require('../src/draft');
  const forge = new TrueForge({ baseUrl, maxRetries: 0 });
  const controller = new AbortController();
  const permissions = new PermissionBroker({ workspace: '/fixture', signal: controller.signal });
  permissions.allowScope('workspace.read');
  const read = async () => 'Workspace bridge fixture.';
  const bridge = await openBridge({
    readOnly: true, permissions, signal: controller.signal, workspace: { read }, draft: new Draft(read), search: async () => [],
  });
  t.after(() => bridge.close());
  const random = randomBytes(6).toString('hex');
  const name = `workspace-probe-${random}`;
  const denied = `workspace-denied-${random}`;
  const register = async (name, token) => forge.settings.mcpServers.create({
    manifest: { name, url: bridge.url, type: 'remote', description: 'Scoped workspace access fixture',
      auth: { type: 'header', headers: { Authorization: `Bearer ${token}` } } },
  });
  t.after(() => Promise.allSettled([forge.settings.mcpServers.delete(name), forge.settings.mcpServers.delete(denied)]));
  await register(name, bridge.token);
  const tools = (await forge.mcpServers.listTools(name)).data;
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['read_file', 'search_workspace']);
  await assert.rejects(async () => { await register(denied, 'wrong-credential'); await forge.mcpServers.listTools(denied); });

  const model = await scriptedModel(t, baseUrl, ({ all, tools, round, call, say }) => {
    assert.ok(!all.includes(bridge.token));
    assert.ok(!tools.some(tool => /command|propose/.test(tool)));
    if (round === 0) return call('read_file', { file: 'sample.txt' });
    assert.match(all, /Workspace bridge fixture/);
    return say('Hosted connector reached the local workspace bridge.');
  });
  const { data: session } = await forge.sessions.create({ agent: { spec: {
    model: { name: model.model }, config: { iterationLimit: 3 }, instructions: 'Read the authorized fixture file.',
    mcpServers: [{ name, preload: true, enableTools: ['read_file'], requireApprovalForTools: [] }],
  } } });
  const stream = await forge.sessions.createTurnStream(session.id, { input: [{ type: 'user.message', content: 'Read sample.txt.' }] });
  for await (const _event of stream.withMetadata()) { /* Drain the hosted turn. */ }
  assert.ifError(model.state.error);
  assert.equal(model.state.requests.length, 2);

  controller.abort();
  await assert.rejects(forge.mcpServers.listTools(name));
  bridge.close();
  await assert.rejects(forge.mcpServers.listTools(name));
});

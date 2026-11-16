const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AuditLog } = require('../src/audit');
const { loadManagedPolicy, syncOrganizationAudit, tokenHash, organizationWorkspace } = require('../src/organization');
const { createOrganizationService } = require('../src/organization-service');
const { PolicyEngine } = require('../src/policy');
const { PermissionBroker, digest } = require('../src/permissions');
const { startHost, scriptedModel } = require('./helpers/host.cjs');

const baseUrl = process.env.AGENTEXTENSION_TEST_FORGE_URL;
const live = { skip: !baseUrl && 'Set AGENTEXTENSION_TEST_FORGE_URL.', timeout: 60_000 };

async function fixture(t, now = Date.now) {
  const area = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-organization-')));
  t.after(() => fs.rm(area, { recursive: true, force: true }));
  const root = path.join(area, 'workspace');
  await fs.mkdir(root);
  const workspace = organizationWorkspace(root);
  const other = 'a'.repeat(16);
  const writer = 'test-organization-writer-secret';
  const reader = 'test-organization-reader-secret';
  const configFile = path.join(area, 'service.json');
  const policyFile = path.join(area, 'policy.json');
  const tokenFile = path.join(area, 'credential');
  await fs.writeFile(tokenFile, writer, { mode: 0o600 });
  const config = {
    clients: [{ id: 'installation', tokenHash: tokenHash(writer), workspaces: [workspace], writeAudit: true },
      { id: 'auditor', tokenHash: tokenHash(reader), workspaces: [workspace], readAudit: true }],
    policies: { [workspace]: { version: 1, rules: [] } }, retentionDays: 1,
  };
  const writeConfig = () => fs.writeFile(configFile, JSON.stringify(config));
  await writeConfig();
  const service = createOrganizationService({ configFile, storage: path.join(area, 'collector'), now });
  await new Promise((resolve, reject) => {
    service.once('error', reject);
    service.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${service.address().port}`;
  const close = () => { service.close(); service.closeAllConnections(); };
  t.after(close);
  await fs.writeFile(policyFile, JSON.stringify({ version: 1, rules: [], organization: { url, tokenFile, workspaces: [workspace], audit: true } }));
  const request = (route, { token = reader, method = 'GET', body, key = workspace } = {}) => {
    const target = new URL(route, url);
    target.searchParams.set('workspace', key);
    return fetch(target, { method, headers: { Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
  };
  return { area, root, workspace, other, writer, tokenFile, policyFile, config, writeConfig, request, close };
}

test('managed administrator policy refreshes, invalidates grants, and fails closed on malformed or offline reads', async t => {
  const f = await fixture(t);
  const options = { files: [f.policyFile] };
  const loadPolicy = async () => new PolicyEngine({ admin: await loadManagedPolicy(f.root, options),
    user: [{ effect: 'command.execute', target: 'node --version', decision: 'allow' }] });
  const broker = new PermissionBroker({ workspace: f.root, policy: await loadPolicy(), loadPolicy });
  const action = broker.action('run_command', 'command.execute', 'node --version');
  assert.ok(broker.grant(action));
  f.config.policies[f.workspace] = { version: 1, rules: [{ effect: 'command.execute', target: 'node *', decision: 'deny' }] };
  await f.writeConfig();
  await broker.refreshPolicy();
  assert.equal(broker.decide('command.execute', 'node --version').source, 'administrator');
  assert.equal(broker.decide('command.execute', 'node --version').decision, 'deny');
  assert.throws(() => broker.require(action), /Permission denied/);
  assert.equal((await f.request('/v1/policy', { key: f.other })).status, 403);
  const unenrolled = await loadManagedPolicy(path.join(f.area, 'unregistered'), options);
  assert.deepEqual(unenrolled.rules, []);
  f.config.policies[f.workspace] = { version: 1, rules: [{ effect: 'made-up', decision: 'deny' }] };
  await f.writeConfig();
  await assert.rejects(loadPolicy(), /Managed policy could not be verified/);
  await assert.rejects(loadManagedPolicy(f.root, { ...options, fetchFn: async () => Response.json({ version: 5 }) }), /Managed policy is malformed/);
  f.close();
  await assert.rejects(broker.refreshPolicy(), /service is unavailable/);
});

test('collector verifies redaction and chain continuity, deduplicates a lost receipt, and enforces workspace access and retention', async t => {
  let time = Date.now();
  const f = await fixture(t, () => time);
  const log = new AuditLog(f.area, f.root);
  await log.append({ runId: 'run-1', target: digest('private-command-argument'), tool: 'run_command', effect: 'command.execute', decision: 'deny',
    reason: 'Denied by administrator rule command.execute private-command-argument', privatePayload: 'never-upload-this-field' });
  let lostReceipt = true;
  const options = { files: [f.policyFile], fetchFn: async (url, request) => {
    const response = await fetch(url, request);
    if (lostReceipt) {
      lostReceipt = false;
      assert.equal(response.status, 200);
      await response.body.cancel();
      throw new Error('fixture dropped response after commit');
    }
    return response;
  } };
  const body = await log.export();
  assert.deepEqual(await syncOrganizationAudit(f.root, log, options), { accepted: 0, duplicates: 1 });
  const get = '/v1/audit?client=installation';
  const collected = (await (await f.request(get)).json()).events;
  assert.equal(collected.length, 1);
  assert.equal(collected[0].hash, (await log.read())[0].hash);
  assert.match(collected[0].reason, /\[target [a-f0-9]+\]/);
  assert.doesNotMatch(JSON.stringify(collected), /private-command-argument|never-upload-this-field|test-organization-writer-secret/);
  assert.equal((await f.request(get, { token: f.writer })).status, 403);
  assert.equal((await f.request(get, { key: f.other })).status, 403);
  assert.equal((await f.request('/v1/audit', { method: 'POST', body: { format: body.format, events: body.events } })).status, 403);
  const altered = { ...body.events[0], reason: 'private command contents', exportHash: '0'.repeat(64) };
  const { exportHash: _, ...fields } = altered;
  altered.exportHash = digest(fields);
  assert.equal((await f.request('/v1/audit', { token: f.writer, method: 'POST', body: { format: body.format, events: [altered] } })).status, 422);
  const { exportHash: __, ...changed } = { ...body.events[0], hash: digest('different source record') };
  assert.equal((await f.request('/v1/audit', { token: f.writer, method: 'POST',
    body: { format: body.format, events: [{ ...changed, exportHash: digest(changed) }] } })).status, 409);

  time += 2 * 86_400_000;
  assert.deepEqual((await (await f.request(get)).json()).events, []);
  assert.deepEqual(await syncOrganizationAudit(f.root, log, options), { accepted: 0, duplicates: 1 });
  assert.deepEqual((await (await f.request(get)).json()).events, []);
  const raw = await fs.readFile(log.file, 'utf8');
  await fs.writeFile(log.file, raw.replace('private-command-argument', 'modified'));
  await assert.rejects(syncOrganizationAudit(f.root, log, options), /Local audit verification failed/);
});

test('the managed editor enforces a policy update at the next command and exposes audit sync status', live, async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'sample.txt'), 'Editor workspace content.');
  const model = await scriptedModel(t, baseUrl, async ({ round, call, say }) => {
    if (round === 0) return call('read_file', { file: 'sample.txt' });
    if (round === 1) {
      f.config.policies[f.workspace] = { version: 1, rules: [{ effect: 'command.execute', target: 'node *', decision: 'deny' }] };
      await f.writeConfig();
      return call('run_command', { command: 'node', args: ['--version'] });
    }
    return say('Finished without running the command.');
  });
  const host = await startHost(t, { root: f.root, settings: { serverUrl: baseUrl, model: model.model, fallbackModel: '',
    permissionRules: [{ effect: 'command.execute', target: 'node --version', decision: 'allow' }],
    turnTimeoutSeconds: 60, compaction: true, automaticSkills: false }, env: { AGENTEXTENSION_POLICY_FILE: f.policyFile } });
  await host.send({ type: 'run', prompt: 'Read the sample and check the Node version.' });
  const result = await host.waitFor(state => !state.runActive && ['done', 'error', 'cancelled'].includes(state.phase), 30_000);
  assert.ifError(model.state.error);
  assert.equal(result.phase, 'done', result.status);
  assert.ok(result.permissions.events.some(event => event.tool === 'run_command' && event.decision === 'deny'
    && /administrator rule/.test(event.reason)));
  assert.deepEqual(result.checks, []);
  host.answers.push({ kind: 'pick', value: items => items.find(item => item.sync) });
  await host.command('syncAudit');
  await host.waitFor(state => /^Organization audit synced/.test(state.status ?? ''), 5_000);
  host.answers.push({ kind: 'pick', value: items => items.find(item => !item.sync) });
  await host.command('syncAudit');
  await host.waitFor(state => /· Organization audit synced/.test(state.status ?? ''), 5_000);
  const collected = (await (await f.request('/v1/audit?client=installation')).json()).events;
  assert.ok(collected.some(event => event.tool === 'run_command' && event.decision === 'deny'));
  assert.doesNotMatch(JSON.stringify(collected), /Editor workspace content|node \*|test-organization-writer-secret/);
  assert.deepEqual(host.answers, []);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { ContainerEnvironment } = require('../src/execution-environment');
const { openBridge } = require('../src/bridge');
const { PermissionBroker } = require('../src/permissions');
const { Draft } = require('../src/draft');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { startHost, scriptedModel } = require('./helpers/host.cjs');

test('the editor exposes a bounded read-only check catalog with no environment values', async t => {
  const controller = new AbortController(), permissions = new PermissionBroker({ workspace: '/fixture', signal: controller.signal });
  permissions.allowScope('workspace.read');
  const environment = new ContainerEnvironment({ checks: [{ name: 'integration', command: 'node', args: ['check.js'],
    env: { FIXTURE_TOKEN: 'private-catalog-value' }, services: [{ name: 'web', command: 'node', args: ['server.js'], ready: { port: 8123 } }] }] });
  const bridge = await openBridge({ signal: controller.signal, permissions, draft: new Draft(async () => ''), workspace: { environment } });
  const client = new Client({ name: 'catalog-test', version: '1' });
  t.after(async () => { await client.close(); bridge.close(); controller.abort(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), { requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } } }));
  const listed = await client.listTools();
  assert.equal(listed.tools.find(tool => tool.name === 'managed_checks').annotations.readOnlyHint, true);
  for (const args of [{}, { name: 'integration' }]) {
    const result = await client.callTool({ name: 'managed_checks', arguments: args });
    assert.equal(result.isError, undefined); assert.doesNotMatch(JSON.stringify(result), /private-catalog-value|FIXTURE_TOKEN/);
    if (args.name) assert.deepEqual(JSON.parse(result.content[0].text).args, ['check.js']);
  }
});

test('the real runtime enables managed-check discovery without running or approving a command', {
  skip: !process.env.AGENTEXTENSION_TEST_FORGE_URL, timeout: 90000,
}, async t => {
  const baseUrl = process.env.AGENTEXTENSION_TEST_FORGE_URL;
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'managed-catalog-host-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'README.md'), 'Managed fixture\n');
  const model = await scriptedModel(t, baseUrl, async ({ round, results, call, say }) => {
    if (round === 0) return call('managed_checks', {});
    const last = results.at(-1).content;
    assert.doesNotMatch(last, /private-catalog-value|FIXTURE_TOKEN/);
    const value = JSON.parse(last);
    if (round === 1) { assert.equal(value.checks[0].name, 'integration'); return call('managed_checks', { name: 'integration' }); }
    assert.deepEqual(value.args, ['check.js']); return say('The integration check is configured and was not run.');
  });
  const host = await startHost(t, { root, settings: { serverUrl: baseUrl, model: model.model, fallbackModel: '',
    turnTimeoutSeconds: 60, automaticSkills: false, skillRoots: [], pluginRoots: [], readConnectors: [],
    executionEnvironment: 'container', 'container.checks': [{ name: 'integration', command: 'node', args: ['check.js'], env: { FIXTURE_TOKEN: 'private-catalog-value' } }] } });
  await host.send({ type: 'run', prompt: 'List configured managed checks. Do not run commands or edit files.' });
  const done = await host.waitFor(state => state.phase === 'done' && !state.runActive, 60000, 'managed catalog');
  assert.equal(done.checks.length, 0);
  assert.equal(host.shown.warning.filter(warning => warning.buttons.includes('Run command')).length, 0);
  assert.ifError(model.state.error);
});

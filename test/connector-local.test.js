const assert = require('node:assert/strict');
const { test } = require('node:test');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { createServer } = require('node:net');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { ReadConnectors, validateLocalConnector } = require('../src/connectors');
const { PermissionBroker } = require('../src/permissions');
const { PolicyEngine } = require('../src/policy');
const { approve } = require('../src/forge');
const { startHost, scriptedModel } = require('./helpers/host.cjs');

test('stdio closes a cancelled MCP child but does not supply a connector tool or environment boundary', { timeout: 15_000 }, async t => {
  const cwd = path.join(__dirname, 'fixtures');
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(cwd, 'local-mcp.cjs')], cwd, stderr: 'pipe', env: {} });
  const client = new Client({ name: 'stdio-evaluation', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const pid = transport.pid;
  assert.ok(pid);
  const status = await client.callTool({ name: 'read_status' });
  const result = JSON.parse(status.content[0].text);
  assert.equal(await fs.realpath(result.cwd), await fs.realpath(cwd));
  assert.equal(result.inheritsHome, Boolean(process.env.HOME || process.env.USERPROFILE));
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['read_status', 'wait_for_close']);
  const controller = new AbortController();
  const waiting = once(transport.stderr, 'data');
  const request = client.callTool({ name: 'wait_for_close' }, undefined, { signal: controller.signal });
  const cancelled = assert.rejects(request);
  assert.match(String((await waiting)[0]), /waiting/);
  controller.abort();
  await cancelled;
  await client.close();
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

const serverOptions = { skip: process.env.AGENTEXTENSION_TEST_LOCAL_MCP !== '1' && 'Enable the isolated local MCP suite.', timeout: 20_000 };
const scope = { id: 'local-docs', node: process.execPath, tools: [{ name: 'read_status', targetArgument: 'document', targets: ['manual', 'wait', 'oversized'] }] };
const input = { connector: scope.id, tool: 'read_status', arguments: { document: 'manual' } };
const request = args => ({ name: 'connector_read', args });

test('local MCP configuration allows only a pinned standalone read server', () => {
  const config = { ...scope, entryPoint: path.join(__dirname, 'server.cjs'), sha256: 'a'.repeat(64) };
  assert.deepEqual(validateLocalConnector(config), config);
  for (const changes of [{ entryPoint: 'relative.cjs' }, { entryPoint: path.join(__dirname, 'server.js') }, { sha256: '' }, { tools: [] },
    { tools: [...scope.tools, ...scope.tools] }, { writeTools: scope.tools }, { args: ['--eval'] }, { env: { TOKEN: 'example' } }]) {
    assert.throws(() => validateLocalConnector({ ...config, ...changes }));
  }
});

async function isolatedFixture(t, { policy, localCurrent } = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-local-test-')));
  const homeDirectory = await fs.mkdtemp(path.join(os.homedir(), '.agentextension-mcp-test-'));
  t.after(() => Promise.all([directory, homeDirectory].map(dir => fs.rm(dir, { recursive: true, force: true }))));
  const workspace = path.join(directory, 'workspace.txt');
  const home = path.join(homeDirectory, 'marker.txt');
  const entryPoint = path.join(directory, 'server.cjs');
  let connections = 0;
  const endpoint = createServer(socket => { connections++; socket.destroy(); });
  endpoint.listen(0, '127.0.0.1');
  await once(endpoint, 'listening');
  t.after(() => endpoint.close());
  const fixture = await fs.readFile(path.join(__dirname, 'fixtures', 'local-mcp-isolated.cjs'), 'utf8');
  const source = fixture.replace("'__FIXTURE__'", () => JSON.stringify({ workspace, home, port: endpoint.address().port }));
  await Promise.all([fs.writeFile(entryPoint, source), fs.writeFile(workspace, 'workspace marker'), fs.writeFile(home, 'home marker')]);
  const config = { ...scope, entryPoint, sha256: createHash('sha256').update(source).digest('hex') };
  const controller = new AbortController();
  const permissions = new PermissionBroker({ workspace: directory, policy, signal: controller.signal });
  const connectors = new ReadConnectors({ configs: [], localConfigs: [config], permissions, signal: controller.signal,
    allowWrites: true, localCurrent, secrets: { get: async () => assert.fail('A local process must not read connector credentials.') } });
  return { config, directory, controller, connectors, permissions, run: { connectors, permissions }, connections: () => connections };
}

test('the macOS or Linux launcher denies host files, writes, subprocesses and loopback access', serverOptions, async t => {
  const policy = new PolicyEngine({ user: [{ effect: 'connector.read', target: 'local-docs/read_status/manual', decision: 'allow' }] });
  const f = await isolatedFixture(t, { policy });
  const { connectors } = f;
  assert.deepEqual(connectors.catalog(), [{ id: 'local-docs', account: 'Local process', server: 'Local stdio', tools: scope.tools }]);
  assert.deepEqual(connectors.catalog({ readOnly: true }), []);
  await assert.rejects(connectors.read(input), /Permission denied/);
  await assert.rejects(connectors.write(input), /scope/);
  for (const invalid of [{ ...input, tool: 'unlisted' }, { ...input, arguments: { document: 'other' } },
    { ...input, arguments: { document: 'manual', extra: 'no' } }]) await assert.rejects(connectors.read(invalid), /scope/);

  let prompts = 0;
  const noPrompt = { connector: async () => { prompts++; return false; } };
  assert.equal(await approve(request(input), { ...f.run, readOnly: true }, noPrompt), false);
  assert.equal(await approve(request(input), { ...f.run, planFirst: true }, noPrompt), false);
  assert.equal(prompts, 0);
  assert.equal(await approve(request(input), f.run, { connector: async () => false }), false);
  await assert.rejects(connectors.read(input), /Permission denied/);
  assert.equal(await approve(request(input), f.run, { connector: async proposal => {
    assert.equal(proposal.server, f.config.entryPoint);
    assert.equal(proposal.local.sha256, f.config.sha256);
    assert.equal(proposal.local.node, await fs.realpath(process.execPath));
    assert.deepEqual(proposal.arguments, input.arguments);
    return true;
  } }), true);
  const output = await connectors.read(input);
  const { pid, env, ...status } = JSON.parse(JSON.parse(output.text).content[0].text);
  assert.ok(pid > 0);
  assert.ok(env.every(key => ['__CF_USER_TEXT_ENCODING', 'PWD'].includes(key)), env.join(', '));
  assert.deepEqual(status, { target: 'manual', methods: ['initialize', 'notifications/initialized', 'tools/call'],
    network: false, entry: true, workspace: false, home: false, write: false, child: false });
  assert.equal(f.connections(), 0);
  await assert.rejects(connectors.read(input), /Permission denied/);
});

test('a changed local server or policy voids approval', serverOptions, async t => {
  let current = true;
  const f = await isolatedFixture(t, { localCurrent: () => current });
  assert.equal(await approve(request(input), f.run, { connector: async () => { current = false; return true; } }), false);
  current = true;
  const approved = { connector: async () => true };
  assert.equal(await approve(request(input), f.run, approved), true);
  f.permissions.setPolicy(new PolicyEngine({ user: [{ effect: 'connector.read', target: 'local-docs/*', decision: 'deny' }] }));
  await assert.rejects(f.connectors.read(input), /Permission denied/);
  assert.equal(await approve(request(input), f.run, { connector: async () => assert.fail('Policy denied this call.') }), false);
  f.permissions.setPolicy(new PolicyEngine());
  assert.equal(await approve(request(input), f.run, approved), true);
  await fs.appendFile(f.config.entryPoint, '\n// changed');
  await assert.rejects(f.connectors.read(input), /SHA-256/);
  assert.equal(f.connections(), 0);
});

test('oversize output fails and cancellation reaps the waiting local process', serverOptions, async t => {
  let checks = 0;
  let onCheck;
  const f = await isolatedFixture(t, { localCurrent: () => { onCheck?.(++checks); return true; } });
  const oversized = { ...input, arguments: { document: 'oversized' } };
  const waiting = { ...input, arguments: { document: 'wait' } };
  const approved = { connector: async () => true };
  assert.equal(await approve(request(oversized), f.run, approved), true);
  await assert.rejects(f.connectors.read(oversized), /Local MCP read failed/);
  assert.equal(await approve(request(waiting), f.run, approved), true);
  const staged = new Set(await fs.readdir(os.tmpdir()));
  const ready = new Promise(resolve => { onCheck = count => { if (count === 3) resolve(); }; });
  const call = f.connectors.read(waiting);
  const cancelled = assert.rejects(call, { name: 'AbortError' });
  await Promise.race([ready, call]);
  await new Promise(resolve => setImmediate(resolve));
  const tempDir = (await fs.readdir(os.tmpdir())).find(dir => dir.startsWith('agentextension-mcp-') && !staged.has(dir));
  assert.ok(tempDir);
  const pids = execFileSync('ps', ['-axo', 'pid,command'], { encoding: 'utf8' }).split('\n')
    .filter(line => line.includes(path.join(tempDir, 'entry.cjs'))).map(line => Number(line.trim().split(/\s+/)[0]));
  assert.ok(pids.length);
  f.controller.abort();
  await cancelled;
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await assert.rejects(fs.access(path.join(os.tmpdir(), tempDir)), { code: 'ENOENT' });
});

test('a local tool that never replies reaches its deadline and loses its staged file', serverOptions, async t => {
  const f = await isolatedFixture(t);
  const waiting = { ...input, arguments: { document: 'wait' } };
  assert.equal(await approve(request(waiting), f.run, { connector: async () => true }), true);
  const staged = new Set(await fs.readdir(os.tmpdir()));
  await assert.rejects(f.connectors.read(waiting), { name: 'TimeoutError' });
  const remaining = (await fs.readdir(os.tmpdir())).filter(dir => dir.startsWith('agentextension-mcp-') && !staged.has(dir));
  assert.deepEqual(remaining, []);
});

test('the editor approves one local read through TrueForge and exposes only the configured scope', {
  ...serverOptions, skip: serverOptions.skip || (!process.env.AGENTEXTENSION_TEST_FORGE_URL && 'Enable the TrueForge integration suite.'),
}, async t => {
  const f = await isolatedFixture(t);
  const baseUrl = process.env.AGENTEXTENSION_TEST_FORGE_URL;
  const model = await scriptedModel(t, baseUrl, async ({ round, results, all, call, say }) => {
    if (round === 0) return call('list_connector_tools', {});
    if (round === 1) {
      assert.deepEqual(JSON.parse(results[0].content), [
        { id: f.config.id, account: 'Local process', server: 'Local stdio', tools: scope.tools },
      ]);
      return call('connector_read', input);
    }
    assert.match(all, /notifications\/initialized/);
    return say('Local connector read completed.');
  });
  const workspace = path.join(f.directory, 'project');
  await fs.mkdir(workspace);
  const host = await startHost(t, { root: workspace,
    settings: { serverUrl: baseUrl, model: model.model, fallbackModel: '', localReadConnectors: [f.config] },
    workspaceSettings: { localReadConnectors: [{ ...f.config, id: 'workspace-override' }] },
  });
  host.answers.push({ kind: 'pick', value: items => items }, { kind: 'modal', value: (_buttons, title) => {
    assert.equal(title, 'Allow this isolated local connector read?');
    const detail = host.shown.warning.at(-1).detail;
    assert.ok(detail.includes(f.config.entryPoint) && detail.includes(f.config.sha256));
    assert.match(detail, /Tool: read_status\nTarget: manual/);
    return 'Allow read';
  } });
  await host.send({ type: 'connectors' });
  await host.waitFor(state => state.connectors?.includes(f.config.id), 5_000, 'local connector selected');
  assert.deepEqual(host.state().connectors, [f.config.id]);
  await host.send({ type: 'run', prompt: 'Read the manual through the local connector.' });
  const done = await host.waitFor(state => ['done', 'error'].includes(state.phase) && !state.runActive, 15_000, 'local connector read completed');
  assert.ifError(model.state.error);
  assert.equal(done.phase, 'done', done.status);
  assert.equal(done.permissions.events.filter(event => event.tool === 'connector_read' && event.decision === 'allow').length, 1);
  assert.equal(host.answers.length, 0);
});

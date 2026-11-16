const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const { ReadConnectors, validateConnector, secretKey } = require('../src/connectors');
const { PermissionBroker } = require('../src/permissions');
const { approve } = require('../src/forge');
const { PolicyEngine } = require('../src/policy');
const { startHost, scriptedModel } = require('./helpers/host.cjs');

const base = { id: 'docs', account: 'test-reader', url: 'https://example.com/mcp',
  tools: [{ name: 'read_doc', targetArgument: 'document', targets: ['manual'] }] };
const input = { connector: 'docs', tool: 'read_doc', arguments: { document: 'manual' } };
const writeTools = [{ name: 'update_label', targetArgument: 'document', targets: ['manual'], extraArguments: ['label'] }];
const writeInput = { connector: 'docs', tool: 'update_label', arguments: { document: 'manual', label: 'Reviewed' } };

test('connector configuration rejects credentials, redirects-in-URL and unsupported transports', () => {
  for (const url of ['http://example.com/mcp', 'file:///etc/passwd', 'https://user:secret@example.com/mcp',
    'https://example.com/mcp?token=secret', 'https://example.com/mcp#auth']) assert.throws(() => validateConnector({ ...base, url }));
  assert.equal(validateConnector(base).account, 'test-reader');
  assert.notEqual(secretKey(base), secretKey({ ...base, account: 'other' }));
  assert.throws(() => validateConnector({ ...base, token: 'hidden' }));
});

test('tool, target and extra arguments are checked before credentials; account and token changes void approval', async () => {
  const broker = new PermissionBroker({ workspace: '/a' });
  let token = 'private-token';
  let reads = 0;
  const registry = new ReadConnectors({ configs: [base], permissions: broker, signal: new AbortController().signal,
    secrets: { get: async () => { reads++; return token; } } });
  for (const invalid of [{ ...input, tool: 'write_doc' }, { ...input, arguments: { document: 'other' } },
    { ...input, arguments: { document: 'manual', delete: true } }]) await assert.rejects(registry.prepare(invalid));
  assert.equal(reads, 0);
  const prepared = await registry.prepare(input);
  broker.grant(prepared.action);
  token = 'new-token';
  assert.throws(() => broker.require({ ...prepared.action, scope: 'changed' }));
  assert.throws(() => broker.require({ ...prepared.action, workspace: '/b' }));
  await assert.rejects(registry.read(input), /Permission denied/);
  const run = { connectors: registry, permissions: broker };
  assert.equal(await approve({ name: 'connector_read', args: input }, run, { connector: async () => { registry.revoke('docs'); return true; } }), false);
});

const network = { skip: !process.env.AGENTEXTENSION_TEST_FORGE_URL && 'Enable the local integration suite.', timeout: 20_000 };

async function fixture(t, options = {}) {
  let calls = 0;
  let token = 'private-fixture-credential';
  let afterAuth;
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) return res.writeHead(401).end();
    if (req.method !== 'POST') return res.writeHead(405).end();
    const mcp = new McpServer({ name: 'fixture', version: '1.0.0' });
    mcp.registerTool('read_doc', { inputSchema: { document: z.string() }, annotations: { readOnlyHint: true } }, async args => {
      calls++;
      afterAuth?.();
      return { content: [{ type: 'text', text: `Read ${args.document}. Echo ${token}` }] };
    });
    mcp.registerTool('delete_doc', { inputSchema: {}, annotations: { readOnlyHint: true } }, async () => { calls++; return { content: [] }; });
    mcp.registerTool('update_label', { inputSchema: { document: z.string(), label: z.string() } }, async args => {
      calls++;
      if (options.disconnectOnWrite) { req.socket.destroy(); return { content: [] }; }
      return { content: [{ type: 'text', text: `Updated ${args.document} to ${args.label}.` }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.once('close', () => { void mcp.close().catch(() => {}); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const controller = new AbortController();
  const broker = new PermissionBroker({ workspace: '/a', signal: controller.signal });
  const config = { ...base, url: `http://127.0.0.1:${server.address().port}/mcp`, ...(options.allowWrites ? { writeTools } : {}) };
  const registry = new ReadConnectors({ configs: [config], permissions: broker, signal: controller.signal, ...options,
    secrets: { get: async key => { assert.equal(key, secretKey(config)); return token; } } });
  return { broker, registry, config, controller, calls: () => calls,
    afterAuth: fn => { afterAuth = fn; }, rotate: () => { token = 'rotated-token'; } };
}

test('authenticated MCP read uses exact approval and redacts a server-echoed credential', network, async t => {
  const f = await fixture(t);
  await assert.rejects(f.registry.read(input), /Permission denied/);
  assert.equal(f.calls(), 0);
  const action = (await f.registry.prepare(input)).action;
  f.broker.grant(action);
  const result = await f.registry.read(input);
  assert.match(result.text, /Read manual/);
  assert.match(result.text, /credential removed/);
  assert.equal(JSON.stringify(result).includes('private-fixture-credential'), false);
  assert.equal(JSON.stringify(f.broker.events).includes('private-fixture-credential'), false);
  assert.equal(f.calls(), 1);
  await assert.rejects(f.registry.read(input), /Permission denied/);
  await assert.rejects(f.registry.read({ ...input, tool: 'delete_doc' }), /scope/);
  assert.equal(f.calls(), 1);
});

test('connector writes require exact approval, recheck policy, and are unavailable to scheduled runs', network, async t => {
  const f = await fixture(t, { allowWrites: true });
  const run = { connectors: f.registry, permissions: f.broker };
  assert.equal(f.registry.catalog()[0].writeTools[0].name, writeInput.tool);
  assert.equal(f.registry.catalog({ readOnly: true })[0].writeTools, undefined);
  await assert.rejects(f.registry.read(writeInput), /read scope/);
  await assert.rejects(f.registry.write(writeInput), /Permission denied/);
  await assert.rejects(f.registry.prepare({ ...writeInput, arguments: { ...writeInput.arguments, unlisted: 1 } }, 'write'), /write scope/);
  const call = { name: 'connector_write', args: writeInput };
  const ui = { connector: async proposal => {
    assert.deepEqual([proposal.operation, proposal.account, proposal.target, proposal.arguments],
      ['write', f.config.account, 'manual', writeInput.arguments]);
    assert.equal(f.calls(), 0);
    return true;
  } };
  assert.equal(await approve(call, { ...run, readOnly: true }, ui), false);
  assert.equal(await approve(call, { ...run, planFirst: true }, ui), false);
  assert.equal(await approve(call, run, ui), true);
  await assert.rejects(f.registry.write({ ...writeInput, arguments: { ...writeInput.arguments, label: 'Changed' } }), /Permission denied/);
  f.broker.policy = new PolicyEngine({ user: [{ effect: 'connector.write', target: 'docs/update_label/manual', decision: 'deny' }] });
  await assert.rejects(f.registry.write(writeInput), /access changed/);
  assert.equal(f.calls(), 0);
  f.broker.policy = new PolicyEngine();
  assert.equal(await approve(call, run, ui), true);
  assert.match((await f.registry.write(writeInput)).text, /Updated manual to Reviewed/);
  assert.equal(f.calls(), 1);
  await assert.rejects(f.registry.write(writeInput), /Permission denied/);
  assert.equal(f.calls(), 1);
});

test('a dropped connector write returns an uncertain outcome and does not retransmit the write', network, async t => {
  const events = [];
  const f = await fixture(t, { allowWrites: true, disconnectOnWrite: true,
    onWriteDispatch: () => events.push('dispatched'), onUncertainWrite: message => events.push(message) });
  f.broker.grant((await f.registry.prepare(writeInput, 'write')).action);
  await assert.rejects(f.registry.write(writeInput), /may have taken effect/);
  assert.equal(f.calls(), 1);
  assert.equal(events.length, 2);
  assert.equal(events[0], 'dispatched');
  assert.match(events[1], /Check the target before retrying/);
});

test('the VS Code run shows the exact connector write before TrueForge can dispatch it', network, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-connector-write-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const f = await fixture(t, { allowWrites: true });
  const baseUrl = process.env.AGENTEXTENSION_TEST_FORGE_URL;
  const model = await scriptedModel(t, baseUrl, async ({ round, all, call, say }) => {
    assert.doesNotMatch(all, /private-fixture-credential/);
    if (round === 0) return call('list_connector_tools', {});
    if (round === 1) { assert.match(all, /update_label/); return call('connector_write', writeInput); }
    assert.match(all, /Updated manual to Reviewed/);
    return say('Label updated.');
  });
  const host = await startHost(t, { root, settings: { serverUrl: baseUrl, model: model.model, fallbackModel: '', readConnectors: [f.config] } });
  await host.context.secrets.store(secretKey(f.config), 'private-fixture-credential');
  host.answers.push({ kind: 'pick', value: items => items }, { kind: 'modal', value: (_buttons, title) => {
    assert.equal(title, 'Allow this connector write?');
    assert.equal(f.calls(), 0);
    const detail = host.shown.warning.at(-1).detail;
    assert.match(detail, /Account: test-reader\nTool: update_label\nTarget: manual/);
    assert.match(detail, /"label": "Reviewed"/);
    return 'Allow write';
  } });
  await host.send({ type: 'connectors' });
  await host.waitFor(state => state.connectors?.includes('docs'), 5_000, 'connector selected');
  await host.send({ type: 'run', prompt: 'Update the label for the manual.' });
  const done = await host.waitFor(state => state.phase === 'done' && !state.runActive, 15_000, 'write run completed');
  assert.ifError(model.state.error);
  assert.equal(f.calls(), 1);
  assert.equal(done.permissions.events.filter(event => event.tool === 'connector_write' && event.decision === 'allow').length, 1);
  assert.equal(host.answers.length, 0);
});

test('revocation after authentication withholds results and blocks the next request', network, async t => {
  const f = await fixture(t);
  f.broker.grant((await f.registry.prepare(input)).action);
  f.afterAuth(() => f.registry.revoke('docs'));
  await assert.rejects(f.registry.read(input), /access changed/);
  assert.equal(f.calls(), 1);
  await assert.rejects(f.registry.read(input), /not enabled/);
  assert.equal(f.calls(), 1);
});

test('credential rotation between approval and dispatch sends no tool request', network, async t => {
  const f = await fixture(t);
  f.broker.grant((await f.registry.prepare(input)).action);
  f.rotate();
  await assert.rejects(f.registry.read(input), /Permission denied/);
  assert.equal(f.calls(), 0);
});

test('cancellation during an authenticated read withholds the result', network, async t => {
  const f = await fixture(t);
  f.broker.grant((await f.registry.prepare(input)).action);
  f.afterAuth(() => f.controller.abort());
  await assert.rejects(f.registry.read(input), { name: 'AbortError' });
  assert.equal(f.calls(), 1);
  await assert.rejects(f.registry.read(input), /revoked/);
});

test('connector redirects do not forward credentials to another endpoint', network, async t => {
  let targetCalls = 0;
  const target = http.createServer((req, res) => { targetCalls++; res.end(); });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  const server = http.createServer((req, res) => res.writeHead(307, { Location: `http://127.0.0.1:${target.address().port}/mcp` }).end());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const endpoint of [server, target]) { endpoint.close(); endpoint.closeAllConnections(); } });
  const broker = new PermissionBroker({ workspace: '/a' });
  const registry = new ReadConnectors({ configs: [{ ...base, url: `http://127.0.0.1:${server.address().port}/mcp` }],
    permissions: broker, signal: new AbortController().signal, secrets: { get: async () => 'private-token' } });
  broker.grant((await registry.prepare(input)).action);
  await assert.rejects(registry.read(input), /failed/);
  assert.equal(targetCalls, 0);
});

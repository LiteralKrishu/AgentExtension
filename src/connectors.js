const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { z } = require('zod');
const path = require('node:path');
const { digest } = require('./permissions');
const { ConnectorAccounts, connectorUrl, secretKey } = require('./connector-oauth');
const { localServer, callLocalServer } = require('./connector-local');
const { connectorSubject, reason } = require('./policy');

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const toolFields = {
  name: identifier, targetArgument: identifier,
  targets: z.array(z.string().min(1).max(300)).min(1).max(20),
};
const connectorSchema = z.strictObject({
  id: identifier, account: z.string().trim().min(1).max(120), url: z.string().max(500),
  tools: z.array(z.strictObject(toolFields)).max(12),
  writeTools: z.array(z.strictObject({ ...toolFields, extraArguments: z.array(identifier).max(12).optional() })).max(12).optional(),
  oauth: z.strictObject({ issuer: z.string().trim().max(500), clientId: z.string().trim().min(1).max(255),
    scopes: z.array(z.string().regex(/^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/)).min(1).max(20) }).optional(),
});
const absolutePath = z.string().max(1_000).refine(value => path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value),
  'Use an absolute file path.');
const localConnectorSchema = z.strictObject({
  id: identifier, node: absolutePath, entryPoint: absolutePath.refine(file => path.extname(file) === '.cjs'),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), tools: z.array(z.strictObject(toolFields)).min(1).max(12),
});
const connectorInput = z.strictObject({ connector: identifier, tool: identifier,
  arguments: z.record(z.string(), z.unknown()),
});

function validateConnector(input) {
  const config = connectorSchema.parse(input);
  let url;
  try { url = connectorUrl(config.url); if (url.search) throw new Error(); }
  catch { throw new Error('Use an HTTPS MCP URL or a loopback HTTP URL without credentials or query parameters.'); }
  const tools = [...config.tools, ...(config.writeTools ?? [])];
  if (!tools.length) throw new Error('Configure at least one read or write tool.');
  if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error('Connector tool names must be unique across reads and writes.');
  if (config.oauth) {
    if (connectorUrl(config.oauth.issuer).search || !config.oauth.scopes.includes('openid')) {
      throw new Error('Configure an OAuth issuer without query parameters and include the openid scope.');
    }
    config.oauth.scopes = [...new Set(config.oauth.scopes)].sort();
  }
  return { ...config, url: url.href };
}

function validateLocalConnector(input) {
  const config = localConnectorSchema.parse(input);
  if (new Set(config.tools.map(tool => tool.name)).size !== config.tools.length) throw new Error('Local tool names must be unique.');
  return config;
}

function resultFor(prepared, result, token) {
  const { config, input, target } = prepared;
  let text = JSON.stringify({ isError: result.isError === true,
    content: result.content?.filter(item => item.type === 'text').map(item => ({ type: 'text', text: item.text })) ?? [],
  });
  if (token) for (const secret of new Set([token, encodeURIComponent(token), JSON.stringify(token).slice(1, -1)])) text = text.split(secret).join('[credential removed]');
  return { connector: config.id, account: config.account, tool: input.tool, target,
    text: text.slice(0, 12_000), truncated: text.length > 12_000 };
}

class ReadConnectors {
  constructor({ configs, localConfigs = [], localCurrent, secrets, permissions, signal, onResult, allowWrites = false,
    accounts = new ConnectorAccounts(secrets), onWriteDispatch, onUncertainWrite }) {
    if (!Array.isArray(configs) || configs.length + localConfigs.length > 8) throw new Error('Enable at most eight connectors.');
    this.configs = new Map();
    const local = localConfigs.map(validateLocalConnector).map(config => ({ ...config, account: 'Local process', local: true }));
    for (const config of [...configs.map(validateConnector), ...local]) {
      if (this.configs.has(config.id)) throw new Error('Connector IDs must be unique.');
      this.configs.set(config.id, config);
    }
    this.secrets = secrets;
    this.permissions = permissions;
    this.signal = signal;
    this.onResult = onResult;
    this.allowWrites = allowWrites;
    this.accounts = accounts;
    this.onWriteDispatch = onWriteDispatch;
    this.onUncertainWrite = onUncertainWrite;
    this.localCurrent = localCurrent;
    this.revoked = new Set();
  }

  catalog({ readOnly = false } = {}) {
    const writes = this.allowWrites && !readOnly;
    return [...this.configs.values()].filter(config => !this.revoked.has(config.id) && !(readOnly && config.local)
      && (config.tools.length || writes && config.writeTools?.length)).map(config => ({
      id: config.id, account: config.account, server: config.local ? 'Local stdio' : config.url, tools: config.tools,
      ...(writes && config.writeTools?.length ? { writeTools: config.writeTools } : {}),
    }));
  }

  revoke(id) {
    this.revoked.add(id);
    this.permissions.reset();
  }

  validate(input, operation = 'read') {
    const parsed = connectorInput.parse(input);
    const limit = operation === 'write' ? 4_000 : 8_000;
    if (JSON.stringify(parsed.arguments).length > limit) throw new Error(`Connector arguments exceed ${limit.toLocaleString('en-US')} characters.`);
    const config = this.configs.get(parsed.connector);
    if (!config || this.revoked.has(config.id)) throw new Error('This connector is not enabled for this run.');
    const tools = operation === 'read' ? config.tools : this.allowWrites ? config.writeTools ?? [] : [];
    const tool = tools.find(tool => tool.name === parsed.tool);
    const target = tool && parsed.arguments[tool.targetArgument];
    const allowed = tool ? [tool.targetArgument, ...(operation === 'write' ? tool.extraArguments ?? [] : [])] : [];
    if (!tool || typeof target !== 'string' || !tool.targets.includes(target) || Object.entries(parsed.arguments).some(([name, value]) =>
      !allowed.includes(name) || !(typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value)))) {
      throw new Error(`This connector tool, target, or arguments are outside the approved ${operation} scope.`);
    }
    return { config, input: parsed, target };
  }

  async prepare(input, operation = 'read') {
    const checked = this.validate(input, operation);
    if (checked.config.local) {
      const server = await localServer(checked.config);
      const { source: _, ...identity } = server;
      const action = this.permissions.action('connector_read', 'connector.read', [server.entry, checked.target], checked.input,
        { config: checked.config, identity });
      this.checkLocal(checked, action);
      return { ...checked, action, server };
    }
    const credential = await this.secrets.get(secretKey(checked.config));
    const account = checked.config.oauth ? this.accounts.identity(credential) : undefined;
    if (checked.config.oauth && !account) throw new Error('Sign in to this connector account first.');
    if (operation === 'write' && !credential) throw new Error('Set a credential for this connector account before writing.');
    this.validate(input, operation);
    const action = this.permissions.action(`connector_${operation}`, `connector.${operation}`,
      [checked.config.url, checked.config.account, checked.target], checked.input,
      { config: checked.config, credential: digest(credential ?? '') });
    if (!this.permissions.valid(action)) throw new Error('Connector access was revoked.');
    return { ...checked, action, credential, account };
  }

  read(input) { return this.call(input, 'read'); }

  write(input) { return this.call(input, 'write'); }

  checkLocal({ config, input }, action) {
    this.validate(input);
    if (!this.permissions.valid(action) || this.localCurrent && !this.localCurrent(config)) throw new Error('Local connector access changed.');
  }

  async readLocal(prepared) {
    const { config, action, input, target, server } = prepared;
    const signal = AbortSignal.any([this.signal, this.permissions.revocation.signal, AbortSignal.timeout(15_000)]);
    const check = async () => {
      await this.permissions.refreshPolicy();
      signal.throwIfAborted();
      this.checkLocal(prepared, action);
      const verdict = this.permissions.decide(action.effect, connectorSubject(config, input.tool, target));
      if (verdict.decision === 'deny') {
        this.permissions.record(action, 'deny', reason(verdict));
        throw new Error('The connector rule denied this action.');
      }
    };
    let result;
    try { result = await callLocalServer(server, { name: input.tool, arguments: input.arguments }, signal, check); }
    catch {
      signal.throwIfAborted();
      throw new Error('Local MCP read failed. Check the isolated runtime, server file, and approved tool.');
    }
    const output = resultFor(prepared, result);
    this.onResult?.(output);
    return output;
  }

  async call(input, operation) {
    const prepared = await this.prepare(input, operation);
    const { config, action, credential } = prepared;
    this.permissions.require(action);
    if (config.local) return this.readLocal(prepared);
    const client = new Client({ name: 'agentextension-mcp-connector', version: '1.0.0' });
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(30_000)]);
    let dispatched = false;
    let refreshed = false;
    const check = async () => {
      await this.permissions.refreshPolicy?.();
      signal.throwIfAborted();
      this.validate(input, operation);
      if (!this.permissions.valid(action) || (await this.secrets.get(secretKey(config))) !== credential) {
        throw new Error('Connector identity or permission changed.');
      }
      signal.throwIfAborted();
      this.validate(input, operation);
      if (!this.permissions.valid(action)) throw new Error('Connector access was revoked.');
      const verdict = this.permissions.decide(action.effect, connectorSubject(config, prepared.input.tool, prepared.target));
      if (verdict.decision === 'deny') {
        this.permissions.record(action, 'deny', reason(verdict));
        throw new Error('The connector rule denied this action.');
      }
    };
    try {
      await check();
      let token = config.oauth ? await this.accounts.access(config, credential, signal) : credential;
      const transport = new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {}, redirect: 'error' },
        fetch: async (url, init) => {
          await check();
          if (new URL(String(url)).href !== config.url) throw new Error('Connector request changed endpoint.');
          const method = init?.method === 'POST' && typeof init.body === 'string' ? JSON.parse(init.body).method : undefined;
          if (operation === 'write' && method === 'tools/call') {
            if (dispatched) throw new Error('A connector write cannot be sent twice.');
            dispatched = true;
            this.onWriteDispatch?.();
          }
          const headers = new Headers(init?.headers);
          if (token) headers.set('Authorization', `Bearer ${token}`);
          const request = { ...init, headers, signal, redirect: 'error' };
          let response = await fetch(url, request);
          if (config.oauth && method === 'initialize' && response.status === 401 && !refreshed) {
            refreshed = true;
            await response.body?.cancel();
            token = await this.accounts.access(config, credential, signal, token);
            await check();
            headers.set('Authorization', `Bearer ${token}`);
            response = await fetch(url, request);
          }
          await check();
          if (!response.body) return response;
          let bytes = 0;
          const body = response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
            bytes += chunk.byteLength;
            if (bytes > 512_000) throw new Error('Connector response exceeds its size limit.');
            controller.enqueue(chunk);
          } }));
          return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
        },
      });
      await client.connect(transport, { signal, timeout: 30_000 });
      const result = await client.callTool({ name: prepared.input.tool, arguments: prepared.input.arguments }, undefined,
        { signal, timeout: 30_000 });
      await check();
      if (operation === 'write' && result.isError) throw new Error('The connector reported an error after dispatch.');
      const output = resultFor(prepared, result, token);
      this.onResult?.(output);
      return output;
    } catch {
      if (dispatched) {
        const message = 'The connector write may have taken effect. Check the target before retrying.';
        this.onUncertainWrite?.(message);
        throw new Error(message);
      }
      signal.throwIfAborted();
      throw new Error(`Connector ${operation} failed or access changed. Check the server, credential, and approved scope.`);
    } finally { await client.close().catch(() => {}); }
  }
}

module.exports = { ReadConnectors, validateConnector, validateLocalConnector, connectorInput, secretKey };

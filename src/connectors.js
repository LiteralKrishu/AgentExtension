const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { z } = require('zod');
const { digest } = require('./permissions');

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const connectorSchema = z.strictObject({
  id: identifier, account: z.string().trim().min(1).max(120), url: z.string().max(500),
  tools: z.array(z.strictObject({
    name: identifier, targetArgument: identifier,
    targets: z.array(z.string().min(1).max(300)).min(1).max(20),
  })).min(1).max(12),
});
const connectorInput = z.strictObject({ connector: identifier, tool: identifier,
  arguments: z.record(z.string(), z.unknown()),
});

function validateConnector(input) {
  const config = connectorSchema.parse(input);
  const url = new URL(config.url);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
      || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTPS MCP URL or a loopback HTTP URL without credentials or query parameters.');
  if (new Set(config.tools.map(tool => tool.name)).size !== config.tools.length) throw new Error('Connector tool names must be unique.');
  return { ...config, url: url.href };
}

const secretKey = config => `connector.v1.${digest([config.id, config.url, config.account])}`;

class ReadConnectors {
  constructor({ configs, secrets, permissions, signal, onResult }) {
    if (!Array.isArray(configs) || configs.length > 8) throw new Error('Enable at most eight connectors.');
    this.configs = new Map();
    for (const config of configs.map(validateConnector)) {
      if (this.configs.has(config.id)) throw new Error('Connector IDs must be unique.');
      this.configs.set(config.id, config);
    }
    this.secrets = secrets;
    this.permissions = permissions;
    this.signal = signal;
    this.onResult = onResult;
    this.revoked = new Set();
  }

  catalog() {
    return [...this.configs.values()].filter(config => !this.revoked.has(config.id)).map(config => ({
      id: config.id, account: config.account, server: config.url, tools: config.tools,
    }));
  }

  revoke(id) {
    this.revoked.add(id);
    this.permissions.reset();
  }

  validate(input) {
    const parsed = connectorInput.parse(input);
    if (JSON.stringify(parsed.arguments).length > 8_000) throw new Error('Connector arguments exceed 8,000 characters.');
    const config = this.configs.get(parsed.connector);
    if (!config || this.revoked.has(config.id)) throw new Error('This connector is not enabled for this run.');
    const tool = config.tools.find(tool => tool.name === parsed.tool);
    const target = tool && parsed.arguments[tool.targetArgument];
    if (!tool || typeof target !== 'string' || !tool.targets.includes(target)
        || Object.keys(parsed.arguments).length !== 1) {
      throw new Error('This connector tool or target is outside the approved read scope.');
    }
    return { config, input: parsed, target };
  }

  async prepare(input) {
    const checked = this.validate(input);
    const token = await this.secrets.get(secretKey(checked.config));
    this.validate(input);
    const action = this.permissions.action('connector_read', 'connector.read',
      [checked.config.url, checked.config.account, checked.target], checked.input,
      { config: checked.config, credential: digest(token ?? '') });
    if (!this.permissions.valid(action)) throw new Error('Connector access was revoked.');
    return { ...checked, action, token };
  }

  async read(input) {
    const prepared = await this.prepare(input);
    const { config, action, token } = prepared;
    this.permissions.require(action);
    const client = new Client({ name: 'agentextension-read-connector', version: '1.0.0' });
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(30_000)]);
    const check = async () => {
      signal.throwIfAborted();
      this.validate(input);
      if (!this.permissions.valid(action) || (await this.secrets.get(secretKey(config))) !== token) {
        throw new Error('Connector identity or permission changed.');
      }
      signal.throwIfAborted();
      this.validate(input);
      if (!this.permissions.valid(action)) throw new Error('Connector access was revoked.');
    };
    // No OAuth discovery, redirects, sampling, local processes, or resource dereferencing.
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {}, redirect: 'error' },
      fetch: async (url, init) => {
        await check();
        if (new URL(String(url)).href !== config.url) throw new Error('Connector request changed endpoint.');
        const response = await fetch(url, { ...init, signal, redirect: 'error' });
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
    try {
      await check();
      await client.connect(transport, { signal, timeout: 30_000 });
      // Only the named tool is used. Read-only annotations cannot add tools or targets.
      const result = await client.callTool({ name: prepared.input.tool, arguments: prepared.input.arguments }, undefined,
        { signal, timeout: 30_000 });
      await check();
      let text = JSON.stringify({ isError: result.isError === true,
        content: result.content?.filter(item => item.type === 'text').map(item => ({ type: 'text', text: item.text })) ?? [],
      });
      if (token) for (const secret of new Set([token, encodeURIComponent(token), JSON.stringify(token).slice(1, -1)])) text = text.split(secret).join('[credential removed]');
      const output = { connector: config.id, account: config.account, tool: prepared.input.tool,
        target: prepared.target, text: text.slice(0, 12_000), truncated: text.length > 12_000 };
      this.onResult?.(output);
      return output;
    } catch {
      signal.throwIfAborted();
      throw new Error('Connector read failed or access changed. Check the server, credential, and approved scope.');
    } finally { await client.close().catch(() => {}); }
  }
}

module.exports = { ReadConnectors, validateConnector, connectorInput, secretKey };

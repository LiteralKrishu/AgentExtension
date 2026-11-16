const { constants } = require('node:fs');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { ReadBuffer, serializeMessage } = require('@modelcontextprotocol/sdk/shared/stdio.js');

const { supported, isolatedRuntime, stageSource, startIsolatedNode } = require('./isolated-node');

const entryLimit = 2 * 1024 * 1024;
const outputLimit = 512_000;

async function localServer(config) {
  const [entry, runtime] = await Promise.all([fs.realpath(config.entryPoint), isolatedRuntime(config.node)]);
  const handle = await fs.open(entry, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > entryLimit) throw new Error('Select a regular server file under 2 MiB.');
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== stat.size) throw new Error('The local server changed while it was being read.');
    const source = bytes.subarray(0, size);
    if (createHash('sha256').update(source).digest('hex') !== config.sha256) {
      throw new Error('The local server does not match the configured SHA-256.');
    }
    return { entry, ...runtime, source };
  } finally { await handle.close(); }
}

// The SDK handles MCP negotiation and response schemas. Keep process and stream limits here
// so the child has no inherited environment and unsolicited messages never reach the client.
class LocalTransport {
  constructor(spec, directory, entry, signal) {
    this.spec = spec;
    this.directory = directory;
    this.entry = entry;
    this.signal = signal;
    this.buffer = new ReadBuffer({ maxBufferSize: outputLimit });
    this.bytes = 0;
  }

  async start() {
    const { child, stop, closed } = await startIsolatedNode(this.spec, { directory: this.directory, entry: this.entry }, this.signal, 'ignore');
    this.child = child;
    this.stop = stop;
    this.closed = closed.then(() => this.onclose?.());
    child.stdout.on('data', chunk => {
      try {
        this.bytes += chunk.length;
        if (this.bytes > outputLimit) throw new Error('Local MCP output limit exceeded.');
        this.buffer.append(chunk);
        for (let message; (message = this.buffer.readMessage()) !== null;) {
          if (!('method' in message) && message.id === this.pending) {
            this.pending = undefined;
            this.onmessage?.(message);
          }
        }
      } catch { this.stop(); }
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  }

  async send(message) {
    this.signal.throwIfAborted();
    if (!['initialize', 'notifications/initialized', 'tools/call'].includes(message.method)) return;
    this.pending = message.id;
    await new Promise((resolve, reject) => this.child.stdin.write(serializeMessage(message), error => error ? reject(error) : resolve()));
  }

  async close() {
    this.stop?.();
    await this.closed;
  }
}

async function callLocalServer(server, request, signal, check) {
  const staged = await stageSource(server.source, 'agentextension-mcp-');
  const client = new Client({ name: 'agentextension-local-mcp', version: '1.0.0' });
  const transport = new LocalTransport(server, staged.directory, staged.entry, signal);
  try {
    await check();
    await client.connect(transport, { signal });
    await check();
    const result = await client.callTool(request, undefined, { signal });
    await check();
    return result;
  } finally {
    await transport.close();
    await staged.clean();
  }
}

module.exports = { localServer, callLocalServer, supported };

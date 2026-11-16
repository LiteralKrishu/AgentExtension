const fs = require('node:fs');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const { createInterface } = require('node:readline');

const fixture = '__FIXTURE__';
const methods = [];
const lines = createInterface({ input: process.stdin });
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');

function permitted(action) {
  try { action(); return true; } catch { return false; }
}

async function probe(id, target) {
  const network = await new Promise(resolve => {
    const socket = net.connect(fixture.port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
  });
  const status = { pid: process.pid, target, methods, network, env: Object.keys(process.env).sort(),
    entry: permitted(() => fs.readFileSync(__filename)),
    workspace: permitted(() => fs.readFileSync(fixture.workspace)),
    home: permitted(() => fs.readFileSync(fixture.home)),
    write: permitted(() => fs.writeFileSync('marker.txt', 'sandbox test')),
    child: permitted(() => spawnSync(process.execPath, ['-v'])),
  };
  reply(id, { content: [{ type: 'text', text: JSON.stringify(status) }] });
}

lines.on('line', line => {
  const message = JSON.parse(line);
  methods.push(message.method);
  if (message.method === 'initialize') {
    reply(message.id, { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} },
      serverInfo: { name: 'isolated-fixture', version: '1.0.0' } });
  }
  if (message.method === 'tools/list') reply(message.id, { tools: [{ name: 'unlisted', inputSchema: { type: 'object' } }] });
  if (message.method !== 'tools/call' || message.params.name !== 'read_status') return;
  const { document } = message.params.arguments;
  if (document === 'wait') return;
  if (document === 'oversized') {
    reply(message.id, { content: [{ type: 'text', text: 'a'.repeat(520_000) }] });
    return;
  }
  void probe(message.id, document);
});

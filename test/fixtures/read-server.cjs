const http = require('node:http');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');

async function startReadServer() {
  const token = 'test-only-mcp-credential';
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) return res.writeHead(401).end();
    if (req.method !== 'POST') return res.writeHead(405).end();
    const mcp = new McpServer({ name: 'read-test', version: '1.0.0' });
    mcp.registerTool('read_doc', { inputSchema: { document: z.string() }, annotations: { readOnlyHint: true } }, async ({ document }) => {
      calls++;
      return { content: [{ type: 'text', text: `Fixture document ${document}. Echo ${token}` }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.once('close', () => { void mcp.close().catch(() => {}); });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { token, calls: () => calls,
    config: { id: 'docs', account: 'test-reader', url: `http://127.0.0.1:${server.address().port}/mcp`,
      tools: [{ name: 'read_doc', targetArgument: 'document', targets: ['manual'] }] },
    close() { server.close(); server.closeAllConnections(); },
  };
}

module.exports = { startReadServer };

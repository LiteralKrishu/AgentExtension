const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

const server = new McpServer({ name: 'local-connector-fixture', version: '1.0.0' });
server.registerTool('read_status', {}, async () => ({ content: [{ type: 'text', text: JSON.stringify({
  cwd: process.cwd(), inheritsHome: Boolean(process.env.HOME || process.env.USERPROFILE),
}) }] }));
server.registerTool('wait_for_close', {}, async () => {
  process.stderr.write('waiting\n');
  await new Promise(() => {});
});
server.connect(new StdioServerTransport()).catch(() => { process.exitCode = 1; });

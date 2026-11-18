// Keep the standalone API private to the VS Code window that started it.
const { registerHooks } = require('node:module');
const { timingSafeEqual } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { serve } = require('@hono/node-server');
const Database = require('better-sqlite3');

const entry = pathToFileURL(require.resolve('@truefoundry/trueforge/dist/main.js')).href;

// VS Code saves the provider secret. Keep TrueForge's working copy and sessions in memory.
module.exports = function openDatabase() {
  return new Database(':memory:');
};

module.exports.serve = (options, listening) => {
  const expected = Buffer.from(`Bearer ${process.env.AGENTEXTENSION_SERVER_TOKEN}`);
  const server = serve({
    ...options, hostname: '127.0.0.1', port: 0,
    fetch(request, ...args) {
      const actual = Buffer.from(request.headers.get('authorization') ?? '');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        return new Response(null, { status: 401 });
      }
      return options.fetch(request, ...args);
    },
  }, address => {
    listening(address);
    process.send({ port: address.port });
  });
  return server;
};

if (require.main === module) {
  if (!process.send || !/^[a-f0-9]{64}$/.test(process.env.AGENTEXTENSION_SERVER_TOKEN ?? '')) process.exit(1);
  process.on('disconnect', () => process.kill(process.pid, 'SIGTERM'));
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL === entry && (specifier === '@hono/node-server' || specifier === 'better-sqlite3')) {
        return { url: pathToFileURL(__filename).href, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
  import(entry).catch(() => process.exit(1));
}

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const { z } = require('zod');
const { verifyExportEvents, workspaceId } = require('./audit');
const { validateAdminDocument } = require('./policy');
const { tokenHash, BATCH_SIZE } = require('./organization');
const { collaborationConfig, serveProject } = require('./collaboration-service');

const installation = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const clientSchema = z.strictObject({
  id: installation, tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  workspaces: z.array(workspaceId).min(1).max(64),
  writeAudit: z.boolean().default(false), readAudit: z.boolean().default(false),
});
const configuration = z.strictObject({
  clients: z.array(clientSchema).min(1).max(500),
  policies: z.record(workspaceId, z.unknown()),
  retentionDays: z.number().int().min(1).max(365).default(30),
  maxEvents: z.number().int().min(1).max(20_000).default(10_000),
  collaboration: collaborationConfig.optional(),
}).refine(config => new Set(config.clients.map(client => client.id)).size === config.clients.length
  && new Set(config.clients.map(client => client.tokenHash)).size === config.clients.length, 'Client IDs and tokens must be unique.');
const batchSchema = z.strictObject({ format: z.literal('agentextension-audit/1'), events: z.array(z.unknown()).min(1).max(BATCH_SIZE) });

async function readConfig(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 1_000_000) throw new Error('Invalid organization configuration.');
  const config = configuration.parse(JSON.parse(await fs.readFile(file, 'utf8')));
  for (const value of Object.values(config.policies)) validateAdminDocument(value);
  return config;
}

async function readBatch(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 256_000) throw new Error('Audit batch is too large.');
    chunks.push(chunk);
  }
  return batchSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

function authenticate(config, request, workspace) {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  const supplied = Buffer.from(tokenHash(header.slice(7)), 'hex');
  return config.clients.find(client => timingSafeEqual(Buffer.from(client.tokenHash, 'hex'), supplied) && client.workspaces.includes(workspace));
}

class Collector {
  constructor(storage, now) {
    this.storage = storage;
    this.now = now;
    this.queue = Promise.resolve();
  }
  serialize(operation) {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => {});
    return next;
  }
  file(workspace, client) { return path.join(this.storage, workspace, `${client}.json`); }
  async read(file) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return { head: null, entries: [] }; }
  }
  async save(file, state) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  retained(entries, config) {
    const cutoff = this.now() - config.retentionDays * 86_400_000;
    return entries.filter(entry => entry.receivedAt >= cutoff).slice(-config.maxEvents);
  }
  append(workspace, client, events, config) {
    return this.serialize(async () => {
      const file = this.file(workspace, client);
      const state = await this.read(file);
      const retained = new Map(state.entries.map(entry => [entry.event.seq, entry.event]));
      let accepted = 0;
      let duplicates = 0;
      for (const event of events) {
        if (state.head && event.seq <= state.head.seq) {
          const previous = retained.get(event.seq) ?? (event.seq === state.head.seq ? state.head : undefined);
          if (previous && (event.hash !== previous.hash || event.exportHash !== previous.exportHash)) return undefined;
          duplicates++;
          continue;
        }
        if (state.head && (event.seq !== state.head.seq + 1 || event.prev !== state.head.hash)) return undefined;
        state.entries.push({ receivedAt: this.now(), event });
        state.head = { seq: event.seq, hash: event.hash, exportHash: event.exportHash };
        accepted++;
      }
      const kept = this.retained(state.entries, config);
      if (accepted || kept.length !== state.entries.length) await this.save(file, { ...state, entries: kept });
      return { accepted, duplicates, confirmed: events.at(-1).hash };
    });
  }
  list(workspace, client, config, after) {
    return this.serialize(async () => {
      const file = this.file(workspace, client);
      const state = await this.read(file);
      const kept = this.retained(state.entries, config);
      if (kept.length !== state.entries.length) await this.save(file, { ...state, entries: kept });
      return { events: kept.filter(entry => entry.event.seq > after).slice(0, BATCH_SIZE).map(entry => entry.event) };
    });
  }
  prune(config) {
    return this.serialize(async () => {
      const workspaces = await fs.readdir(this.storage).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
      for (const workspace of workspaces.filter(value => workspaceId.safeParse(value).success)) {
        const files = await fs.readdir(path.join(this.storage, workspace));
        for (const name of files.filter(value => /^[a-zA-Z0-9_-]{1,64}\.json$/.test(value))) {
          const file = path.join(this.storage, workspace, name);
          const state = await this.read(file);
          const kept = this.retained(state.entries, config);
          if (kept.length !== state.entries.length) await this.save(file, { ...state, entries: kept });
        }
      }
    });
  }
}

function createOrganizationService({ configFile, storage, now = Date.now }) {
  const collector = new Collector(storage, now);
  const server = http.createServer(async (request, response) => {
    const send = (status, body) => response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
    try {
      const url = new URL(request.url, 'http://localhost');
      if (!['/v1/policy', '/v1/audit', '/v1/project'].includes(url.pathname)) return send(404, { error: 'Unknown endpoint.' });
      const workspace = url.searchParams.get('workspace');
      if (!workspaceId.safeParse(workspace).success) return send(400, { error: 'A workspace key is required.' });
      const config = await readConfig(configFile);
      const client = authenticate(config, request, workspace);
      if (!client) return send(403, { error: 'Workspace access denied.' });
      if (url.pathname === '/v1/project') return await serveProject({ url, request, send, store: collector, workspace, reload: async () => {
        const config = await readConfig(configFile);
        return { config, client: authenticate(config, request, workspace) };
      } });
      if (request.method === 'GET' && url.pathname === '/v1/policy') {
        const policy = config.policies[workspace];
        return policy ? send(200, policy) : send(404, { error: 'Workspace policy is unavailable.' });
      }
      if (request.method === 'GET' && url.pathname === '/v1/audit') {
        if (!client.readAudit) return send(403, { error: 'Audit read access denied.' });
        const stream = installation.safeParse(url.searchParams.get('client') ?? client.id);
        const after = Number(url.searchParams.get('after') ?? 0);
        if (!stream.success || !Number.isSafeInteger(after) || after < 0) return send(400, { error: 'Invalid audit cursor.' });
        return send(200, await collector.list(workspace, stream.data, config, after));
      }
      if (request.method === 'POST' && url.pathname === '/v1/audit') {
        if (!client.writeAudit) return send(403, { error: 'Audit write access denied.' });
        let batch;
        try {
          batch = await readBatch(request);
          verifyExportEvents(batch.events, workspace);
        } catch { return send(422, { error: 'Audit export failed verification.' }); }
        const result = await collector.append(workspace, client.id, batch.events, config);
        return result ? send(200, result) : send(409, { error: 'Audit chain conflicts with previously received events.' });
      }
      return send(405, { error: 'Method unavailable.' });
    } catch { return send(503, { error: 'Organization configuration or storage is unavailable.' }); }
  });
  const prune = () => readConfig(configFile).then(config => collector.prune(config)).catch(() => {});
  const cleanup = setInterval(prune, 3_600_000);
  cleanup.unref();
  server.on('listening', () => { void prune(); });
  server.on('close', () => clearInterval(cleanup));
  return server;
}

module.exports = { createOrganizationService };

if (require.main === module) {
  const [, , configFile, storage, rawPort = '8788'] = process.argv;
  const port = Number(rawPort);
  if (!configFile || !storage || !path.isAbsolute(configFile) || !path.isAbsolute(storage) || !Number.isInteger(port) || port < 1 || port > 65_535) {
    process.stderr.write('Usage: node <organization-service> <absolute-config-file> <absolute-storage> [port]\n');
    process.exitCode = 1;
  } else {
    createOrganizationService({ configFile, storage }).listen(port, '127.0.0.1', () => {
      process.stdout.write(`Organization service listening on 127.0.0.1:${port}\n`);
    });
  }
}

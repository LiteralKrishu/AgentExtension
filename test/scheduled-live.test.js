const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { Workspace } = require('../src/workspace');
const { ScheduleStore, Scheduler, schedulePin, zonedInstant } = require('../src/schedules');
const { runScheduledReport } = require('../src/scheduled-run');
const { secretKey } = require('../src/connectors');
const { startReadServer } = require('./fixtures/read-server.cjs');

const baseUrl = process.env.AGENTEXTENSION_TEST_FORGE_URL;
const options = { skip: !baseUrl && 'Set AGENTEXTENSION_TEST_FORGE_URL to a local TrueForge instance.', timeout: 90_000 };
const WRITE_TOOLS = ['propose_write', 'propose_lines', 'create_file', 'review_changes', 'run_command', 'propose_plan',
  'research_repository', 'review_draft', 'browser_open', 'browser_act', 'computer_act', 'read_skill_resource'];

function respond(res, req, message, usage) {
  const chunk = (delta, finish_reason) => ({ id: 'scheduled', object: 'chat.completion.chunk', created: 1, model: req.model,
    choices: [{ index: 0, delta, finish_reason }] });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', ...message }, null))}\n\n`);
  res.write(`data: ${JSON.stringify(chunk({}, message.tool_calls ? 'tool_calls' : 'stop'))}\n\n`);
  if (usage) res.write(`data: ${JSON.stringify({ ...chunk({}, null), choices: [], usage })}\n\n`);
  res.end('data: [DONE]\n\n');
}

async function environment(t) {
  const { TrueForge } = await import('@truefoundry/trueforge-sdk');
  const forge = new TrueForge({ baseUrl, maxRetries: 0 });
  const name = `agentextension-sched-${randomBytes(5).toString('hex')}`;
  const seen = [];
  let providerError;
  const connector = await startReadServer();
  t.after(() => connector.close());
  const provider = http.createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const input = JSON.parse(raw);
      const all = JSON.stringify(input.messages);
      const tools = input.tools.map(tool => tool.function.name);
      const find = suffix => tools.find(tool => tool.endsWith(suffix));
      const defer = tools.find(tool => tool.endsWith('call_tool'));
      const server = all.match(/agentextension-[a-f0-9]{16}/)?.[0];
      const results = input.messages.filter(message => message.role === 'tool');
      const round = results.length;
      seen.push({ tools, round, all });
      assert.ok(!all.includes(connector.token), 'Connector credential reached the model');
      assert.match(all, /SCHEDULED READ-ONLY REPORT MODE/);
      assert.match(all, /scheduled read-only report/);
      for (const tool of tools) assert.ok(!WRITE_TOOLS.some(name => tool.endsWith(name)), `Write tool exposed: ${tool}`);
      const call = (tool, args) => respond(res, input, { tool_calls: [{ index: 0, id: `call_${round}`, type: 'function',
        function: { name: tool, arguments: JSON.stringify(args) } }] });
      const deferred = (tool, args) => call(defer, { mcp_server: server, tool_name: tool, input: args });
      if (all.includes('Token limit probe')) {
        return respond(res, input, { content: 'Token limit probe result.' }, { prompt_tokens: 1_200, completion_tokens: 50, total_tokens: 1_250 });
      }
      if (all.includes('Nightly release summary')) {
        if (round === 0) return call(find('search_workspace'), { query: 'release' });
        if (round === 1) return call(find('read_file'), { file: 'NOTES.md' });
        if (round === 2) return call(find('list_connector_tools'), {});
        if (round === 3) return call(find('connector_read'), { connector: 'docs', tool: 'read_doc', arguments: { document: 'manual' } });
        if (round === 4) {
          assert.match(all, /Fixture document manual/);
          assert.match(all, /\[credential removed\]/);
          return defer ? deferred('propose_write', { file: 'NOTES.md', old_text: 'Release', new_text: 'Changed' })
            : call(find('read_file'), { file: 'NOTES.md' });
        }
        if (round === 5) return defer ? deferred('run_command', { command: 'node', args: ['-v'] }) : call(find('read_file'), { file: 'NOTES.md' });
        return respond(res, input, { content: '## Findings\n- NOTES.md:1 Release 2.4 is pending.\n- docs/manual mentions the fixture.\n## Recommendations\n- Start an interactive run to update NOTES.md.' });
      }
      if (all.includes('Budget probe')) {
        if (round < 3) return call(find('search_workspace'), { query: `release ${round}` });
        assert.match(JSON.stringify(results.at(-1)), /budget reached/);
        return respond(res, input, { content: 'Stopped at the tool budget.' });
      }
      if (all.includes('Connector limit probe')) {
        if (round === 0) return call(find('connector_read'), { connector: 'docs', tool: 'read_doc', arguments: { document: 'manual' } });
        return respond(res, input, { content: 'Connector read was not available.' });
      }
      if (all.includes('Unlisted target probe')) {
        if (round === 0) return call(find('connector_read'), { connector: 'docs', tool: 'read_doc', arguments: { document: 'secret-plan' } });
        return respond(res, input, { content: 'Unlisted target refused.' });
      }
      return respond(res, input, { content: 'Unknown scenario.' });
    } catch (error) {
      providerError ??= error;
      res.writeHead(500).end();
    }
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => { provider.close(); provider.closeAllConnections(); });
  await forge.settings.modelProviders.createOrUpdate({ manifest: {
    type: 'custom', name, baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, auth: { apiKey: 'fixture-key' },
    models: [{ modelId: 'good', name: 'good', properties: { contextLength: 16000 } }],
  } });
  t.after(() => forge.settings.modelProviders.delete(name));
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-sched-')));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-storage-'));
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(storage, { recursive: true, force: true })]));
  const files = { 'NOTES.md': 'Release 2.4 is pending.\nOwner: docs team.\n', 'src/app.js': 'export const release = "2.4";\n' };
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), text);
  }
  const workspace = new Workspace(root, () => undefined, async () => Object.keys(files));
  workspace.identity = root;
  const secrets = { get: async key => key === secretKey(connector.config) ? connector.token : undefined };
  const settings = { serverUrl: baseUrl, model: `${name}/good`, fallbackModel: '', compaction: true, turnTimeoutSeconds: 60 };
  return { forge, connector, provider, seen, providerError: () => providerError, root, storage, workspace, secrets, settings, files };
}

function scheduleFor(prompt, overrides = {}) {
  return { name: prompt.split(':')[0], prompt, days: [0, 1, 2, 3, 4, 5, 6], times: ['09:00'], timeZone: 'Asia/Kolkata',
    connectors: ['docs'], budget: { minutes: 2, toolCalls: 12, connectorReads: 2 }, catchUpMinutes: 60, ...overrides };
}

async function pinFor(env, schedule, configs = [env.connector.config]) {
  const selected = configs.filter(config => schedule.connectors.includes(config.id));
  return schedulePin({ workspace: env.root, schedule, connectors: selected,
    credentials: await Promise.all(selected.map(async config => `${config.id}:${await env.secrets.get(secretKey(config)) ?? ''}`)),
    model: env.settings.model, serverUrl: env.settings.serverUrl });
}

test('a scheduled report stops when streamed model usage reaches its approved token limit', options, async t => {
  const env = await environment(t);
  const input = scheduleFor('Token limit probe', { connectors: [], budget: { minutes: 2, toolCalls: 12, connectorReads: 0, maxTokens: 1_000 } });
  const store = new ScheduleStore(env.storage, env.root);
  const schedule = await store.create(input, await pinFor(env, input), Date.now());
  const at = Date.now();
  const result = await runScheduledReport({ schedule, occurrence: { at, slot: 'Test occurrence' }, trigger: 'manual',
    workspace: env.workspace, settings: env.settings, secrets: env.secrets, storage: env.storage });
  assert.ifError(env.providerError());
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /token limit of 1,000/);
  assert.equal(result.usage.tokens, 1_250);
  assert.match(await fs.readFile(result.report, 'utf8'), /\| Model tokens \| 1,250 \| 1,000 \|/);
  assert.equal(env.seen.length, 1);
});

test('a due schedule runs once through TrueForge with read tools, a standing connector approval and a saved report', options, async t => {
  const env = await environment(t);
  const store = new ScheduleStore(env.storage, env.root);
  const input = scheduleFor('Nightly release summary: list pending releases from notes and the manual.');
  const approvedAt = Date.UTC(2026, 10, 10, 12, 0);
  const schedule = await store.create(input, await pinFor(env, input), approvedAt);
  const nine = zonedInstant({ year: 2026, month: 11, day: 11, hour: 9, minute: 0 }, 'Asia/Kolkata').at;
  assert.equal(new Date(nine).toISOString(), '2026-11-11T03:30:00.000Z');
  let clock = nine - 60_000;
  const runs = [];
  const scheduler = new Scheduler({ store, now: () => clock, pinFor: item => pinFor(env, item),
    execute: async (item, occurrence, trigger) => {
      runs.push({ occurrence, trigger });
      return runScheduledReport({ schedule: item, occurrence, trigger, workspace: env.workspace, settings: env.settings,
        connectorConfigs: [env.connector.config], secrets: env.secrets, notes: [{ id: 'n', text: 'Releases are tracked in NOTES.md.' }],
        storage: env.storage });
    } });
  await scheduler.tick();
  assert.equal(runs.length, 0, 'Nothing runs before 09:00 IST');
  clock = nine + 5_000;
  await scheduler.tick();
  await scheduler.tick();
  assert.ifError(env.providerError());
  assert.equal(runs.length, 1, 'One run per occurrence');
  assert.equal(runs[0].trigger, 'schedule');
  assert.equal(runs[0].occurrence.slot, '2026-11-11 09:00');
  const [record] = await store.history(schedule.id);
  assert.equal(record.status, 'completed', record.reason);
  assert.equal(record.usage.connectorReads, 1);
  assert.equal(record.usage.toolCalls, 4, 'Refused write attempts never reached the editor bridge');
  assert.equal(record.usage.writesRequested, 2, 'Both write attempts are counted in the report');
  assert.equal(env.connector.calls(), 1);
  const report = await fs.readFile(record.report, 'utf8');
  assert.match(report, /Scheduled for: 2026-11-11 09:00 Asia\/Kolkata \(2026-11-11T03:30:00.000Z\) · trigger: schedule/);
  assert.match(report, /Outcome: completed/);
  assert.match(report, /NOTES.md:1 Release 2.4 is pending/);
  assert.match(report, /\| Connector reads \| 1 \| 2 \|/);
  assert.match(report, /\| Write tool requests refused \| 2 \| 0 approved \|/);
  assert.match(report, /connector\\_read · connector.read · approve · Standing schedule approval for a listed target/);
  assert.ok(!report.includes(env.connector.token));
  for (const [file, text] of Object.entries(env.files)) assert.equal(await fs.readFile(path.join(env.root, file), 'utf8'), text);
  const lastTools = env.seen.at(-1).tools;
  assert.ok(lastTools.some(tool => tool.endsWith('connector_read')));
  // TrueForge's deferred-call tool exists, but it refuses tools outside the read-only allowlist.
  assert.ok(lastTools.some(tool => tool.endsWith('call_tool')));
  const attempts = env.seen.find(entry => entry.round === 6).all;
  assert.match(attempts, /Tool 'propose_write' is not allowed on MCP server/);
  assert.match(attempts, /Tool 'run_command' is not allowed on MCP server/);
});

test('tool budget, connector-read budget and unlisted targets stop unattended work', options, async t => {
  const env = await environment(t);
  const run = async (prompt, budget) => {
    const schedule = { ...scheduleFor(prompt), id: 'fixed', approval: { digest: 'x', at: 0 }, budget };
    return runScheduledReport({ schedule, occurrence: { at: Date.now(), slot: 'manual' }, trigger: 'manual', workspace: env.workspace,
      settings: env.settings, connectorConfigs: [env.connector.config], secrets: env.secrets, storage: env.storage });
  };
  const tools = await run('Budget probe: search three times.', { minutes: 2, toolCalls: 2, connectorReads: 1 });
  assert.equal(tools.status, 'completed', tools.reason);
  assert.equal(tools.usage.toolCalls, 2);
  const reads = await run('Connector limit probe: read the manual.', { minutes: 2, toolCalls: 5, connectorReads: 0 });
  assert.equal(reads.usage.connectorReads, 0);
  const unlisted = await run('Unlisted target probe: read a secret plan.', { minutes: 2, toolCalls: 5, connectorReads: 2 });
  assert.equal(unlisted.usage.connectorReads, 0);
  assert.equal(env.connector.calls(), 0);
  assert.ifError(env.providerError());
  assert.match(await fs.readFile(tools.report, 'utf8'), /\| Tool calls \| 2 \| 2 \|/);
});

test('changed connector scope blocks the next run until it is approved again; an offline server is recorded', options, async t => {
  const env = await environment(t);
  const store = new ScheduleStore(env.storage, env.root);
  const input = scheduleFor('Nightly release summary: list pending releases.');
  const schedule = await store.create(input, await pinFor(env, input), Date.UTC(2026, 10, 10, 12, 0));
  const nine = zonedInstant({ year: 2026, month: 11, day: 11, hour: 9, minute: 0 }, 'Asia/Kolkata').at;
  const widened = { ...env.connector.config, tools: [{ ...env.connector.config.tools[0], targets: ['manual', 'secret-plan'] }] };
  let executed = 0;
  const scheduler = new Scheduler({ store, now: () => nine + 1_000, pinFor: item => pinFor(env, item, [widened]),
    execute: async () => { executed++; return { status: 'completed' }; } });
  await scheduler.tick();
  assert.equal(executed, 0);
  const [blocked] = await store.history(schedule.id);
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.reason, /changed after approval/);
  const [stored] = await store.list();
  assert.equal(stored.enabled, false);
  assert.equal(stored.needsReview, true);

  const closed = http.createServer(); await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
  const port = closed.address().port; closed.close();
  const offline = await runScheduledReport({ schedule: { ...stored, connectors: [], enabled: true }, occurrence: { at: nine, slot: '2026-11-11 09:00' },
    trigger: 'schedule', workspace: env.workspace, settings: { ...env.settings, serverUrl: `http://127.0.0.1:${port}` },
    connectorConfigs: [], secrets: env.secrets, storage: env.storage });
  assert.equal(offline.status, 'offline', offline.reason);
  assert.match(await fs.readFile(offline.report, 'utf8'), /Outcome: offline/);
});

const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const { runWorkerSession } = require('../src/worker-session');
const { WorkerPool } = require('../src/workers');
const { Draft } = require('../src/draft');
const { PermissionBroker } = require('../src/permissions');

const baseUrl = process.env.AGENTEXTENSION_TEST_FORGE_URL;
const options = { skip: !baseUrl && 'Set AGENTEXTENSION_TEST_FORGE_URL.', timeout: 20_000 };
const snapshot = { role: 'repository-research', question: 'Find the entry point',
  sources: [{ file: 'main.js', start: 1, end: 1, text: 'const main = 1;' }], digest: 'fixture' };
async function fixture(t, mode = 'good') {
  const { TrueForge } = await import('@truefoundry/trueforge-sdk');
  const client = new TrueForge({ baseUrl, maxRetries: 0 });
  const name = `worker-test-${randomBytes(5).toString('hex')}`;
  let failure;
  let requests = 0;
  const server = http.createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const input = JSON.parse(raw);
      assert.deepEqual((input.tools ?? []).map(tool => tool.function.name), ['get_current_datetime'], 'Only the server clock is exposed, with no workspace or connector tools');
      const messages = JSON.stringify(input.messages);
      assert.ok(!messages.includes('parent-private-memory'));
      assert.match(messages, /bounded read-only subagent/);
      requests++;
      const report = JSON.stringify({ summary: 'Entry point found.', findings: [{ file: 'main.js', line: 1, severity: 'info', message: 'Main declaration.' }] });
      const delta = mode === 'tool' ? { role: 'assistant', tool_calls: [{ index: 0, id: 'attack', type: 'function', function: {
        name: 'run_command', arguments: JSON.stringify({ command: 'touch', args: ['should-not-exist'] }),
      } }] } : { role: 'assistant', content: mode === 'oversized' ? 'x'.repeat(8_001) : mode === 'hold' ? '{' : report };
      const packet = (delta, finish_reason) => ({ id: 'worker-message', object: 'chat.completion.chunk', created: 1, model: input.model,
        choices: [{ index: 0, delta, finish_reason }] });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify(packet(delta, null))}\n\n`);
      if (mode === 'hold') return;
      res.end(`data: ${JSON.stringify(packet({}, mode === 'tool' ? 'tool_calls' : 'stop'))}\n\ndata: [DONE]\n\n`);
    } catch (error) { failure = error; res.writeHead(500).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await client.settings.modelProviders.createOrUpdate({ manifest: { name, type: 'custom',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, models: [{ name: 'worker', modelId: 'worker', properties: { contextLength: 16000 } }] } });
  t.after(async () => { server.close(); server.closeAllConnections(); await client.settings.modelProviders.delete(name); });
  return { client, settings: { serverUrl: baseUrl, model: `${name}/worker` }, failure: () => failure, requests: () => requests };
}

test('a real child session exposes only the server clock, with no memory, skills or inherited MCP servers', options, async t => {
  const f = await fixture(t);
  let url;
  const text = await runWorkerSession(f.settings, snapshot, new AbortController().signal, value => { url = value; })
    .catch(error => { throw f.failure() ?? error; });
  assert.ifError(f.failure());
  assert.equal(JSON.parse(text).findings[0].file, 'main.js');
  assert.equal(f.requests(), 1);
  const session = (await f.client.sessions.get(url.split('/').at(-1))).data;
  assert.deepEqual(session.agent.spec.mcpServers, []);
  assert.deepEqual(session.agent.spec.skills, []);
  assert.equal(session.agent.spec.config.memory.enabled, false);
  assert.equal(session.agent.spec.config.dynamicSubAgents.enabled, false);
  assert.equal(session.agent.spec.config.iterationLimit, 1);
});

test('a child tool-call attempt fails without reaching any editor executor', options, async t => {
  const f = await fixture(t, 'tool');
  await assert.rejects(runWorkerSession(f.settings, snapshot, new AbortController().signal), /Worker attempted a tool call/);
  assert.ifError(f.failure());
});

test('oversized live child output is stopped', options, async t => {
  const f = await fixture(t, 'oversized');
  await assert.rejects(runWorkerSession(f.settings, snapshot, new AbortController().signal), /output exceeded/);
  assert.ifError(f.failure());
});

test('cancelling a parent stops both active TrueForge child turns', options, async t => {
  const f = await fixture(t, 'hold');
  const controller = new AbortController();
  const run = { signal: controller.signal, privateMemory: 'parent-private-memory',
    workspace: { read: async () => 'const main = 1;' }, search: async () => [{ file: 'main.js', line: 1 }] };
  run.draft = new Draft(run.workspace.read);
  run.permissions = new PermissionBroker({ workspace: '/fixture', signal: controller.signal });
  run.permissions.allowScope('worker.research');
  const pool = new WorkerPool({ run, settings: f.settings, roles: ['repository-research'] });
  const pending = Promise.allSettled([pool.execute('repository-research', { question: 'Wait' }), pool.execute('repository-research', { question: 'Wait' })]);
  for (let attempt = 0; attempt < 60 && f.requests() < 2; attempt++) await sleep(50);
  assert.equal(f.requests(), 2);
  controller.abort();
  assert.ok((await pending).every(result => result.status === 'rejected'));
  await pool.close();
  for (const row of pool.reports) {
    const session = (await f.client.sessions.get(row.session.split('/').at(-1))).data;
    assert.equal(session.lastTurnDetails.state.status, 'cancelled');
  }
  assert.ifError(f.failure());
});

test('a repository worker reads named snapshot lines and is denied a tool outside its role', options, async t => {
  const { scriptedModel } = require('./helpers/host.cjs');
  const model = await scriptedModel(t, baseUrl, ({ input, tools, round, call, say, results }) => {
    assert.ok(!tools.some(name => name.endsWith('run_command')));
    const request = JSON.parse(input.messages.find(message => message.role === 'user').content);
    if (request.previous_reply_rejected) {
      assert.match(request.previous_reply_rejected, /tool call outside its role/);
      assert.ok(!tools.some(name => name.endsWith('read_file')));
      return say(JSON.stringify({ summary: 'No tool used on retry.', findings: [] }));
    }
    assert.ok(tools.some(name => name.endsWith('read_file')));
    if (request.question === 'Try an unavailable tool') return call('get_current_datetime', {});
    if (round === 0) return call('read_file', { file: 'outside.js', start_line: 1 });
    if (round === 1) {
      assert.match(results.at(-1).content, /explicitly named/);
      return call('read_file', { file: 'main.js', start_line: 55, end_line: 55 });
    }
    assert.match(results.at(-1).content, /line 55/);
    return say(JSON.stringify({ summary: 'Line read.', findings: [{ file: 'main.js', line: 55, severity: 'info', message: 'Read only.' }] }));
  });
  const signal = new AbortController().signal;
  const permissions = new PermissionBroker({ workspace: '/fixture', signal });
  for (const effect of ['workspace.read', 'worker.custom', 'worker.read']) permissions.allowScope(effect);
  const run = { permissions, signal, workspace: { read: async () => Array.from({ length: 80 }, (_, index) => `// line ${index + 1}`).join('\n') } };
  const role = { id: 'test/read', name: 'read', instructions: 'Inspect the named file.', snapshot: 'repository', tools: ['read_file'] };
  const pool = new WorkerPool({ run, settings: { serverUrl: baseUrl, model: model.model }, roles: [], customRoles: [role] });
  try {
    const result = await pool.execute(role.id, { question: 'Read extra lines', files: ['main.js'] })
      .catch(error => { throw model.state.error ?? error; });
    assert.equal(result.findings[0].line, 55);
    assert.ok(permissions.events.some(event => event.effect === 'worker.read' && event.decision === 'allow'));
    assert.ok(permissions.events.some(event => event.effect === 'worker.read' && event.decision === 'deny'));
    const retried = await pool.execute(role.id, { question: 'Try an unavailable tool', files: ['main.js'] });
    assert.equal(retried.summary, 'No tool used on retry.');
    assert.match(pool.reports.at(-1).retried, /tool call outside its role/);
    assert.ifError(model.state.error);
  } finally { await pool.close(); }
});

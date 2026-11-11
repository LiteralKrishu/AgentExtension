const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { Draft } = require('../src/draft');
const { runForge } = require('../src/forge');
const { search } = require('../src/context');
const { PermissionBroker } = require('../src/permissions');
const { ReadConnectors } = require('../src/connectors');
const { SkillRegistry } = require('../src/skills');
const { ContextManifest, composePrompt } = require('../src/prompt');
const { startReadServer } = require('./fixtures/read-server.cjs');
const path = require('node:path');

const baseUrl = process.env.AGENTEXTENSION_TEST_FORGE_URL;
const options = { skip: !baseUrl && 'Set AGENTEXTENSION_TEST_FORGE_URL to a local TrueForge instance.', timeout: 45_000 };

function respond(res, req, message) {
  const chunk = (delta, finish_reason) => ({
    id: 'test-completion', object: 'chat.completion.chunk', created: 1, model: req.model,
    choices: [{ index: 0, delta, finish_reason }],
  });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', ...message }, null))}\n\n`);
  res.end(`data: ${JSON.stringify(chunk({}, message.tool_calls ? 'tool_calls' : 'stop'))}\n\ndata: [DONE]\n\n`);
}

function call(name, args, id) {
  return { tool_calls: [{ index: 0, id: `call_${id}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
}

async function fixture(t, mode, { fallback = false, cancel = false, cancelOnToken = false, command = false,
  forgetReview = false, planFirst = false, cancelPlan = false, capabilities = false, surfaceWrites = false, policy } = {}) {
  const { TrueForge } = await import('@truefoundry/trueforge-sdk');
  const forge = new TrueForge({ baseUrl, maxRetries: 0 });
  const name = `agentextension-test-${randomBytes(5).toString('hex')}`;
  let requests = 0;
  let providerError;
  let selectedSkillId;
  const provider = http.createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const input = JSON.parse(raw);
      if (input.model === 'bad') {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Invalid API key', type: 'invalid_request_error' } }));
        return;
      }
      const all = JSON.stringify(input.messages);
      const server = all.match(/agentextension-[a-f0-9]{16}/)?.[0];
      const tools = input.tools.map(tool => tool.function.name);
      const defer = tools.find(tool => tool.endsWith('call_tool'));
      const direct = tools.find(tool => tool.endsWith('search_workspace'));
      assert.ok(server && defer && direct, 'TrueForge exposed preloaded and deferred tools');
      const toolMessages = input.messages.filter(message => message.role === 'tool');
      let round = toolMessages.length;
      if (capabilities) {
        assert.ok(!all.includes('test-only-mcp-credential'), 'Credentials never enter model context');
        assert.match(all, /SELECTED SKILL WORKFLOWS/);
        assert.match(all, /WORKSPACE MEMORY/);
        if (round === 0) return respond(res, input, call(tools.find(tool => tool.endsWith('list_connector_tools')), {}, 'catalog'));
        if (round === 1) return respond(res, input, call(defer, { mcp_server: server, tool_name: 'connector_read',
          input: { connector: 'docs', tool: 'read_doc', arguments: { document: 'manual' } } }, 'connector'));
        if (round >= 2) assert.match(all, /Fixture document manual/);
        if (round === 2) return respond(res, input, call(defer, { mcp_server: server, tool_name: 'read_skill_resource',
          input: { skill: selectedSkillId, file: 'references/checks.md' } }, 'skill-resource'));
        if (round >= 3) assert.match(all, /Focused verification/);
        round -= 3;
      }
      if (round === 0) return respond(res, input, call(direct, { query: 'start' }, 0));
      if (planFirst) {
        const planTool = tools.find(tool => tool.endsWith('propose_plan'));
        assert.ok(planTool, 'TrueForge exposed the plan approval tool');
        if (round === 1) return respond(res, input, call(defer, {
          mcp_server: server, tool_name: 'propose_write', input: { file: 'file1.txt', old_text: 'start', new_text: 'too early' },
        }, 'early'));
        if (round === 2) {
          assert.match(JSON.stringify(toolMessages.at(-1)), /plan approval/);
          return respond(res, input, call(planTool, { goal: 'Change three files', steps: ['Edit the files'], checks: ['Check output'] }, 'plan'));
        }
        round -= 2;
      }
      if (round <= 3) return respond(res, input, call(defer, {
        mcp_server: server, tool_name: 'propose_write',
        input: { file: `file${round}.txt`, old_text: 'start', new_text: 'changed' },
      }, round));
      if (round === 4 && forgetReview && !all.includes('Call the editor review_changes tool now')) {
        return respond(res, input, { content: 'I staged the changes.' });
      }
      if (round === 4) return respond(res, input, call(defer, { mcp_server: server, tool_name: 'review_changes', input: {} }, 4));
      if (round === 5 && command) return respond(res, input, call(defer, {
        mcp_server: server, tool_name: 'run_command', input: { command: 'python3', args: ['-V'] },
      }, 5));
      if (cancelOnToken) {
        const chunk = { id: 'open-stream', object: 'chat.completion.chunk', created: 1, model: input.model,
          choices: [{ index: 0, delta: { role: 'assistant', content: 'Partial response' }, finish_reason: null }] };
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        return;
      }
      respond(res, input, { content: 'Finished through the real TrueForge stream.' });
      requests++;
    } catch (error) {
      providerError = error;
      res.writeHead(500).end();
    }
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => { provider.close(); provider.closeAllConnections(); });
  await forge.settings.modelProviders.createOrUpdate({ manifest: {
    type: 'custom', name, baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, auth: { apiKey: 'fixture-key' },
    models: ['good', 'bad'].map(id => ({ modelId: id, name: id, properties: { contextLength: 16000 } })),
  } });
  t.after(() => forge.settings.modelProviders.delete(name));
  const controller = new AbortController();
  const disk = new Map([1, 2, 3].map(number => [`file${number}.txt`, 'start\n']));
  const toolNames = [];
  const executed = [];
  const checks = [];
  const plans = [];
  const run = {
    planFirst,
    signal: controller.signal,
    search: (query, limit) => search([...disk].map(([path, text]) => ({ path, text })), query, limit),
    workspace: {
      read: async file => disk.get(file),
      command: async (executable, args, changes) => {
        executed.push({ command: executable, args, files: changes.map(change => change.file) });
        return { exitCode: 0, output: 'Check output' };
      },
    },
    commandGrants: new Map(),
    onTool: tool => toolNames.push(tool),
    onCheck: result => checks.push(result),
    resetDraft() {
      this.draft = new Draft(file => this.workspace.read(file));
      this.reviewed = undefined;
      this.reviewGrant = undefined;
      this.approvedPlan = undefined;
      this.planGrant = undefined;
    },
  };
  run.permissions = new PermissionBroker({ workspace: '/fixture', signal: controller.signal, policy });
  const prompts = [];
  run.permissions.allowScope('workspace.read');
  run.permissions.allowScope('draft.edit');
  let connectorFixture;
  let prompt = 'Change the files.';
  const manifest = new ContextManifest('/fixture');
  if (capabilities) {
    connectorFixture = await startReadServer();
    t.after(() => connectorFixture.close());
    run.connectors = new ReadConnectors({ configs: [connectorFixture.config], permissions: run.permissions,
      signal: controller.signal, secrets: { get: async () => connectorFixture.token } });
    run.permissions.allowScope('connector.catalog');
    run.skills = new SkillRegistry([path.join(__dirname, '..', 'skills')]);
    const catalog = await run.skills.discover();
    selectedSkillId = catalog[0].id;
    const skills = await run.skills.select([catalog[0].id]);
    run.permissions.allowScope('skill.read');
    run.manifest = manifest;
    prompt = composePrompt({ request: prompt, assembled: { text: '', selected: [], budget: 12000 }, skills,
      memory: [{ id: 'approved-note', text: 'Use focused checks.' }], manifest });
  }
  run.resetDraft();
  run.surfaceWrites = surfaceWrites;
  const output = [];
  const retries = [];
  const task = runForge({
    serverUrl: baseUrl, model: `${name}/${mode}`, compaction: !forgetReview, fallbackModel: fallback ? `${name}/good` : '',
  }, run, prompt, {
    status() {}, session() {}, token: text => {
      output.push(text);
      if (cancelOnToken) controller.abort();
    }, retry: text => retries.push(text),
    plan: async plan => {
      assert.equal(run.draft.files.size, 0);
      plans.push(plan);
      if (cancelPlan) controller.abort();
      return !cancelPlan;
    },
    command: async (input, target) => {
      prompts.push(input);
      assert.deepEqual(input, { command: 'python3', args: ['-V'] });
      assert.equal(executed.length, 0);
      assert.deepEqual(target, { revision: 3, scope: 'Accepted hunks' });
      return true;
    },
    connector: async request => {
      assert.equal(connectorFixture.calls(), 0);
      assert.equal(request.account, 'test-reader');
      assert.equal(request.target, 'manual');
      return true;
    },
    review: async hunks => {
      assert.equal(hunks.length, 3);
      assert.ok([...disk.values()].every(text => text === 'start\n'));
      if (cancel) controller.abort();
      return hunks.filter(hunk => hunk.file !== 'file2.txt');
    },
  });
  return { task, run, disk, toolNames, output, retries, executed, checks, plans, manifest, connectorFixture, prompts,
    providerError: () => providerError, requests: () => requests };
}

test('TrueForge uses selected skill and approved memory, then pauses for an authenticated connector read', options, async t => {
  const fixtureRun = await fixture(t, 'good', { capabilities: true });
  await fixtureRun.task;
  assert.ifError(fixtureRun.providerError());
  assert.equal(fixtureRun.connectorFixture.calls(), 1);
  assert.equal(fixtureRun.run.reviewed.hunks.length, 2);
  assert.ok(fixtureRun.manifest.entries.some(item => item.kind === 'tool result' && item.source === 'connector_read'));
  assert.ok(fixtureRun.manifest.entries.some(item => item.kind === 'skill'));
  assert.ok(fixtureRun.manifest.entries.some(item => item.kind === 'memory'));
});

test('TrueForge streams, discovers tools, stages three files, and resumes editor approval', options, async t => {
  const run = await fixture(t, 'good');
  await run.task;
  assert.ifError(run.providerError());
  assert.equal(run.requests(), 1);
  assert.ok(run.output.join('').includes('Finished'));
  assert.deepEqual(run.toolNames.filter(tool => tool !== 'search_workspace'),
    ['propose_write', 'propose_write', 'propose_write', 'review_changes']);
  assert.deepEqual(run.run.draft.changes(run.run.reviewed.hunks).map(change => change.file), ['file1.txt', 'file3.txt']);
  assert.ok([...run.disk.values()].every(text => text === 'start\n'));
});

test('TrueForge retries a rejected model without producing changes', options, async t => {
  const run = await fixture(t, 'bad');
  await assert.rejects(run.task, /model credentials were rejected/i);
  assert.equal(run.retries.length, 1);
  assert.equal(run.run.draft.files.size, 0);
  assert.ok([...run.disk.values()].every(text => text === 'start\n'));
});

test('TrueForge switches to a separately configured model after failure', options, async t => {
  const run = await fixture(t, 'bad', { fallback: true });
  await run.task;
  assert.equal(run.retries.length, 1);
  assert.equal(run.run.reviewed.hunks.length, 2);
});

test('a model failure after an approved external action does not retry or replay through fallback', options, async t => {
  const run = await fixture(t, 'bad', { fallback: true, surfaceWrites: true });
  await assert.rejects(run.task, /model credentials were rejected/i);
  assert.equal(run.retries.length, 0);
  assert.equal(run.run.draft.files.size, 0);
});

test('cancellation at the review boundary sends no approval and applies nothing', options, async t => {
  const run = await fixture(t, 'good', { cancel: true });
  await assert.rejects(run.task, { name: 'AbortError' });
  assert.equal(run.run.reviewed, undefined);
  assert.equal(run.requests(), 0);
  assert.ok([...run.disk.values()].every(text => text === 'start\n'));
});


test('TrueForge approves the exact command and checks only the accepted hunks', options, async t => {
  const run = await fixture(t, 'good', { command: true });
  await run.task;
  assert.deepEqual(run.executed, [{ command: 'python3', args: ['-V'], files: ['file1.txt', 'file3.txt'] }]);
  assert.equal(run.checks[0].revision, 3);
  assert.equal(run.checks[0].scope, 'Accepted hunks');
  assert.equal(run.checks[0].output, 'Check output');
});

test('permission rules run an allowed command without a prompt and refuse a denied one without asking', options, async t => {
  const { PolicyEngine } = require('../src/policy');
  const allowed = await fixture(t, 'good', { command: true, policy: new PolicyEngine({
    workspace: [{ effect: 'command.execute', target: 'python3 -V', decision: 'allow' }] }) });
  await allowed.task;
  assert.equal(allowed.prompts.length, 0);
  assert.deepEqual(allowed.executed, [{ command: 'python3', args: ['-V'], files: ['file1.txt', 'file3.txt'] }]);
  assert.ok(allowed.run.permissions.events.some(event => event.tool === 'run_command' && event.decision === 'approve'
    && event.reason === 'Allowed by workspace rule command.execute python3 -V'));
  const denied = await fixture(t, 'good', { command: true, policy: new PolicyEngine({
    admin: { rules: [{ effect: 'command.execute', target: 'python3 *', decision: 'deny', source: 'administrator' }], userAllowRules: true, sources: ['test'] },
    workspace: [{ effect: 'command.execute', target: 'python3 -V', decision: 'allow' }] }) });
  await denied.task;
  assert.equal(denied.prompts.length, 0);
  assert.deepEqual(denied.executed, []);
  assert.ok(denied.run.permissions.events.some(event => event.tool === 'run_command' && event.decision === 'deny'
    && event.reason === 'Denied by administrator rule command.execute python3 *'));
});

test('plan-first rejects early edits and resumes after plan approval', options, async t => {
  const run = await fixture(t, 'good', { planFirst: true });
  await run.task;
  assert.ifError(run.providerError());
  assert.equal(run.plans.length, 1);
  assert.equal(run.run.approvedPlan.goal, 'Change three files');
  assert.equal(run.run.draft.revision, 3);
  assert.equal(run.run.reviewed.hunks.length, 2);
});

test('cancelling plan approval leaves no staged changes', options, async t => {
  const run = await fixture(t, 'good', { planFirst: true, cancelPlan: true });
  await assert.rejects(run.task, { name: 'AbortError' });
  assert.equal(run.plans.length, 1);
  assert.equal(run.run.draft.files.size, 0);
});

test('cancelling during an open model stream aborts with no applicable changes', options, async t => {
  const run = await fixture(t, 'good', { cancelOnToken: true });
  await assert.rejects(run.task, { name: 'AbortError' });
  assert.ok(run.output.join('').includes('Partial response'));
  assert.equal(run.run.reviewed, undefined);
  assert.ok([...run.disk.values()].every(text => text === 'start\n'));
});


test('a staged draft gets one follow-up review request if the model forgets the tool', options, async t => {
  const run = await fixture(t, 'good', { forgetReview: true });
  await run.task;
  assert.equal(run.run.reviewed.hunks.length, 2);
  assert.ok(run.output.join('').includes('I staged the changes.'));
});

test('editor line proposals use exact read receipts and reject stale ranges', options, async t => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { openBridge } = require('../src/bridge');
  const read = async () => 'first\r\nsecond';
  const signal = new AbortController().signal;
  const permissions = new PermissionBroker({ workspace: '/fixture', signal });
  permissions.allowScope('workspace.read');
  permissions.allowScope('draft.edit');
  const bridge = await openBridge({
    signal, permissions,
    draft: new Draft(read),
    workspace: { read },
  });
  const client = new Client({ name: 'read-check', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    bridge.close();
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), {
    requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } },
  }));
  const result = await client.callTool({ name: 'read_file', arguments: { file: 'example.txt', start_line: 1 } });
  assert.equal(result.isError, undefined);
  const excerpt = JSON.parse(result.content[0].text);
  assert.deepEqual(excerpt, {
    file: 'example.txt', receipt: 1, total_lines: 2, start_line: 1, end_line: 2, text: 'first\r\nsecond', truncated: false,
  });
  const args = { receipt: excerpt.receipt, start_line: 2, delete_count: 0, new_text: 'inserted\n' };
  const outside = await client.callTool({ name: 'propose_lines', arguments: { ...args, start_line: 4 } });
  assert.equal(outside.isError, true);
  const joined = await client.callTool({ name: 'propose_lines', arguments: { ...args, new_text: 'inserted' } });
  assert.equal(joined.isError, true);
  assert.match(joined.content[0].text, /newline/);
  const mismatch = await client.callTool({ name: 'propose_lines', arguments: { ...args, start_line: 1, anchor_line: 'second' } });
  assert.match(mismatch.content[0].text, /anchor is on line 2/);
  const staged = await client.callTool({ name: 'propose_lines', arguments: { receipt: excerpt.receipt, anchor_line: 'second', new_text: 'inserted\n' } });
  assert.equal(staged.isError, undefined);
  const stale = await client.callTool({ name: 'propose_lines', arguments: args });
  assert.equal(stale.isError, true);
  const changed = await client.callTool({ name: 'read_file', arguments: { file: 'example.txt', start_line: 1 } });
  assert.equal(JSON.parse(changed.content[0].text).text, 'first\r\ninserted\r\nsecond');
  assert.equal(JSON.parse(changed.content[0].text).warning, undefined);
  // Inserting a near copy of the anchor without deleting it is staged with a warning.
  const receipt = JSON.parse(changed.content[0].text).receipt;
  const copy = await client.callTool({ name: 'propose_lines', arguments: { receipt, anchor_line: 'second', new_text: 'second fixed\r\n' } });
  assert.equal(copy.isError, undefined);
  assert.equal(JSON.parse(copy.content[0].text).warning, undefined, 'Different first word: no warning');
  const fresh = JSON.parse((await client.callTool({ name: 'read_file', arguments: { file: 'example.txt', start_line: 1 } })).content[0].text);
  const duplicate = await client.callTool({ name: 'propose_lines', arguments: { receipt: fresh.receipt, anchor_line: 'first', new_text: 'first(1)\r\n' } });
  assert.match(JSON.parse(duplicate.content[0].text).warning, /delete_count: 1/);
  // The same unchanged range read again and again gets a note, then a refusal.
  const reads = [];
  for (let index = 0; index < 7; index++) reads.push(await client.callTool({ name: 'read_file', arguments: { file: 'example.txt', start_line: 2 } }));
  assert.equal(JSON.parse(reads[1].content[0].text).note, undefined);
  assert.match(JSON.parse(reads[2].content[0].text).note, /Read 3 times/);
  assert.equal(reads[6].isError, true);
  assert.match(reads[6].content[0].text, /Stop reading it/);
});

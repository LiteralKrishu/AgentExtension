const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { startHost } = require('./helpers/host.cjs');
const { ManagedForge, MODEL_SECRET, readProfile } = require('../src/managed-forge');

const extensionPath = process.env.AGENTEXTENSION_TEST_PACKAGED_PATH;

test('installed VSIX connects a model and runs from saved credentials', { skip: !extensionPath, timeout: 90_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-first-run-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'README.md'), 'Test workspace.\n');
  let calls = 0;
  let providerRequests = 0;
  let authorization;
  let messages;
  const provider = http.createServer(async (req, res) => {
    providerRequests += 1;
    if (req.url !== '/v1/chat/completions') return res.writeHead(404).end();
    authorization = req.headers.authorization;
    let body = '';
    for await (const chunk of req) body += chunk;
    messages = JSON.parse(body).messages;
    calls += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish_reason) => JSON.stringify({
      id: 'fixture', object: 'chat.completion.chunk', model: 'test-model', choices: [{ index: 0, delta, finish_reason }],
    });
    res.write(`data: ${chunk({ role: 'assistant', content: 'The bundled connection works.' }, null)}\n\n`);
    res.end(`data: ${chunk({}, 'stop')}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((resolve, reject) => provider.on('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => { provider.close(); provider.closeAllConnections(); });

  const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
  const isolated = { root, settings: { compaction: false }, extensionPath,
    extensionEntry: path.join(extensionPath, 'src', 'extension.bundle.cjs') };
  const host = await startHost(t, isolated);
  host.answers.push(
    { kind: 'pick', value: items => items.find(item => item.id === 'custom') },
    { kind: 'input', value: baseUrl },
    { kind: 'input', value: 'fixture-secret' },
    { kind: 'input', value: 'test-model' },
  );
  await host.send({ type: 'model-settings' });
  await host.waitFor(state => state.configuringModel === false, 35_000, 'model setup to finish');
  assert.equal(host.state().model, 'test-model', host.state().status);
  assert.equal(providerRequests, 0, 'Setup registers the model through TrueForge without querying the provider.');
  assert.equal(JSON.stringify(host.states).includes('fixture-secret'), false);
  const stored = host.secrets.get(MODEL_SECRET);
  assert.equal(readProfile(stored).apiKey, 'fixture-secret');

  const reopened = await startHost(t, {
    ...isolated, storedSecrets: [[MODEL_SECRET, stored]],
  });
  await reopened.send({ type: 'run', prompt: 'Say hello.' });
  await reopened.waitFor(state => ['done', 'error', 'cancelled'].includes(state.phase), 35_000, 'first model response');
  assert.equal(reopened.state().phase, 'done', reopened.state().status);
  assert.match(reopened.state().text, /bundled connection works/);
  assert.ok(calls > 0);
  assert.equal(authorization, 'Bearer fixture-secret');
  assert.equal(JSON.stringify(messages).includes('fixture-secret'), false);

  const runtime = new ManagedForge(extensionPath);
  t.after(() => runtime.dispose());
  const server = await runtime.connection(readProfile(stored), AbortSignal.timeout(30_000));
  assert.equal((await fetch(`${server.serverUrl}/healthz`)).status, 401);
  assert.equal((await fetch(`${server.serverUrl}/healthz`, {
    headers: { Authorization: `Bearer ${server.serverToken}` },
  })).status, 200);
});

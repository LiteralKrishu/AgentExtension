const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AGENTEXTENSION_TEST_MODEL = 'hosted-main/main';
const { registerHostedMain } = require('./model/run.cjs');
const example = { name: 'local-lm-studio', models: [{ properties: { contextLength: 32768, maxOutputTokens: 2600 } }] };

function fakeForge() { const calls = []; return { calls, settings: { modelProviders: { createOrUpdate: async body => { calls.push(body); } } } }; }
function withEnv(values, fn) {
  const keys = ['AGENTEXTENSION_TEST_HOSTED_URL', 'AGENTEXTENSION_TEST_HOSTED_KEY', 'AGENTEXTENSION_TEST_MODEL_ID'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) { if (values[key] === undefined) delete process.env[key]; else process.env[key] = values[key]; }
  return fn().finally(() => { for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });
}
const good = { AGENTEXTENSION_TEST_HOSTED_URL: 'https://example.test/api/v1/', AGENTEXTENSION_TEST_HOSTED_KEY: 'k-123', AGENTEXTENSION_TEST_MODEL_ID: 'vendor/model' };

test('hosted main registration sends the key only to TrueForge and returns just the host', () => withEnv(good, async () => {
  const forge = fakeForge();
  assert.equal(await registerHostedMain(forge, 'hosted-main', example), 'example.test');
  assert.deepEqual(forge.calls, [{ manifest: { type: 'custom', name: 'hosted-main', baseUrl: 'https://example.test/api/v1',
    auth: { apiKey: 'k-123' }, models: [{ name: 'main', modelId: 'vendor/model', properties: example.models[0].properties }] } }]);
}));

test('hosted main registration refuses insecure, incomplete, or local-provider setups before any request', async () => {
  const cases = [
    [{ ...good, AGENTEXTENSION_TEST_HOSTED_URL: 'http://example.test/v1' }, 'hosted-main'],
    [{ ...good, AGENTEXTENSION_TEST_HOSTED_URL: 'https://user:pw@example.test/v1' }, 'hosted-main'],
    [{ ...good, AGENTEXTENSION_TEST_HOSTED_URL: 'not a url' }, 'hosted-main'],
    [{ ...good, AGENTEXTENSION_TEST_HOSTED_KEY: undefined }, 'hosted-main'],
    [{ ...good, AGENTEXTENSION_TEST_HOSTED_KEY: 'a\nb' }, 'hosted-main'],
    [{ ...good, AGENTEXTENSION_TEST_MODEL_ID: undefined }, 'hosted-main'],
    [good, 'local-lm-studio'],
  ];
  for (const [env, provider] of cases) await withEnv(env, async () => {
    const forge = fakeForge();
    await assert.rejects(registerHostedMain(forge, provider, example));
    assert.equal(forge.calls.length, 0);
  });
});

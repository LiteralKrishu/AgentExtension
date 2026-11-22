const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');
const script = path.join(__dirname, '../scripts/phase10-local-trials.sh');
const models = ['openai/gpt-oss-20b', 'qwen3-coder-30b-a3b-instruct', 'qwen/qwen3.5-9b'];
const run = cap => execFileSync('bash', [script, '--print-context-caps', ...models], {
  encoding: 'utf8', env: { ...process.env, MAX_CONTEXT_LENGTH: cap, LMS: '/does-not-exist' }, timeout: 5000,
}).trim().split('\n').map(row => Number(row.split('=').at(-1)));

test('trial context caps are inspectable without loading models or starting servers', () => {
  execFileSync('bash', ['-n', script]);
  assert.deepEqual(run('32768'), [32768, 32768, 32768]);
  assert.deepEqual(run('65536'), [65536, 32768, 65536]);
  const result = spawnSync('bash', [script, '--print-context-caps', ...models], {
    encoding: 'utf8', env: { ...process.env, MAX_CONTEXT_LENGTH: '131072', LMS: '/does-not-exist' }, timeout: 5000,
  });
  assert.equal(result.status, 1); assert.match(result.stderr, /MAX_CONTEXT_LENGTH/);
});

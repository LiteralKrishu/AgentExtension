const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { startHost, scriptedModel } = require('./helpers/host.cjs');
const baseUrl = process.env.AGENTEXTENSION_TEST_FORGE_URL;

test('six identical rejected edits stop the editor run without changing source', {
  skip: !baseUrl && 'Set AGENTEXTENSION_TEST_FORGE_URL to a local TrueForge instance.', timeout: 120_000,
}, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-edit-stop-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.txt'), 'one\n');
  let attempts = 0;
  const model = await scriptedModel(t, baseUrl, async ({ call }) => {
    attempts++;
    return call('propose_write', { file: 'a.txt', old_text: 'missing', new_text: 'ONE' });
  });
  const host = await startHost(t, { root, settings: { serverUrl: baseUrl, model: model.model, fallbackModel: '',
    turnTimeoutSeconds: 60, automaticSkills: false, skillRoots: [], pluginRoots: [], readConnectors: [], browserOrigins: [] } });
  await host.send({ type: 'run', prompt: 'Make a valid edit.' });
  const done = await host.waitFor(state => !state.runActive && state.phase === 'cancelled', 90_000, 'bounded rejection stop');
  assert.ok(attempts >= 6 && attempts <= 7, 'At most one response can already be in flight when cancellation reaches the runtime.');
  assert.match(done.status, /six times/);
  assert.equal(host.states.at(-1).progress.rejectedTools, 6);
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'one\n');
  assert.ifError(model.state.error);
});

test('a fresh model attempt sees the preserved draft and requests a new hunk review', {
  skip: !baseUrl && 'Set AGENTEXTENSION_TEST_FORGE_URL to a local TrueForge instance.', timeout: 120_000,
}, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-retry-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.txt'), 'one\n');
  let staged = false; let failed = false;
  const model = await scriptedModel(t, baseUrl, async ({ round, all, call, say, fail }) => {
    if (!staged) { staged = true; return call('propose_write', { file: 'a.txt', old_text: 'one', new_text: 'ONE' }); }
    if (!failed) { failed = true; return fail(); }
    if (round === 0) return call('read_file', { file: 'a.txt', start_line: 1, end_line: 1 });
    assert.match(all, /ONE/);
    if (round === 1) return call('review_changes', {});
    return say('Preserved draft ready for review.');
  });
  const host = await startHost(t, { root, settings: { serverUrl: baseUrl, model: model.model, fallbackModel: '',
    turnTimeoutSeconds: 60, automaticSkills: false, skillRoots: [], pluginRoots: [], readConnectors: [], browserOrigins: [] } });
  await host.send({ type: 'run', prompt: 'Change one to uppercase and submit it for review.' });
  const review = await host.waitFor(state => state.phase === 'review', 90_000, 'fresh review');
  assert.ok(review.hunks.some(hunk => hunk.file === 'a.txt' && hunk.added > 0));
  for (const hunk of review.hunks) await host.send({ type: 'decision', id: hunk.id, value: 'accept' });
  await host.send({ type: 'continue' });
  await host.waitFor(state => state.phase === 'ready' && !state.runActive, 30_000, 'retained draft');
  assert.ifError(model.state.error);
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'one\n');
  assert.ok(host.states.some(state => state.progress?.retries === 1));
  await host.send({ type: 'cancel' });
});

test('three failing checks on the same staged snapshot stop and keep a recoverable draft', {
  skip: !baseUrl && 'Set AGENTEXTENSION_TEST_FORGE_URL to a local TrueForge instance.', timeout: 120_000,
}, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-check-stop-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'calc.js'), 'exports.add = (a,b) => a-b;\n');
  await fs.writeFile(path.join(root, 'calc.test.js'), "require('node:assert/strict').equal(require('./calc').add(2, 3), 5);\n");
  const model = await scriptedModel(t, baseUrl, async ({ round, call }) => round === 0
    ? call('propose_write', { file: 'calc.js', old_text: 'a-b', new_text: 'a*b' })
    : call('run_command', { command: 'node', args: ['calc.test.js'] }));
  const host = await startHost(t, { root, settings: { serverUrl: baseUrl, model: model.model, fallbackModel: '',
    turnTimeoutSeconds: 60, automaticSkills: false, skillRoots: [], pluginRoots: [], readConnectors: [], browserOrigins: [] } });
  for (let n = 0; n < 3; n++) host.answers.push({ kind: 'modal', value: 'Run command' });
  await host.send({ type: 'run', prompt: 'Fix the add function and run its check.' });
  const done = await host.waitFor(state => !state.runActive && state.phase === 'cancelled', 90000, 'bounded check stop');
  assert.match(done.status, /three times/);
  assert.equal(done.checks.length, 3);
  assert.equal(new Set(done.checks.map(check => check.inputDigest)).size, 1);
  assert.ok(done.checks.every(check => check.exitCode !== 0 && check.inputDigest));
  await host.waitFor(state => state.checkpoint, 10000, 'saved draft checkpoint');
  assert.equal(await fs.readFile(path.join(root, 'calc.js'), 'utf8'), 'exports.add = (a,b) => a-b;\n');
  assert.ifError(model.state.error);
});

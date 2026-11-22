const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawnSync } = require('node:child_process');
const { promisify } = require('node:util');
const { loadRetrievalCorpus, overlaySnapshot } = require('./corpus.cjs');
const { validateJudgments } = require('./judgments.cjs');
const { digest } = require('../../src/permissions');

test('version 2 freezes corrected development labels and fresh held-out queries without changing version 1', async () => {
  const old = await loadRetrievalCorpus('1');
  const current = await loadRetrievalCorpus('2');
  assert.equal(digest(old.files), 'e0fb47d71bffbb8c3bfbf699f46daf69667304ed5277845855751b5057d05b36');
  assert.equal(validateJudgments({ ...old, labels: old.labels }).readyForRevisedCorpus, false);
  assert.equal(validateJudgments({ ...current, labels: current.labels }).readyForRevisedCorpus, true);
  assert.equal(current.files.length, old.files.length + 1);
  for (const file of old.files) assert.equal(current.files.find(item => item.path === file.path).text, file.text);
  assert.deepEqual(current.labels.queries.find(q => q.id === 'query-20').expected.test, ['test/workspace-command-cancellation.test.js']);
  const held = current.labels.queries.filter(q => q.split === 'held-out');
  assert.equal(held.length, 16);
  assert.ok(held.every(query => !old.labels.queries.some(oldQuery => oldQuery.query.toLowerCase() === query.query.toLowerCase())));
  assert.equal(current.freeze.heldOutStatus, 'not evaluated when frozen');
  const input = current.files.map(file => file.text).join('\n');
  for (const query of held) assert.ok(!input.includes(query.id), 'Labels are not retrieval candidates.');
});

test('source overlays reject replacement, traversal, symlinks, and changed bytes', async t => {
  const base = await loadRetrievalCorpus('1');
  const original = require('./corpora/v2/source.json');
  const directory = path.join(__dirname, 'corpora/v2');
  for (const change of [
    m => { m.overlays[0].path = 'src/workspace.js'; },
    m => { m.overlays[0].path = '../outside.test.js'; },
    m => { m.overlays[0].artifact = '../source.json'; },
    m => { m.overlays[0].sha256 = '0'.repeat(64); },
    m => { m.sourceVersion = 'changed'; },
  ]) {
    const manifest = structuredClone(original); change(manifest);
    await assert.rejects(overlaySnapshot(base, manifest, directory));
  }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-overlay-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  await fs.symlink(path.join(directory, original.overlays[0].artifact), path.join(temporary, original.overlays[0].artifact));
  await assert.rejects(overlaySnapshot(base, original, temporary), /Invalid overlay artifact/);
});

test('held-out evaluation stays closed by default and version 2 source citations pass readiness', () => {
  const run = spawnSync(process.execPath, [path.join(__dirname, 'run.cjs'), '--split', 'held-out'], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /needs --evaluate-held-out/);
  const audit = spawnSync(process.execPath, [path.join(__dirname, 'judgments.cjs'), '--corpus', '2', '--require-ready'], { encoding: 'utf8' });
  assert.equal(audit.status, 0, audit.stderr);
  assert.equal(JSON.parse(audit.stdout).readyForRevisedCorpus, true);
});

test('the pinned version 2 source executes its cancellation and cleanup evidence', {
  skip: process.platform !== 'darwin' && 'Native process observation requires macOS.', timeout: 20_000,
}, async t => {
  const corpus = await loadRetrievalCorpus('2');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-reference-cancel-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const name of ['src/workspace.js', 'src/draft.js', 'test/workspace-command-cancellation.test.js']) {
    const file = corpus.files.find(file => file.path === name);
    await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await fs.writeFile(path.join(directory, name), file.text);
  }
  const env = { ...process.env, NODE_PATH: path.join(__dirname, '../../node_modules') };
  delete env.NODE_TEST_CONTEXT;
  const { stdout } = await promisify(execFile)(process.execPath, ['--test', '--test-reporter=tap', 'test/workspace-command-cancellation.test.js'], {
    cwd: directory, timeout: 15_000, env,
  });
  assert.match(stdout, /^# pass 2$/m);
  assert.match(stdout, /^# fail 0$/m);
  assert.match(stdout, /^# skipped 0$/m);
});

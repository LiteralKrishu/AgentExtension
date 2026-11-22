const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { corpus, loadCorpus, fixtureScenario, fixtureDigest } = require('./model/corpus.cjs');
const { verifyDraft } = require('./model/verify.cjs');
const labels = require('./retrieval/queries.json');
const { evaluateQueries } = require('./retrieval/run.cjs');
const { requireLocalEndpoint } = require('./model/local-only.cjs');

test('frozen corpus contains twenty coding tasks, three languages, and twelve/eight splits', async () => {
  const loaded = await loadCorpus();
  assert.equal(loaded.version, 'agent-capability-upgrade/1');
  assert.equal(loaded.tasks.length, 20);
  assert.equal(loaded.tasks.filter(task => task.split === 'development').length, 12);
  assert.equal(loaded.tasks.filter(task => task.split === 'held-out').length, 8);
  assert.deepEqual(new Set(loaded.tasks.map(task => task.language)), new Set(['javascript', 'python', 'typescript']));
  assert.equal(new Set(loaded.tasks.map(task => task.name)).size, 20);
  assert.deepEqual(loaded.policy, { models: 'local-only', apiSpendingUSD: 0, repetitions: 3 });
  for (const task of loaded.tasks) {
    assert.ok(task.budget.minutes > 0 && task.budget.maxTokens > 0);
    assert.ok(task.sourceRevision || task.fixtureDigest);
  }
});

test('retrieval labels have forty nonempty queries and do not enter candidate inputs', async () => {
  assert.equal(labels.queries.length, 40);
  assert.equal(labels.queries.filter(query => query.split === 'development').length, 24);
  assert.equal(labels.queries.filter(query => query.split === 'held-out').length, 16);
  assert.equal(new Set(labels.queries.map(query => query.id)).size, 40);
  for (const query of labels.queries) {
    for (const paths of Object.values(query.expected)) {
      assert.ok(paths.length);
      for (const file of paths) await fs.access(path.join(__dirname, '..', file));
    }
  }
  const files = [{ path: 'src/a.js', text: 'function needle() {}' }];
  const result = evaluateQueries(files, [{ id: 'test', query: 'needle', kind: 'identifier', split: 'development',
    expected: { implementation: ['src/a.js'], test: ['test/missing.js'], documentation: ['README.md'] } }])[0];
  assert.deepEqual(result.hits, ['src/a.js']);
  assert.equal(result.recall, 1 / 3);
});

test('local-only evaluations reject hosted destinations before model dispatch', () => {
  for (const value of ['http://127.0.0.1:1234/v1', 'http://localhost:11434/v1', 'http://[::1]:1234/v1']) assert.ok(requireLocalEndpoint(value));
  for (const value of ['https://api.openai.com/v1', 'http://127.0.0.1.example.com', 'http://localhost@evil.example/v1', 'file:///tmp/model']) {
    assert.throws(() => requireLocalEndpoint(value));
  }
});

for (const task of corpus.tasks) {
  test(task.id + ': independent checks accept the reference and reject the original bug', async t => {
    assert.equal(fixtureDigest(task.files), task.fixtureDigest);
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-corpus-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    for (const [file, text] of Object.entries(task.files)) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), text);
    }
    const scenario = fixtureScenario(task);
    const changes = Object.entries(task.reference).map(([file, after]) => ({ file, before: task.files[file], after }));
    const verified = await verifyDraft({ source: root, changes, allowedFiles: scenario.allowedFiles, acceptance: task.acceptance });
    assert.equal(verified.status, 'complete', JSON.stringify(verified));
    const wrong = changes.map(change => change.file === task.source ? { ...change, after: change.before } : change);
    const rejected = await verifyDraft({ source: root, changes: wrong, allowedFiles: scenario.allowedFiles, acceptance: task.acceptance });
    assert.equal(rejected.status, 'failed', 'Original bug unexpectedly passed');
    assert.ok(rejected.checks.some(check => !check.ok));
    assert.ok(scenario.evaluate({ changes }).every(item => item.ok));
    assert.ok(scenario.evaluate({ changes: changes.filter(change => change.file !== task.source) }).some(item => !item.ok));
    assert.equal(await fs.readFile(path.join(root, task.source), 'utf8'), task.files[task.source]);
  });
}

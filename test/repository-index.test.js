const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Workspace } = require('../src/workspace');
const { RepositoryIndex } = require('../src/repository-index');

async function setup(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-index-test-')));
  const storage = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-index-cache-')));
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(storage, { recursive: true, force: true })]));
  const names = new Set(); const buffers = new Map(); let branch = 'a';
  const workspace = new Workspace(root, full => buffers.get(path.relative(root, full)), async (_signal, limit) => [...names].slice(0, limit));
  workspace.gitRevision = async () => branch;
  const put = async (name, text) => { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), text); names.add(name); };
  const index = new RepositoryIndex(workspace, storage, options);
  return { root, storage, names, buffers, workspace, index, put, branch: value => { branch = value; },
    snapshot: () => index.snapshot(new AbortController().signal) };
}

test('warm index reuses disk bodies, overlays buffers without persistence, and reconciles missed events', async t => {
  const f = await setup(t);
  await f.put('src/a.js', 'disk one\n'); await f.put('test/a.test.js', 'disk test\n');
  const cold = await f.snapshot();
  assert.equal(cold.coverage.sourceReads, 2);
  assert.equal(cold.coverage.complete, true);
  f.buffers.set('src/a.js', 'private unsaved text\n');
  const warm = await f.snapshot();
  assert.equal(warm.coverage.sourceReads, 0);
  assert.equal(warm.coverage.cacheHits, 2);
  assert.equal(warm.files.find(file => file.path === 'src/a.js').text, 'private unsaved text\n');
  for (const file of await fs.readdir(f.index.directory)) assert.ok(!(await fs.readFile(path.join(f.index.directory, file), 'utf8')).includes('private unsaved text'));
  f.buffers.clear();
  await f.put('src/a.js', 'disk two\n'); // No invalidate call: reconciliation must find this.
  const changed = await f.snapshot();
  assert.equal(changed.coverage.sourceReads, 1);
  assert.equal(changed.files.find(file => file.path === 'src/a.js').text, 'disk two\n');
  await fs.rename(path.join(f.root, 'src/a.js'), path.join(f.root, 'src/renamed.js'));
  f.names.delete('src/a.js'); f.names.add('src/renamed.js');
  const renamed = await f.snapshot();
  assert.ok(!renamed.files.some(file => file.path === 'src/a.js'));
  assert.ok(renamed.files.some(file => file.path === 'src/renamed.js'));
});

test('restart loads a versioned cache and corrupt content rebuilds from current disk', async t => {
  const f = await setup(t);
  await f.put('a.txt', 'disk source\n');
  const first = await f.snapshot();
  const restart = new RepositoryIndex(f.workspace, f.storage);
  assert.equal((await restart.snapshot(new AbortController().signal)).coverage.sourceReads, 0);
  const hash = first.files[0].contentHash;
  await fs.writeFile(path.join(f.index.directory, hash.slice(0, 2) + '.json'), JSON.stringify({ [hash]: 'corrupted' }));
  const corrupt = new RepositoryIndex(f.workspace, f.storage);
  const rebuilt = await corrupt.snapshot(new AbortController().signal);
  assert.equal(rebuilt.coverage.rebuilt, true);
  assert.equal(rebuilt.files[0].text, 'disk source\n');
  assert.equal(rebuilt.coverage.sourceReads, 1);
  await corrupt.clear();
  await assert.rejects(fs.stat(corrupt.directory), { code: 'ENOENT' });
});

test('branch changes, scope exclusions, symlinks, quotas and cancellation stay explicit', async t => {
  const f = await setup(t, { maxFiles: 4, maxBytes: 12 });
  await f.put('a.txt', 'one\n'); await f.put('b.txt', 'two\n'); await f.put('.env', 'private\n');
  await fs.symlink(path.join(f.root, 'a.txt'), path.join(f.root, 'link.txt')); f.names.add('link.txt');
  let result = await f.snapshot();
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.excludedOrUnreadable, 1);
  assert.deepEqual(result.files.map(file => file.path), ['a.txt', 'b.txt']);
  f.branch('b');
  result = await f.snapshot();
  assert.equal(result.coverage.sourceReads, 2);
  f.index.invalidate('a.txt');
  assert.equal((await f.snapshot()).coverage.sourceReads, 1);
  await f.put('c.txt', 'more than quota\n');
  result = await f.snapshot();
  assert.equal(result.coverage.reason, 'byte-limit');
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(f.index.snapshot(stopped.signal), { name: 'AbortError' });
  const expired = new RepositoryIndex(f.workspace, f.storage, { timeoutMs: 0 });
  assert.equal((await expired.snapshot(new AbortController().signal)).coverage.reason, 'deadline');
});

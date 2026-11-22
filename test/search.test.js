const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Workspace, runIsolated } = require('../src/workspace');
const { FreshSearch, draftOverlay, searchExecutable } = require('../src/search');
const { Draft } = require('../src/draft');

async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-search-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const names = [];
  const buffers = new Map();
  const staged = new Map();
  const put = async (name, text) => {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), text);
    if (!names.includes(name)) names.push(name);
  };
  const workspace = new Workspace(root, full => buffers.get(path.relative(root, full)), async (_signal, limit) => names.slice(0, limit));
  const search = new FreshSearch(workspace, { overlay: () => staged, timeoutMs: 5000, ...options });
  return { root, names, buffers, staged, put, workspace, search };
}

test('search reads changed disk, open buffers and staged new files on the next query', async t => {
  const f = await fixture(t);
  await f.put('src/a.js', 'old disk\n');
  assert.equal((await f.search.query({ query: 'old disk', mode: 'literal' })).matches.length, 1);
  await f.put('src/a.js', 'new disk\n');
  assert.equal((await f.search.query({ query: 'old disk', mode: 'literal' })).matches.length, 0);
  const disk = await f.search.query({ query: 'new disk', mode: 'literal' });
  f.buffers.set('src/a.js', 'unsaved buffer\n');
  const buffer = await f.search.query({ query: 'unsaved buffer', mode: 'literal' });
  assert.notEqual(disk.matches[0].contentDigest, buffer.matches[0].contentDigest);
  assert.equal((await f.search.query({ query: 'new disk', mode: 'literal' })).matches.length, 0);
  f.staged.set('src/a.js', 'staged replacement\n');
  f.staged.set('src/new.js', 'staged replacement\n');
  assert.deepEqual((await f.search.query({ query: 'staged replacement', mode: 'literal' })).matches.map(hit => hit.file), ['src/a.js', 'src/new.js']);
  assert.equal((await f.search.query({ query: 'unsaved buffer', mode: 'literal' })).matches.length, 0);
  assert.equal(await fs.readFile(path.join(f.root, 'src/a.js'), 'utf8'), 'new disk\n');
});

test('an inline draft keeps surrounding file text and original line offsets in search', async t => {
  const f = await fixture(t);
  const base = 'prefix\nselected\nsuffix\n';
  await f.put('a.txt', base);
  const draft = new Draft((file, create) => f.workspace.read(file, create), { file: 'a.txt', base, start: 7, end: 15 });
  await draft.replace('a.txt', 'selected', 'CHANGED');
  const search = new FreshSearch(f.workspace, { overlay: () => draftOverlay(draft) });
  const changed = await search.query({ query: 'CHANGED', mode: 'literal' });
  assert.equal(changed.matches[0].line, 2);
  assert.equal((await search.query({ query: 'suffix', mode: 'literal' })).matches[0].line, 3);
  assert.equal((await search.query({ query: 'selected', mode: 'literal' })).matches.length, 0);
  assert.equal(await fs.readFile(path.join(f.root, 'a.txt'), 'utf8'), base);
});

test('keyword relevance survives fresh-source collection, result pages, and buffer changes', async t => {
  const f = await fixture(t);
  await f.put('a.txt', 'approval before request\n');
  await f.put('z.txt', 'approval request\napproval and request\n');
  const first = await f.search.query({ query: 'approval request', limit: 1 });
  assert.equal(first.coverage.complete, true);
  assert.equal(first.matches[0].file, 'z.txt');assert.equal(first.matches[0].line, 1);
  assert.equal(first.matches[0].score, undefined);
  const second = await f.search.query({ query: 'approval request', limit: 1, cursor: first.nextCursor });
  assert.equal(second.matches[0].file, 'a.txt');
  const third = await f.search.query({ query: 'approval request', limit: 1, cursor: second.nextCursor });
  assert.equal(third.matches[0].file, 'z.txt');assert.equal(third.matches[0].line, 2);assert.equal(third.nextCursor, null);
  // Exact modes keep deterministic source-location order.
  assert.equal((await f.search.query({ query: 'approval', mode: 'literal', limit: 1 })).matches[0].file, 'a.txt');
  f.buffers.set('a.txt', 'approval request\n');f.staged.set('z.txt', 'removed\n');
  const changed = await f.search.query({ query: 'approval request', limit: 1 });
  assert.equal(changed.matches[0].file, 'a.txt');assert.equal(changed.nextCursor, null);
  await assert.rejects(f.search.query({ query: 'approval request', cursor: first.nextCursor }), /changed/);
  assert.equal(await fs.readFile(path.join(f.root, 'a.txt'), 'utf8'), 'approval before request\n');
});

test('keyword ranking retains the strongest duplicate location without exposing private files', async t => {
  const f = await fixture(t, { allow: file => !file.startsWith('denied/') });
  await f.put('a.txt', 'approval before request\n');
  await f.put('y.txt', 'approval.request\n');
  await f.put('z/approval.request.txt', 'approval.request\n');
  await f.put('denied/exact.txt', 'approval.request\n');
  const result = await f.search.query({ query: 'approval.request' });
  assert.deepEqual(result.matches.map(hit => [hit.file, hit.line]), [['z/approval.request.txt', 1], ['y.txt', 1], ['a.txt', 1]]);
  assert.equal(result.coverage.complete, false);assert.ok(result.matches.every(hit => hit.contentDigest));
});

test('literal, word, path, glob and result pages keep exact semantics', async t => {
  const f = await fixture(t);
  await f.put('src/a.js', 'a.*b\naXXb\ncat\nconcatenate\n(cat)\n');
  await f.put('docs/a.md', 'cat\n');
  assert.deepEqual((await f.search.query({ query: 'a.*b', mode: 'literal' })).matches.map(hit => hit.line), [1]);
  const first = await f.search.query({ query: 'cat', mode: 'word', glob: 'src/**', limit: 1 });
  assert.equal(first.matches[0].line, 3);
  assert.equal(first.coverage.complete, true);
  const second = await f.search.query({ query: 'cat', mode: 'word', glob: 'src/**', limit: 1, cursor: first.nextCursor });
  assert.equal(second.matches[0].line, 5);
  assert.equal(second.nextCursor, null);
  assert.deepEqual((await f.search.query({ query: 'docs/', mode: 'path' })).matches.map(hit => hit.file), ['docs/a.md']);
  await f.put('src/a.js', 'cat\ncat\n');
  await assert.rejects(f.search.query({ query: 'cat', mode: 'word', glob: 'src/**', limit: 1, cursor: first.nextCursor }), /changed/);
  await assert.rejects(f.search.query({ query: 'cat', cursor: 'invalid' }), /cursor/);
  await assert.rejects(f.search.query({ query: '(a+)+$', mode: 'regex' }), /requires/);
});

test('scope exclusions and symlink replacement apply to buffers and search hits', async t => {
  const f = await fixture(t, { allow: file => !file.startsWith('denied/') });
  for (const name of ['src/a.txt', 'denied/b.txt', '.env', 'secrets.json', 'binary.txt']) await f.put(name, name === 'binary.txt' ? 'needle\0secret' : 'needle\n');
  f.names.push('../outside.txt');
  f.staged.set('.env', 'needle\n');
  f.staged.set('link.txt', 'needle\n');
  await fs.symlink(path.join(f.root, 'src/a.txt'), path.join(f.root, 'link.txt'));
  f.names.push('link.txt');
  f.buffers.set('link.txt', 'needle\n');
  const result = await f.search.query({ query: 'needle', mode: 'literal' });
  assert.deepEqual(result.matches.map(hit => hit.file), ['src/a.txt']);
  assert.equal(result.coverage.complete, false);
  await fs.unlink(path.join(f.root, 'src/a.txt'));
  await fs.symlink(path.join(f.root, 'denied/b.txt'), path.join(f.root, 'src/a.txt'));
  assert.deepEqual((await f.search.query({ query: 'needle', mode: 'literal' })).matches, []);
});

test('bounded search reports omissions, deadlines and user cancellation', async t => {
  const f = await fixture(t, { maxFiles: 2, maxMatches: 1, maxBytes: 4 });
  for (const name of ['a.txt', 'b.txt', 'c.txt']) await f.put(name, 'needle\n');
  const result = await f.search.query({ query: 'needle', mode: 'literal' });
  assert.equal(result.coverage.complete, false);
  assert.ok(result.matches.length <= 1);
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(f.search.query({ query: 'needle' }, stopped.signal), { name: 'AbortError' });
  const delayed = new FreshSearch({ paths: signal => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) }, { timeoutMs: 10 });
  // Keep the test alive while the deliberately unref'ed deadline signal expires.
  const timer = setTimeout(() => {}, 100);
  try {
    assert.equal((await delayed.query({ query: 'needle' })).coverage.reason, 'deadline');
  } finally { clearTimeout(timer); }
});

test('fresh path search finds a target beyond the former 12000 path prefix', async t => {
  const f = await fixture(t);
  f.names.push(...Array.from({ length: 12000 }, (_, i) => `prefix/${i}.txt`));
  await f.put('target-after-prefix.txt', 'target\n');
  assert.equal((await f.workspace.paths()).length, 12000);
  const result = await f.search.query({ query: 'target-after-prefix', mode: 'path' });
  assert.equal(result.matches[0].file, 'target-after-prefix.txt');
  assert.equal(result.coverage.complete, true);
});

const executable = process.env.AGENTEXTENSION_TEST_RG;
test('search discovers the current editor universal binary and the older layout', {
  skip: !['darwin', 'linux'].includes(process.platform),
}, async t => {
  if (process.platform === 'linux' && !await fs.access('/usr/bin/bwrap').then(() => true, () => false)) return t.skip('Native isolation requires bubblewrap.');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-search-editor-')));
  t.after(() => fs.rm(root, {recursive:true,force:true}));
  const modern = path.join(root, 'node_modules.asar.unpacked/@vscode/ripgrep-universal/bin', `${process.platform}-${process.arch}`, 'rg');
  await fs.mkdir(path.dirname(modern), {recursive:true}); await fs.writeFile(modern, 'fixture', {mode:0o755});
  assert.equal(await searchExecutable(root), modern);
  await fs.rm(modern);
  const legacy = path.join(root, 'node_modules/@vscode/ripgrep/bin/rg');
  await fs.mkdir(path.dirname(legacy), {recursive:true}); await fs.writeFile(legacy, 'fixture', {mode:0o755});
  assert.equal(await searchExecutable(root), legacy);
});

test('native search revalidates source and replaces disk hits with dirty buffers', { skip: !executable && 'Set AGENTEXTENSION_TEST_RG to a trusted ripgrep executable.' }, async t => {
  const f = await fixture(t, { executable });
  await f.put('src/a.js', 'old_value = 42\n');
  await f.put('src/b.js', 'a.*b\n');
  let result = await f.search.query({ query: 'old_\\w+ = [0-9]+', mode: 'regex' });
  assert.equal(result.coverage.complete, true, JSON.stringify(result));
  assert.equal(result.matches[0].text, 'old_value = 42');
  f.buffers.set('src/a.js', 'new_value = 24\n');
  assert.equal((await f.search.query({ query: 'old_\\w+', mode: 'regex' })).matches.length, 0);
  result = await f.search.query({ query: 'new_\\w+', mode: 'regex' });
  assert.equal(result.matches[0].text, 'new_value = 24');
  assert.equal((await f.search.query({ query: 'a.*b', mode: 'literal' })).matches.length, 1);
  assert.equal((await f.search.query({ query: '[', mode: 'regex' })).coverage.complete, false);
  const bounded = new FreshSearch(f.workspace, { executable, timeoutMs: 1 });
  assert.equal((await bounded.query({ query: 'new_\\w+', mode: 'regex' })).coverage.reason, 'deadline');
  assert.equal(await fs.readFile(path.join(f.root, 'src/a.js'), 'utf8'), 'old_value = 42\n');
});

test('native source root remains read-only', { skip: !executable && 'Set AGENTEXTENSION_TEST_RG to enable isolated native checks.' }, async t => {
  const f = await fixture(t);
  await f.put('a.txt', 'original\n');
  const result = await runIsolated(process.execPath, ['-e', "require('fs').writeFileSync('a.txt', 'changed')"], f.root, new AbortController().signal, { readOnly: true });
  assert.notEqual(result.exitCode, 0);
  assert.equal(await fs.readFile(path.join(f.root, 'a.txt'), 'utf8'), 'original\n');
});

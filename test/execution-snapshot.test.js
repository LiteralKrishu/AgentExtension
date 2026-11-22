const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Workspace } = require('../src/workspace');

async function repository(t, files) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-fixture-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [file, data] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), data);
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}
const signal = () => new AbortController().signal;
async function snapshot(t, workspace, changes = [], options) {
  const result = await workspace.snapshot(changes, signal(), options);
  t.after(() => fs.rm(result.directory, { recursive: true, force: true }));
  return result;
}

test('a snapshot covers a tree beyond the old 12,000-path and 64 MB limits', async t => {
  const files = { 'large.bin': Buffer.alloc(65_000_000, 1) };
  for (let i = 0; i < 12_050; i++) files[`src/${i % 50}/f${i}.js`] = `module.exports = ${i};\n`;
  const root = await repository(t, files);
  const result = await snapshot(t, new Workspace(root, () => undefined));
  assert.equal(result.files, 12_051);
  assert.ok(result.bytes > 64_000_000);
  assert.equal((await fs.stat(path.join(result.directory, 'large.bin'))).size, 65_000_000);
  assert.equal(await fs.readFile(path.join(result.directory, 'src/7/f12007.js'), 'utf8'), 'module.exports = 12007;\n');
});

test('a snapshot over quota fails with a reason instead of checking a partial tree', async t => {
  const root = await repository(t, Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}.txt`, 'x'.repeat(100)])));
  const workspace = new Workspace(root, () => undefined);
  workspace.quota = { files: 10, bytes: 1e9 };
  await assert.rejects(workspace.snapshot([], signal()), error => error.code === 'ESNAPSHOTQUOTA' && /10-file limit/.test(error.message));
  workspace.quota = { files: 100, bytes: 1000 };
  await assert.rejects(workspace.snapshot([], signal()), error => error.code === 'ESNAPSHOTQUOTA' && /1000-byte limit/.test(error.message));
});

test('lockfiles are build inputs while private files stay out', async t => {
  const root = await repository(t, { 'yarn.lock': 'lock\n', 'Cargo.lock': 'lock\n', 'app.js': 'ok\n', '.env': 'SECRET=1\n',
    'secrets.json': '{}', 'id_rsa': 'key', 'node_modules/x/index.js': 'x' });
  const workspace = new Workspace(root, () => undefined);
  const result = await snapshot(t, workspace);
  assert.deepEqual([...result.sources.keys()].sort(), ['Cargo.lock', 'app.js', 'yarn.lock']);
  assert.ok(!(await workspace.paths(signal())).includes('yarn.lock'), 'search and editor tools still skip lockfiles');
});

test('a check cannot modify the workspace through its snapshot', async t => {
  const root = await repository(t, { 'app.js': 'original\n' });
  const result = await snapshot(t, new Workspace(root, () => undefined));
  await fs.writeFile(path.join(result.directory, 'app.js'), 'changed by a check\n');
  assert.equal(await fs.readFile(path.join(root, 'app.js'), 'utf8'), 'original\n');
  assert.notEqual((await fs.stat(path.join(result.directory, 'app.js'))).ino, (await fs.stat(path.join(root, 'app.js'))).ino);
});

test('cached hashes are reused for unchanged files and never go stale', async t => {
  const root = await repository(t, { 'a.js': 'one\n', 'b.js': 'two\n' });
  const workspace = new Workspace(root, () => undefined);
  const first = await snapshot(t, workspace);
  const cached = workspace.hashes.get(path.join(root, 'a.js'));
  await fs.writeFile(path.join(root, 'b.js'), 'TWO\n');
  const second = await snapshot(t, workspace);
  assert.equal(workspace.hashes.get(path.join(root, 'a.js')), cached, 'an unchanged file keeps its cached hash');
  assert.equal(second.sources.get('a.js'), first.sources.get('a.js'));
  assert.notEqual(second.sources.get('b.js'), first.sources.get('b.js'), 'a same-size edit is detected');
  assert.equal(await fs.readFile(path.join(second.directory, 'b.js'), 'utf8'), 'TWO\n');
});

test('open editor text and the draft are applied, and a stale draft is refused', async t => {
  const root = await repository(t, { 'a.js': 'disk\n', 'b.js': 'before\n' });
  const workspace = new Workspace(root, file => file.endsWith('a.js') ? 'unsaved\n' : undefined);
  const result = await snapshot(t, workspace, [{ file: 'b.js', before: 'before\n', after: 'after\n' }, { file: 'c.js', before: null, after: 'new\n' }]);
  assert.equal(await fs.readFile(path.join(result.directory, 'a.js'), 'utf8'), 'unsaved\n');
  assert.equal(await fs.readFile(path.join(result.directory, 'b.js'), 'utf8'), 'after\n');
  assert.equal(result.sources.get('b.js') === result.inputs.get('b.js'), false);
  const disk = await snapshot(t, workspace, [], { overlay: false });
  assert.equal(await fs.readFile(path.join(disk.directory, 'a.js'), 'utf8'), 'disk\n');
  await assert.rejects(workspace.snapshot([{ file: 'b.js', before: 'old\n', after: 'x' }], signal()), /changed since the draft was staged/);
});

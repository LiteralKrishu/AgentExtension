const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Relationships } = require('../../src/relationships');
const { Workspace } = require('../../src/workspace');

test('syntax relationships reach JS/TS callers, matching tests, and linked documentation', async t => {
  const files = [
    { path: 'src/math.ts', text: 'export function add(a: number, b: number) { return a + b; }' },
    { path: 'src/caller.ts', text: "import { add } from './math';\nadd(1, 2);" },
    { path: 'test/math.test.ts', text: "import { add } from '../src/math';\nadd(1, 2);" },
    { path: 'docs/math.md', text: '[Implementation](../src/math.ts)\n' },
  ];
  const graph = new Relationships(files);
  const related = graph.related(['src/math.ts']);
  assert.deepEqual(new Set(related.map(item => item.file)), new Set(['src/caller.ts', 'test/math.test.ts', 'docs/math.md']));
  assert.ok(related.every(item => item.provenance === 'inferred-syntax'));
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-relations-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const file of files) { await fs.mkdir(path.dirname(path.join(root, file.path)), { recursive: true }); await fs.writeFile(path.join(root, file.path), file.text); }
  const workspace = new Workspace(root, () => undefined, async () => []);
  assert.equal((await graph.currentHints(workspace, ['src/math.ts'], new AbortController().signal)).length, 3);
  await fs.writeFile(path.join(root, 'src/math.ts'), 'changed implementation');
  assert.deepEqual(await graph.currentHints(workspace, ['src/math.ts'], new AbortController().signal), []);
});

test('Python absolute/relative imports and test names have bounded, workspace-only edges', () => {
  const files = [{ path: 'src/pkg/math.py', text: 'def add(a,b): return a+b' },
    { path: 'src/pkg/caller.py', text: 'from .math import add\n' },
    { path: 'tests/test_math.py', text: 'from pkg.math import add\n' },
    { path: 'docs/math.md', text: '[Outside](../../private.py)\n[Secret](../.env)\n' },
    { path: 'rust/other.rs', text: 'fn main() {}' }];
  const graph = new Relationships(files);
  assert.deepEqual(new Set(graph.related(['src/pkg/math.py']).map(item => item.file)), new Set(['src/pkg/caller.py', 'tests/test_math.py']));
  assert.deepEqual(graph.related(['rust/other.rs']), []);
  const limited = new Relationships(files, { maxEdges: 1, maxNeighbors: 1 });
  assert.equal(limited.coverage.complete, false);
  assert.ok(limited.related(['src/pkg/math.py']).length <= 1);
});

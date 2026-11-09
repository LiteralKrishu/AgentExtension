const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Draft, applyHunks, splitHunks } = require('../src/draft');
const { assemble, mentions } = require('../src/context');
const { Workspace, safePath } = require('../src/workspace');
const { localUrl, parseApproval, failure } = require('../src/forge');

test('applies selected hunks at base offsets, including insertions and final newlines', () => {
  const before = 'alpha\nbravo\ncharlie\ndelta\nend';
  const after = 'start\nalpha\nBRAVO\ncharlie\ndelta\nend\n';
  const hunks = splitHunks(before, after);
  assert.equal(applyHunks(before, hunks), after);
  assert.equal(applyHunks(before, hunks.slice(-1)), before + '\n');
});

test('inline proposals preserve text outside the selection and handle CRLF', async () => {
  const base = 'prefix off\r\nselected off\r\nsuffix off';
  const start = base.indexOf('selected');
  const end = base.indexOf('\r\nsuffix');
  const draft = new Draft(async () => base, { file: 'main.py', base, start, end });
  await assert.rejects(draft.replaceRange('main.py', base, start, end, 'other'), /original inline selection/);
  await assert.rejects(draft.replace('other.py', 'selected off', 'selected false'), /original selection/);
  await assert.rejects(draft.replace('main.py', 'prefix off', 'prefix false'), /exactly once/);
  await draft.replace('main.py', 'selected off', 'selected false\nmore');
  assert.equal(draft.changes(draft.review())[0].after, 'prefix off\r\nselected false\r\nmore\r\nsuffix off');
});

test('staged files retain one base and review IDs expire after a new proposal', async () => {
  const draft = new Draft(async () => 'same\nsame\nend\n');
  await assert.rejects(draft.replace('main.py', 'same', 'other'), /exactly once/);
  await draft.replace('main.py', 'end', 'end revised');
  const old = draft.review();
  await draft.replace('main.py', 'end revised', 'finished');
  assert.deepEqual(draft.changes(old), []);
  assert.equal(draft.changes(draft.review())[0].after, 'same\nsame\nfinished\n');
});

test('explicit mentions are pinned and retrieval keeps implementation, tests and docs within budget', () => {
  const files = [
    { path: 'src/cli.py', text: 'def configure():\n    return json_config\n' },
    { path: 'test/test_cli.py', text: 'def test_config():\n    assert json_config\n' },
    { path: 'docs/usage.rst', text: 'CLI config prints JSON\n' },
  ];
  const prompt = 'Add CLI config JSON @symbol:configure @file:"docs/usage.rst" @file:missing';
  const result = assemble(files, prompt, 500);
  assert.equal(mentions(prompt).length, 3);
  assert.equal(result.selected.length, 3);
  assert.equal(result.selected[0].reason, 'Explicit symbol configure');
  assert.deepEqual(result.unresolved, [{ type: 'file', value: 'missing' }]);
  assert.ok(result.used <= 500);
});

test('context reserves room for tests and docs that share the implementation name', () => {
  const files = [
    { path: 'src/cli.py', text: 'def run_command():\n    return config\n\ncli.add_command(run_command)\n' },
    { path: 'tests/test_config.py', text: 'def test_config_json_secret_mask():\n    pass\n' },
    { path: 'tests/test_cli.py', text: 'def test_run_command():\n    pass\n' },
    { path: 'docs/config.rst', text: 'JSON config with secret masking\n' },
    { path: 'docs/cli.rst', text: 'Built-in CLI commands\n---------------------\n' },
  ];
  const result = assemble(files, 'Add a CLI command to print JSON config with secret masking', 700);
  assert.deepEqual(result.selected.slice(0, 3).map(hit => hit.file), ['src/cli.py', 'tests/test_cli.py', 'docs/cli.rst']);
  assert.ok(result.used <= 700);
  const excerpts = assemble(files, 'Add a CLI command to print JSON config').text.trim().split('\n').map(JSON.parse);
  assert.ok(excerpts.find(excerpt => excerpt.file === 'src/cli.py').anchors.includes('4: cli.add_command(run_command)'));
  assert.ok(excerpts.find(excerpt => excerpt.file === 'docs/cli.rst').anchors.includes('1: Built-in CLI commands'));
});

test('private paths, traversal and symlink reads are rejected', async () => {
  for (const invalid of ['../other', '/etc/passwd', '.git/config', '.env', 'foo\\bar', 'secrets.json']) {
    assert.throws(() => safePath(invalid));
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-test-'));
  try {
    await fs.writeFile(path.join(directory, 'data.txt'), 'disk');
    await fs.symlink(path.join(directory, 'data.txt'), path.join(directory, 'link.txt'));
    const workspace = new Workspace(directory, full => full.endsWith('data.txt') ? 'buffer' : undefined, async () => []);
    await assert.rejects(workspace.read('link.txt'), /Symbolic links/);
    assert.equal(await workspace.read('data.txt'), 'buffer');
    assert.equal(await workspace.read('new.txt', true), null);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('local TrueForge URLs and deferred approval arguments are validated', () => {
  assert.equal(localUrl('http://localhost:8790'), 'http://localhost:8790');
  assert.throws(() => localUrl('http://127.0.0.1.example.com:8790'));
  assert.throws(() => localUrl('http://localhost:8790/sessions'));
  assert.match(failure('No user query found in messages'), /compaction/i);
  assert.match(failure('Cannot connect to API'), /endpoint did not respond/i);
  const argumentsJson = JSON.stringify({ mcp_server: 'editor', tool_name: 'review_changes', input: {} });
  const messages = new Map([['msg', { toolCalls: [{ id: 'call', function: { name: 'call_tool', arguments: argumentsJson } }] }]]);
  assert.deepEqual(parseApproval({ id: 'call', sourceEventId: 'msg' }, messages), { name: 'review_changes', args: {} });
});

test('the retrieval worker serves context and tool searches, then stops on cancel', async () => {
  const { Retrieval } = require('../src/retrieval');
  const controller = new AbortController();
  const retrieval = new Retrieval(controller.signal);
  try {
    const context = await retrieval.query('assemble', [{ path: 'src/main.py', text: 'def lookup():\n    return 42' }], '@symbol:lookup');
    assert.equal(context.selected[0].file, 'src/main.py');
    assert.deepEqual(await retrieval.query('search', 'lookup', 1),
      [{ file: 'src/main.py', line: 1, text: 'def lookup():' }]);
    assert.deepEqual(await retrieval.query('search', 'src main.py', 1),
      [{ file: 'src/main.py', line: 1, text: 'def lookup():' }]);
    controller.abort();
    assert.throws(() => retrieval.query('search', 'lookup', 1), { name: 'AbortError' });
  } finally {
    retrieval.close();
  }
});

test('a replaced workspace root cannot redirect approved reads or command snapshots', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ae-root-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'a'));
  await fs.mkdir(path.join(directory, 'b'));
  await fs.writeFile(path.join(directory, 'b', 'other.txt'), 'outside');
  const workspace = new Workspace(path.join(directory, 'a'), () => undefined, async () => []);
  workspace.identity = workspace.root;
  await fs.rmdir(workspace.root);
  await fs.symlink(path.join(directory, 'b'), workspace.root);
  await assert.rejects(workspace.read('other.txt'), /identity changed/);
  await assert.rejects(workspace.paths(), /identity changed/);
});

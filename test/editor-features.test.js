const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { assemble } = require('../src/context');
const { editorContext } = require('../src/editor-context');
const { rebaseCheckpoint } = require('../src/checkpoint');
const { changedPaths, readChanges } = require('../src/git-review');
const { Workspace } = require('../src/workspace');
const { startHost, scriptedModel } = require('./helpers/host.cjs');

const baseUrl = process.env.AGENTEXTENSION_TEST_FORGE_URL;
const live = { skip: !baseUrl && 'Set AGENTEXTENSION_TEST_FORGE_URL.', timeout: 60_000 };
const settings = model => ({ serverUrl: baseUrl, model, fallbackModel: '', compaction: false, turnTimeoutSeconds: 30,
  readConnectors: [], skillRoots: [], pluginRoots: [], browserOrigins: [], automaticSkills: false });

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ae-editor-features-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = new Workspace(root, () => undefined, async () => []);
  workspace.identity = root;
  return { root, workspace, write: (file, text) => fs.writeFile(path.join(root, file), text),
    git: (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, stdio: 'ignore' }) };
}

test('language providers add definitions and references under the existing workspace and excerpt limits', async t => {
  const f = await fixture(t);
  await f.write('implementation.js', 'const target = 1;\n');
  await f.write('usage.js', 'console.log(target);\n');
  const location = file => ({ uri: { scheme: 'file', fsPath: path.resolve(f.root, file) }, range: { start: { line: 0, character: 0 } } });
  const vscode = { commands: { executeCommand: async name => ({
    'vscode.executeWorkspaceSymbolProvider': [{ name: 'target', location: location('implementation.js') }],
    'vscode.executeDefinitionProvider': [location('implementation.js')],
    'vscode.executeReferenceProvider': [location('../outside.js'), location('usage.js')],
  })[name] } };
  const language = await editorContext(vscode, f.workspace, 'Change @symbol:target', undefined, new AbortController().signal);
  const result = assemble(language.files, 'Change @symbol:target', 4_000, language.anchors);
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(result.selected.map(entry => entry.file), ['implementation.js', 'usage.js']);
  assert.match(result.selected[1].reason, /reference/);
  assert.ok(result.used <= 4_000);
});

test('checkpoint rebase retains independent changes and offers both versions of an overlap', async t => {
  const f = await fixture(t);
  const base = 'first\nsecond\nthird\nfourth\n';
  await f.write('file.txt', 'local first\nsecond\nthird\nlocal fourth\n');
  const saved = { files: [{ file: 'file.txt', base, text: 'saved first\nsecond\nsaved third\nfourth\n' }] };
  const result = await rebaseCheckpoint(saved, f.workspace);
  assert.deepEqual(result.files, []);
  assert.equal(result.conflicts[0].keep.text, 'local first\nsecond\nsaved third\nlocal fourth\n');
  assert.equal(result.conflicts[0].saved.text, 'saved first\nsecond\nsaved third\nlocal fourth\n');
  await f.write('file.txt', 'first\nsecond\nthird\nlocal fourth\n');
  const independent = await rebaseCheckpoint(saved, f.workspace);
  assert.deepEqual(independent.conflicts, []);
  assert.equal(independent.files[0].text, 'saved first\nsecond\nsaved third\nlocal fourth\n');
});

async function gitFixture(t) {
  const f = await fixture(t);
  f.git('init');
  await f.write('a.js', 'const a = 1;\n');
  await f.write('b.js', 'const b = 3;\n');
  f.git('add', '--', 'a.js', 'b.js');
  f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Fixture');
  await f.write('a.js', 'const a = 2;\n');
  await f.write('b.js', 'const b = 30;\n');
  await f.write('.env', 'private fixture');
  return f;
}

test('Git review reads only selected visible files against HEAD', async t => {
  const f = await gitFixture(t);
  const signal = new AbortController().signal;
  assert.deepEqual(await changedPaths(f.workspace, signal), ['a.js', 'b.js']);
  const snapshot = await readChanges(f.workspace, ['a.js'], signal);
  assert.deepEqual(snapshot.changes, [{ file: 'a.js', before: 'const a = 1;\n', after: 'const a = 2;\n' }]);
  await assert.rejects(readChanges(f.workspace, ['.env'], signal), /private files/);
});

test('the Git review command sends only selected hunks to the read-only worker and marks a changed snapshot stale', live, async t => {
  const f = await gitFixture(t);
  const model = await scriptedModel(t, baseUrl, async ({ all, tools, say }) => {
    assert.match(all, /const a = 2/);
    assert.doesNotMatch(all, /const b = 30|private fixture/);
    assert.ok(tools.every(tool => tool === 'get_current_datetime'));
    await f.write('a.js', 'const a = 4;\n');
    return say(JSON.stringify({ summary: 'Review the changed constant.', findings: [] }));
  });
  const host = await startHost(t, { root: f.root, settings: settings(model.model) });
  host.answers.push({ kind: 'pick', value: items => items.filter(item => item.label === 'a.js') });
  await host.command('reviewGit');
  const state = await host.waitFor(state => state.phase === 'done' && !state.runActive);
  assert.ifError(model.state.error);
  assert.equal(state.workers[0].state, 'stale');
  assert.equal(state.workers[0].target.scope, 'Working tree changes');
  assert.deepEqual(state.hunks, []);
  assert.equal(await fs.readFile(path.join(f.root, 'a.js'), 'utf8'), 'const a = 4;\n');
});

test('Fix from Problems validates the current diagnostic and stages a reviewed proposal', live, async t => {
  const f = await fixture(t);
  await f.write('a.js', 'const x = missing;\n');
  const model = await scriptedModel(t, baseUrl, ({ round, all, call, say }) => {
    assert.match(all, /SELECTED EDITOR DIAGNOSTIC/);
    assert.match(all, /Unknown name missing/);
    if (round === 0) return call('propose_plan', { goal: 'Resolve the name', steps: ['Change the declaration'] });
    if (round === 1) return call('propose_write', { file: 'a.js', old_text: 'missing', new_text: '1' });
    if (round === 2) return call('review_changes', {});
    return say('Ready.');
  });
  const host = await startHost(t, { root: f.root, settings: settings(model.model) });
  const uri = host.vscode.Uri.file(path.join(f.root, 'a.js'));
  const range = { start: { line: 0, character: 10 }, end: { line: 0, character: 17 }, isEqual: other => other === range };
  const diagnostic = { range, source: 'fixture', message: 'Unknown name missing' };
  const document = { uri, version: 2 };
  host.vscode.workspace.getWorkspaceFolder = () => host.vscode.workspace.workspaceFolders[0];
  host.vscode.workspace.openTextDocument = async () => document;
  host.vscode.languages.getDiagnostics = () => [diagnostic];
  const [action] = host.codeActions.provideCodeActions(document, range, { diagnostics: [diagnostic] });
  await host.command('fixDiagnostic', { ...action.command.arguments[0], version: 1 });
  assert.equal(model.state.requests.length, 0);
  const fixing = host.command('fixDiagnostic', ...action.command.arguments);
  await host.waitFor(state => state.phase === 'plan');
  await host.send({ type: 'approve-plan' });
  const review = await host.waitFor(state => state.phase === 'review');
  assert.ok(review.manifest.some(entry => entry.kind === 'diagnostic'));
  await host.send({ type: 'decision', id: review.hunks[0].id, value: 'accept' });
  await host.send({ type: 'continue' });
  await fixing;
  await host.waitFor(state => state.phase === 'ready' && !state.runActive);
  assert.ifError(model.state.error);
  assert.equal(await fs.readFile(path.join(f.root, 'a.js'), 'utf8'), 'const x = missing;\n');
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startHost, scriptedModel } = require('./helpers/host.cjs');
const baseUrl = process.env.AGENTEXTENSION_TEST_FORGE_URL;
const packaged = process.env.AGENTEXTENSION_TEST_PACKAGED_PATH;

test('the extracted package checks, reviews, applies, undoes and cancels a local fixture', {
  skip: !(baseUrl && packaged) && 'Set local TrueForge and extracted package paths.', timeout: 90000,
}, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ae-package-workflow-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'calc.js'), before = 'exports.add=(a,b)=>a-b;\n';
  await fs.writeFile(file, before);
  await fs.writeFile(path.join(root, 'calc.test.js'), "require('node:assert/strict').equal(require('./calc').add(1,2),3);\n");
  await fs.writeFile(path.join(root, '.gitattributes'), 'calc.js filter=fixture\n');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Package Fixture'); git('config', 'user.email', 'package@example.invalid');
  git('add', '.'); git('commit', '-qm', 'fixture'); git('remote', 'add', 'origin', 'https://example.invalid/package/repo.git');
  const sourceCommit = git('rev-parse', 'HEAD');
  const metadata = await fs.mkdtemp(path.join(os.tmpdir(), 'ae-package-git-'));
  t.after(() => fs.rm(metadata, { recursive: true, force: true }));
  const marker = path.join(metadata, 'filter-ran'), filter = path.join(metadata, 'filter.cjs'), config = path.join(metadata, 'gitconfig');
  await fs.writeFile(filter, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');process.stdin.pipe(process.stdout);`);
  await fs.writeFile(config, `[filter "fixture"]\nsmudge = node ${filter}\nrequired = true\n`);
  const globalConfig = process.env.GIT_CONFIG_GLOBAL; process.env.GIT_CONFIG_GLOBAL = config;
  t.after(() => { if (globalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = globalConfig; });
  const model = await scriptedModel(t, baseUrl, ({ round, all, call, say }) => {
    if (all.includes('CANCEL_PACKAGE_FIXTURE')) return call('ask_user_question', { question: 'Cancel this fixture?' });
    if (round === 0) return call('propose_write', { file: 'calc.js', old_text: 'a-b', new_text: 'a+b' });
    if (round === 1) return call('run_command', { command: 'node', args: ['--test', 'calc.test.js'] });
    if (round === 2) return call('review_changes', {});
    return say('The focused check passed.');
  });
  const host = await startHost(t, { root, settings: { serverUrl: baseUrl, model: model.model, fallbackModel: '', compaction: false,
    turnTimeoutSeconds: 60, automaticSkills: false, skillRoots: [], pluginRoots: [], readConnectors: [], browserOrigins: [] } });
  // Model VS Code's text edits in this disposable host; interactive editor acceptance is separate.
  host.vscode.Range = class { constructor(start, end) { Object.assign(this, { start, end }); } };
  host.vscode.WorkspaceEdit = class {
    constructor() { this.edits = []; }
    get size() { return this.edits.length; }
    replace(uri, range, text) { this.edits.push({ uri, range, text }); }
  };
  host.vscode.workspace.openTextDocument = async uri => {
    const text = await fs.readFile(uri.fsPath, 'utf8');
    return { getText: () => text, version: 1, positionAt: offset => offset, isDirty: false };
  };
  host.vscode.workspace.applyEdit = async edit => {
    const text = await fs.readFile(file, 'utf8');
    let after = text;
    for (const value of [...edit.edits].sort((a, b) => b.range.start - a.range.start)) {
      assert.equal(value.uri.fsPath, file);
      after = after.slice(0, value.range.start) + value.text + after.slice(value.range.end);
    }
    await fs.writeFile(file, after); return true;
  };
  host.answers.push({ kind: 'modal', value: 'Run command' });
  await host.send({ type: 'run', prompt: 'Fix add and run the focused test.' });
  const review = await host.waitFor(state => state.phase === 'review', 30000, 'packaged review');
  assert.equal(review.checks[0].exitCode, 0);
  for (const hunk of review.hunks) await host.send({ type: 'decision', id: hunk.id, value: 'accept' });
  await host.send({ type: 'continue' });
  await host.waitFor(state => state.phase === 'ready' && !state.runActive, 30000, 'ready');
  assert.equal(await fs.readFile(file, 'utf8'), before);
  host.answers.push({ kind: 'pick', value: 'Prepare local branch' }, { kind: 'input', value: 'main/package-draft' },
    { kind: 'input', value: 'https://example.invalid/package/repo.git' }, { kind: 'modal', value: 'Prepare branch' });
  await host.command('handoff');
  await host.waitFor(state => state.status?.startsWith('Local branch prepared at '), 5000, 'managed branch');
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' }); assert.equal(git('rev-parse', 'HEAD'), sourceCommit);
  host.answers.push({ kind: 'pick', value: 'Commit managed draft' }, { kind: 'input', value: 'Update addition' }, { kind: 'modal', value: 'Commit locally' });
  await host.command('handoff');
  await host.waitFor(state => state.status?.startsWith('Committed '), 5000, 'local commit');
  host.answers.push({ kind: 'pick', value: 'Remove managed checkout' }); await host.command('handoff');
  await host.sendAndWait({ type: 'apply' });
  await host.waitFor(state => state.phase === 'applied', 5000, 'apply');
  assert.equal(await fs.readFile(file, 'utf8'), before.replace('a-b', 'a+b'));
  await host.command('undo');
  assert.equal(await fs.readFile(file, 'utf8'), before);
  await host.send({ type: 'run', prompt: 'CANCEL_PACKAGE_FIXTURE' });
  await host.waitFor(state => state.phase === 'question', 30000, 'question');
  await host.send({ type: 'cancel' });
  await host.waitFor(state => !state.runActive && state.phase === 'cancelled', 10000, 'cancel');
  assert.equal(await fs.readFile(file, 'utf8'), before); assert.ifError(model.state.error);
});

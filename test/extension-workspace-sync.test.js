const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { projectClient } = require('../src/collaboration');
const { Workspace } = require('../src/workspace');
const { digest } = require('../src/permissions');
const { startHost } = require('./helpers/host.cjs');
const { startProject } = require('./fixtures/project.cjs');

const pick = label => ({ kind: 'pick', value: items => items.find(item => item.label === label) });
const defaults = { kind: 'pick', value: items => items.filter(item => item.picked) };
const accept = value => ({ kind: 'modal', value });
const clientFor = device => projectClient(device.root, { files: [device.policy] });
const fixture = t => startProject(t, { fileSync: true, tlsDirectory: process.env.AGENTEXTENSION_TEST_FILE_SYNC_TLS });

test('the project menu publishes reviewed saved files and applies only approved workspace updates', async t => {
  const f = await fixture(t);
  const [first, second] = f.devices;
  const source = await startHost(t, { root: first.root, settings: {}, env: { AGENTEXTENSION_POLICY_FILE: first.policy } });
  const tracked = 'tracked.txt';
  const nested = 'docs/notes.txt';
  await fs.mkdir(path.join(first.root, 'docs'));
  await fs.writeFile(path.join(first.root, nested), 'Nested addition\n');
  await fs.writeFile(path.join(first.root, tracked), 'Published update\n');
  const a = clientFor(first);
  const revision = await new Workspace(first.root, () => undefined).gitRevision();
  source.answers.push(pick('Publish workspace files'), defaults, accept(undefined));
  await source.command('project');
  assert.equal((await a.workspaceFiles(revision)).sequence, 0);
  source.answers.push(pick('Publish workspace files'), defaults, accept('Publish selected files'));
  await source.command('project');
  await source.waitFor(state => /Published 2 workspace files/.test(state.status), 5_000);
  assert.deepEqual((await a.workspaceFiles(revision)).files.map(file => file.file), [nested, tracked]);
  assert.ok(source.shown.info.includes('command:vscode.diff'));

  const target = await startHost(t, { root: second.root, settings: {}, env: { AGENTEXTENSION_POLICY_FILE: second.policy } });
  const saved = new Map();
  let edits = 0;
  target.vscode.workspace.openTextDocument = async uri => ({ getText: () => saved.get(uri.fsPath), isDirty: false,
    positionAt: index => index, version: 1 });
  const trackedPath = path.join(second.root, tracked);
  const nestedPath = path.join(second.root, nested);
  saved.set(trackedPath, 'Original text\n');
  target.vscode.WorkspaceEdit.prototype.deleteFile = function (uri) { this.edits.push(['delete', uri]); };
  Object.defineProperty(target.vscode.WorkspaceEdit.prototype, 'size', { get() { return this.edits.length; } });
  target.vscode.workspace.applyEdit = async edit => {
    edits++;
    for (const [kind, uri, first, second] of edit.edits) {
      if (kind === 'replace') {
        await fs.writeFile(uri.fsPath, second);
        saved.set(uri.fsPath, second);
      } else if (kind === 'create') {
        await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
        await fs.writeFile(uri.fsPath, first.contents, { flag: 'wx' });
        saved.set(uri.fsPath, String(first.contents));
      } else if (kind === 'delete') {
        await fs.unlink(uri.fsPath);
        saved.delete(uri.fsPath);
      } else assert.fail(`Unexpected editor operation ${kind}`);
    }
    return true;
  };

  const receive = choice => {
    target.answers.push(pick('Review workspace file updates'), defaults, accept(choice));
    return target.command('project');
  };
  await receive(undefined);
  assert.equal(edits, 0);
  await receive(async () => {
    const current = await a.workspaceFiles(revision);
    await a.publishWorkspaceFiles(current, current.files.map(file => file.file === tracked ? { ...file, text: 'Newer shared copy\n' } : file));
    return 'Apply selected files';
  });
  await target.waitFor(state => /changed after review/.test(state.status), 5_000);
  assert.equal(edits, 0);
  assert.equal(await fs.readFile(trackedPath, 'utf8'), 'Original text\n');
  await receive(async () => {
    await fs.writeFile(trackedPath, 'New local change during review\n');
    return 'Apply selected files';
  });
  await target.waitFor(state => /tracked.txt changed during file review/.test(state.status), 5_000);
  assert.equal(edits, 0);
  assert.equal(await fs.readFile(trackedPath, 'utf8'), 'New local change during review\n');
  await fs.writeFile(trackedPath, 'Original text\n');
  await receive('Apply selected files');
  await target.waitFor(state => /Applied 2 workspace files/.test(state.status), 5_000);
  assert.equal(await fs.readFile(trackedPath, 'utf8'), 'Newer shared copy\n');
  assert.equal(await fs.readFile(nestedPath, 'utf8'), 'Nested addition\n');

  const current = await a.workspaceFiles(revision);
  const next = await a.publishWorkspaceFiles(current, [{ file: tracked, baseDigest: digest('Original text\n'), text: null }]);
  const member = f.members[1];
  await receive(async () => {
    f.members.splice(1, 1);
    await f.update();
    return 'Apply selected files';
  });
  await target.waitFor(state => /could not be verified|access was denied/.test(state.status), 5_000);
  assert.equal(await fs.readFile(trackedPath, 'utf8'), 'Newer shared copy\n');
  assert.equal(await fs.readFile(nestedPath, 'utf8'), 'Nested addition\n');
  assert.equal((await a.workspaceFiles(revision)).sequence, next.sequence);
  f.members.splice(1, 0, member);
  await f.update();
  await receive('Apply selected files');
  await target.waitFor(state => /Applied 2 workspace files/.test(state.status), 5_000);
  await assert.rejects(fs.access(trackedPath), { code: 'ENOENT' });
  await assert.rejects(fs.access(nestedPath), { code: 'ENOENT' });
});

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { applyWorkspaceChanges } = require('../src/apply');
const { Draft } = require('../src/draft');
const { Workspace } = require('../src/workspace');

async function run() {
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const find = full => vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === full)?.getText();
  const workspace = new Workspace(root, find, async () => []);
  const readDisk = file => fs.readFile(path.join(root, file), 'utf8');
  await vscode.extensions.getExtension('LiteralKrishu.agentextension').activate();
  const original = 'one\ntwo\nthree\nfour\n';
  await fs.writeFile(path.join(root, 'demo.txt'), original);
  const draft = new Draft((file, create) => workspace.read(file, create));
  await draft.replace('demo.txt', 'one', 'ONE');
  await draft.replace('demo.txt', 'four', 'FOUR');
  await draft.create('new.txt', 'new file\n');
  const accepted = draft.review().filter(hunk => hunk.line !== 4);
  const changes = draft.changes(accepted);
  assert.equal(await readDisk('demo.txt'), original);
  await assert.rejects(readDisk('new.txt'), { code: 'ENOENT' });
  await applyWorkspaceChanges(workspace, changes);
  assert.equal(await readDisk('demo.txt'), original);
  assert.equal(await readDisk('new.txt'), 'new file\n');
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, 'demo.txt')));
  assert.equal(doc.getText(), 'ONE\ntwo\nthree\nfour\n');
  await applyWorkspaceChanges(workspace, changes.map(change => ({ file: change.file, before: change.after, after: change.before })));
  assert.equal(doc.getText(), original);
  await assert.rejects(readDisk('new.txt'), { code: 'ENOENT' });
  await fs.writeFile(path.join(root, 'demo.txt'), 'different\n');
  await assert.rejects(applyWorkspaceChanges(workspace, [{ file: 'demo.txt', before: 'never', after: 'new' }]), /changed since review/);
  console.log('VS Code host passed native apply, partial acceptance, file creation, undo and stale draft checks.');
}

module.exports = { run };

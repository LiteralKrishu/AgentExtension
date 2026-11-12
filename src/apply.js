// @ts-check
const vscode = require('vscode');
const fs = require('node:fs/promises');

/** @typedef {{ file: string } & ({ before: null, after: string }
 * | { before: string, after: null } | { before: string, after: string, hunks?: readonly import('./draft').Hunk[] })} WorkspaceChange */
/** @typedef {{ uri: vscode.Uri, full: string } & ({ create: string, remove?: never } | { create?: never, remove: string })} FileOperation */

/** @param {{ resolve(file: string, newFile: boolean): Promise<string> }} workspace @param {readonly WorkspaceChange[]} changes */
async function applyWorkspaceChanges(workspace, changes) {
  const textEdit = new vscode.WorkspaceEdit();
  /** @type {FileOperation[]} */
  const resources = [];
  /** @type {{ doc: vscode.TextDocument, version: number }[]} */
  const versions = [];
  for (const change of changes) {
    const full = await workspace.resolve(change.file, change.before === null);
    const uri = vscode.Uri.file(full);
    if (change.before === null) {
      resources.push({ uri, full, create: change.after });
      continue;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    if (doc.getText() !== change.before) throw new Error(`${change.file} changed since review. Discard this draft and start again.`);
    versions.push({ doc, version: doc.version });
    if (change.after === null) {
      if (doc.isDirty || await fs.readFile(full, 'utf8') !== change.before) {
        throw new Error(`Save or resolve changes to ${change.file} before undoing its creation.`);
      }
      resources.push({ uri, full, remove: change.before });
    } else if (change.hunks) {
      for (const hunk of change.hunks) {
        textEdit.replace(uri, new vscode.Range(doc.positionAt(hunk.offset), doc.positionAt(hunk.offset + hunk.before.length)), hunk.after);
      }
    } else {
      textEdit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(change.before.length)), change.after);
    }
  }
  const applied = [];
  function checkVersions() {
    if (versions.some(({ doc, version }) => doc.version !== version)) throw new Error('A file changed during apply. Review the current files and try again.');
  }
  try {
    checkVersions();
    for (const item of resources) {
      const edit = new vscode.WorkspaceEdit();
      if (item.create !== undefined) {
        edit.createFile(item.uri, { overwrite: false, ignoreIfExists: false, contents: Buffer.from(item.create) });
      } else {
        if (await fs.readFile(item.full, 'utf8') !== item.remove) throw new Error('A created file changed before undo.');
        edit.deleteFile(item.uri);
      }
      if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code could not apply the file operation.');
      applied.push(item);
    }
    checkVersions();
    if (textEdit.size && !await vscode.workspace.applyEdit(textEdit)) throw new Error('VS Code could not apply the reviewed text edits.');
  } catch (error) {
    try {
      for (const item of applied.reverse()) {
        if (item.create !== undefined) {
          if (await fs.readFile(item.full, 'utf8') !== item.create) throw new Error('The file was modified during rollback.');
          await fs.unlink(item.full);
        } else {
          await fs.writeFile(item.full, item.remove, { flag: 'wx' });
        }
      }
    } catch {
      throw new Error('Apply stopped and a file changed during rollback. Check the affected files before retrying.');
    }
    throw error;
  }
}

module.exports = { applyWorkspaceChanges };

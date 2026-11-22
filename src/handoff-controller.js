const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { exportHandoff, parseHandoff, importHandoff, prepareBranch, commitBranch, deliverHandoff, connectorProvider } = require('./git-handoff');
const { PermissionBroker } = require('./permissions');
const { ReadConnectors } = require('./connectors');
function createHandoffController({ context, chooseFolder, makeWorkspace, readyDraft, busy, resume, policyFor, connectorAccounts, tell }) {
  let prepared, running;
  async function manage() {
    if(running)return tell('A draft handoff is already in progress.');
    running=new AbortController();
    try { return await perform(running.signal); } catch(error) { tell(error.message); }
    finally { running=undefined; }
  }
  async function perform(signal) {
    if (!vscode.workspace.isTrusted || busy()) return tell('Finish the active task in a trusted workspace before a handoff.');
    const action = await vscode.window.showQuickPick(['Export reviewed draft', 'Import draft handoff', 'Prepare local branch',
      ...(prepared ? ['Commit managed draft', 'Push managed branch', 'Create draft pull request', 'Remove managed checkout'] : [])], { title: 'Draft handoff' });
    if (!action) return;
    if (action === 'Remove managed checkout') { await fs.rm(prepared.parent, { recursive: true, force: true }); prepared = undefined; return tell('Managed checkout removed.'); }
    if (action === 'Commit managed draft') {
      const message = await vscode.window.showInputBox({ title: 'Commit message for the managed checkout' }); if (!message) return;
      if (await vscode.window.showWarningMessage('Commit this managed draft?', { modal: true,
        detail: `${prepared.directory}\n${prepared.branch}\nAuthor: ${prepared.author.name} <${prepared.author.email}>\nThis creates only a local commit.` }, 'Commit locally') !== 'Commit locally') return;
      const commit = await commitBranch(prepared, message, signal); return tell(`Committed ${commit.slice(0, 12)} in ${prepared.directory}. Nothing was pushed.`);
    }
    const folder = await chooseFolder(); if (!folder) return;
    const workspace = makeWorkspace(folder); workspace.root = await fs.realpath(workspace.root); workspace.identity = workspace.root;
    if (action === 'Push managed branch' || action === 'Create draft pull request') return deliver(workspace, action, signal);
    if (action === 'Import draft handoff') {
      if(readyDraft())return tell('Apply or discard the current draft before importing another.');
      const selected = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Draft handoff': ['json'] } }); if (!selected?.length) return;
      const stat = await fs.lstat(selected[0].fsPath); if (!stat.isFile() || stat.size > 8000000) throw new Error('Choose a regular draft handoff under 8 MB.');
      const artifact = parseHandoff(JSON.parse(await fs.readFile(selected[0].fsPath, 'utf8')));
      const document = await vscode.workspace.openTextDocument({ content: artifact.patch, language: 'diff' }); await vscode.window.showTextDocument(document, { preview: true });
      if (await vscode.window.showWarningMessage('Import this draft for fresh review?', { modal: true, detail: `${artifact.request}\n${artifact.changes.map(change => change.file).join('\n')}\nSource: ${artifact.source.head}` }, 'Import draft') !== 'Import draft') return;
      await importHandoff(workspace, artifact, context.globalStorageUri.fsPath, signal); return resume();
    }
    const ready = readyDraft();
    if (!ready || ready.workspace.root !== workspace.root) return tell('Review and accept a draft in this workspace before exporting or preparing a branch.');
    const changes = ready.draft.changes(ready.reviewed.hunks);
    const artifact = await exportHandoff(workspace, { request: ready.run.taskRequest, changes,
      checks: ready.run.report.checks, notes: 'Review the exact patch and the recorded check outcomes. Imported drafts require fresh hunk review.' }, signal);
    if (action === 'Export reviewed draft') {
      const target = await vscode.window.showSaveDialog({ title: 'Save draft handoff', defaultUri: vscode.Uri.file(path.join(os.tmpdir(), 'draft.agentextension-handoff.json')), filters: { JSON: ['json'] } }); if (!target) return;
      const parent=await fs.realpath(path.dirname(target.fsPath));
      if(parent===workspace.root||parent.startsWith(workspace.root+path.sep))throw Error('Save the handoff outside the source checkout so its source base stays unchanged.');
      await fs.writeFile(target.fsPath, JSON.stringify(artifact, null, 2), { mode: 0o600 }); return tell('Draft handoff exported. Review it before sharing source.');
    }
    if (action === 'Prepare local branch') {
      if (prepared) return tell('Remove the existing managed checkout before preparing another.');
      const branch = await vscode.window.showInputBox({ title: 'Managed branch name', value: `main/draft-${Date.now()}` }); if (!branch) return;
      const repository = await vscode.window.showInputBox({ title: 'Exact Git remote URL', prompt: 'Must match origin. No push will run.' }); if (!repository) return;
      if (await vscode.window.showWarningMessage('Prepare this branch in a separate checkout?', { modal: true,
        detail: `${repository}\n${branch}\n${artifact.changes.map(change => change.file).join('\n')}\nYour active checkout stays unchanged.` }, 'Prepare branch') !== 'Prepare branch') return;
      prepared = await prepareBranch(workspace, artifact, { branch, repository }, signal); return tell(`Local branch prepared at ${prepared.directory}. Commit and push are separate actions.`);
    }
  }
  async function deliver(workspace, action, signal) {
    if (!prepared?.committed) return tell('Commit the managed draft first.');
    const configs = vscode.workspace.getConfiguration('agentextension').get('readConnectors', []);
    const selected = await vscode.window.showQuickPick(configs.filter(config => config.tools.length && config.writeTools?.length).map(config => ({ label: config.id, config })), { title: 'Configured Git provider connector' });
    if (!selected) return;
    const kind = action === 'Push managed branch' ? 'push' : 'pull-request'; const config = selected.config;
    const read = await vscode.window.showQuickPick(config.tools.map(tool => ({ label: tool.name, tool })), { title: 'Tool that reads the destination state' }); if (!read) return;
    const write = await vscode.window.showQuickPick(config.writeTools.map(tool => ({ label: tool.name, tool })), { title: 'Tool that writes the destination' }); if (!write) return;
    const target = await vscode.window.showQuickPick(read.tool.targets.filter(target => target===prepared.repository&&write.tool.targets.includes(target)), { title: 'Exact configured repository URL' }); if (!target) return;
    const permissions = new PermissionBroker({ workspace: workspace.root, policy: await policyFor(workspace.root), loadPolicy:()=>policyFor(workspace.root), signal });
    const run = { permissions, signal, gitPatch: prepared.artifact.patch, connectors: new ReadConnectors({ configs: [config], secrets: context.secrets, accounts: connectorAccounts, permissions, signal, allowWrites: true }) };
    const input = (tool) => ({ connector: config.id, tool: tool.name, arguments: { [tool.targetArgument]: target } });
    const provider = connectorProvider(run, { [kind]: { read: input(read.tool), write: input(write.tool) } }, {
      connector: async request => await vscode.window.showWarningMessage(request.operation === 'write' ? 'Allow this Git provider write?' : 'Read this Git destination?', { modal: true,
        detail: `${prepared.repository}\n${prepared.branch}\nCommit: ${prepared.committed}\n${request.server}\nAccount: ${request.account}\nTool: ${request.tool}\nTarget: ${request.target}\n${JSON.stringify(request.arguments)}` }, request.operation === 'write' ? 'Allow write' : 'Read destination') === (request.operation === 'write' ? 'Allow write' : 'Read destination'),
    });
    const title = kind === 'pull-request' ? await vscode.window.showInputBox({ title: 'Draft pull request title' }) : undefined; if (kind === 'pull-request' && !title) return;
    const body = kind === 'pull-request' ? prepared.artifact.notes : undefined;
    try { const result = await deliverHandoff(prepared, provider, { kind, title, body }, signal); tell(result.status === 'confirmed' ? 'Git handoff confirmed by the provider.' : result.reason); }
    finally { permissions.revokeAll('Git handoff ended'); }
  }
  return { manage, cancel:reason=>running?.abort(new Error(reason??'Git handoff cancelled.')) };
}
module.exports = { createHandoffController };

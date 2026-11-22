const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const { CodingScheduleStore, codingSchedulePin } = require('./coding-schedules');
const { codingProfile, executionDigest, readCodingResult, importCodingResult, assertSource } = require('./coding-run');
const { ContainerEnvironment } = require('./execution-environment');

function createCodingController({ storage, chooseFolder, makeWorkspace, runSettings, policyFor, tell, busy, resume }) {
  let running;
  async function refresh() {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const identity = await fs.realpath(folder.uri.fsPath);
      const store = new CodingScheduleStore(storage, identity);
      for (const schedule of (await store.list()).filter(row => row.enabled)) {
        let current = false;
        try {
          const profile = codingProfile({ ...runSettings(), fallbackModel: '' }, await policyFor(identity));
          current = codingSchedulePin(identity, schedule, profile) === schedule.approval.digest
            && executionDigest(schedule.environment.profile, makeWorkspace(folder).environment?.checks ?? []) === schedule.environment.declaration;
        } catch { /* An invalid current profile cannot keep unattended authority. */ }
        if (!current) await store.update(schedule.id, { enabled: false, needsReview: true });
      }
    }
  }
  async function manage() {
    if (running) return tell('A coding draft is already running. Cancel it before opening another operation.');
    if (!vscode.workspace.isTrusted) return tell('Trust the workspace before using coding schedules.');
    const folder = await chooseFolder(); if (!folder) return;
    const workspace = makeWorkspace(folder); workspace.root = await fs.realpath(workspace.root); workspace.identity = workspace.root;
    const store = new CodingScheduleStore(storage, workspace.root);
    const rows = await store.list();
    const selected = await vscode.window.showQuickPick([
      { label: 'Create a coding schedule', create: true },
      { label: 'Review coding drafts', inbox: true },
      ...rows.map(schedule => ({ label: schedule.name, description: schedule.enabled ? 'Enabled' : 'Paused', schedule })),
    ], { title: 'Scheduled coding drafts' });
    if (!selected) return;
    if (selected.inbox) return inbox(store, workspace);
    if (selected.create) return create(store, workspace);
    const schedule = selected.schedule;
    const action = await vscode.window.showQuickPick(['Run now in background', 'Pause schedule', 'Revoke schedule', 'Remove schedule'], { title: schedule.name });
    if (action === 'Pause schedule' || action === 'Revoke schedule') { await store.suspend(schedule, action === 'Revoke schedule'); return tell('Coding schedule paused.'); }
    if (action === 'Remove schedule') { await store.remove(schedule.id); return tell('Coding schedule removed.'); }
    if (action === 'Run now in background') {
      // The same occurrence claim is used by editor and standalone runners.
      const { codingScheduler } = require('./coding-run');
      const controller = new AbortController(); running = controller;
      tell('Running a coding draft in a private copy…');
      try { const result = await codingScheduler({ store, signal: controller.signal }).runNow(schedule.id); tell(`Coding draft: ${result.status}. Open Review coding drafts.`); }
      catch (error) { tell(error.message); }
      finally { running = undefined; }
    }
  }
  async function create(store, workspace) {
    if (busy()) return tell('Finish the active task before approving a coding schedule.');
    const settings = { ...runSettings(), fallbackModel: '' };
    const policy = await policyFor(workspace.root);
    const profile = codingProfile(settings, policy);
    const checks = workspace.environment?.checks ?? [];
    if (!checks.length) return tell('Configure managed container checks before creating a coding schedule.');
    const selected = await vscode.window.showQuickPick(checks.map(check => ({ label: check.name, check })),
      { title: 'Checks the coding schedule must run', canPickMany: true });
    if (!selected?.length || selected.length > 4) return;
    const name = await vscode.window.showInputBox({ title: 'Coding schedule name', validateInput: value => !value.trim() || value.length > 80 ? 'Use 1 to 80 characters.' : undefined });
    if (!name) return;
    const prompt = await vscode.window.showInputBox({ title: 'Coding task', validateInput: value => !value.trim() || value.length > 2000 ? 'Use 1 to 2,000 characters.' : undefined });
    if (!prompt) return;
    const paths = await workspace.paths(new AbortController().signal);
    const files = await vscode.window.showQuickPick(paths.map(file => ({ label: file })), { title: 'Files this schedule may change (up to eight)', canPickMany: true });
    if (!files?.length || files.length > 8) return;
    const time = await vscode.window.showInputBox({ title: 'Daily run time', value: '09:00', validateInput: value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? undefined : 'Use HH:MM.' });
    if (!time) return;
    const checkProfiles = new Set(selected.map(item => item.check.profile));
    if (checkProfiles.size !== 1) return tell('Choose checks that use the same container profile.');
    const environment = new ContainerEnvironment({ profile: selected[0].check.profile, checks, allowScripts: false });
    const signal = new AbortController().signal;
    let identity;
    try { identity = await environment.authorizationIdentity(workspace.root, selected[0].check.command, selected[0].check.args, signal); }
    catch (error) {
      if (error.code !== 'ENEEDSIMAGE' || await vscode.window.showWarningMessage('Download this coding environment?', { modal: true, detail: error.image }, 'Download image') !== 'Download image') throw error;
      await environment.imageIdentity(error.image, signal);
      identity = await environment.authorizationIdentity(workspace.root, selected[0].check.command, selected[0].check.args, signal);
    }
    const source = { head: await workspace.gitRevision(signal), contents: await workspace.sourceIdentity(signal) };
    const schedule = { schemaVersion: 1, type: 'coding-draft', output: 'review-inbox', name, prompt, source, files: files.map(file => file.label),
      checks: selected.map(({ check }) => ({ command: check.command, args: check.args })),
      environment: { kind: 'container', profile: selected[0].check.profile, image: identity.image, declaration: executionDigest(selected[0].check.profile, checks), allowScripts: false },
      days: [0, 1, 2, 3, 4, 5, 6], times: [time], timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      budget: { minutes: 5, toolCalls: 30, connectorReads: 0, maxTokens: 100000 }, catchUpMinutes: 60,
      validUntil: new Date(Date.now() + 7 * 86400000).toISOString() };
    const pin = codingSchedulePin(workspace.root, schedule, profile);
    const detail = [`Task: ${prompt}`, `Model: ${settings.model} · ${settings.serverUrl}`, `Daily: ${time} ${schedule.timeZone}`,
      `Edit only: ${schedule.files.join(', ')}`, `Checks: ${selected.map(item => item.label).join(', ')}`, `Image: ${identity.image}`,
      'Runs on saved source in a private copy, including while the editor is closed. The original Git base and source must still match.',
      'Reads the permitted source snapshot. Dependencies may install from the configured registry; lifecycle scripts are off.',
      'Limits: 5 minutes, 100,000 reported tokens, 30 tool calls. Approval expires in seven days.',
      'No connectors, browser, native apps, commits, or pushes. Drafts require fresh human review and explicit apply.'].join('\n');
    if (await vscode.window.showWarningMessage('Approve this coding schedule?', { modal: true, detail }, 'Approve coding schedule') !== 'Approve coding schedule') return;
    if (!vscode.workspace.isTrusted || codingSchedulePin(workspace.root, schedule, codingProfile(runSettings(), await policyFor(workspace.root))) !== pin) throw new Error('Coding settings changed during review.');
    await assertSource(workspace, source, signal);
    const rules = policy.rules.filter(rule => rule.source === 'user' || rule.source === 'workspace');
    const declared = rules.map(({ effect, target, decision, note }) => ({ effect, target, decision, ...(note ? { note } : {}) }));
    await store.create(schedule, { digest: pin, settings, checks, userRules: declared.filter((_, i) => rules[i].source === 'user'), workspaceRules: declared.filter((_, i) => rules[i].source === 'workspace') });
    tell('Coding schedule saved. Start the local background runner to run it while the editor is closed.');
  }
  async function inbox(store, workspace) {
    if (busy()) return tell('Finish or discard the active task before importing a coding draft.');
    const directory = path.join(store.directory, 'inbox');
    const names = await fs.readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const entries = [];
    for (const name of names.filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
      try { const artifact = await readCodingResult(store, path.join(directory, name)); entries.push({ label: artifact.name,
        description: artifact.status, detail: artifact.question?.text ?? artifact.reason ?? artifact.summary?.slice(0, 200), file: path.join(directory, name), artifact }); }
      catch { /* Invalid artifacts cannot enter the review path. */ }
    }
    const selected = await vscode.window.showQuickPick(entries, { title: 'Coding draft review inbox' }); if (!selected) return;
    const content = selected.artifact;
    const document = await vscode.workspace.openTextDocument({ content: JSON.stringify({ source: content.source, status: content.status,
      changes: content.changes, checks: content.checks.map(({ command, args, exitCode, status }) => ({ command, args, exitCode, status })),
      question: content.question, reason: content.reason }, null, 2), language: 'json' });
    await vscode.window.showTextDocument(document, { preview: true });
    const choice = await vscode.window.showQuickPick([
      ...(['ready-for-review', 'needs-input'].includes(content.status) ? ['Import for interactive review'] : []), 'Dismiss result',
    ], { title: content.question?.text ?? 'Review this coding result' });
    if (choice === 'Dismiss result') { await fs.rm(selected.file); return tell('Coding result dismissed.'); }
    if (choice !== 'Import for interactive review' || busy() || !vscode.workspace.isTrusted) return;
    let answer;
    if (content.question) {
      answer = await vscode.window.showInputBox({ title: content.question.text, prompt: 'Your answer starts a new interactive review.', validateInput: text => !text.trim() || text.length > 2000 ? 'Use 1 to 2,000 characters.' : undefined });
      if (!answer) return;
    }
    await importCodingResult(store, selected.file, storage, workspace, answer);
    await resume();
  }
  return { manage, refresh, cancel: reason => running?.abort(new Error(reason ?? 'Coding run cancelled.')) };
}
module.exports = { createCodingController };

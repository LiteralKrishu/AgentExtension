const vscode = require('vscode');
const fs = require('node:fs/promises');
const { digest } = require('./permissions');
const { secretKey } = require('./connectors');
const { WorkspaceMemory } = require('./memory');
const { Scheduler, ScheduleStore, normalizeSchedule, validateTimeZone, schedulePin, nextOccurrence, localLabel, describeCadence } = require('./schedules');
const { runScheduledReport } = require('./scheduled-run');

function createScheduleController({ context, panel, status, chooseFolder, makeWorkspace, runSettings, policyFor,
  connectorConfigs, auditDecision, tell, openReport, setLastReport, isForegroundActive, isForegroundBusy, onError }) {
  const schedulers = new Map();
  let scheduled;
  let disposed = false;

  async function pinFor(identity, schedule) {
    const selected = connectorConfigs().filter(config => schedule.connectors.includes(config.id));
    if (selected.length !== schedule.connectors.length) throw new Error('A connector in this schedule is no longer configured.');
    const settings = runSettings();
    if (!settings.model.trim()) throw new Error('Set AgentExtension: Model first.');
    return schedulePin({ workspace: identity, schedule, connectors: selected,
      credentials: await Promise.all(selected.map(async config => `${config.id}:${digest(await context.secrets.get(secretKey(config)) ?? '')}`)),
      model: settings.model, fallbackModel: settings.fallbackModel, serverUrl: settings.serverUrl });
  }

  async function refreshSchedulers() {
    const enabled = vscode.workspace.isTrusted && vscode.workspace.getConfiguration('agentextension').get('scheduledReports', true);
    const open = new Map();
    for (const folder of enabled ? (vscode.workspace.workspaceFolders ?? []).filter(item => item.uri.scheme === 'file') : []) {
      try { open.set(await fs.realpath(folder.uri.fsPath), folder); } catch { /* A missing folder has no schedules to run. */ }
    }
    if (disposed) return;
    for (const [identity, entry] of schedulers) {
      if (!open.has(identity)) { entry.scheduler.stop(); schedulers.delete(identity); }
    }
    for (const [identity, folder] of open) {
      const existing = schedulers.get(identity);
      if (existing) { existing.folder = folder; continue; }
      const store = new ScheduleStore(context.globalStorageUri.fsPath, identity);
      const scheduler = new Scheduler({ store, isBusy: () => isForegroundBusy() || Boolean(scheduled), pinFor: schedule => pinFor(identity, schedule),
        execute: (schedule, occurrence, trigger, onCancel) => executeSchedule(identity, schedule, occurrence, trigger, onCancel),
        onChange: record => { void scheduleChanged(record).catch(error => onError(error)); } });
      schedulers.set(identity, { scheduler, store, folder });
      scheduler.start();
    }
    await scheduleSummary();
  }

  // Multi-root windows have one scheduler per folder. Reports run one at a time.
  let scheduleQueue = Promise.resolve();
  function executeSchedule(...args) {
    const next = scheduleQueue.then(() => executeScheduleNow(...args));
    scheduleQueue = next.catch(() => {});
    return next;
  }

  async function executeScheduleNow(identity, schedule, occurrence, trigger, onCancel) {
    const entry = schedulers.get(identity);
    if (!entry || !vscode.workspace.isTrusted) throw new Error('The workspace is not open in a trusted window.');
    const workspace = makeWorkspace(entry.folder);
    workspace.root = await fs.realpath(workspace.root);
    if (workspace.root !== identity) throw new Error('Workspace identity changed. Review the schedule.');
    workspace.identity = workspace.root;
    scheduled = { schedule, cancel: () => {} };
    status.text = '$(calendar) Scheduled report';
    status.tooltip = `Cancel scheduled report "${schedule.name}"`;
    status.show();
    panel.update({ scheduledRunning: schedule.name, status: `Scheduled report "${schedule.name}" is running read-only.` });
    try {
      return await runScheduledReport({ schedule, occurrence, trigger, workspace, settings: runSettings(), policy: policyFor(identity),
        connectorConfigs: connectorConfigs(), secrets: context.secrets, notes: new WorkspaceMemory(context.globalState, identity).list(),
        storage: context.globalStorageUri.fsPath, audit: event => auditDecision(event, identity),
        onCancel: stop => { scheduled.cancel = stop; onCancel(stop); } });
    } finally {
      scheduled = undefined;
      if (!isForegroundActive()) status.hide();
      panel.update({ scheduledRunning: '' });
    }
  }

  async function scheduleChanged(record) {
    if (record.report) setLastReport(record.report);
    await scheduleSummary();
    const label = `Scheduled report "${record.name}"`;
    const reason = record.reason ? ` ${record.reason}` : '';
    if (record.status === 'completed') {
      tell(`${label} completed.`);
      if (await vscode.window.showInformationMessage(`${label} completed.`, 'Open report') === 'Open report') await openReport();
    } else if (record.status === 'missed') {
      tell(`${label} missed ${record.count}${record.countIsMinimum ? ' or more' : ''} occurrence(s).${reason}`);
    } else {
      tell(`${label}: ${record.status}.${reason}`);
      const choice = await vscode.window.showWarningMessage(`${label}: ${record.status}.${reason}`, ...(record.report ? ['Open report'] : []), 'Manage schedules');
      if (choice === 'Open report') await openReport();
      if (choice === 'Manage schedules') await manageSchedules();
    }
  }

  async function scheduleSummary() {
    const now = Date.now();
    const rows = [];
    for (const { store } of schedulers.values()) {
      for (const schedule of await store.list().catch(() => [])) {
        const next = schedule.enabled ? nextOccurrence(schedule, now) : undefined;
        rows.push({ schedule, next });
      }
    }
    const upcoming = rows.filter(row => row.next).sort((a, b) => a.next.at - b.next.at)[0];
    const paused = rows.filter(row => !row.schedule.enabled).length;
    panel.update({ scheduleSummary: !rows.length ? '' : `${rows.length} scheduled report${rows.length === 1 ? '' : 's'}`
      + (upcoming ? ` · next "${upcoming.schedule.name}" at ${upcoming.next.slot} ${upcoming.schedule.timeZone}` : '')
      + (paused ? ` · ${paused} paused or awaiting review` : '') + '. Runs only while VS Code is open.' });
  }

  function approvalDetail(identity, schedule, connectors) {
    const next = nextOccurrence(schedule, Date.now());
    const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const settings = runSettings();
    return [`Workspace: ${identity}`, `When: ${describeCadence(schedule)}`,
      next ? `Next run: ${next.slot} ${schedule.timeZone}${host !== schedule.timeZone ? ` (${localLabel(next.at, host)} ${host})` : ''}` : '',
      `Request: ${schedule.prompt}`,
      `Reads: workspace files${connectors.length ? `; ${connectors.map(config => `${config.id} (${config.account}): ${config.tools.map(tool => `${tool.name} ${tool.targets.join(', ')}`).join('; ')}`).join(' · ')}` : ''}`,
      `Model: ${settings.model}${settings.fallbackModel ? `, fallback ${settings.fallbackModel}` : ''}. Repository excerpts, approved notes and connector results are sent to it.`,
      `Budget: ${schedule.budget.minutes} min, ${schedule.budget.toolCalls} tool calls, ${schedule.budget.connectorReads} connector reads.`,
      `Offline: runs only while VS Code is open with this trusted workspace. After downtime, only the latest missed run starts, and only within ${schedule.catchUpMinutes} minutes. Others are recorded as missed. An unreachable model server is recorded as offline and not retried.`,
      'No writes, draft edits, commands, browser, native app, or subagent access. Connector reads to the listed targets are approved in advance by this schedule. Any change to the workspace path, request, timing, budget, connectors, credentials, model or server pauses the schedule until you approve it again.'].filter(Boolean).join('\n');
  }

  async function manageSchedules() {
    if (!vscode.workspace.isTrusted) return tell('Trust this workspace before scheduling reports.');
    if (!vscode.workspace.getConfiguration('agentextension').get('scheduledReports', true)) return tell('Turn on AgentExtension: Scheduled Reports in Settings first.');
    const folder = await chooseFolder();
    if (!folder) return tell('Open a workspace folder first.');
    const identity = await fs.realpath(folder.uri.fsPath);
    await refreshSchedulers();
    const entry = schedulers.get(identity);
    if (!entry) return tell('This workspace is not available for schedules.');
    const list = await entry.store.list();
    const pick = await vscode.window.showQuickPick([{ label: '$(add) New scheduled report', create: true },
      ...list.map(schedule => {
        const next = schedule.enabled ? nextOccurrence(schedule, Date.now()) : undefined;
        return { label: schedule.name, schedule,
          description: schedule.needsReview ? 'Needs review' : !schedule.enabled ? 'Paused' : next ? `Next ${next.slot} ${schedule.timeZone}` : '',
          detail: `${describeCadence(schedule)} · ${schedule.connectors.length ? `Connectors: ${schedule.connectors.join(', ')}` : 'Workspace reads only'}` };
      })], { placeHolder: `Read-only scheduled reports for ${folder.name}. They run only while VS Code is open.` });
    if (!pick) return;
    if (pick.create) return createSchedule(folder, identity, entry);
    const schedule = pick.schedule;
    const action = await vscode.window.showQuickPick([
      { label: 'Run now', id: 'run' },
      schedule.enabled ? { label: 'Pause', id: 'pause' } : { label: 'Review and resume', id: 'resume', detail: 'Shows the current scope for a new approval.' },
      { label: 'View run history', id: 'history' },
      { label: 'Delete', id: 'delete' }], { placeHolder: schedule.name });
    if (action?.id === 'run') {
      if (!schedule.enabled || await pinFor(identity, schedule).catch(() => '') !== schedule.approval.digest) {
        return tell(schedule.enabled ? 'This schedule changed since approval. Choose Review and resume first.' : 'Resume this schedule before running it.');
      }
      void entry.scheduler.runNow(schedule.id).catch(error => tell(error.message));
    } else if (action?.id === 'pause') {
      await entry.store.update(schedule.id, { enabled: false });
      tell(`Paused "${schedule.name}".`);
    } else if (action?.id === 'resume') {
      const connectors = connectorConfigs().filter(config => schedule.connectors.includes(config.id));
      const pin = await pinFor(identity, schedule);
      if (await vscode.window.showWarningMessage(`Approve scheduled report "${schedule.name}" again?`, { modal: true,
        detail: approvalDetail(identity, schedule, connectors) }, 'Approve schedule') !== 'Approve schedule') return;
      if (await pinFor(identity, schedule) !== pin) throw new Error('Settings changed during approval. Try again.');
      const now = Date.now();
      await entry.store.update(schedule.id, { enabled: true, needsReview: false, cursor: now, approval: { digest: pin, at: now } });
      tell(`Approved "${schedule.name}" again.`);
    } else if (action?.id === 'history') {
      const rows = await entry.store.history(schedule.id);
      const choice = await vscode.window.showQuickPick(rows.map(row => ({
        label: `${row.status} · ${row.status === 'missed' ? `${row.count}${row.countIsMinimum ? '+' : ''} × ${row.firstLocal}${row.count > 1 ? ` – ${row.lastLocal}` : ''}` : row.local} ${row.timeZone}`,
        description: row.trigger, row,
        detail: [row.reason, row.usage ? `${row.usage.toolCalls} tool calls · ${row.usage.connectorReads} connector reads · ${row.usage.seconds} s` : ''].filter(Boolean).join(' · ') })),
      { placeHolder: rows.length ? 'Run history, newest first. Select a run to open its report.' : 'No runs yet.' });
      if (choice?.row.report) await vscode.window.showTextDocument(vscode.Uri.file(choice.row.report), { preview: false });
    } else if (action?.id === 'delete') {
      if (await vscode.window.showWarningMessage(`Delete scheduled report "${schedule.name}"?`, { modal: true, detail: 'Saved reports stay in the report list.' }, 'Delete') === 'Delete') {
        await entry.store.remove(schedule.id);
      }
    }
    await scheduleSummary();
  }

  async function createSchedule(folder, identity, entry) {
    if (!runSettings().model.trim()) return tell('Set AgentExtension: Model in VS Code Settings first.');
    const name = await vscode.window.showInputBox({ title: 'New scheduled report (1/7)', prompt: 'Name', ignoreFocusOut: true,
      validateInput: text => !text.trim() || text.length > 80 ? 'Use 1 to 80 characters.' : undefined });
    if (!name) return;
    const prompt = await vscode.window.showInputBox({ title: 'New scheduled report (2/7)', ignoreFocusOut: true,
      prompt: 'What should the report cover? The run can read but cannot change anything.',
      validateInput: text => !text.trim() || text.length > 2_000 ? 'Use 1 to 2,000 characters.' : undefined });
    if (!prompt) return;
    const cadence = await vscode.window.showQuickPick([{ label: 'Every day', days: [0, 1, 2, 3, 4, 5, 6] },
      { label: 'Weekdays', days: [1, 2, 3, 4, 5] }, { label: 'Choose days…', choose: true }], { title: 'New scheduled report (3/7)', placeHolder: 'Days' });
    if (!cadence) return;
    let days = cadence.days;
    if (cadence.choose) {
      const picked = await vscode.window.showQuickPick(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
        .map((label, day) => ({ label, day })), { canPickMany: true, placeHolder: 'Days of the week in the schedule time zone' });
      if (!picked?.length) return;
      days = picked.map(item => item.day);
    }
    const times = await vscode.window.showInputBox({ title: 'New scheduled report (4/7)', value: '09:00', ignoreFocusOut: true,
      prompt: 'Times in 24-hour HH:MM, separated by commas. Up to four.',
      validateInput: text => /^\s*([01]\d|2[0-3]):[0-5]\d(\s*,\s*([01]\d|2[0-3]):[0-5]\d){0,3}\s*$/.test(text) ? undefined : 'Use HH:MM, for example 09:00, 17:30.' });
    if (!times) return;
    const timeZone = await vscode.window.showInputBox({ title: 'New scheduled report (5/7)', ignoreFocusOut: true,
      value: Intl.DateTimeFormat().resolvedOptions().timeZone, prompt: 'IANA time zone. Times follow this zone, including daylight-saving changes.',
      validateInput: text => { try { validateTimeZone(text.trim()); return undefined; } catch (error) { return error.message; } } });
    if (!timeZone) return;
    let connectors = [];
    const configs = connectorConfigs();
    if (configs.length) {
      const picked = await vscode.window.showQuickPick(configs.map(config => ({ label: config.id, config,
        description: `${config.account} · ${config.url}`, detail: config.tools.map(tool => `${tool.name}: ${tool.targets.join(', ')}`).join('; ') })),
      { canPickMany: true, title: 'New scheduled report (6/7)', placeHolder: 'Optional connector reads. Every listed target is approved in advance for this schedule.' });
      if (!picked) return;
      connectors = picked.map(item => item.config.id);
    }
    const size = await vscode.window.showQuickPick([
      { label: 'Standard', description: '5 min · 20 tool calls · 5 connector reads · catch up within 6 hours', budget: { minutes: 5, toolCalls: 20, connectorReads: 5 }, catchUpMinutes: 360 },
      { label: 'Small', description: '2 min · 8 tool calls · 2 connector reads · catch up within 1 hour', budget: { minutes: 2, toolCalls: 8, connectorReads: 2 }, catchUpMinutes: 60 },
      { label: 'Large', description: '10 min · 40 tool calls · 10 connector reads · catch up within 24 hours', budget: { minutes: 10, toolCalls: 40, connectorReads: 10 }, catchUpMinutes: 1_440 },
      { label: 'Standard, never catch up', description: 'Missed runs are only recorded', budget: { minutes: 5, toolCalls: 20, connectorReads: 5 }, catchUpMinutes: 0 },
    ], { title: 'New scheduled report (7/7)', placeHolder: 'Run budget and offline catch-up' });
    if (!size) return;
    const schedule = normalizeSchedule({ name: name.trim(), prompt: prompt.trim(), days, times: times.split(',').map(time => time.trim()),
      timeZone: timeZone.trim(), connectors, budget: size.budget, catchUpMinutes: size.catchUpMinutes });
    const pin = await pinFor(identity, schedule);
    const selected = configs.filter(config => connectors.includes(config.id));
    if (await vscode.window.showWarningMessage(`Approve scheduled report "${schedule.name}"?`, { modal: true,
      detail: approvalDetail(identity, schedule, selected) }, 'Approve schedule') !== 'Approve schedule') return;
    if (await pinFor(identity, schedule) !== pin) throw new Error('Settings changed during approval. Try again.');
    await entry.store.create(schedule, pin);
    await scheduleSummary();
    const next = nextOccurrence(schedule, Date.now());
    tell(`Scheduled "${schedule.name}". ${next ? `Next run ${next.slot} ${schedule.timeZone}.` : ''}`);
  }

  function cancel(reason) {
    scheduled?.cancel(reason);
  }

  function dispose() {
    disposed = true;
    cancel('Extension stopped');
    for (const { scheduler } of schedulers.values()) scheduler.stop();
    schedulers.clear();
  }

  return {
    manage: manageSchedules,
    refresh: refreshSchedulers,
    cancel,
    dispose,
    get runningName() { return scheduled?.schedule.name; },
  };
}

module.exports = { createScheduleController };

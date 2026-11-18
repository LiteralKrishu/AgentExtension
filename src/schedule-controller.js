const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { WorkspaceMemory } = require('./memory');
const { resolveScheduleScope } = require('./schedule-scope');
const { BackgroundCredentials } = require('./background-runner');
const { webhookUrl } = require('./schedule-notifications');
const { Scheduler, ScheduleStore, normalizeSchedule, validateTimeZone, hasScheduleContext,
  nextOccurrence, localLabel, describeCadence, DEFAULT_SCHEDULE_TOKENS } = require('./schedules');
const { runScheduledReport } = require('./scheduled-run');

function createScheduleController({ context, panel, status, chooseFolder, makeWorkspace, runSettings, prepareRunSettings, policyFor,
  connectorConfigs, connectorAccounts, auditDecision, tell, openReport, setLastReport, isForegroundActive, isForegroundBusy, onError,
  contextCatalog, startFollowUp, backgroundProfile }) {
  const schedulers = new Map();
  let scheduled;
  let disposed = false;

  async function scopeFor(identity, schedule) {
    const connectors = connectorConfigs();
    const settings = runSettings();
    const policy = await policyFor(identity);
    const scope = await resolveScheduleScope({ identity, schedule, connectors, settings, secrets: context.secrets,
      accounts: connectorAccounts, contextCatalog: (root, ids, fields) => contextCatalog(root, ids, fields, policy),
      backgroundProfile: schedule.background ? backgroundProfile(identity, schedule, settings, connectors.filter(config => schedule.connectors.includes(config.id)), policy) : undefined });
    return { ...scope, policy };
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
      const scheduler = new Scheduler({ store, isBusy: () => isForegroundBusy() || Boolean(scheduled),
        owns: schedule => !schedule.background,
        pinFor: async schedule => (await scopeFor(identity, schedule)).approval.digest,
        execute: (schedule, occurrence, trigger, onCancel) => executeSchedule(identity, schedule, occurrence, trigger, onCancel),
        onChange: record => { void scheduleChanged(record).catch(error => onError(error)); } });
      schedulers.set(identity, { scheduler, store, folder });
      scheduler.start();
    }
    // The runner uses the settings reviewed at enrollment. Check them when the editor sees live settings.
    for (const { store } of schedulers.values()) {
      for (const schedule of (await store.list()).filter(item => item.enabled && item.background)) {
        const scope = await scopeFor(store.workspace, schedule).catch(() => undefined);
        if (scope?.approval.digest !== schedule.approval.digest) await store.pauseForReview(schedule);
      }
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
      const verify = async () => {
        const current = (await entry.store.list()).find(item => item.id === schedule.id);
        if (!vscode.workspace.isTrusted || !current?.enabled || current.background
            || current.approval.digest !== schedule.approval.digest || current.approval.at !== schedule.approval.at) {
          throw new Error('The schedule approval is no longer active.');
        }
        const scope = await scopeFor(identity, current);
        if (scope.approval.digest !== schedule.approval.digest) throw new Error('The approved schedule or its inputs changed.');
        return scope;
      };
      let scope;
      try { scope = await verify(); }
      catch (error) { return { status: 'blocked', reason: `${error.message} Review and approve the schedule again.` }; }
      return await runScheduledReport({ schedule, occurrence, trigger, workspace, settings: scope.settings, policy: scope.policy,
        inputs: scope.inputs, verify, prepareRunSettings,
        connectorConfigs: scope.selected, accounts: connectorAccounts, secrets: context.secrets, notes: new WorkspaceMemory(context.globalState, identity).list(),
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
    if (record.status === 'needs-answer') {
      tell(`${label} saved a question for review.`);
      if (await vscode.window.showInformationMessage(`${label} has a question.`, 'Review questions') === 'Review questions') await questions();
    } else if (record.status === 'completed') {
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
    const pending = await pendingQuestions();
    const background = rows.filter(row => row.schedule.background).length;
    panel.update({ pendingScheduleQuestions: pending.length, scheduleSummary: !rows.length ? '' : `${rows.length} scheduled report${rows.length === 1 ? '' : 's'}`
      + (upcoming ? ` · next "${upcoming.schedule.name}" at ${upcoming.next.slot} ${upcoming.schedule.timeZone}` : '')
      + (paused ? ` · ${paused} paused or awaiting review` : '')
      + (background ? ` · ${background} assigned to the background runner.` : '. Runs only while VS Code is open.') });
  }

  function approvalDetail(identity, schedule, { selected: connectors, approval, settings, oauthAccounts }) {
    const next = nextOccurrence(schedule, Date.now());
    const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return [`Workspace: ${identity}`, `When: ${describeCadence(schedule)}`,
      next ? `Next run: ${next.slot} ${schedule.timeZone}${host !== schedule.timeZone ? ` (${localLabel(next.at, host)} ${host})` : ''}` : '',
      `Request: ${schedule.prompt}`,
      `Reads: workspace files${connectors.length ? `; ${connectors.map(config => `${config.id} (${config.account}): ${config.tools.map(tool => `${tool.name} ${tool.targets.join(', ')}`).join('; ')}`).join(' · ')}` : ''}`,
      ...connectors.filter(config => config.oauth).map(config => {
        const { label, scopes } = oauthAccounts.get(config.id).identity;
        return `Verified OAuth account for ${config.id}: ${label} · ${config.oauth.issuer}\nScopes: ${scopes.join(', ')}`;
      }),
      ...(approval.versions?.inputs.map(item => `Approved context: ${item.label}${item.description ? ` · ${item.description}` : ''} · SHA-256 ${item.version}`) ?? []),
      `Model: ${settings.model}${settings.fallbackModel ? `, fallback ${settings.fallbackModel}` : ''}. Repository excerpts, approved notes and connector results are sent to it.`,
      `Budget: ${schedule.budget.minutes} min, ${schedule.budget.toolCalls} tool calls, ${schedule.budget.connectorReads} connector reads, ${(schedule.budget.maxTokens ?? DEFAULT_SCHEDULE_TOKENS).toLocaleString('en-US')} model tokens.`,
      schedule.background
        ? 'Runner: a local background process under this login reads saved files and approved notes while VS Code is closed. The model server must remain running.'
        : 'Runner: the editor runs this schedule while the trusted workspace is open.',
      schedule.background && oauthAccounts.size ? 'The browser will ask you to authorize each listed OAuth account for this schedule. The runner stores separate refresh credentials under this login.' : '',
      schedule.background && connectors.some(config => !config.oauth) ? 'Provision any matching bearer tokens separately.' : '',
      `After downtime, only the latest missed run starts, and only within ${schedule.catchUpMinutes} minutes. Others are recorded as missed.`,
      schedule.background?.webhook
        ? `Send a JSON notification to ${schedule.background.webhook}\nPayload preview: {"outcome":"completed","report":"reports/<workspace-key>/<run-id>/report.md"}` : '',
      `No writes, draft edits, commands, browser, native app${schedule.context?.workers?.length ? ' or edit-worker access' : ', or subagent access'}. Connector reads to listed targets are approved in advance. The report can save a question and finish. Changes to approved inputs or scope pause the schedule until you approve it again.`].filter(Boolean).join('\n');
  }

  async function approveScheduleUpdate(identity, entry, schedule, updated) {
    const scope = await scopeFor(identity, updated);
    if (await vscode.window.showWarningMessage(`Approve scheduled report "${schedule.name}" again?`, { modal: true,
      detail: approvalDetail(identity, updated, scope) }, 'Approve schedule') !== 'Approve schedule') return false;
    const verifyScope = async () => {
      if (!vscode.workspace.isTrusted || (await scopeFor(identity, updated)).approval.digest !== scope.approval.digest) {
        throw new Error('Settings or the OAuth account changed during approval. Try again.');
      }
    };
    await verifyScope();
    const oauth = updated.background ? scope.selected.filter(config => config.oauth) : [];
    const records = [];
    if (oauth.length) {
      const authorised = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
        title: `Authorize background OAuth for ${schedule.name}`, cancellable: true }, async (_progress, cancellation) => {
        const controller = new AbortController();
        const subscription = cancellation.onCancellationRequested(() => controller.abort());
        try {
          for (const config of oauth) {
            await verifyScope();
            if (scope.policy.decide('connector.account', `${config.id}/${config.account}`).decision === 'deny') {
              throw new Error('A permission rule denies authorization of this connector account.');
            }
            const { raw } = scope.oauthAccounts.get(config.id);
            const record = await connectorAccounts.authorizeBackground(config, raw, {
              signal: controller.signal, openBrowser: url => vscode.env.openExternal(vscode.Uri.parse(url.href)),
            });
            records.push({ config, raw, record });
          }
          return !controller.signal.aborted;
        } catch (error) {
          if (!controller.signal.aborted) throw error;
          return false;
        } finally { subscription.dispose(); }
      });
      if (!authorised) return false;
    }
    await verifyScope();
    const now = Math.max(Date.now(), schedule.approval.at + 1);
    const approval = { ...scope.approval, at: now, ...(records.length ? { oauthEpoch: randomUUID() } : {}) };
    const credentials = new BackgroundCredentials(entry.store, { ...schedule, approval });
    try {
      for (const { config, raw, record } of records) await credentials.provisionOAuth(config, raw, record);
      await verifyScope();
      if (Boolean((await entry.store.withRuntime(schedule)).backgroundRevoked) !== Boolean(schedule.backgroundRevoked)) {
        throw new Error('Background access was revoked during approval. Review the schedule again.');
      }
      await entry.store.update(schedule.id, current => {
        if (current.approval.digest !== schedule.approval.digest || current.approval.at !== schedule.approval.at
            || current.approval.oauthEpoch !== schedule.approval.oauthEpoch) {
          throw new Error('The schedule changed in another editor window. Review it again.');
        }
        return { context: updated.context, background: updated.background, enabled: true,
          needsReview: false, cursor: now, approval };
      });
    } catch (error) {
      if (records.length) await credentials.clearOAuth();
      throw error;
    }
    if (schedule.background) {
      const previous = new BackgroundCredentials(entry.store, schedule);
      if (updated.background) await previous.clearOAuth();
      else await previous.clear();
    }
    tell(`Approved "${schedule.name}" again.`);
    return true;
  }

  async function backgroundSettings(identity, entry, schedule) {
    if (!process.getuid) return tell('The background runner pilot is available on macOS and Linux.');
    const choice = await vscode.window.showQuickPick([
      { label: schedule.background ? 'Review background approval and notifications' : 'Allow this schedule to run in the background', id: 'approve' },
      { label: 'Show runner setup', id: 'setup' },
      ...(schedule.background ? [{ label: 'Return this schedule to the editor', id: 'editor' }, { label: 'Revoke background approval', id: 'revoke' }] : []),
    ], { placeHolder: 'Background schedule' });
    if (choice?.id === 'setup') {
      const bundled = path.join(context.extensionPath, 'src', 'background-cli.cjs');
      const cli = await fs.access(bundled).then(() => bundled, () => path.join(context.extensionPath, 'src', 'background-cli.js'));
      await vscode.window.showInformationMessage('Run the local schedule runner', { modal: true,
        detail: `Start in a terminal with Node.js 22.14 or later.\nnode "${cli}" serve "${context.globalStorageUri.fsPath}"\nUse status instead of serve to see schedule IDs. Use pause or revoke with a schedule ID to stop it while VS Code is closed.` });
    } else if (choice?.id === 'revoke') {
      if (await vscode.window.showWarningMessage(`Revoke background approval for "${schedule.name}"?`,
        { modal: true, detail: 'This pauses the schedule and removes its separately provisioned runner tokens.' }, 'Revoke') !== 'Revoke') return;
      await entry.store.suspend(schedule, true);
      await new BackgroundCredentials(entry.store, schedule).clear();
      tell(`Revoked background approval for "${schedule.name}".`);
    } else if (choice?.id === 'editor') {
      await approveScheduleUpdate(identity, entry, schedule, { ...schedule, background: undefined });
    } else if (choice?.id === 'approve') {
      const raw = await vscode.window.showInputBox({
        title: 'Optional HTTPS notification webhook', value: schedule.background?.webhook ?? '', ignoreFocusOut: true,
        prompt: 'Leave empty to run without an external notification.',
        validateInput: value => { try { if (value.trim()) webhookUrl(value.trim()); } catch (error) { return error.message; } },
      });
      if (raw === undefined) return;
      const background = raw.trim() ? { webhook: webhookUrl(raw.trim()) } : {};
      await approveScheduleUpdate(identity, entry, schedule, { ...schedule, background });
    }
  }

  async function chooseContext(identity, connectorIds, previous) {
    const { options } = await contextCatalog(identity, connectorIds);
    if (!options.length) return {};
    const choices = await vscode.window.showQuickPick(options.map(item => ({
      ...item, picked: Array.isArray(previous?.[item.kind]) ? previous[item.kind].includes(item.id) : Boolean(previous?.[item.kind]),
    })), { canPickMany: true, placeHolder: 'Optional approved instructions, skills and read-only workers' });
    if (!choices) return undefined;
    return {
      userInstructions: choices.some(item => item.kind === 'userInstructions'),
      workspaceInstructions: choices.some(item => item.kind === 'workspaceInstructions'),
      skills: choices.filter(item => item.kind === 'skills').map(item => item.id),
      workers: choices.filter(item => item.kind === 'workers').map(item => item.id),
    };
  }

  async function pendingQuestions() {
    const groups = await Promise.all((vscode.workspace.isTrusted ? vscode.workspace.workspaceFolders ?? [] : [])
      .filter(folder => folder.uri.scheme === 'file').map(async folder => {
        const identity = await fs.realpath(folder.uri.fsPath).catch(() => undefined);
        if (!identity) return [];
        const store = schedulers.get(identity)?.store ?? new ScheduleStore(context.globalStorageUri.fsPath, identity);
        return (await store.pendingQuestions()).map(row => ({ row, folder, store, identity }));
      }));
    return groups.flat().sort((a, b) => b.row.recordedAt.localeCompare(a.row.recordedAt))
      .filter((item, index, all) => all.findIndex(other => other.identity === item.identity && other.row.id === item.row.id) === index);
  }

  async function questions() {
    const pending = await pendingQuestions();
    if (!pending.length) {
      panel.update({ pendingScheduleQuestions: 0 });
      return tell('No scheduled questions are waiting.');
    }
    const selected = await vscode.window.showQuickPick(pending.map(item => ({
      ...item, label: item.row.question.text, description: item.row.name, detail: `${item.folder.name} · ${item.row.local} ${item.row.timeZone}`,
    })), { placeHolder: 'Choose a saved question from a scheduled report' });
    if (!selected) return;
    const { row, store, folder, identity } = selected;
    const action = await vscode.window.showQuickPick([
      ...row.question.options.map(answer => ({ label: answer, description: 'Start a follow-up with this answer', answer })),
      { label: 'Type an answer and start a follow-up', typeAnswer: true },
      { label: 'Dismiss question', dismiss: true },
    ], { title: row.question.text, placeHolder: 'Answer or dismiss the saved question' });
    if (!action || !vscode.workspace.isTrusted) return;
    if (action.dismiss) {
      const resolved = await store.resolveQuestion(row.id, 'dismissed');
      await scheduleSummary();
      return tell(resolved ? 'Scheduled question dismissed.' : 'This question has already been handled.');
    }
    const answer = action.typeAnswer ? await vscode.window.showInputBox({ title: 'Answer the scheduled question', prompt: row.question.text,
      ignoreFocusOut: true, validateInput: text => !text.trim() || text.length > 2_000 ? 'Use 1 to 2,000 characters.' : undefined }) : action.answer;
    if (!answer?.trim()) return;
    await startFollowUp(folder, {
      workspace: identity, answer: answer.trim(),
      reference: { schedule: row.name, occurrence: `${row.local} ${row.timeZone}`, question: row.question.text },
      claim: async () => {
        const resolved = await store.resolveQuestion(row.id, 'answered');
        await scheduleSummary().catch(error => onError(error));
        return resolved;
      },
    });
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
          detail: `${describeCadence(schedule)} · ${schedule.background ? 'Background runner' : 'VS Code'}${schedule.connectors.length ? ` · Connectors: ${schedule.connectors.join(', ')}` : ''}` };
      })], { placeHolder: `Read-only scheduled reports for ${folder.name}` });
    if (!pick) return;
    if (pick.create) return createSchedule(folder, identity, entry);
    const schedule = pick.schedule;
    const action = await vscode.window.showQuickPick([
      { label: 'Run now', id: 'run' },
      schedule.enabled ? { label: 'Pause', id: 'pause' } : { label: 'Review and resume', id: 'resume', detail: 'Shows the current scope for a new approval.' },
      { label: 'Edit approved context', id: 'context' },
      { label: 'Manage background runner', id: 'background' },
      { label: 'View run history', id: 'history' },
      { label: 'Delete', id: 'delete' }], { placeHolder: schedule.name });
    if (action?.id === 'run') {
      if (schedule.background) return tell('Use the background runner’s run-now command with this schedule ID: ' + schedule.id);
      if (!schedule.enabled || (!schedule.context && (await scopeFor(identity, schedule).catch(() => null))?.approval.digest !== schedule.approval.digest)) {
        return tell(schedule.enabled ? 'This schedule changed since approval. Choose Review and resume first.' : 'Resume this schedule before running it.');
      }
      void entry.scheduler.runNow(schedule.id).catch(error => tell(error.message));
    } else if (action?.id === 'pause') {
      await entry.store.suspend(schedule);
      tell(`Paused "${schedule.name}".`);
    } else if (action?.id === 'resume' || action?.id === 'context') {
      if (schedule.backgroundRevoked) return tell('Use Manage background runner to grant a new background approval or return the schedule to the editor.');
      const selected = action.id === 'context' ? await chooseContext(identity, schedule.connectors, schedule.context) : schedule.context;
      if (action.id === 'context' && selected === undefined) return;
      const updated = { ...schedule, context: hasScheduleContext(selected) ? selected : undefined };
      await approveScheduleUpdate(identity, entry, schedule, updated);
    } else if (action?.id === 'background') {
      await backgroundSettings(identity, entry, schedule);
    } else if (action?.id === 'history') {
      const rows = await entry.store.history(schedule.id);
      const choice = await vscode.window.showQuickPick(rows.map(row => ({
        label: `${row.status} · ${row.status === 'missed' ? `${row.count}${row.countIsMinimum ? '+' : ''} × ${row.firstLocal}${row.count > 1 ? ` – ${row.lastLocal}` : ''}` : row.local} ${row.timeZone}`,
        description: row.trigger, row,
        detail: [row.question?.text, row.reason, row.notification ? `Notification ${row.notification.status}${row.notification.reason ? ` · ${row.notification.reason}` : ''}` : '',
          row.usage ? `${row.usage.toolCalls} tool calls · ${row.usage.connectorReads} connector reads · ${row.usage.tokens ?? 'unreported'} tokens · ${row.usage.seconds} s` : ''].filter(Boolean).join(' · ') })),
      { placeHolder: rows.length ? 'Run history, newest first. Select a run to open its report.' : 'No runs yet.' });
      if (choice?.row.report) await vscode.window.showTextDocument(vscode.Uri.file(choice.row.report), { preview: false });
    } else if (action?.id === 'delete') {
      if (await vscode.window.showWarningMessage(`Delete scheduled report "${schedule.name}"?`, { modal: true, detail: 'Saved reports stay in the report list.' }, 'Delete') === 'Delete') {
        await entry.store.remove(schedule.id);
        if (schedule.background) await new BackgroundCredentials(entry.store, schedule).clear();
      }
    }
    await scheduleSummary();
  }

  async function createSchedule(folder, identity, entry) {
    if (!runSettings().model.trim()) return tell('Connect a model before creating a scheduled report.');
    const name = await vscode.window.showInputBox({ title: 'New scheduled report', prompt: 'Name', ignoreFocusOut: true,
      validateInput: text => !text.trim() || text.length > 80 ? 'Use 1 to 80 characters.' : undefined });
    if (!name) return;
    const prompt = await vscode.window.showInputBox({ title: 'Report request', ignoreFocusOut: true,
      prompt: 'What should the report cover? The run can read but cannot change anything.',
      validateInput: text => !text.trim() || text.length > 2_000 ? 'Use 1 to 2,000 characters.' : undefined });
    if (!prompt) return;
    const cadence = await vscode.window.showQuickPick([{ label: 'Every day', days: [0, 1, 2, 3, 4, 5, 6] },
      { label: 'Weekdays', days: [1, 2, 3, 4, 5] }, { label: 'Choose days…', choose: true }], { title: 'Report days', placeHolder: 'Days' });
    if (!cadence) return;
    let days = cadence.days;
    if (cadence.choose) {
      const picked = await vscode.window.showQuickPick(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
        .map((label, day) => ({ label, day })), { canPickMany: true, placeHolder: 'Days of the week in the schedule time zone' });
      if (!picked?.length) return;
      days = picked.map(item => item.day);
    }
    const times = await vscode.window.showInputBox({ title: 'Report times', value: '09:00', ignoreFocusOut: true,
      prompt: 'Times in 24-hour HH:MM, separated by commas. Up to four.',
      validateInput: text => /^\s*([01]\d|2[0-3]):[0-5]\d(\s*,\s*([01]\d|2[0-3]):[0-5]\d){0,3}\s*$/.test(text) ? undefined : 'Use HH:MM, for example 09:00, 17:30.' });
    if (!times) return;
    const timeZone = await vscode.window.showInputBox({ title: 'Report time zone', ignoreFocusOut: true,
      value: Intl.DateTimeFormat().resolvedOptions().timeZone, prompt: 'IANA time zone. Times follow this zone, including daylight-saving changes.',
      validateInput: text => { try { validateTimeZone(text.trim()); return undefined; } catch (error) { return error.message; } } });
    if (!timeZone) return;
    let connectors = [];
    const configs = connectorConfigs().filter(config => config.tools.length);
    if (configs.length) {
      const picked = await vscode.window.showQuickPick(configs.map(config => ({ label: config.id, config,
        description: `${config.account} · ${config.url}`, detail: config.tools.map(tool => `${tool.name}: ${tool.targets.join(', ')}`).join('; ') })),
      { canPickMany: true, title: 'Report connectors', placeHolder: 'Optional connector reads. Every listed target is approved in advance for this schedule.' });
      if (!picked) return;
      connectors = picked.map(item => item.config.id);
    }
    const size = await vscode.window.showQuickPick([
      { label: 'Standard', description: '5 min · 20 tool calls · 5 connector reads · 100,000 tokens', budget: { minutes: 5, toolCalls: 20, connectorReads: 5, maxTokens: DEFAULT_SCHEDULE_TOKENS }, catchUpMinutes: 360 },
      { label: 'Small', description: '2 min · 8 tool calls · 2 connector reads · 25,000 tokens', budget: { minutes: 2, toolCalls: 8, connectorReads: 2, maxTokens: 25_000 }, catchUpMinutes: 60 },
      { label: 'Large', description: '10 min · 40 tool calls · 10 connector reads · 250,000 tokens', budget: { minutes: 10, toolCalls: 40, connectorReads: 10, maxTokens: 250_000 }, catchUpMinutes: 1_440 },
      { label: 'Standard, never catch up', description: '100,000 tokens · missed runs are recorded only', budget: { minutes: 5, toolCalls: 20, connectorReads: 5, maxTokens: DEFAULT_SCHEDULE_TOKENS }, catchUpMinutes: 0 },
    ], { title: 'Report budget', placeHolder: 'Run budget and offline catch-up' });
    if (!size) return;
    const selectedContext = await chooseContext(identity, connectors);
    if (!selectedContext) return;
    const schedule = normalizeSchedule({ name: name.trim(), prompt: prompt.trim(), days, times: times.split(',').map(time => time.trim()),
      timeZone: timeZone.trim(), connectors, budget: size.budget, catchUpMinutes: size.catchUpMinutes, context: selectedContext });
    const scope = await scopeFor(identity, schedule);
    if (await vscode.window.showWarningMessage(`Approve scheduled report "${schedule.name}"?`, { modal: true,
      detail: approvalDetail(identity, schedule, scope) }, 'Approve schedule') !== 'Approve schedule') return;
    if ((await scopeFor(identity, schedule)).approval.digest !== scope.approval.digest) throw new Error('Settings changed during approval. Try again.');
    await entry.store.create(schedule, scope.approval);
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
    questions,
    refresh: refreshSchedulers,
    cancel,
    dispose,
    get runningName() { return scheduled?.schedule.name; },
  };
}

module.exports = { createScheduleController };

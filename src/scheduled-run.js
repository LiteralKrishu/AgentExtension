const { Draft } = require('./draft');
const { Retrieval } = require('./retrieval');
const { runForge, REPORT_INSTRUCTIONS } = require('./forge');
const { PermissionBroker } = require('./permissions');
const { ContextManifest, composePrompt } = require('./prompt');
const { ReadConnectors } = require('./connectors');
const { RunBudget, OFFLINE } = require('./schedules');
const { saveScheduledReport } = require('./reports');
const { RunUsage } = require('./usage');
const { WorkerPool } = require('./workers');

// Runs one unattended read-only report. The schedule approval is the only standing approval. It covers workspace
// reads and the inputs reviewed when the schedule was approved, within the run budget.
async function runScheduledReport({ schedule, occurrence, trigger, workspace, settings, policy, connectorConfigs = [], secrets, accounts,
  notes = [], inputs, verify, prepareRunSettings, storage, audit = () => {}, onStatus = () => {}, onCancel = () => {}, now = Date.now }) {
  const controller = new AbortController();
  onCancel(reason => controller.abort(new Error(reason ?? 'Scheduled report cancelled.')));
  const deadline = AbortSignal.timeout(schedule.budget.minutes * 60_000);
  const signal = AbortSignal.any([controller.signal, deadline]);
  const budget = new RunBudget(schedule.budget);
  const permissions = new PermissionBroker({ workspace: workspace.root, signal, audit, policy });
  permissions.allowScope('workspace.read');
  const selected = connectorConfigs.filter(config => config.tools.length && schedule.connectors.includes(config.id));
  if (selected.length !== schedule.connectors.length) throw new Error('A connector in this schedule is no longer configured. Review the schedule.');
  const retrieval = new Retrieval(signal);
  const started = now();
  let text = '';
  let question;
  let scopeChanged = false;
  const run = {
    readOnly: true, budget, workspace, signal, controller, permissions, maxTurns: schedule.budget.connectorReads + 3,
    usage: new RunUsage({ maxTokens: budget.limits.maxTokens }, now),
    search: (query, limit) => retrieval.query('search', query, limit),
    resetDraft() { this.draft = new Draft((file, create) => workspace.read(file, create)); this.permissions.reset(); },
    onTool: name => onStatus(`Scheduled report: ${name}`),
    deferQuestion: value => { question = value; },
  };
  if (verify) run.validateCapabilities = async () => {
    if (signal.aborted) signal.throwIfAborted();
    try {
      const scope = await verify();
      signal.throwIfAborted();
      if (scope?.policy) permissions.setPolicy(scope.policy);
    }
    catch (error) {
      scopeChanged = true;
      controller.abort(new Error(`${error.message} Review and approve the schedule again.`));
      signal.throwIfAborted();
    }
  };
  run.resetDraft();
  let status = 'completed';
  let reason = '';
  let session;
  try {
    await run.validateCapabilities?.();
    if (prepareRunSettings) settings = await prepareRunSettings(settings, signal, onStatus);
    if (selected.length && permissions.allowScope('connector.catalog')) {
      run.connectors = new ReadConnectors({ configs: selected, secrets, permissions, signal, accounts });
    }
    run.manifest = new ContextManifest(workspace.root);
    if (inputs) {
      run.instructions = inputs.instructions;
      const roles = inputs.roles.filter(() => permissions.allowScope('worker.research'));
      const customRoles = inputs.customRoles.length && permissions.allowScope('worker.custom') ? inputs.customRoles : [];
      if (customRoles.some(role => role.tools.length)) permissions.allowScope('worker.read');
      if (roles.length || customRoles.length) {
        const seconds = settings.workerTimeoutSeconds ?? 60;
        run.scheduledWorkers = true;
        run.workers = new WorkerPool({ run, roles, customRoles, timeoutMs: seconds * 1_000, settings: { ...settings, timeoutSeconds: seconds } });
      }
    }
    permissions.require(permissions.action('context_index', 'workspace.read', workspace.root));
    const index = await workspace.index(signal);
    const assembled = await retrieval.query('assemble', index, schedule.prompt);
    const scope = { schedule: schedule.name, occurrence: `${occurrence.slot} ${schedule.timeZone}`, trigger,
      connectors: run.connectors?.catalog() ?? [], budget: budget.limits,
      ...(inputs ? { skills: inputs.skills.map(skill => skill.name),
        workers: [...(run.workers?.roles ?? []), ...(run.workers?.custom.keys() ?? [])] } : {}) };
    const prompt = composePrompt({ request: schedule.prompt, assembled, memory: notes, manifest: run.manifest,
      instructions: run.instructions, skills: inputs?.skills,
      report: { instructions: REPORT_INSTRUCTIONS, scope } });
    permissions.require(permissions.action('context_send', 'workspace.read', workspace.root));
    await runForge(settings, run, prompt, {
      status: onStatus,
      session: link => { session = link; },
      token: delta => { text = (text + delta).slice(-40_000); },
      retry: message => { text = ''; onStatus(message); },
      plan: async () => false, review: async () => false, command: async () => false,
      // Standing approval: the target was already checked by ReadConnectors.prepare against the approved config.
      connector: async () => budget.canRead() && !signal.aborted,
    });
    await run.validateCapabilities?.();
    signal.throwIfAborted();
    if (question) status = 'needs-answer';
  } catch (error) {
    question = undefined;
    status = scopeChanged ? 'blocked' : deadline.aborted || run.tokenLimitReached ? 'failed' : signal.aborted ? 'cancelled' : 'failed';
    reason = deadline.aborted ? `Run-time budget of ${schedule.budget.minutes} minutes reached.` : signal.aborted
      ? String(signal.reason?.message ?? 'Cancelled.') : error.message;
    if (status === 'failed' && !deadline.aborted && OFFLINE.test(reason)) status = 'offline';
  } finally {
    permissions.revokeAll('Scheduled report ended');
    await run.workers?.close();
    retrieval.close();
  }
  const finished = now();
  const snapshot = run.usage.snapshot();
  const usage = { ...budget.used, tokens: snapshot.modelCalls ? snapshot.tokens.total : null, cost: snapshot.cost };
  const report = await saveScheduledReport(storage, workspace.root, permissions.runId, {
    schedule, occurrence, trigger, status, reason, text, session, usage, limits: budget.limits,
    compactions: snapshot.compactions, compactionSources: run.manifest?.compactionCounts(),
    permissions: permissions.snapshot(), connectors: selected, question, workers: run.workers?.reports ?? [], started, finished });
  return { status, reason, report, session, runId: permissions.runId, ...(question ? { question } : {}),
    usage: { ...usage, seconds: Math.round((finished - started) / 1000) } };
}

module.exports = { runScheduledReport };

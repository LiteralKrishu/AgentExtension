const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Draft } = require('./draft');
const { Workspace } = require('./workspace');
const { ContainerEnvironment } = require('./execution-environment');
const { PermissionBroker, digest } = require('./permissions');
const { PolicyEngine } = require('./policy');
const { runForge, localUrl, approve } = require('./forge');
const { FreshSearch } = require('./search');
const { RunUsage } = require('./usage');
const { RunBudget, Scheduler } = require('./schedules');
const { RunReport } = require('./reports');
const { normalizeCodingSchedule, codingFields } = require('./coding-schedules');
const { CheckpointStore } = require('./checkpoint');

const executionDigest = (profile, checks) => digest({ profile, checks, allowScripts: false });
function codingProfile(settings, policy) {
  localUrl(settings.serverUrl);
  if (settings.serverToken) throw new Error('Coding schedules require an existing local runtime without copied credentials.');
  return { model: settings.model, policy: digest([policy.digest, policy.admin.digest, policy.admin.userAllowRules]), connection: digest({ serverUrl: settings.serverUrl, compaction: settings.compaction, turnTimeoutSeconds: settings.turnTimeoutSeconds }) };
}
async function codingScope(store, schedule, signal) {
  const settings = schedule.approval.settings;
  if (!settings || settings.fallbackModel) throw new Error('Review the coding model connection again.');
  const { loadManagedPolicy } = require('./organization');
  const policy = new PolicyEngine({ admin: await loadManagedPolicy(store.workspace, { signal }),
    user: schedule.approval.userRules ?? [], workspace: schedule.approval.workspaceRules ?? [] });
  await store.current(schedule.id, codingProfile(settings, policy));
  const declarations = schedule.approval.checks ?? [];
  if (executionDigest(schedule.environment.profile, declarations) !== schedule.environment.declaration) throw new Error('The approved coding environment changed.');
  return { settings, policy, declarations };
}
async function assertSource(workspace, source, signal) {
  if (await workspace.gitRevision(signal) !== source.head || await workspace.sourceIdentity(signal) !== source.contents) {
    throw new Error('The coding draft requires its approved source base. Review and approve current source.');
  }
}
async function writeResult(store, id, artifact) {
  const directory = path.join(store.directory, 'inbox');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${id}.json`);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, JSON.stringify(artifact, null, 2), { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
  const results = [];
  for (const name of (await fs.readdir(directory)).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
    const full = path.join(directory, name); const stat = await fs.stat(full).catch(() => undefined);
    if (stat) results.push({ full, time: stat.mtimeMs });
  }
  for (const old of results.sort((a, b) => b.time - a.time).slice(50)) if (old.full !== file) await fs.rm(old.full, { force: true });
  return file;
}
async function runCodingDraft({ store, schedule, occurrence, trigger, signal: outer, onCancel = () => {}, onStatus = () => {},
  verify = () => codingScope(store, schedule, outer), invoke = runForge }) {
  schedule = { ...schedule, ...normalizeCodingSchedule(codingFields(schedule)) };
  const id = randomUUID(); const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, ...(outer ? [outer] : []), AbortSignal.timeout(schedule.budget.minutes * 60_000)]);
  onCancel(reason => controller.abort(new Error(reason ?? 'Coding schedule cancelled.')));
  const original = new Workspace(store.workspace, () => undefined); original.identity = store.workspace;
  let privateCopy; let run; let report; let question; let scopeChanged = false; let text = '';
  const artifact = { schemaVersion: 1, id, scheduleId: schedule.id, name: schedule.name, request: schedule.prompt,
    occurrence, trigger, source: schedule.source, files: schedule.files, status: 'failed', changes: [], checks: [], applied: false };
  const validate = async () => {
    signal.throwIfAborted();
    try { const scope = await verify(); signal.throwIfAborted(); return scope; }
    catch (error) { scopeChanged = true; controller.abort(error); throw error; }
  };
  // Check revocation while the model is thinking, even when no tools are dispatched.
  let checking = false;
  const timer = setInterval(() => {
    if (checking || signal.aborted) return;
    checking = true; void validate().catch(() => {}).finally(() => { checking = false; });
  }, 250); timer.unref?.();
  try {
    const scope = await validate();
    await assertSource(original, schedule.source, signal);
    privateCopy = await original.snapshot([], signal, { overlay: false });
    await assertSource(original, schedule.source, signal);
    const workspace = new Workspace(privateCopy.directory, () => undefined, async (_signal, limit) => [...privateCopy.sources.keys()].slice(0, limit));
    workspace.identity = privateCopy.directory;
    workspace.environment = new ContainerEnvironment({ profile: schedule.environment.profile, checks: scope.declarations, allowScripts: false });
    for (const check of schedule.checks) {
      const identity = await workspace.environment.authorizationIdentity(workspace.root, check.command, check.args, signal);
      if (identity.image !== schedule.environment.image) throw new Error('Coding environment image changed. Approve it again.');
    }
    const permissions = new PermissionBroker({ workspace: workspace.root, signal, policy: scope.policy });
    for (const effect of ['workspace.read', 'draft.edit']) permissions.allowScope(effect);
    const searcher = new FreshSearch(workspace, { overlay: () => new Map([...run.draft.files].map(([file, entry]) => [file, run.draft.current(file, entry.base)])) });
    run = { workspace, permissions, signal, controller, coding: schedule, taskRequest: schedule.prompt,
      usage: new RunUsage({ maxTokens: schedule.budget.maxTokens, maxToolCalls: schedule.budget.toolCalls, maxMinutes: schedule.budget.minutes }),
      budget: new RunBudget(schedule.budget), maxTurns: 12, checks: [],
      resetDraft() { this.draft = new Draft((file, create) => workspace.read(file, create)); this.permissions.reset(); },
      validateCapabilities: validate,
      searchDetailed: input => searcher.query(input, signal), search: async (query, limit) => (await searcher.query({ query, limit }, signal)).matches,
      searchModes: ['keywords', 'literal', 'word', 'path'], deferQuestion: value => { question = value; },
      onCheck: check => { run.checks.push(check); },
    };
    run.resetDraft();
    // Preserve a partial draft when the common runner clears its failed attempt.
    run.checkpoint = async () => { artifact.changes = run.draft.changes(run.draft.review()); };
    const sources = await Promise.all(schedule.files.map(async file => {
      const text = await workspace.read(file, true).catch(async () => workspace.read(file));
      return { file, text: text?.slice(0, 3000) ?? null, truncated: (text?.length ?? 0) > 3000 };
    }));
    const prompt = JSON.stringify({ mode: 'scheduled-coding-draft', request: schedule.prompt, permittedFiles: schedule.files,
      checks: schedule.checks, budget: schedule.budget, source: schedule.source, sources });
    await invoke(scope.settings, run, prompt, { status: onStatus, session: () => {}, token: delta => { text = (text + delta).slice(-8000); },
      retry: () => {}, command: async () => false, plan: async () => false, review: async () => false });
    await validate(); await assertSource(original, schedule.source, signal);
    artifact.changes = run.draft.changes(run.draft.review());
    if (artifact.changes.some(change => !schedule.files.includes(change.file))) throw new Error('Coding draft contains an unapproved path.');
    if (!question && artifact.changes.length) {
      const { executeCheck, actionFor } = require('./bridge');
      for (const input of schedule.checks) {
        await validate();
        if (!await approve({ name: 'run_command', args: input }, run, {})) throw new Error('A declared coding check is denied by policy.');
        const permit = permissions.require(actionFor(run, 'run_command', input));
        await executeCheck(run, input, signal, permit);
      }
    }
    const passing = schedule.checks.every(input => run.checks.some(check => digest({ command: check.command, args: check.args }) === digest(input)
      && check.revision === run.draft.revision && check.exitCode === 0 && check.verification !== false));
    await validate(); await assertSource(original, schedule.source, signal);
    artifact.status = question ? 'needs-input' : artifact.changes.length && passing ? 'ready-for-review' : 'failed';
    if (!question && artifact.status === 'failed') artifact.reason = artifact.changes.length ? 'Required checks did not pass on the final draft.' : 'No coding draft was produced.';
  } catch (error) {
    artifact.status = scopeChanged ? 'blocked' : signal.aborted ? 'cancelled' : 'failed';
    artifact.reason = signal.reason?.message ?? error.message;
  } finally {
    clearInterval(timer);
    if (run) {
      artifact.checks = run.checks.map(({ changes, ...check }) => ({ ...check, changesDigest: digest(changes ?? []) }));
      artifact.usage = run.usage.snapshot();
      run.permissions.revokeAll('Coding schedule ended');
      report = new RunReport(path.dirname(path.dirname(store.directory)), store.workspace, id);
      for (const check of run.checks) report.check(check);
    }
    if (privateCopy) await fs.rm(privateCopy.directory, { recursive: true, force: true });
  }
  if (question) artifact.question = question;
  artifact.summary = text;
  if (report) artifact.report = await report.save({ phase: artifact.status, revision: run.draft.revision, changes: artifact.changes,
    selection: '', permissions: run.permissions.snapshot(), usage: artifact.usage });
  artifact.digest = digest(artifact);
  const file = await writeResult(store, id, artifact);
  return { status: artifact.status, reason: artifact.reason ?? '', artifact: file, runId: id,
    ...(question ? { question } : {}), ...(artifact.report ? { report: artifact.report } : {}) };
}
function codingScheduler({ store, signal, ...options }) {
  return new Scheduler({ ...options, store, owns: () => true,
    pinFor: async schedule => { await codingScope(store, schedule, signal); return schedule.approval.digest; },
    execute: (schedule, occurrence, trigger, onCancel) => runCodingDraft({ store, schedule, occurrence, trigger, signal, onCancel }) });
}
async function readCodingResult(store, file) {
  const directory = path.join(store.directory, 'inbox');
  if (path.dirname(file) !== directory || !/^[a-f0-9-]{36}\.json$/.test(path.basename(file))) throw new Error('Invalid coding result path.');
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size > 32_000_000) throw new Error('Invalid coding result file.');
  const artifact = JSON.parse(await fs.readFile(file, 'utf8')); const { digest: expected, ...body } = artifact;
  if (artifact.schemaVersion !== 1 || digest(body) !== expected || !Array.isArray(artifact.changes) || artifact.changes.length > 8) throw new Error('Coding result failed verification.');
  return artifact;
}
async function importCodingResult(store, file, storage, workspace, answer) {
  const artifact = await readCodingResult(store, file); const signal = new AbortController().signal;
  if (!['ready-for-review', 'needs-input'].includes(artifact.status)) throw new Error('This coding result is not ready for import.');
  await assertSource(workspace, artifact.source, signal);
  for (const change of artifact.changes) {
    if (!artifact.files.includes(change.file) || await workspace.read(change.file, change.before === null) !== change.before) throw new Error('The coding draft source changed.');
  }
  const checkpoint = new CheckpointStore(storage, workspace.root);
  if(answer && (!artifact.question || typeof answer!=='string' || answer.length>2000))throw new Error('Invalid coding question answer.');
  const request=answer?`${artifact.request}\n\nQuestion: ${artifact.question.text}\nAnswer: ${answer}`:artifact.request;
  return checkpoint.save({ runId: artifact.id, revision: 0, planFirst: false, approvedPlan: null, request, files: artifact.changes.map(change => ({ file: change.file, base: change.before, text: change.after })),
    phase: 'interrupted', checks: [], reviewed: null, summary: artifact.summary,
    ...(artifact.question ? { codingQuestion: artifact.question } : {}) }, { exclusive: true });
}
module.exports = { runCodingDraft, codingScope, codingProfile, codingScheduler, executionDigest, readCodingResult, importCodingResult, assertSource };

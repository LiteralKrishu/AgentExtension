#!/usr/bin/env node
// Real-model checks for AgentExtension. Drives the extension in a stubbed VS Code host against a running TrueForge
// server and a real model, then writes results to test-results/. Model quality is reported, not assumed.
//
//   npm run test:qwen                       # all scenarios with local-lm-studio/qwen
//   npm run test:qwen -- --only question    # one scenario
//
// Environment: AGENTEXTENSION_TEST_FORGE_URL (default http://127.0.0.1:8790), AGENTEXTENSION_TEST_MODEL
// (default local-lm-studio/qwen), AGENTEXTENSION_TEST_MODEL_URL (default from trueforge/model.example.json),
// AGENTEXTENSION_TEST_MODEL_ID (default: the example's id when served, otherwise a served Qwen 9B),
// AGENTEXTENSION_TEST_RESULTS_DIR (default: test-results in the repository).
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const { startHost } = require('../helpers/host.cjs');
const { evaluateScenario, successful } = require('./evaluate.cjs');
const { verifyDraft } = require('./verify.cjs');
const { readCheckEvidence, dispatchAuthorization } = require('./evidence.cjs');
const { requireLocalEndpoint } = require('./local-only.cjs');
const { compactionOption, executionSettings } = require('./profile.cjs');

const ROOT = path.join(__dirname, '..', '..');
const FORGE = process.env.AGENTEXTENSION_TEST_FORGE_URL || 'http://127.0.0.1:8790';
const MODEL = process.env.AGENTEXTENSION_TEST_MODEL || 'local-lm-studio/qwen';
const SCENARIO_MINUTES = Number(process.env.AGENTEXTENSION_TEST_SCENARIO_MINUTES || 12);
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1]?.split(',') : undefined;
const useCorpus = process.argv.includes('--corpus');
const listedOnly = process.argv.includes('--list');
// --hosted-main is an explicit, user-authorized opt-in for a paid hosted main profile. Every other corpus run stays local.
const hostedMain = process.argv.includes('--hosted-main');
const localOnly = !hostedMain && (useCorpus || process.argv.includes('--local-only'));
const repetitions = process.argv.includes('--repetitions') ? Number(process.argv[process.argv.indexOf('--repetitions') + 1]) : useCorpus ? 3 : 1;
const compaction = compactionOption(process.argv);

const { scenarios, flaskScenario } = require('./scenarios.cjs');

async function implementationDigest() {
  const source = path.join(ROOT, 'src');
  const files = (await fs.readdir(source)).filter(name => name.endsWith('.js')).sort();
  const hash = createHash('sha256');
  for (const name of files) { hash.update(name + '\0'); hash.update(await fs.readFile(path.join(source,name))); hash.update('\0'); }
  for (const name of ['trueforge/agent.json','package.json']) { hash.update(name + '\0'); hash.update(await fs.readFile(path.join(ROOT,name))); }
  return hash.digest('hex');
}

async function evaluationDigest() {
  const directory=__dirname;
  const names=(await fs.readdir(directory)).filter(name=>name.endsWith('.cjs')||['corpus.json','flask-inputs.json'].includes(name)).sort();
  const hash=createHash('sha256');
  for(const name of names){hash.update(name+'\0');hash.update(await fs.readFile(path.join(directory,name)));hash.update('\0');}
  for(const name of ['queries.json','judgments.json','judgments.cjs','run.cjs','source.cjs','corpus.cjs',
    ...['queries.json','judgments.json','source.json','freeze.json','cancellation.test.js.txt'].map(name=>'corpora/v2/'+name)]){
    hash.update('../retrieval/'+name+'\0');hash.update(await fs.readFile(path.join(directory,'../retrieval',name)));hash.update('\0');
  }
  hash.update(await fs.readFile(path.join(directory,'../helpers/host.cjs')));
  return hash.digest('hex');
}

// Registers the hosted main provider in the local TrueForge. The key comes from the environment and is never recorded.
async function registerHostedMain(forge, provider, example) {
  const { AGENTEXTENSION_TEST_HOSTED_URL: baseUrl, AGENTEXTENSION_TEST_HOSTED_KEY: apiKey, AGENTEXTENSION_TEST_MODEL_ID: modelId } = process.env;
  const url = URL.canParse(baseUrl ?? '') ? new URL(baseUrl) : undefined;
  if (!url || url.protocol !== 'https:' || url.username || url.password || !apiKey || /[\r\n]/.test(apiKey) || !modelId)
    throw new Error('--hosted-main requires an HTTPS AGENTEXTENSION_TEST_HOSTED_URL, AGENTEXTENSION_TEST_HOSTED_KEY, and AGENTEXTENSION_TEST_MODEL_ID.');
  if (provider === example.name) throw new Error(`--hosted-main cannot reuse the local provider name ${example.name}.`);
  const models = [{ name: MODEL.split('/')[1], modelId, properties: example.models[0].properties }];
  await forge.settings.modelProviders.createOrUpdate({ manifest: { type: 'custom', name: provider,
    baseUrl: url.href.replace(/\/$/, ''), auth: { apiKey }, models } });
  return url.host;
}

async function preflight() {
  require('../../src/forge').localUrl(FORGE);
  const { TrueForge } = await import('@truefoundry/trueforge-sdk');
  const forge = new TrueForge({ baseUrl: FORGE, maxRetries: 0, timeoutInSeconds: 10 });
  try { await fetch(FORGE, { signal: AbortSignal.timeout(5_000) }); } catch {
    throw new Error(`TrueForge is not reachable at ${FORGE}. Start it as described in README.md.`);
  }
  const [provider] = MODEL.split('/');
  const example = JSON.parse(await fs.readFile(path.join(ROOT, 'trueforge', 'model.example.json'), 'utf8')).manifest;
  const hostedHost = hostedMain ? await registerHostedMain(forge, provider, example) : null;
  if (localOnly && provider !== example.name) {
    const listed = await forge.settings.modelProviders.list();
    const items = Array.isArray(listed) ? listed : listed?.data ?? listed?.items ?? [];
    const configured = items.find(item => (item.manifest?.name ?? item.name) === provider);
    requireLocalEndpoint((configured?.manifest ?? configured)?.baseUrl);
  }
  if (provider === example.name) {
    const baseUrl = process.env.AGENTEXTENSION_TEST_MODEL_URL || example.baseUrl;
    if (localOnly) requireLocalEndpoint(baseUrl);
    let served;
    try { served = (await (await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(5_000) })).json())?.data?.map(item => item.id) ?? []; } catch {
      throw new Error(`The model server is not reachable at ${baseUrl}. Start LM Studio's server and load the model.`);
    }
    // LM Studio names models by their download id. Use the example's id when it is served, otherwise a served Qwen 9B.
    const wanted = example.models[0].modelId;
    const modelId = process.env.AGENTEXTENSION_TEST_MODEL_ID
      || (served.includes(wanted) ? wanted : served.find(id => /qwen/i.test(id) && /9b/i.test(id)) ?? wanted);
    if (!served.includes(modelId)) console.log(`Warning: ${baseUrl} does not list ${modelId}. Served: ${served.join(', ') || 'none'}.`);
    // Registers the example provider if it is missing, or points it at the served model. Other settings are kept.
    const listed = await forge.settings.modelProviders.list().catch(() => undefined);
    const items = Array.isArray(listed) ? listed : listed?.data ?? listed?.items ?? [];
    const existing = items.find(item => (item.manifest?.name ?? item.name) === provider);
    const registered = (existing?.manifest ?? existing)?.models?.find(model => model.name === MODEL.split('/')[1]);
    if (listed && (!existing || registered?.modelId !== modelId || (existing.manifest ?? existing).baseUrl !== baseUrl)) {
      const models = example.models.map(model => ({ ...model, modelId }));
      await forge.settings.modelProviders.createOrUpdate({ manifest: { ...example, baseUrl, models } });
      console.log(`Registered TrueForge provider ${provider} at ${baseUrl} with model ${modelId}.`);
    }
  }
  const { data: models } = await forge.models.list();
  const configured = models.find(model => model.name === MODEL);
  return { model: MODEL, modelId: configured?.modelId, properties: configured?.properties ?? {},
    compaction, turnTimeoutSeconds: 600, workerTimeoutSeconds: 180,
    fallbackModel: '', temperature: null, determinism: 'Provider defaults; temperature was not exposed by this setup.', localOnly, hostedHost };
}

async function runScenario(scenario) {
  const started = Date.now();
  const root = scenario.workspace ?? await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `agentextension-model-${scenario.name}-`)));
  const cleanups = [];
  const t = { after: fn => cleanups.push(fn) };
  const result = { name: scenario.name, purpose: scenario.purpose, model: MODEL, hunks: [], draft: {}, checks: [], questions: [], suggestions: [],
    workers: [], manifest: [], log: [], text: '', errors: [], changes: [], unapprovedActions: scenario.scheduled ? 0 : null, approvals: 0, interactionMs: 0,
    taskVersion: scenario.version ?? 1, fixtureDigest: scenario.fixtureDigest, sourceRevision: scenario.sourceRevision,
    split: scenario.split, language: scenario.language, budget: scenario.budget };
  result.implementationDigest = await implementationDigest();
  result.evaluationDigest = await evaluationDigest();
  result.environment = { editorAppRoot: process.env.AGENTEXTENSION_TEST_EDITOR_APP_ROOT ?? null,
    searchExecutable: await require('../../src/search').searchExecutable(process.env.AGENTEXTENSION_TEST_EDITOR_APP_ROOT) ?? null };
  try {
    for (const [file, text] of Object.entries(scenario.files)) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), text);
    }
    if (scenario.scheduled) return await scheduledScenario(scenario, root, result, started);
    const settings = { serverUrl: FORGE, model: MODEL, fallbackModel: '', compaction, turnTimeoutSeconds: 600, workerTimeoutSeconds: 180, readConnectors: [],
      skillRoots: [], pluginRoots: [], browserOrigins: [], automaticSkills: false, ...scenario.settings,
      ...(scenario.budget ? {runBudget: {maxTokens: scenario.budget.maxTokens,maxMinutes: scenario.budget.minutes,maxToolCalls: scenario.budget.maxToolCalls}} : {}) };
    result.executionSettings = executionSettings(settings);
    const host = await startHost(t, { root, settings });
    host.autoAnswer = async (kind, title, items) => {
      if (kind === 'modal') {
        result.approvals++;
        return items.find(item => ['Run command', 'Allow read', 'Allow action', 'Enable plugin', 'Approve instructions', 'Save note'].includes(item));
      }
      return undefined;
    };
    if (scenario.plugins) {
      host.answers.push({ kind: 'pick', value: items => items.filter(item => scenario.plugins.includes(item.label)) });
      await host.send({ type: 'plugins' });
      await host.waitFor(state => scenario.plugins.every(id => state.plugins?.some(plugin => plugin.id === id)), 15_000, 'plugins');
    }
    if (scenario.approveInstructions) {
      host.answers.push({ kind: 'pick', value: items => items.find(item => item.id === 'approve') });
      await host.send({ type: 'instructions' });
      await host.waitFor(state => /In use: .*AGENTS\.md/.test(state.instructionSummary ?? ''), 15_000, 'instructions approved');
    }
    const first = host.states.length;
    result.submittedAt = Date.now();
    await host.send({ type: 'run', prompt: scenario.prompt });
    const minutes = scenario.budget?.minutes ?? SCENARIO_MINUTES;
    const deadline = result.submittedAt + minutes * 60_000;
    let handled = '';
    let sawActive = false;
    let lastPollAt = result.submittedAt;
    result.maxPollGapMs = 0;
    while (Date.now() < deadline) {
      await sleep(500);
      const polledAt = Date.now();
      result.maxPollGapMs = Math.max(result.maxPollGapMs, polledAt - lastPollAt);
      lastPollAt = polledAt;
      if (polledAt >= deadline) break;
      const state = host.state();
      // A fast run can start and finish between polls, so check every state published since the request.
      sawActive ||= host.states.slice(first).some(item => item.runActive);
      if (state.hunks?.length && result.firstReviewPatchMs === undefined) result.firstReviewPatchMs = Date.now() - result.submittedAt;
      if (Number.isFinite(state.progress?.firstDraftMs)) result.firstPatchMs = Math.max(0,state.progress.startedAt + state.progress.firstDraftMs - result.submittedAt);
      const interactionAt = Date.now();
      if (state.phase === 'review' && handled !== `review:${state.revision}:${state.reviewSequence ?? 0}`) {
        handled = `review:${state.revision}:${state.reviewSequence ?? 0}`;
        result.reviewed = true;
        result.hunks = state.hunks;
        for (const hunk of state.hunks) await host.send({ type: 'decision', id: hunk.id, value: 'accept' });
        await host.send({ type: 'continue' });
      } else if (state.phase === 'question' && handled !== `question:${state.question?.index}`) {
        handled = `question:${state.question.index}`;
        result.questions.push(state.question);
        await host.send({ type: 'answer', ...(scenario.answer ? scenario.answer(state.question) : { option: 0, text: '' }) });
      } else if (state.phase === 'plan' && handled !== 'plan') {
        handled = 'plan';
        await host.send({ type: 'approve-plan' });
      } else if (sawActive && state.runActive === false) break;
      if (['review', 'question', 'plan'].includes(state.phase)) result.interactionMs += Date.now() - interactionAt;
    }
    let state = host.state();
    result.modelRunMs = Date.now() - result.submittedAt;
    result.deadlineOverrunMs = Math.max(0,result.modelRunMs-minutes*60000);
    if (state.runActive) {
      result.timedOut = true; result.errors.push(`Timed out after ${minutes} minutes.`);
      // Save partial diagnostic work before the harness's user-style cancel discards it.
      result.interruptedCheckpoint = await new (require('../../src/checkpoint').CheckpointStore)(host.storage,root).load();
      await host.send({ type: 'cancel' });
    }
    if (state.runActive) state = await host.waitFor(value => !value.runActive, 15000, 'terminal run cleanup');
    Object.assign(result, { revision: state.revision, phase: state.phase, status: state.status, text: state.text ?? '', checks: state.checks ?? [], workers: state.workers ?? [],
      manifest: (state.manifest ?? []).map(({ kind, source, trust, reason }) => ({ kind, source, trust, reason })), log: state.log ?? [],
      usage: state.usageDetail, permissions: (state.permissions?.events ?? []).map(({ tool, effect, decision, reason }) => ({ tool, effect, decision, reason })) });
    result.authorizationEvidence = dispatchAuthorization(host.states,result.usage?.toolCalls);
    result.unapprovedActions = result.authorizationEvidence.unapprovedActions;
    if (!result.hunks.length && state.hunks?.length) result.hunks = state.hunks;
    // The draft as staged, from the run report written by the extension.
    await host.sendAndWait({ type: 'run-report' });
    const reportFile = host.shown.documents.at(-1);
    if (reportFile) {
      try {
        const changes = JSON.parse(await fs.readFile(path.join(path.dirname(reportFile), 'draft.json'), 'utf8'));
        result.changes = changes;
        for (const change of changes) result.draft[change.file] = change.after;
        result.checks = await readCheckEvidence(path.dirname(reportFile), result.checks);
        try {
          result.progress = JSON.parse(await fs.readFile(path.join(path.dirname(reportFile), 'progress.json'), 'utf8'));
          if (Number.isFinite(result.progress.firstDraftMs)) result.firstPatchMs = Math.max(0,result.progress.startedAt + result.progress.firstDraftMs - result.submittedAt);
        }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      } catch (error) { result.errors.push('Could not read final draft evidence: ' + error.message); }
    }
    const { SuggestedNotes } = require('../../src/memory');
    result.suggestions = new SuggestedNotes(host.context.globalState, root).list();
    if (scenario.audit) result.audit = await new (require('../../src/audit').AuditLog)(host.storage, root).export();
    if (state.checkpoint) {
      result.checkpoint = await new (require('../../src/checkpoint').CheckpointStore)(host.storage, root).load();
    }
    if (state.phase === 'ready' && !scenario.kind) {
      const verificationAt = Date.now();
      result.verification = await verifyDraft({ source: root, changes: result.changes, allowedFiles: scenario.allowedFiles,
        acceptance: scenario.acceptance, acceptanceInputs: scenario.acceptanceInputs });
      result.verificationMs = Date.now() - verificationAt;
    }
    if (state.phase === 'ready') await host.send({ type: 'cancel' });
    result.errors.push(...host.shown.errors);
  } catch (error) {
    result.errors.push(error.stack ?? error.message);
  } finally {
    for (const fn of cleanups.reverse()) await Promise.resolve(fn()).catch(() => {});
    if (!scenario.workspace) await fs.rm(root, { recursive: true, force: true });
  }
  return finish(scenario, result, started);
}

async function scheduledScenario(scenario, root, result, started) {
  const { runScheduledReport } = require('../../src/scheduled-run');
  const { Workspace } = require('../../src/workspace');
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-model-storage-'));
  try {
    const workspace = new Workspace(root, () => undefined, async () => Object.keys(scenario.files));
    workspace.identity = root;
    const schedule = { id: 'model-check', name: 'Model check', prompt: scenario.scheduled, days: [0, 1, 2, 3, 4, 5, 6], times: ['09:00'],
      timeZone: 'UTC', connectors: [], budget: { minutes: 10, toolCalls: 20, connectorReads: 0 }, catchUpMinutes: 60, approval: { digest: 'x', at: 0 } };
    const settings = { serverUrl: FORGE, model: MODEL, fallbackModel: '', compaction, turnTimeoutSeconds: 600, workerTimeoutSeconds: 180 };
    result.executionSettings = executionSettings(settings);
    const run = await runScheduledReport({ schedule, occurrence: { at: Date.now(), slot: 'manual' }, trigger: 'manual', workspace,
      settings, storage });
    const report = await fs.readFile(run.report, 'utf8');
    Object.assign(result, { phase: run.status, status: run.status, reason: run.reason, usage: run.usage,
      text: report.split('## Report')[1]?.split('## Permission decisions')[0] ?? '' });
  } catch (error) { result.errors.push(error.stack ?? error.message); }
  finally { await fs.rm(storage, { recursive: true, force: true }); }
  return finish(scenario, result, started);
}

function finish(scenario, result, started) {
  if (Number.isFinite(result.submittedAt)) {
    result.wallMs = Date.now() - result.submittedAt;
    result.activeMs = Math.max(0,result.wallMs-(result.progress?.waitingMs??result.interactionMs??0));
  }
  result.seconds = Math.round((Date.now() - started) / 1000);
  result.reason ??= result.usage?.reached;
  Object.assign(result, evaluateScenario(scenario, result));
  console.log(`${result.outcome.padEnd(14)} ${scenario.name} (${result.seconds} s)`);
  if (result.reason) console.log('  reason: ' + result.reason);
  for (const item of result.results) console.log(`  ${item.ok ? 'ok  ' : 'MISS'} ${item.required ? '*' : ' '} ${item.name}`);
  for (const error of result.errors) console.log(`  error: ${String(error).split('\n')[0]}`);
  return result;
}

async function main() {
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 3) throw new Error('Use one to three repetitions.');
  const loaded = useCorpus ? await require('./corpus.cjs').loadCorpus() : undefined;
  const candidates = loaded?.tasks ?? [...scenarios];
  if (!useCorpus && only?.includes('flask-task-b')) candidates.push(await flaskScenario());
  const selected = candidates.filter(item => !only || only.includes(item.name));
  if (!selected.length || only?.some(name => !selected.some(item => item.name === name))) throw new Error('Unknown real-model scenario.');
  if (listedOnly) {
    console.log(JSON.stringify({ version: loaded?.version ?? 'legacy-strict/1', policy: loaded?.policy,
      repetitions, executionSettings: executionSettings({ compaction }), tasks: selected.map(({name,split,language,fixtureDigest,sourceRevision,budget,unavailable}) =>
        ({name,split,language,fixtureDigest,sourceRevision,budget,unavailable})) }, null, 2));
    return;
  }
  let unavailable; let modelConfiguration;
  try { modelConfiguration = await preflight(); } catch (error) { unavailable = error.message; }
  console.log(`AgentExtension real-model checks · ${MODEL} via ${FORGE}\n`);
  const results = [];
  const directory = process.env.AGENTEXTENSION_TEST_RESULTS_DIR ?? path.join(ROOT, 'test-results');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (let repetition = 1; repetition <= repetitions; repetition++) for (const scenario of selected) {
    const reason = unavailable ?? scenario.unavailable;
    if (reason) {
      results.push(finish(scenario, { name: scenario.name, purpose: scenario.purpose, model: MODEL, environmentUnavailable: true,
        reason, repetition, split: scenario.split, language: scenario.language, phase: 'unavailable', hunks: [], changes: [], draft: {}, checks: [], questions: [], suggestions: [],
        workers: [], manifest: [], log: [], text: '', errors: [], unapprovedActions: 0 }, Date.now()));
    } else results.push({ ...await runScenario(scenario), repetition });
    // Keep completed attempts if a later attempt or the harness is interrupted.
    const attemptFile = path.join(directory, `attempt-${stamp}-${String(results.length).padStart(3, '0')}.json`);
    await fs.writeFile(attemptFile + '.tmp', JSON.stringify({ corpusVersion: loaded?.version ?? 'legacy-strict/1', model: MODEL,
      modelConfiguration, plannedAttempts: selected.length * repetitions, completedAttempts: results.length,
      hardware: {arch: os.arch(),cpu: os.cpus()[0]?.model,memoryBytes: os.totalmem()}, node: process.version,
      result: results.at(-1) }, null, 2), { mode: 0o600 });
    await fs.rename(attemptFile + '.tmp', attemptFile);
  }
  const summary = { corpusVersion: loaded?.version ?? 'legacy-strict/1', policy: loaded?.policy, repetitions,
    hardware: {arch: os.arch(),cpu: os.cpus()[0]?.model,memoryBytes: os.totalmem()},
    runtime: {server: require('../../trueforge/server/package.json').dependencies['@truefoundry/trueforge'],sdk: require('../../package.json').dependencies['@truefoundry/trueforge-sdk']},
    model: MODEL, modelId: modelConfiguration?.modelId ?? process.env.AGENTEXTENSION_TEST_MODEL_ID, modelConfiguration,
    forge: FORGE, node: process.version, platform: `${process.platform} ${os.release()}`, startedAt: stamp, results };
  await fs.writeFile(path.join(directory, `model-${stamp}.json`), JSON.stringify(summary, null, 2), {mode:0o600});
  const lines = [`# Real-model check: ${MODEL}`, '', `Run ${stamp} · ${process.platform} · Node.js ${process.version}`, '',
    '| Scenario | Outcome | Seconds | Tokens | Missed checks |', '| --- | --- | --- | --- | --- |',
    ...results.map(item => `| ${item.name} | ${item.outcome} | ${item.seconds} | ${item.usage?.tokens?.total ?? '—'} | ${item.results.filter(check => !check.ok).map(check => `${check.required ? '*' : ''}${check.name}`).join('; ') || '—'} |`),
    '', 'Only complete outcomes pass. A patch must be reviewed, applied in a disposable copy, and independently checked. Full evidence is in the JSON file next to this one.', ''];
  await fs.writeFile(path.join(directory, 'model-latest.md'), lines.join('\n'), {mode:0o600});
  await fs.writeFile(path.join(directory, 'model-latest.json'), JSON.stringify(summary, null, 2), {mode:0o600});
  console.log(`\nResults in ${directory}: model-latest.md and model-${stamp}.json`);
  process.exitCode = successful(results) ? 0 : 1;
  // TrueForge client streams can keep the event loop open after the last scenario.
  setTimeout(() => process.exit(), 1_000).unref();
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exit(2); });
module.exports = { runScenario, preflight, implementationDigest, evaluationDigest, registerHostedMain };

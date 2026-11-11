#!/usr/bin/env node
// Real-model checks for AgentExtension. Drives the extension in a stubbed VS Code host against a running TrueForge
// server and a real model, then writes results to test-results/. Model quality is reported, not assumed.
//
//   npm run test:qwen                       # all scenarios with local-lm-studio/qwen
//   npm run test:qwen -- --only question    # one scenario
//
// Environment: AGENTEXTENSION_TEST_FORGE_URL (default http://127.0.0.1:8790), AGENTEXTENSION_TEST_MODEL
// (default local-lm-studio/qwen), AGENTEXTENSION_TEST_MODEL_URL (default from trueforge/model.example.json),
// AGENTEXTENSION_TEST_MODEL_ID (default: the example's id when served, otherwise a served Qwen 9B).
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { startHost } = require('../helpers/host.cjs');

const ROOT = path.join(__dirname, '..', '..');
const FORGE = process.env.AGENTEXTENSION_TEST_FORGE_URL || 'http://127.0.0.1:8790';
const MODEL = process.env.AGENTEXTENSION_TEST_MODEL || 'local-lm-studio/qwen';
const SCENARIO_MINUTES = Number(process.env.AGENTEXTENSION_TEST_SCENARIO_MINUTES || 12);
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1].split(',') : undefined;

const calc = 'exports.add = (a, b) => a - b;\nexports.sub = (a, b) => a - b;\n';
const calcTest = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { add, sub } = require('./calc.js');\n\ntest('add', () => assert.equal(add(1, 2), 3));\ntest('sub', () => assert.equal(sub(5, 2), 3));\n";
const staged = (result, file) => result.hunks.filter(hunk => hunk.file === file);

const scenarios = [
  {
    name: 'edit-and-check',
    purpose: 'Stage a focused fix, run the test through the command approval, and submit for review.',
    files: { 'calc.js': calc, 'calc.test.js': calcTest },
    prompt: 'The add function in calc.js returns the wrong result. Fix it, run `node --test calc.test.js` to check the fix, then submit the change for review.',
    evaluate: r => [
      { name: 'Staged a change to calc.js', required: true, ok: staged(r, 'calc.js').length > 0 },
      { name: 'The staged add uses +', required: true, ok: /a \+ b/.test(r.draft['calc.js'] ?? '') },
      { name: 'Requested hunk review', required: true, ok: r.reviewed },
      { name: 'Ran a check through the approval', ok: r.checks.length > 0 },
      { name: 'The last check passed', ok: r.checks.at(-1)?.exitCode === 0 },
      { name: 'Left sub unchanged', ok: /sub = \(a, b\) => a - b/.test(r.draft['calc.js'] ?? calc) },
    ],
  },
  {
    name: 'question',
    purpose: 'Ask a structured question before an ambiguous edit, then act on the answer.',
    files: { 'config/dev.json': '{\n  "logLevel": "info"\n}\n', 'config/prod.json': '{\n  "logLevel": "warn"\n}\n' },
    prompt: 'Set the log level to "debug" in the config file. There are two config files. Ask me which one to change before you edit anything, then submit the change for review.',
    answer: question => {
      const index = question.options.findIndex(option => /dev/i.test(option));
      return index >= 0 ? { option: index, text: '' } : { text: 'config/dev.json' };
    },
    evaluate: r => [
      { name: 'Asked a question', required: true, ok: r.questions.length > 0 },
      { name: 'Changed config/dev.json', required: true, ok: /"debug"/.test(r.draft['config/dev.json'] ?? '') },
      { name: 'Left config/prod.json alone', required: true, ok: !r.draft['config/prod.json'] },
    ],
  },
  {
    name: 'suggest-note',
    purpose: 'Suggest a workspace note with a source reference instead of editing files.',
    files: { 'package.json': '{\n  "name": "demo",\n  "scripts": {\n    "test": "node --test"\n  }\n}\n' },
    prompt: 'Read package.json and suggest a workspace note that records how to run this project\'s tests. Cite package.json as the source. Do not change any files.',
    evaluate: r => [
      { name: 'Suggested a note', required: true, ok: r.suggestions.length > 0 },
      { name: 'The note mentions the test command', ok: r.suggestions.some(item => /node --test|npm test/.test(item.text)) },
      { name: 'Cited package.json', ok: r.suggestions.some(item => item.references.some(ref => ref.file === 'package.json')) },
      { name: 'Staged no edits', required: true, ok: r.hunks.length === 0 },
    ],
  },
  {
    name: 'instructions',
    purpose: 'Follow an approved workspace profile and a path rule delivered with a matching file.',
    files: { 'calc.js': calc.replace('a - b;\nexports.sub', 'a + b;\nexports.sub'),
      'AGENTS.md': 'Keep changes small. End every summary with the line "Checked by AgentExtension."\n',
      '.agentextension/rules/js.md': '---\npaths: ["**/*.js"]\n---\nEvery exported function you add needs a JSDoc comment that starts with /** and describes its parameters.\n' },
    approveInstructions: true,
    prompt: 'Add an exported function mul(a, b) to calc.js that multiplies two numbers, then submit the change for review.',
    evaluate: r => [
      { name: 'Added mul', required: true, ok: /mul/.test(r.draft['calc.js'] ?? '') },
      { name: 'Path rule delivered', required: true, ok: r.manifest.some(entry => entry.kind === 'path rule') },
      { name: 'Followed the path rule (JSDoc)', ok: /\/\*\*[\s\S]*mul/.test(r.draft['calc.js'] ?? '') },
      { name: 'Followed the workspace profile', ok: /Checked by AgentExtension/.test(r.text) },
    ],
  },
  {
    name: 'fix-team-workers',
    purpose: 'Use the diagnosis and edit-proposal workers, merge the proposal, and recheck.',
    files: { 'calc.js': calc, 'calc.test.js': calcTest },
    plugins: ['fix-team'],
    prompt: 'calc.test.js fails. Run `node --test calc.test.js`. Then call diagnose_failure to find the cause, call propose_worker_edits for calc.js, check the proposed hunks, and merge them with merge_worker_edits. Rerun the test and submit the change for review.',
    evaluate: r => [
      { name: 'Called diagnose_failure', ok: r.workers.some(worker => worker.role === 'test-diagnosis') },
      { name: 'Diagnosis completed', ok: r.workers.some(worker => worker.role === 'test-diagnosis' && worker.state === 'completed') },
      { name: 'Worker proposal merged', ok: r.workers.some(worker => worker.role === 'edit-proposal' && worker.state === 'merged') },
      { name: 'Staged add uses +', required: true, ok: /a \+ b/.test(r.draft['calc.js'] ?? '') },
      { name: 'The last check passed', ok: r.checks.at(-1)?.exitCode === 0 },
    ],
  },
  {
    name: 'budget-and-audit',
    purpose: 'Stop tool calls at the run budget, finish cleanly, and export a verified audit log.',
    files: Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`notes/n${index + 1}.md`, `Note ${index + 1}: item ${index * 7}.\n`])),
    settings: { runBudget: { maxTokens: 400_000, maxMinutes: 15, maxToolCalls: 3 } },
    prompt: 'Read each file in the notes folder one at a time with read_file and summarize each one. Do not change any files.',
    audit: true,
    evaluate: r => [
      { name: 'Run ended without an error', required: true, ok: ['done', 'ready'].includes(r.phase) },
      { name: 'Tool-call limit reached', required: true, ok: /tool-call limit/.test(r.usage?.reached ?? '') },
      { name: 'Tokens reported by the model server', ok: (r.usage?.tokens.total ?? 0) > 0 },
      { name: 'Audit export verified', required: true, ok: r.audit?.verification.ok === true },
    ],
  },
  {
    name: 'scheduled-report',
    purpose: 'Run an unattended read-only report and produce cited findings.',
    files: { 'src/a.js': '// TODO: handle empty input\nexports.a = x => x;\n', 'src/b.js': 'exports.b = 1;\n// TODO remove legacy flag\n', 'README.md': 'Demo.\n' },
    scheduled: 'List every TODO comment in the workspace with its file and line number.',
    evaluate: r => [
      { name: 'Report completed', required: true, ok: r.status === 'completed' },
      { name: 'Report names src/a.js', ok: /a\.js/.test(r.text) },
      { name: 'Report names src/b.js', ok: /b\.js/.test(r.text) },
      { name: 'No write-tool requests', required: true, ok: r.usage.writesRequested === 0 },
    ],
  },
];

async function preflight() {
  const { TrueForge } = await import('@truefoundry/trueforge-sdk');
  const forge = new TrueForge({ baseUrl: FORGE, maxRetries: 0, timeoutInSeconds: 10 });
  try { await fetch(FORGE, { signal: AbortSignal.timeout(5_000) }); } catch {
    throw new Error(`TrueForge is not reachable at ${FORGE}. Start it as described in README.md.`);
  }
  const [provider] = MODEL.split('/');
  const example = JSON.parse(await fs.readFile(path.join(ROOT, 'trueforge', 'model.example.json'), 'utf8')).manifest;
  if (provider === example.name) {
    const baseUrl = process.env.AGENTEXTENSION_TEST_MODEL_URL || example.baseUrl;
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
}

async function runScenario(scenario) {
  const started = Date.now();
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `agentextension-model-${scenario.name}-`)));
  const cleanups = [];
  const t = { after: fn => cleanups.push(fn) };
  const result = { name: scenario.name, purpose: scenario.purpose, model: MODEL, hunks: [], draft: {}, checks: [], questions: [], suggestions: [],
    workers: [], manifest: [], log: [], text: '', errors: [] };
  try {
    for (const [file, text] of Object.entries(scenario.files)) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), text);
    }
    if (scenario.scheduled) return await scheduledScenario(scenario, root, result, started);
    const settings = { serverUrl: FORGE, model: MODEL, fallbackModel: '', compaction: false, turnTimeoutSeconds: 600, workerTimeoutSeconds: 180, readConnectors: [],
      skillRoots: [], pluginRoots: [], browserOrigins: [], automaticSkills: false, ...scenario.settings };
    const host = await startHost(t, { root, settings });
    host.autoAnswer = async (kind, title, items) => {
      if (kind === 'modal') return items.find(item => ['Run command', 'Allow read', 'Allow action', 'Enable plugin', 'Approve instructions', 'Save note'].includes(item)) ?? items[0];
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
    await host.send({ type: 'run', prompt: scenario.prompt });
    const deadline = Date.now() + SCENARIO_MINUTES * 60_000;
    let handled = '';
    let sawActive = false;
    while (Date.now() < deadline) {
      await sleep(500);
      const state = host.state();
      // A fast run can start and finish between polls, so check every state published since the request.
      sawActive ||= host.states.slice(first).some(item => item.runActive);
      if (state.phase === 'review' && handled !== `review:${state.revision}`) {
        handled = `review:${state.revision}`;
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
    }
    const state = host.state();
    if (state.runActive) { result.errors.push(`Timed out after ${SCENARIO_MINUTES} minutes.`); await host.send({ type: 'cancel' }); }
    Object.assign(result, { phase: state.phase, status: state.status, text: state.text ?? '', checks: state.checks ?? [], workers: state.workers ?? [],
      manifest: (state.manifest ?? []).map(({ kind, source, trust, reason }) => ({ kind, source, trust, reason })), log: state.log ?? [],
      usage: state.usageDetail, permissions: (state.permissions?.events ?? []).map(({ tool, effect, decision, reason }) => ({ tool, effect, decision, reason })) });
    if (!result.hunks.length && state.hunks?.length) result.hunks = state.hunks;
    // The draft as staged, from the run report written by the extension.
    await host.send({ type: 'run-report' });
    const reportFile = host.shown.documents.at(-1);
    if (reportFile) {
      try {
        const changes = JSON.parse(await fs.readFile(path.join(path.dirname(reportFile), 'draft.json'), 'utf8'));
        for (const change of changes) result.draft[change.file] = change.after;
      } catch { /* No draft. */ }
    }
    const { SuggestedNotes } = require('../../src/memory');
    result.suggestions = new SuggestedNotes(host.context.globalState, root).list();
    if (scenario.audit) result.audit = await new (require('../../src/audit').AuditLog)(host.storage, root).export();
    if (state.phase === 'ready') await host.send({ type: 'cancel' });
    result.errors.push(...host.shown.errors);
  } catch (error) {
    result.errors.push(error.stack ?? error.message);
  } finally {
    for (const fn of cleanups.reverse()) await Promise.resolve(fn()).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
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
    const run = await runScheduledReport({ schedule, occurrence: { at: Date.now(), slot: 'manual' }, trigger: 'manual', workspace,
      settings: { serverUrl: FORGE, model: MODEL, fallbackModel: '', compaction: false, turnTimeoutSeconds: 600 }, storage });
    const report = await fs.readFile(run.report, 'utf8');
    Object.assign(result, { phase: run.status, status: run.status, reason: run.reason, usage: run.usage,
      text: report.split('## Report')[1]?.split('## Permission decisions')[0] ?? '' });
  } catch (error) { result.errors.push(error.stack ?? error.message); }
  finally { await fs.rm(storage, { recursive: true, force: true }); }
  return finish(scenario, result, started);
}

function finish(scenario, result, started) {
  result.seconds = Math.round((Date.now() - started) / 1000);
  try { result.results = scenario.evaluate(result); } catch (error) { result.results = []; result.errors.push(error.message); }
  const required = result.results.filter(item => item.required);
  result.outcome = result.errors.length && !result.results.length ? 'error'
    : required.every(item => item.ok) ? (result.results.every(item => item.ok) ? 'pass' : 'pass with gaps') : 'fail';
  console.log(`${result.outcome.padEnd(14)} ${scenario.name} (${result.seconds} s)`);
  for (const item of result.results) console.log(`  ${item.ok ? 'ok  ' : 'MISS'} ${item.required ? '*' : ' '} ${item.name}`);
  for (const error of result.errors) console.log(`  error: ${String(error).split('\n')[0]}`);
  return result;
}

async function main() {
  await preflight();
  console.log(`AgentExtension real-model checks · ${MODEL} via ${FORGE}\n`);
  const results = [];
  for (const scenario of scenarios.filter(item => !only || only.includes(item.name))) results.push(await runScenario(scenario));
  const directory = path.join(ROOT, 'test-results');
  await fs.mkdir(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const summary = { model: MODEL, forge: FORGE, node: process.version, platform: `${process.platform} ${os.release()}`, startedAt: stamp, results };
  await fs.writeFile(path.join(directory, `model-${stamp}.json`), JSON.stringify(summary, null, 2));
  const lines = [`# Real-model check: ${MODEL}`, '', `Run ${stamp} · ${process.platform} · Node.js ${process.version}`, '',
    '| Scenario | Outcome | Seconds | Tokens | Missed checks |', '| --- | --- | --- | --- | --- |',
    ...results.map(item => `| ${item.name} | ${item.outcome} | ${item.seconds} | ${item.usage?.tokens?.total ?? '—'} | ${item.results.filter(check => !check.ok).map(check => `${check.required ? '*' : ''}${check.name}`).join('; ') || '—'} |`),
    '', '`*` marks a required check. Full transcripts are in the JSON file next to this one.', ''];
  await fs.writeFile(path.join(directory, 'model-latest.md'), lines.join('\n'));
  await fs.writeFile(path.join(directory, 'model-latest.json'), JSON.stringify(summary, null, 2));
  console.log(`\nResults: test-results/model-latest.md and test-results/model-${stamp}.json`);
  process.exitCode = results.every(item => item.outcome.startsWith('pass')) ? 0 : 1;
  // TrueForge client streams can keep the event loop open after the last scenario.
  setTimeout(() => process.exit(), 1_000).unref();
}

main().catch(error => { console.error(error.message); process.exit(2); });

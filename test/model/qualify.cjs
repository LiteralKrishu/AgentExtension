const fs = require('node:fs/promises');
const path = require('node:path');
const { loadCorpus } = require('./corpus.cjs');
const FROZEN_RETRIEVAL_LABELS = require('../retrieval/queries.json');
const { validateJudgments } = require('../retrieval/judgments.cjs');
const { evaluateScenario } = require('./evaluate.cjs');
const { digest } = require('../../src/permissions');
const { executionSettings } = require('./profile.cjs');

const THRESHOLDS = Object.freeze({ complete: 51, heldOutComplete: 20, flaskComplete: 3,
  recallAt10: .90, heldOutRecallAt10: .85, exactSuccessRate: .95 });

// Qualification consumes host evidence, including failed and unavailable attempts.
// It cannot turn a smoke run, an empty batch, or mixed profiles into a qualified model.
function qualify({ batch, tasks, retrieval, corpusVersion, profile, retrievalLabels = FROZEN_RETRIEVAL_LABELS, judgmentDataset }) {
  const issues = [];
  const add = (condition, issue) => { if (!condition) issues.push(issue); };
  add(batch?.corpusVersion === corpusVersion && retrieval?.version === retrievalLabels.version, 'corpus-version-mismatch');
  add(typeof batch?.model === 'string' && batch.model.length && batch.model === profile?.model,
    'declared-model-profile-required');
  add(typeof batch?.modelId === 'string' && batch.modelId === profile?.modelId, 'declared-model-id-required');
  // A local profile must show zero spend; a hosted main profile must be declared and report its measured spend.
  add((profile?.localOnly === true && profile?.apiSpend === 0) ||
    (profile?.localOnly === false && profile?.hostedMain === true && Number.isFinite(profile?.apiSpend) && profile.apiSpend >= 0),
    'declared-model-cost-profile-required');
  const judgmentAudit = Array.isArray(judgmentDataset?.files) && typeof judgmentDataset?.revision === 'string'
    ? validateJudgments({ ...judgmentDataset, labels: retrievalLabels })
    : { valid: false, readyForRevisedCorpus: false, issues: ['Raw review, pinned source files, and source revision are required.'] };
  add(judgmentAudit.valid, 'verified-retrieval-judgments-required');
  if (judgmentAudit.valid) {
    add(judgmentAudit.readyForRevisedCorpus, 'retrieval-label-review-pending');
    add(retrieval?.sourceRevision === judgmentDataset.revision, 'judgment-retrieval-source-mismatch');
    add(retrieval?.inputDigest === judgmentDataset.review.inputDigest, 'judgment-retrieval-input-mismatch');
    if (retrievalLabels.sourceVersion) add(retrieval?.sourceVersion === judgmentDataset.sourceVersion, 'judgment-retrieval-source-version-mismatch');
  }
  add(typeof profile?.contextLength === 'number' && profile.contextLength >= 1024 &&
    typeof profile?.toolCompatibility === 'string' && typeof profile?.cancellation === 'string' &&
    typeof profile?.compaction === 'string' && typeof profile?.timeoutSeconds === 'number', 'observed-profile-details-required');
  const settings = batch?.modelConfiguration;
  add(typeof settings?.compaction === 'boolean' && Number.isFinite(settings?.turnTimeoutSeconds) &&
    Number.isFinite(settings?.workerTimeoutSeconds) && typeof settings?.fallbackModel === 'string' &&
    digest(profile?.executionSettings ?? null) === digest(executionSettings(settings ?? {})),
    'declared-execution-settings-required');
  const results = Array.isArray(batch?.results) ? batch.results : [];
  const known = new Map(tasks.map(task => [task.name, task]));
  const attempts = new Map();
  for (const result of results) {
    const task = known.get(result.name);
    if (!task || ![1,2,3].includes(result.repetition) || result.model !== batch.model) { issues.push('unknown-or-mixed-attempt'); continue; }
    const key = `${result.name}:${result.repetition}`;
    if (attempts.has(key)) { issues.push('duplicate-attempt'); continue; }
    attempts.set(key, result);
    add(digest(result.executionSettings ?? null) === digest(executionSettings(settings ?? {})), 'mixed-or-missing-execution-settings');
    add(result.taskVersion === task.version && result.fixtureDigest === task.fixtureDigest &&
      result.sourceRevision === task.sourceRevision, 'task-input-version-mismatch');
    add(digest(result.budget ?? null) === digest(task.budget ?? null) && result.split === task.split, 'task-contract-mismatch');
    if (result.outcome === 'complete') {
      add(evaluateScenario(task, result).outcome === 'complete',
      'complete-result-missing-host-evidence');
      add(Number.isFinite(result.usage?.tokens?.total) && result.usage.tokens.total >= 0 && result.usage.tokens.total <= task.budget.maxTokens &&
        Number.isInteger(result.usage?.toolCalls) && result.usage.toolCalls >= 0 && result.usage.toolCalls <= task.budget.maxToolCalls &&
        Number.isFinite(result.wallMs) && result.wallMs >= 0 && result.wallMs <= task.budget.minutes * 60000,
      'complete-result-missing-budget-evidence');
    }
  }
  add(tasks.length === 20 && attempts.size === 60 && batch?.repetitions === 3, 'full-20-task-three-repetition-batch-required');
  const accepted = [...attempts.values()].filter(result => result.outcome === 'complete');
  const implementations = new Set([...attempts.values()].map(result => result.implementationDigest));
  add(implementations.size === 1 && [...implementations].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)),
    'one-recorded-implementation-required');
  const evaluators=new Set([...attempts.values()].map(result=>result.evaluationDigest));
  add(evaluators.size===1&&[...evaluators].every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)),
    'one-recorded-evaluator-required');
  if (retrievalLabels.sourceVersion) {
    add(implementations.size === 1 && implementations.has(retrieval?.implementationDigest), 'retrieval-implementation-mismatch');
    add(evaluators.size === 1 && evaluators.has(retrieval?.evaluationDigest), 'retrieval-evaluator-mismatch');
  }
  const heldOut = accepted.filter(result => known.get(result.name).split === 'held-out');
  const flask = accepted.filter(result => result.name === 'flask-task-b');
  add(accepted.length >= THRESHOLDS.complete, 'complete-task-target-missed');
  add(heldOut.length >= THRESHOLDS.heldOutComplete, 'held-out-task-target-missed');
  add(flask.length === THRESHOLDS.flaskComplete, 'all-three-flask-attempts-must-pass');
  const queries = Array.isArray(retrieval?.results) ? retrieval.results : [];
  const queryMap = new Map(queries.map(row => [row.id, row]));
  add(queries.length === retrievalLabels.queries.length && queryMap.size === retrievalLabels.queries.length &&
    retrievalLabels.queries.every(query => queryMap.has(query.id)), 'full-frozen-retrieval-set-required');
  const scoredQueries = retrievalLabels.queries.map(query => {
    const hits = [...new Set(queryMap.get(query.id)?.hits ?? [])].slice(0,10);
    const expected = [...new Set(Object.values(query.expected).flat())];
    return { split: query.split, kind: query.kind, recall: expected.filter(file => hits.includes(file)).length / expected.length,
      exact: query.expected.implementation.some(file => hits.includes(file)) };
  });
  const average = rows => rows.reduce((sum,row) => sum + row.recall,0) / Math.max(1,rows.length);
  const recallAt10 = average(scoredQueries);
  const heldOutRecallAt10 = average(scoredQueries.filter(row => row.split === 'held-out'));
  const exactQueries = scoredQueries.filter(row => row.kind === 'identifier');
  const exactSuccessRate = exactQueries.filter(row => row.exact).length / Math.max(1,exactQueries.length);
  add(typeof retrieval?.sourceRevision === 'string' && retrieval.sourceRevision.startsWith(retrievalLabels.sourceRevision), 'retrieval-source-revision-mismatch');
  add(recallAt10 >= THRESHOLDS.recallAt10, 'retrieval-recall-target-missed');
  add(heldOutRecallAt10 >= THRESHOLDS.heldOutRecallAt10, 'held-out-retrieval-target-missed');
  add(exactSuccessRate >= THRESHOLDS.exactSuccessRate, 'exact-retrieval-target-missed');
  return { qualified: issues.length === 0, thresholds: THRESHOLDS, judgmentAudit, observed: { attempts: attempts.size,
    complete: accepted.length, heldOutComplete: heldOut.length, flaskComplete: flask.length,
    recallAt10, heldOutRecallAt10, exactSuccessRate },
    issues: [...new Set(issues)] };
}

async function main() {
  const args = process.argv.slice(2);
  const option = args.indexOf('--retrieval-corpus');
  const retrievalVersion = option < 0 ? '2' : args[option + 1];
  if (option >= 0) args.splice(option, 2);
  const [batchFile, retrievalFile, profileFile, outputFile] = args;
  if (args.length > 4) throw new Error('Provide three input files and an optional output file.');
  if (!batchFile || !retrievalFile || !profileFile) throw new Error('Provide batch, retrieval, and observed-profile JSON files.');
  const { tasks, version } = await loadCorpus();
  const [batch, retrieval, profile] = await Promise.all([batchFile,retrievalFile,profileFile].map(async file => JSON.parse(await fs.readFile(file,'utf8'))));
  const judgmentDataset = await require('../retrieval/corpus.cjs').loadRetrievalCorpus(retrievalVersion);
  const result = qualify({ batch, tasks, retrieval, profile, corpusVersion: version,
    retrievalLabels: judgmentDataset.labels, judgmentDataset });
  if (outputFile) { await fs.mkdir(path.dirname(outputFile), { recursive: true }); await fs.writeFile(outputFile, JSON.stringify(result,null,2)); }
  console.log(JSON.stringify(result,null,2));
  process.exitCode = result.qualified ? 0 : 1;
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 2; });
module.exports = { qualify, THRESHOLDS };

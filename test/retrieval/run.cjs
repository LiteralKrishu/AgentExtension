const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { rank, assemble } = require('../../src/context');
const { digest } = require('../../src/permissions');
const labels = require('./queries.json');
const { gitSnapshot } = require('./source.cjs');
const root = path.join(__dirname, '../..');

async function snapshot() {
  return gitSnapshot(labels.sourceRevision);
}

function evaluateQueries(files, queries = labels.queries, options) {
  return queries.map(query => {
    const started = performance.now();
    const hits = [...new Set(rank(files, query.query, options).map(hit => hit.file))].slice(0, 10);
    const packed = assemble(files, query.query, undefined, [], options);
    const expected = [...new Set(Object.values(query.expected).flat())];
    const found = expected.filter(file => hits.includes(file));
    return { id: query.id, split: query.split, kind: query.kind, hits, expected, found,
      recall: found.length / expected.length, exactSuccess: query.kind === 'identifier' ? query.expected.implementation.some(file => hits.includes(file)) : null,
      packedCoverage: Object.fromEntries(Object.entries(query.expected).map(([kind, paths]) =>
        [kind, paths.some(file => packed.selected.some(hit => hit.file === file))])),
      packedCharacters: packed.used, durationMs: performance.now() - started };
  });
}

async function main() {
  const args = process.argv.slice(2);
  const value = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
  const corpus = await require('./corpus.cjs').loadRetrievalCorpus(value('--corpus', '2'));
  const split = value('--split', 'development');
  if (!['development', 'held-out', 'all'].includes(split)) throw new Error('Choose development, held-out, or all.');
  if (split !== 'development' && !args.includes('--evaluate-held-out')) throw new Error('Held-out evaluation needs --evaluate-held-out. Freeze the candidate first.');
  const { revision, files, sourceVersion, labels: corpusLabels } = corpus;
  const queries = corpusLabels.queries.filter(query => split === 'all' || query.split === split);
  const results = evaluateQueries(files, queries);
  const average = rows => rows.reduce((sum, row) => sum + row.recall, 0) / rows.length;
  const exact = results.filter(row => row.kind === 'identifier');
  const { implementationDigest, evaluationDigest } = require('../model/run.cjs');
  const report = { version: corpusLabels.version, sourceRevision: revision, sourceVersion, inputDigest: digest(files), split,
    heldOutEvaluated: split !== 'development', recordedAt: new Date().toISOString(),
    implementationDigest: await implementationDigest(), evaluationDigest: await evaluationDigest(),
    files: files.length, sourceCharacters: files.reduce((sum, file) => sum + file.text.length, 0),
    recallAt10: average(results), heldOutRecallAt10: results.some(row => row.split === 'held-out') ? average(results.filter(row => row.split === 'held-out')) : null,
    exactSuccessRate: exact.length ? exact.filter(row => row.exactSuccess).length / exact.length : null, results };
  const directory = process.env.AGENTEXTENSION_TEST_RESULTS_DIR ?? path.join(root, 'test-results');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'retrieval-latest.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, results: undefined }, null, 2));
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { snapshot, evaluateQueries };

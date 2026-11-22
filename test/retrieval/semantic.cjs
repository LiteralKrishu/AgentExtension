const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { EmbeddingProvider, VectorCache, similarity } = require('../../src/embedding-provider');
const { rank } = require('../../src/context');
const { digest } = require('../../src/permissions');
const { snapshot } = require('./run.cjs');
const labels = require('./queries.json');

function packCandidates(hits, files, budget = 12000) {
  const selected = []; let used = 0;
  for (const name of hits.slice(0,10)) {
    const file = files.find(item => item.path === name);
    if (!file) continue;
    const cost = JSON.stringify({ file: name, start: 1, text: file.text.slice(0,2300) }).length + 1;
    if (used + cost > budget) continue;
    used += cost; selected.push(name);
  }
  return { selected, characters: used };
}

async function main() {
  // Environment setup is explicit. No endpoint or model is selected on the user's behalf here.
  const provider = new EmbeddingProvider({ endpoint: process.env.AGENTEXTENSION_EMBEDDING_URL, model: process.env.AGENTEXTENSION_EMBEDDING_MODEL });
  const { revision, files } = await snapshot();
  const scope = digest([revision, files.map(({ path, text }) => [path, digest(text)])]);
  const directory = process.env.AGENTEXTENSION_TEST_RESULTS_DIR ?? path.join(__dirname, '../../test-results/semantic');
  await fs.mkdir(directory, { recursive: true });
  const excerpts = files.map(file => 'search_document: ' + file.path + '\n' + file.text.slice(0, 5000));
  const started = performance.now();
  const [probe] = await provider.embed([excerpts[0]]);
  const namespace = { schema: 1, endpoint: provider.endpoint, model: provider.model, dimension: provider.dimension, scope };
  const cache = new VectorCache(path.join(directory, 'vectors.json'), namespace);
  const keys = excerpts.map(text => provider.key(text, scope));
  const vectors = await cache.load(keys);
  vectors.set(keys[0], probe);
  for (let i = 0; i < excerpts.length; i += 8) {
    const missing = excerpts.slice(i, i + 8).map((text, n) => ({ text, key: keys[i + n] })).filter(item => !vectors.has(item.key));
    if (!missing.length) continue;
    const batch = await provider.embed(missing.map(item => item.text));
    missing.forEach((item, n) => vectors.set(item.key, batch[n]));
  }
  await cache.replace(vectors);
  const preparationMs = performance.now() - started;
  const rows = [];
  for (const query of labels.queries) {
    const started = performance.now();
    const [vector] = await provider.embed(['search_query: ' + query.query]);
    const semantic = files.map((file, i) => ({ file: file.path, score: similarity(vector, vectors.get(keys[i])) })).sort((a,b) => b.score - a.score).map(item => item.file);
    const lexical = [...new Set(rank(files, query.query, { relationships: false }).map(item => item.file))];
    const relationships = [...new Set(rank(files, query.query, { relationships: true }).map(item => item.file))];
    const scores = new Map();
    for (const list of [lexical, semantic]) list.forEach((file, i) => scores.set(file, (scores.get(file) ?? 0) + 1 / (61 + i)));
    // Preserve an exact file/symbol result before fusion. No label enters candidate selection.
    const first = rank(files, query.query, { relationships: false })[0];
    const pinned = first?.priority ? [first.file] : [];
    const hybrid = [...new Set([...pinned, ...[...scores].sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([file]) => file)])];
    const expected = [...new Set(Object.values(query.expected).flat())];
    const results = Object.fromEntries(Object.entries({ lexical, relationships, hybrid }).map(([kind, hits]) => {
      const packed = packCandidates(hits, files);
      return [kind, {
      hits: hits.slice(0,10), recall: expected.filter(file => hits.slice(0,10).includes(file)).length / expected.length,
      categoryCoverage: Object.fromEntries(Object.entries(query.expected).map(([category, paths]) => [category, paths.some(file => hits.slice(0,10).includes(file))])),
      packedFiles: packed.selected, packedCharacters: packed.characters,
      packedCoverage: Object.fromEntries(Object.entries(query.expected).map(([category, paths]) => [category, paths.some(file => packed.selected.includes(file))])) }];
    }));
    rows.push({ id: query.id, split: query.split, kind: query.kind, durationMs: performance.now() - started, results });
  }
  const summarize = split => Object.fromEntries(['lexical', 'relationships', 'hybrid'].map(kind => {
    const selected = rows.filter(row => !split || row.split === split);
    return [kind, selected.reduce((sum,row) => sum + row.results[kind].recall, 0) / selected.length];
  }));
  const development = summarize('development'); const heldOut = summarize('held-out');
  const retain = development.hybrid > development.lexical && heldOut.hybrid > heldOut.lexical;
  const report = { version: 1, recordedAt: new Date().toISOString(), inputDigest: digest(files), scope, namespace,
    corpus: labels.version, files: files.length, excerptLimit: 5000, contextBudget: 12000, fusion: 'file RRF k=60 with exact-result pinning',
    preparationMs, requests: provider.requests, embeddedCharacters: provider.characters,
    cacheBytes: (await fs.stat(cache.file)).size, memory: process.memoryUsage(), apiSpend: 0,
    development, heldOut, overall: summarize(), decision: retain ? 'research-only; completion non-regression remains unverified' : 'reject this embedding configuration',
    enabledByDefault: false, limitation: 'One bounded leading excerpt per file. These are file-candidate ablations, not completed coding tasks. Frozen held-out labels are now exposed for subsequent changes.', rows };
  await fs.writeFile(path.join(directory, 'semantic-latest.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, rows: undefined }, null, 2));
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { packCandidates };

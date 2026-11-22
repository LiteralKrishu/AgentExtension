const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const { Workspace } = require('../../src/workspace');
const { RepositoryIndex } = require('../../src/repository-index');
const { FreshSearch } = require('../../src/search');
const { assemble } = require('../../src/context');

async function main() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-scale-source-')));
  const storage = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-scale-cache-')));
  try {
    const names = Array.from({ length: 20000 }, (_, n) => `source-${String(n).padStart(5, '0')}.js`);
    const body = '// ordinary source context\n'.repeat(400).slice(0, 9950);
    for (let offset = 0; offset < names.length; offset += 100) await Promise.all(names.slice(offset, offset + 100).map((file, i) => fs.writeFile(path.join(root, file), `const needle${offset + i} = ${offset + i};\n${body}\n`)));
    const workspace = new Workspace(root, () => undefined, async (_signal, limit) => names.slice(0, limit));
    workspace.gitRevision = async () => 'synthetic-v1';
    const signal = new AbortController().signal;
    let firstUsableMs;
    const coldStarted = performance.now();
    const index = new RepositoryIndex(workspace, storage, { onStatus: status => { if (status.indexed && firstUsableMs === undefined) firstUsableMs = performance.now() - coldStarted; } });
    const cold = await index.snapshot(signal);
    const coldMs = performance.now() - coldStarted;
    const warmStarted = performance.now();
    const warm = await index.snapshot(signal);
    const warmMs = performance.now() - warmStarted;
    await fs.appendFile(path.join(root, names[19999]), '\n// saved change\n');
    const changeStarted = performance.now();
    const changed = await index.snapshot(signal);
    const savedChangeMs = performance.now() - changeStarted;
    const rankStarted = performance.now();
    assemble(changed.files, 'Find needle19999');
    const rankColdMs = performance.now() - rankStarted;
    const rankedMs = [];
    for (let i = 0; i < 20; i++) {
      const started = performance.now();
      assemble(changed.files, i % 2 ? 'Find ordinary source context' : `Find needle${[19999, 42, 10000, 6789][i % 4]}`);
      rankedMs.push(performance.now() - started);
    }
    const exact = new FreshSearch(workspace, { executable: process.env.AGENTEXTENSION_TEST_RG, timeoutMs: 5000 });
    const timings = [];
    const queries = [];
    for (const value of Array.from({ length: 20 }, (_, i) => [19999, 12001, 6789, 42, 10000][i % 5])) {
      const started = performance.now();
      const result = await exact.query({ query: `needle${value}`, mode: 'word' }, signal);
      timings.push(performance.now() - started);
      queries.push({ value, found: result.matches.some(hit => hit.file === names[value]), coverage: result.coverage });
    }
    const result = { version: 1, recordedAt: new Date().toISOString(), node: process.version, platform: process.platform,
      hardware: { cpu: os.cpus()[0]?.model, cores: os.cpus().length, memory: os.totalmem() }, fixture: { files: names.length, approximateBytes: 200000000 },
      firstIndexedBatchMs: firstUsableMs, coldMs, warmMs, savedChangeMs, cold: cold.coverage, warm: warm.coverage, changed: changed.coverage,
      rankColdMs, rankedMs, rankedP95Ms: [...rankedMs].sort((a,b) => a-b)[18],
      exactMs: timings, exactP95Ms: [...timings].sort((a, b) => a - b)[Math.ceil(timings.length * .95) - 1], queries,
      memory: process.memoryUsage(), filesystem: await fs.statfs(root), note: 'First indexed batch is observable progress; the editor prompt currently waits for snapshot return. Twenty queries are an initial sample. Warm ranked retrieval is measured separately.' };
    const output = process.env.AGENTEXTENSION_TEST_RESULTS_DIR ?? path.join(__dirname, '../../test-results');
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, 'retrieval-scale-latest.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });

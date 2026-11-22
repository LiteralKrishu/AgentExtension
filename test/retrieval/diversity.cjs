const fs = require('node:fs/promises');
const path = require('node:path');
const { snapshot } = require('./run.cjs');
const { rank } = require('../../src/context');
const labels = require('./queries.json');

// Development-only experiment. It does not change runtime ranking or use held-out labels.
function diversify(ranked, slots) {
  const pinned = ranked.filter(item => item.priority > 0).map(item => item.file);
  const lists = ['implementation','test','documentation'].map(kind => [...new Set(ranked.filter(item => item.category === kind).map(item => item.file))]);
  return [...new Set([...pinned, ...lists.flatMap((list,index) => list.slice(0,slots[index]))])].slice(0,10);
}
async function main() {
  const { files, revision } = await snapshot();
  const queries = labels.queries.filter(query => query.split === 'development');
  const ranked = queries.map(query => ({ query, ranked: rank(files, query.query) }));
  const results = [[4,3,3],[5,3,2],[5,2,3],[3,4,3],[3,3,4]].map(slots => {
    const rows = ranked.map(({ query, ranked }) => {
      const hits = diversify(ranked, slots);
      const expected = [...new Set(Object.values(query.expected).flat())];
      return { id: query.id, hits, recall: expected.filter(file => hits.includes(file)).length / expected.length,
        exact: query.kind === 'identifier' ? query.expected.implementation.some(file => hits.includes(file)) : null };
    });
    const exact = rows.filter(row => row.exact !== null);
    return { slots, recallAt10: rows.reduce((sum,row) => sum + row.recall,0) / rows.length,
      exactFound: exact.filter(row => row.exact).length, exactCount: exact.length, rows };
  });
  const report = { version:1, corpus:labels.version, sourceRevision:revision, split:'development', queries:queries.length,
    enabledInRuntime:false, decision:'Research only. No variant reaches the overall quality target on development data.', results };
  const directory = process.env.AGENTEXTENSION_TEST_RESULTS_DIR ?? path.join(__dirname,'../../test-results/diversity');
  await fs.mkdir(directory,{recursive:true}); await fs.writeFile(path.join(directory,'diversity-latest.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({...report,results:results.map(({rows,...rest})=>rest)},null,2));
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={diversify};

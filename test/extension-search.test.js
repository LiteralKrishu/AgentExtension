const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { startHost, scriptedModel } = require('./helpers/host.cjs');
const baseUrl = process.env.AGENTEXTENSION_TEST_FORGE_URL;

test('editor search observes external edits and the current staged draft', {
  skip: !baseUrl && 'Set AGENTEXTENSION_TEST_FORGE_URL to a local TrueForge instance.', timeout: 120000,
}, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-editor-search-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.txt'), 'old_value\n');
  const model = await scriptedModel(t, baseUrl, async ({ round, results, call, say }) => {
    const last = results.at(-1)?.content ?? '';
    if (round === 0) { await fs.writeFile(path.join(root, 'a.txt'), 'new_value\n'); return call('search_workspace', { query: 'new_value', mode: 'literal' }); }
    if (round === 1) { assert.match(last, /new_value/); assert.match(last, /contentDigest/); return call('propose_write', { file: 'a.txt', old_text: 'new_value', new_text: 'staged_value' }); }
    if (round === 2) return call('search_workspace', { query: 'staged_value', mode: 'literal' });
    if (round === 3) { assert.match(last, /staged_value/); return call('review_changes', {}); }
    return say('Staged text found and submitted for review.');
  });
  const host = await startHost(t, { root, settings: { serverUrl: baseUrl, model: model.model, fallbackModel: '', turnTimeoutSeconds: 60,
    automaticSkills: false, skillRoots: [], pluginRoots: [], readConnectors: [], browserOrigins: [] } });
  await host.send({ type: 'run', prompt: 'Inspect current source and stage its rename for review.' });
  const review = await host.waitFor(state => state.phase === 'review', 90000, 'search draft review');
  assert.equal(review.hunks.length, 1);
  assert.ifError(model.state.error);
  await host.send({ type: 'cancel' });
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'new_value\n');
});

test('explicit relationship lookup returns source-checked test and documentation hints', {
  skip: !baseUrl && 'Set AGENTEXTENSION_TEST_FORGE_URL to a local TrueForge instance.', timeout: 120000,
}, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-related-search-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'math.js'), 'exports.add = (a,b) => a+b;\n');
  await fs.writeFile(path.join(root, 'math.test.js'), "const {add} = require('./math');\n");
  await fs.writeFile(path.join(root, 'guide.md'), '[Math](math.js)\n');
  const model = await scriptedModel(t, baseUrl, async ({ round, results, call, say }) => {
    if (round === 0) return call('search_workspace', { query: 'math.js', mode: 'related', glob: '*.test.js', limit: 1 });
    const result = JSON.parse(results.at(-1).content);
    assert.equal(result.matches.length, 1); assert.equal(result.matches[0].file, 'math.test.js');
    assert.equal(result.matches[0].provenance, 'inferred-syntax');
    assert.equal(result.coverage.complete, false);
    return say('The relevant test is math.test.js.');
  });
  const host = await startHost(t, { root, settings: { serverUrl: baseUrl, model: model.model, fallbackModel: '', turnTimeoutSeconds: 60,
    automaticSkills: false, skillRoots: [], pluginRoots: [], readConnectors: [], browserOrigins: [] } });
  await host.send({ type: 'run', prompt: 'Find the test for math.js. Do not edit.' });
  await host.waitFor(state => state.phase === 'done' && !state.runActive, 90000, 'related hints');
  assert.ifError(model.state.error);
});

test('a batched source read supplies current receipts through the real runtime',{
 skip:!baseUrl&&'Set AGENTEXTENSION_TEST_FORGE_URL to a local TrueForge instance.',timeout:90000,
},async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'agentextension-editor-batch-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(path.join(root,'a.txt'),'one\ntwo\n');await fs.writeFile(path.join(root,'b.txt'),'reference\n');
 let receipt;
 const model=await scriptedModel(t,baseUrl,async({round,results,call,say})=>{
  if(round===0)return call('read_files',{files:[{file:'a.txt',start_line:2,end_line:2},{file:'b.txt'}]});
  if(round===1){const value=JSON.parse(results.at(-1).content);assert.equal(value.coverage.returned,2);assert.equal(value.excerpts[1].text,'reference\n');receipt=value.excerpts[0].receipt;return call('propose_lines',{receipt,start_line:2,delete_count:1,new_text:'TWO\n'});}
  if(round===2)return call('review_changes',{});
  return say('The small draft is ready for the user to apply.');
 });
 const host=await startHost(t,{root,settings:{serverUrl:baseUrl,model:model.model,fallbackModel:'',turnTimeoutSeconds:60,
  automaticSkills:false,skillRoots:[],pluginRoots:[],readConnectors:[],browserOrigins:[]}});
 await host.send({type:'run',prompt:'Read both files and uppercase two in a.txt.'});
 const review=await host.waitFor(s=>s.phase==='review',30000,'batch draft');
 await host.send({type:'decision',id:review.hunks[0].id,value:'accept'});await host.send({type:'continue'});
 const done=await host.waitFor(s=>!s.runActive&&s.phase==='ready',30000,'batch completion');
 assert.equal(done.usageDetail.toolCalls,3);
 const evidence=require('./model/evidence.cjs').dispatchAuthorization(host.states,done.usageDetail.toolCalls);
 assert.equal(evidence.complete,true);assert.equal(evidence.unapprovedActions,0);assert.ifError(model.state.error);
 assert.equal(await fs.readFile(path.join(root,'a.txt'),'utf8'),'one\ntwo\n');await host.send({type:'cancel'});
});

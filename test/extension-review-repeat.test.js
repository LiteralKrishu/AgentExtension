const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { startHost, scriptedModel } = require('./helpers/host.cjs');
const baseUrl = process.env.AGENTEXTENSION_TEST_FORGE_URL;

test('repeated review retains the accepted subset without another dialog or source write', {
  skip: !baseUrl && 'Set AGENTEXTENSION_TEST_FORGE_URL to a local TrueForge instance.', timeout: 90000,
}, async t => {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'agentextension-review-repeat-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const base='first\nmiddle\nlast\n'; await fs.writeFile(path.join(root,'a.txt'),base);
  const model=await scriptedModel(t,baseUrl,async({round,call,say,results})=>{
    if(round===0)return call('propose_write',{file:'a.txt',old_text:'first',new_text:'FIRST'});
    if(round===1)return call('propose_write',{file:'a.txt',old_text:'last',new_text:'LAST'});
    if(round===2||round===3)return call('review_changes',{});
    const result=JSON.parse(results.at(-1).content);
    assert.equal(result.already_reviewed,true);assert.equal(result.accepted_hunks,1);assert.equal(result.rejected_hunks,1);
    return say('The accepted subset is ready.');
  });
  const host=await startHost(t,{root,settings:{serverUrl:baseUrl,model:model.model,fallbackModel:'',turnTimeoutSeconds:60,
    automaticSkills:false,skillRoots:[],pluginRoots:[],readConnectors:[],browserOrigins:[]}});
  await host.send({type:'run',prompt:'Stage both uppercase changes for review.'});
  const review=await host.waitFor(state=>state.phase==='review',30000,'first review');
  assert.equal(review.hunks.length,2);
  for(const [index,hunk]of review.hunks.entries())await host.send({type:'decision',id:hunk.id,value:index===0?'accept':'reject'});
  await host.send({type:'continue'});
  const ready=await host.waitFor(state=>state.phase==='ready'&&!state.runActive,30000,'repeat review completion');
  assert.equal(ready.reviewSequence,1);
  assert.equal(Object.values(ready.decisions).filter(value=>value==='accept').length,1);
  assert.equal(Object.values(ready.decisions).filter(value=>value==='reject').length,1);
  await host.sendAndWait({type:'run-report'});
  const report=host.shown.documents.at(-1);
  const changes=JSON.parse(await fs.readFile(path.join(path.dirname(report),'draft.json'),'utf8'));
  assert.equal(changes[0].after,'FIRST\nmiddle\nlast\n');
  assert.equal(await fs.readFile(path.join(root,'a.txt'),'utf8'),base);assert.ifError(model.state.error);
  await host.send({type:'cancel'});
});

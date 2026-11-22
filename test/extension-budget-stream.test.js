const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const project=path.resolve(__dirname,'..');
const {startHost,scriptedModel}=require(path.join(project,'test/helpers/host.cjs'));
const baseUrl=process.env.AGENTEXTENSION_TEST_FORGE_URL;
const options={skip:!baseUrl && 'Set AGENTEXTENSION_TEST_FORGE_URL to a local TrueForge instance.',timeout:90000};
test('streamed interactive usage stops a model loop before the end of its autonomous turn', options,async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'agentextension-live-budget-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.writeFile(path.join(root,'a.txt'),'one\n');
 let calls=0;
 const model=await scriptedModel(t,baseUrl,async({call,say})=>{calls++;return calls<=10?call('read_file',{file:'a.txt',start_line:1,end_line:1},4000):say('Finished.',4000);});
 const host=await startHost(t,{root,extensionPath:project,extensionEntry:path.join(project,'src/extension.js'),
 settings:{serverUrl:baseUrl,model:model.model,fallbackModel:'',turnTimeoutSeconds:60,automaticSkills:false,skillRoots:[],pluginRoots:[],readConnectors:[],browserOrigins:[],
 runBudget:{maxTokens:10000,maxMinutes:2,maxToolCalls:48}}});
 await host.send({type:'run',prompt:'Inspect the text. Do not edit it.'});
 const state=await host.waitFor(state=>!state.runActive&&state.phase==='cancelled',60000,'live token stop');
 assert.match(state.status,/budget/i);assert.ok(calls<=5,`${calls} model calls`);assert.ok(state.usageDetail.tokens.total>=12500);
 assert.equal(state.progress.retries,0);assert.equal(state.usageDetail.tokens.total,state.usageDetail.modelCalls*4025);
 assert.equal(await fs.readFile(path.join(root,'a.txt'),'utf8'),'one\n');assert.ifError(model.state.error);
});
test('streamed token cancellation preserves a staged draft and clears review authority', options,async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'agentextension-live-budget-draft-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.writeFile(path.join(root,'a.txt'),'one\n');
 let calls=0;
 const model=await scriptedModel(t,baseUrl,async({call,say})=>{
   calls++;
   if(calls===1)return call('propose_write',{file:'a.txt',old_text:'one',new_text:'ONE'},4000);
   return calls<=10?call('read_file',{file:'a.txt',start_line:1,end_line:1},4000):say('Finished.',4000);
 });
 const host=await startHost(t,{root,extensionPath:project,extensionEntry:path.join(project,'src/extension.js'),
 settings:{serverUrl:baseUrl,model:model.model,fallbackModel:'',turnTimeoutSeconds:60,automaticSkills:false,skillRoots:[],pluginRoots:[],readConnectors:[],browserOrigins:[],
 runBudget:{maxTokens:10000,maxMinutes:2,maxToolCalls:48}}});
 await host.send({type:'run',prompt:'Stage the uppercase correction and stop when the budget is reached.'});
 const state=await host.waitFor(state=>!state.runActive&&state.phase==='cancelled'&&state.checkpoint,60000,'budget draft checkpoint');
 assert.match(state.status,/budget/i);assert.ok(calls<=5,`${calls} model calls`);assert.deepEqual(state.hunks,[]);
 assert.equal(state.progress.retries,0);assert.equal(await fs.readFile(path.join(root,'a.txt'),'utf8'),'one\n');assert.ifError(model.state.error);
});
test('retry retains approved plan constraints as reference and asks for fresh plan approval', options,async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'agentextension-retry-plan-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.writeFile(path.join(root,'a.txt'),'one\n');
 const plan={goal:'Keep the required error format',steps:['Uppercase one'],checks:['Preserve the required error format']};
 let planned=false,failed=false;
 const model=await scriptedModel(t,baseUrl,async({round,all,call,say,fail})=>{
   if(!planned){planned=true;return call('propose_plan',plan);}
   if(!failed){failed=true;return fail();}
   if(round===0){assert.match(all,/PREVIOUS PLAN/);assert.match(all,/Preserve the required error format/);return call('propose_plan',plan);}
   if(round===1)return call('propose_write',{file:'a.txt',old_text:'one',new_text:'ONE'});
   if(round===2)return call('review_changes',{});
   return say('Draft ready.');
 });
 const host=await startHost(t,{root,extensionPath:project,extensionEntry:path.join(project,'src/extension.js'),
 settings:{serverUrl:baseUrl,model:model.model,fallbackModel:'',turnTimeoutSeconds:60,automaticSkills:false,skillRoots:[],pluginRoots:[],readConnectors:[],browserOrigins:[]}});
 await host.send({type:'run',prompt:'Uppercase one and preserve the error format.',planFirst:true});
 await host.waitFor(state=>state.phase==='plan',20000,'first plan');await host.send({type:'approve-plan'});
 await host.waitFor(state=>state.progress?.retries===1&&state.phase==='plan',20000,'fresh plan');
 assert.equal(await fs.readFile(path.join(root,'a.txt'),'utf8'),'one\n');
 await host.send({type:'approve-plan'});const review=await host.waitFor(state=>state.phase==='review',20000,'review after fresh plan');
 assert.equal(review.hunks.length,1);assert.ifError(model.state.error);await host.send({type:'cancel'});
});

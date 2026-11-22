const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {startHost,scriptedModel}=require('./helpers/host.cjs');
const {runForge}=require('../src/forge');
const {PermissionBroker}=require('../src/permissions');
const {Draft}=require('../src/draft');
const baseUrl=process.env.AGENTEXTENSION_TEST_FORGE_URL;
const options={skip:!baseUrl&&'Set AGENTEXTENSION_TEST_FORGE_URL to a local TrueForge instance.',timeout:90000};
const settings=model=>({serverUrl:baseUrl,model,fallbackModel:'',turnTimeoutSeconds:60,automaticSkills:false,
 skillRoots:[],pluginRoots:[],readConnectors:[],browserOrigins:[]});

test('a premature finish gets one check-and-repair follow-up and fresh review',options,async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'agentextension-verify-followup-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));const base='exports.add=(a,b)=>a-b;\n';
 await fs.writeFile(path.join(root,'calc.js'),base);
 await fs.writeFile(path.join(root,'calc.test.js'),"require('node:assert/strict').equal(require('./calc').add(2,3),5);\n");
 let stopped=false;
 const model=await scriptedModel(t,baseUrl,async({round,all,results,call,say})=>{
  if(round===0)return call('propose_write',{file:'calc.js',old_text:'a-b',new_text:'a+'});
  if(round===1)return call('review_changes',{});
  if(round===2&&!stopped){stopped=true;return say('The draft is done. Run checks after applying.');}
  if(round===2){assert.match(all,/current draft has no current successful project check/);assert.match(all,/Keep subtraction unchanged/);return call('run_command',{command:'node',args:['--test','calc.test.js']});}
  if(round===3){assert.notEqual(JSON.parse(results.at(-1).content).exitCode,0);return call('propose_write',{file:'calc.js',old_text:'a+',new_text:'a+b'});}
  if(round===4)return call('run_command',{command:'node',args:['--test','calc.test.js']});
  if(round===5){assert.equal(JSON.parse(results.at(-1).content).exitCode,0);return call('review_changes',{});}
  return say('The focused test passed. The user can apply the reviewed draft.');
 });
 const host=await startHost(t,{root,settings:settings(model.model)});
 host.autoAnswer=async(kind,title,items)=>kind==='modal'?items.find(x=>x==='Run command'):undefined;
 await host.send({type:'run',prompt:'Fix add and run its test. Keep subtraction unchanged.'});
 const first=await host.waitFor(s=>s.phase==='review',30000,'first review');
 for(const h of first.hunks)await host.send({type:'decision',id:h.id,value:'accept'});await host.send({type:'continue'});
 const second=await host.waitFor(s=>s.phase==='review'&&s.revision!==first.revision,30000,'repaired review');
 for(const h of second.hunks)await host.send({type:'decision',id:h.id,value:'accept'});await host.send({type:'continue'});
 const done=await host.waitFor(s=>s.phase==='ready'&&!s.runActive,30000,'verified completion');
 assert.equal(done.checks.length,2);assert.equal(done.checks.at(-1).exitCode,0);assert.match(done.status,/Recorded checks passed/);
 assert.equal(done.progress.events.filter(e=>e.type==='verification-requested').length,1);
 assert.equal(await fs.readFile(path.join(root,'calc.js'),'utf8'),base);assert.ifError(model.state.error);await host.send({type:'cancel'});
});

test('an unavailable or deliberately skipped check stays explicit without endless follow-ups',options,async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'agentextension-verify-skip-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.writeFile(path.join(root,'a.txt'),'one\n');let summaries=0;
 const model=await scriptedModel(t,baseUrl,async({round,all,call,say})=>{
  if(round===0)return call('propose_write',{file:'a.txt',old_text:'one',new_text:'ONE'});
  if(round===1)return call('review_changes',{});
  summaries++;assert.match(all,/Do not run commands/);return say('Draft reviewed. Checks were deliberately skipped as requested.');
 });
 const host=await startHost(t,{root,settings:settings(model.model)});
 await host.send({type:'run',prompt:'Uppercase one. Do not run commands.'});
 const review=await host.waitFor(s=>s.phase==='review',30000,'review');
 await host.send({type:'decision',id:review.hunks[0].id,value:'accept'});await host.send({type:'continue'});
 const done=await host.waitFor(s=>s.phase==='ready'&&!s.runActive,30000,'bounded unchecked completion');
 assert.equal(summaries,2);assert.equal(done.checks.length,0);assert.match(done.status,/Verification is incomplete/);
 assert.equal(done.progress.events.filter(e=>e.type==='verification-requested').length,1);assert.ifError(model.state.error);
 await host.send({type:'cancel'});
});

test('an empty interactive result gets one continuation and stays visibly incomplete if it repeats',options,async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'agentextension-empty-result-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.writeFile(path.join(root,'a.txt'),'one\n');let calls=0;
 const model=await scriptedModel(t,baseUrl,async({all,say})=>{
  calls++;if(calls===2){assert.match(all,/previous turn ended without a final answer/);assert.match(all,/Explain the contents of a.txt/);}return say('');
 });
 const host=await startHost(t,{root,settings:settings(model.model)});
 await host.send({type:'run',prompt:'Explain the contents of a.txt. Do not edit it.'});
 const done=await host.waitFor(s=>s.phase==='done'&&!s.runActive,30000,'bounded empty result');
 assert.equal(calls,2);assert.match(done.status,/ended without a final answer/);
 assert.equal(done.progress.events.filter(e=>e.type==='result-requested').length,1);
 await host.sendAndWait({type:'run-report'});const report=host.shown.documents.at(-1);
 const task=JSON.parse(await fs.readFile(path.join(path.dirname(report),'task.json'),'utf8'));
 assert.deepEqual(task.unresolved,['model-returned-no-result']);assert.equal(task.status,'needs-attention');assert.ifError(model.state.error);
});

test('an empty result continuation can finish a read-only answer without inventing a patch',options,async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'agentextension-empty-recovered-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.writeFile(path.join(root,'a.txt'),'one\n');let calls=0;
 const model=await scriptedModel(t,baseUrl,async({all,say})=>{calls++;if(calls===1)return say('');assert.match(all,/previous turn ended without a final answer/);return say('a.txt contains one line.');});
 const host=await startHost(t,{root,settings:settings(model.model)});await host.send({type:'run',prompt:'Describe the supplied source. Do not edit.'});
 const done=await host.waitFor(s=>s.phase==='done'&&!s.runActive,30000,'empty result recovered');
 assert.equal(calls,2);assert.match(done.text,/contains one line/);assert.match(done.status,/No changes were staged/);assert.ifError(model.state.error);
});

for(const response of ['', 'I will stage the edits now.'])test(`a ${response?'promised':'blank'} result after an external effect never triggers automatic continuation`,options,async t=>{
 let calls=0;const model=await scriptedModel(t,baseUrl,async({say})=>{calls++;return say(response);});
 const controller=new AbortController();const permissions=new PermissionBroker({workspace:'/fixture',signal:controller.signal});
 const run={taskRequest:'Report the completed external change.',signal:controller.signal,controller,permissions,surfaceWrites:1,
  draft:new Draft(async()=>''),workspace:{read:async()=>''},resetDraft(){this.draft=new Draft(async()=> '');}};
 const ui={session(){},token(){},status(){},retry(){},plan:async()=>false,review:async()=>[],command:async()=>false};
 await runForge(settings(model.model),run,run.taskRequest,ui);
 assert.equal(calls,1);assert.equal(run.incompleteReason,response?undefined:'model-returned-no-result');assert.ifError(model.state.error);
});

test('an empty reply followed by a promise can finish through approved checks and review',options,async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'agentextension-promised-work-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));const base='exports.add=(a,b)=>a-b;\n';
 await fs.writeFile(path.join(root,'calc.js'),base);await fs.writeFile(path.join(root,'calc.test.js'),"require('node:assert/strict').equal(require('./calc').add(2,3),5);\n");
 let calls=0;const model=await scriptedModel(t,baseUrl,async({all,call,say})=>{
  calls++;if(calls===1)return say('');if(calls===2)return say('I will stage these edits and then request review.');
  if(calls===3){assert.match(all,/response describes future work, but no draft is staged/);assert.match(all,/Fix add and run its test/);return call('propose_write',{file:'calc.js',old_text:'a-b',new_text:'a+b'});}
  if(calls===4)return call('run_command',{command:'node',args:['--test','calc.test.js']});
  if(calls===5)return call('review_changes',{});return say('The test passed. The corrected draft is reviewed.');
 });
 const host=await startHost(t,{root,settings:settings(model.model)});host.autoAnswer=async(kind,title,items)=>kind==='modal'?items.find(x=>x==='Run command'):undefined;
 await host.send({type:'run',prompt:'Fix add and run its test.'});const review=await host.waitFor(s=>s.phase==='review',30000,'promised edit review');
 for(const h of review.hunks)await host.send({type:'decision',id:h.id,value:'accept'});await host.send({type:'continue'});
 const done=await host.waitFor(s=>s.phase==='ready'&&!s.runActive,30000,'promised edit completion');
 assert.equal(calls,6);assert.equal(done.checks.at(-1).exitCode,0);
 for(const type of ['result-requested','implementation-requested'])assert.equal(done.progress.events.filter(e=>e.type===type).length,1);
 assert.equal(await fs.readFile(path.join(root,'calc.js'),'utf8'),base);assert.ifError(model.state.error);await host.send({type:'cancel'});
});

test('a repeated promise ends without a success claim or endless continuation',options,async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'agentextension-repeated-promise-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.writeFile(path.join(root,'a.txt'),'one\n');let calls=0;
 const model=await scriptedModel(t,baseUrl,async({say})=>{calls++;return say('I will edit a.txt next.');});
 const host=await startHost(t,{root,settings:settings(model.model)});await host.send({type:'run',prompt:'Uppercase one in a.txt.'});
 const done=await host.waitFor(s=>s.phase==='done'&&!s.runActive,30000,'bounded promise');
 assert.equal(calls,2);assert.match(done.status,/Run ended\. No changes were staged/);assert.doesNotMatch(done.status,/complete/i);
 assert.equal(done.progress.events.filter(e=>e.type==='implementation-requested').length,1);
 assert.equal(await fs.readFile(path.join(root,'a.txt'),'utf8'),'one\n');assert.ifError(model.state.error);
});

test('a planning-only request retains its no-edit restriction in the continuation',options,async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'agentextension-plan-only-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.writeFile(path.join(root,'a.txt'),'one\n');let calls=0;
 const model=await scriptedModel(t,baseUrl,async({all,say})=>{calls++;if(calls===1)return say('I will edit a.txt after the plan is approved.');assert.match(all,/Give a plan only\. Do not edit files or run commands/);assert.match(all,/provide that answer without editing/);return say('Plan: uppercase the first line, then check the result after a separate implementation request.');});
 const host=await startHost(t,{root,settings:settings(model.model)});await host.send({type:'run',prompt:'Give a plan only. Do not edit files or run commands.'});
 const done=await host.waitFor(s=>s.phase==='done'&&!s.runActive,30000,'planning-only answer');
 assert.equal(calls,2);assert.equal(done.checks.length,0);assert.equal(done.hunks.length,0);
 assert.equal(await fs.readFile(path.join(root,'a.txt'),'utf8'),'one\n');assert.ifError(model.state.error);
});

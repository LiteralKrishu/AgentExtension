const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {startHost,scriptedModel}=require('./helpers/host.cjs');
const baseUrl=process.env.AGENTEXTENSION_TEST_FORGE_URL;

test('an empty interpreter is rejected before approval and an explicit test can verify the draft',{
 skip:!baseUrl&&'Set AGENTEXTENSION_TEST_FORGE_URL to a local TrueForge instance.',timeout:90000,
},async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'agentextension-command-evidence-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const base='exports.add=(a,b)=>a-b;\n';
 await fs.writeFile(path.join(root,'calc.js'),base);
 await fs.writeFile(path.join(root,'calc.test.js'),"require('node:assert/strict').equal(require('./calc').add(1,2),3);\n");
 const model=await scriptedModel(t,baseUrl,async({round,results,call,say})=>{
  if(round===0)return call('propose_write',{file:'calc.js',old_text:'a-b',new_text:'a+b'});
  if(round===1)return call('run_command',{command:'node',args:[]});
  if(round===2){assert.match(results.at(-1).content,/needs a script/);assert.match(results.at(-1).content,/No command was run/);return call('run_command',{command:'node',args:['-v','missing-project-test.js']});}
  if(round===3){const result=JSON.parse(results.at(-1).content);assert.equal(result.verification,false);assert.match(result.note,/diagnostic only/);return call('run_command',{command:'node',args:['--test','calc.test.js']});}
  if(round===4){assert.equal(JSON.parse(results.at(-1).content).exitCode,0);return call('review_changes',{});}
  return say('The focused test passed.');
 });
 const host=await startHost(t,{root,settings:{serverUrl:baseUrl,model:model.model,fallbackModel:'',turnTimeoutSeconds:60,
  automaticSkills:false,skillRoots:[],pluginRoots:[],readConnectors:[],browserOrigins:[]}});
 host.answers.push({kind:'modal',value:'Run command'},{kind:'modal',value:'Run command'});
 await host.send({type:'run',prompt:'Fix add and run its tests.'});
 const review=await host.waitFor(state=>state.phase==='review',30000,'verified review');
 assert.equal(review.checks.length,2);assert.equal(review.checks[0].verification,false);assert.equal(review.checks[1].exitCode,0);
 assert.equal(host.shown.warning.filter(w=>w.buttons.includes('Run command')).length,2);
 await host.send({type:'decision',id:review.hunks[0].id,value:'accept'});await host.send({type:'continue'});
 await host.waitFor(state=>state.phase==='ready'&&!state.runActive,30000,'ready');
 await host.sendAndWait({type:'run-report'});const file=host.shown.documents.at(-1);
 const text=await fs.readFile(file,'utf8');assert.match(text,/diagnostic only/);
 const task=JSON.parse(await fs.readFile(path.join(path.dirname(file),'task.json'),'utf8'));assert.deepEqual(task.unresolved,[]);assert.equal(task.observedChecks.length,1);
 const evidence=require('./model/evidence.cjs').dispatchAuthorization(host.states,host.state().usageDetail.toolCalls);
 assert.equal(evidence.complete,true);assert.equal(evidence.unapprovedActions,0);
 assert.equal(await fs.readFile(path.join(root,'calc.js'),'utf8'),base);assert.ifError(model.state.error);await host.send({type:'cancel'});
});

test('malformed command input receives a repair reason before any command approval',{
 skip:!baseUrl&&'Set AGENTEXTENSION_TEST_FORGE_URL to a local TrueForge instance.',timeout:90000,
},async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'agentextension-command-format-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(path.join(root,'check.js'),"require('node:assert/strict').equal(2+2,4);\n");
 const model=await scriptedModel(t,baseUrl,async({round,results,call,say})=>{
  if(round===0)return call('run_command',{command:'node check.js'});
  if(round===1){assert.match(results.at(-1).content,/Invalid run_command input/);assert.match(results.at(-1).content,/each argument in args/);return call('run_command',{command:'node',args:['check.js']});}
  assert.equal(JSON.parse(results.at(-1).content).exitCode,0);return say('The corrected check passed.');
 });
 const host=await startHost(t,{root,settings:{serverUrl:baseUrl,model:model.model,fallbackModel:'',turnTimeoutSeconds:60,
  automaticSkills:false,skillRoots:[],pluginRoots:[],readConnectors:[],browserOrigins:[]}});
 host.answers.push({kind:'modal',value:'Run command'});
 await host.send({type:'run',prompt:'Run the existing check.'});
 const done=await host.waitFor(s=>!s.runActive&&s.phase==='done',30000,'corrected command');
 assert.equal(done.checks.length,1);assert.equal(done.checks[0].command,'node');
 assert.equal(host.shown.warning.filter(w=>w.buttons.includes('Run command')).length,1);
 assert.ok(done.progress.events.some(e=>e.type==='failure'&&e.category==='model-tool-format'));
 const evidence=require('./model/evidence.cjs').dispatchAuthorization(host.states,done.usageDetail.toolCalls);
 assert.equal(evidence.complete,true);assert.equal(evidence.unapprovedActions,0);assert.equal(evidence.successfulCalls,1);
 assert.ifError(model.state.error);
});

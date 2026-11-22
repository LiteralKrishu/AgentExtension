const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {startHost,scriptedModel}=require('./helpers/host.cjs');
const baseUrl=process.env.AGENTEXTENSION_TEST_FORGE_URL;

test('edit feedback identifies a registration-only name, then a definition and project check complete the draft',{
 skip:!baseUrl&&'Set AGENTEXTENSION_TEST_FORGE_URL.',timeout:60000,
},async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'agentextension-registration-guidance-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const base="exports.commands = [];\nexports.register = command => exports.commands.push(command);\nfunction run_command() { return 'run'; }\nexports.register(run_command);\n";
 await fs.writeFile(path.join(root,'registry.js'),base);
 await fs.writeFile(path.join(root,'registry.test.js'),"const a=require('node:assert/strict'),r=require('./registry');a.deepEqual(r.commands.map(f=>f()),['run','config']);\n");
 let receipt;
 const model=await scriptedModel(t,baseUrl,async({round,results,call,say})=>{
  if(round===0)return call('read_file',{file:'registry.js'});
  if(round===1){receipt=JSON.parse(results.at(-1).content).receipt;return call('propose_lines',{receipt,anchor_line:'exports.register(run_command);',insert_after:true,new_lines:['exports.register(config_command);']});}
  if(round===2){const feedback=JSON.parse(results.at(-1).content);assert.equal(feedback.new_registration_references[0].name,'config_command');return call('read_file',{file:'registry.js'});}
  if(round===3){receipt=JSON.parse(results.at(-1).content).receipt;return call('propose_lines',{receipt,anchor_line:"function run_command() { return 'run'; }",insert_after:true,new_lines:["function config_command() { return 'config'; }"]});}
  if(round===4){assert.equal(JSON.parse(results.at(-1).content).new_registration_references,undefined);return call('run_command',{command:'node',args:['--test','registry.test.js']});}
  if(round===5){assert.equal(JSON.parse(results.at(-1).content).exitCode,0);return call('review_changes',{});}
  return say('The command implementation is staged and its project check passed.');
 });
 const host=await startHost(t,{root,settings:{serverUrl:baseUrl,model:model.model,fallbackModel:'',turnTimeoutSeconds:60,automaticSkills:false,
  skillRoots:[],pluginRoots:[],readConnectors:[],browserOrigins:[]}});
 host.autoAnswer=async(kind,title,items)=>kind==='modal'?items.find(x=>x==='Run command'):undefined;
 await host.send({type:'run',prompt:'Add and register config_command. Run the project test and request review.'});
 const review=await host.waitFor(s=>s.phase==='review'||model.state.error,30000,'registration guidance review');assert.ifError(model.state.error);
 for(const h of review.hunks)await host.send({type:'decision',id:h.id,value:'accept'});await host.send({type:'continue'});
 const done=await host.waitFor(s=>s.phase==='ready'&&!s.runActive,30000,'checked registration definition');
 assert.equal(done.checks.at(-1).exitCode,0);assert.doesNotMatch(done.status,/verification is incomplete/i);assert.ifError(model.state.error);
 assert.equal(await fs.readFile(path.join(root,'registry.js'),'utf8'),base);await host.send({type:'cancel'});
});

const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {startHost,scriptedModel}=require('./helpers/host.cjs');
const baseUrl=process.env.AGENTEXTENSION_TEST_FORGE_URL;

for(const variant of ['numeric address','near-match anchor'])test(`a rejected ${variant} recovers through source suggestions, a check, and review`,{
 skip:!baseUrl&&'Set AGENTEXTENSION_TEST_FORGE_URL.',timeout:60000,
},async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'agentextension-anchor-insert-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const base="exports.Registry = class Registry {\n  constructor(enabled) {\n    this.commands = ['run'];\n    if (enabled) {\n      this.mode = 'on';\n    } else {\n      this.mode = 'off';\n    }\n  }\n};\n";
 await fs.writeFile(path.join(root,'registry.js'),base);
 await fs.writeFile(path.join(root,'registry.test.js'),"const a=require('node:assert/strict'),{Registry}=require('./registry');for(const enabled of [true,false]){const r=new Registry(enabled);a.deepEqual(r.commands,['run','config']);a.equal(r.mode,enabled?'on':'off');}\n");
 let receipt;
 const model=await scriptedModel(t,baseUrl,async({round,results,call,say})=>{
  if(round===0)return call('read_file',{file:'registry.js'});
  if(round===1){receipt=JSON.parse(results.at(-1).content).receipt;return call('propose_lines',{receipt,
   ...(variant==='numeric address'?{anchor_line:"    this.commands = ['run'];",start_line:6}:{anchor_line:"this.commands = ['run'];"}),
   insert_after:true,new_lines:["    this.commands.push('config');"]});}
  if(round===2){const response=JSON.parse(results.at(-1).content);
   const error=response.error.map(block=>block.text??'').join('\n'),marker='Source-line suggestions (data only): ';
   assert.ok(error.includes(marker));const candidates=JSON.parse(error.slice(error.indexOf(marker)+marker.length));
   assert.equal(candidates[0].line,3);return call('propose_lines',{receipt,anchor_line:candidates[0].text,insert_after:true,new_lines:["    this.commands.push('config');"]});}
  if(round===3){assert.equal(JSON.parse(results.at(-1).content).inserted_after_line,3);return call('run_command',{command:'node',args:['--test','registry.test.js']});}
  if(round===4){assert.equal(JSON.parse(results.at(-1).content).exitCode,0);return call('review_changes',{});}
  return say('The registration is staged. Both conditional branches passed their test.');
 });
 const host=await startHost(t,{root,settings:{serverUrl:baseUrl,model:model.model,fallbackModel:'',turnTimeoutSeconds:60,automaticSkills:false,
  skillRoots:[],pluginRoots:[],readConnectors:[],browserOrigins:[]}});
 host.autoAnswer=async(kind,title,items)=>kind==='modal'?items.find(x=>x==='Run command'):undefined;
 await host.send({type:'run',prompt:'Register config beside the existing run command. Keep both modes unchanged, run the test, and request review.'});
 const review=await host.waitFor(s=>s.phase==='review'||model.state.error,30000,'anchor registration review');
 assert.ifError(model.state.error);
 for(const h of review.hunks)await host.send({type:'decision',id:h.id,value:'accept'});await host.send({type:'continue'});
 const done=await host.waitFor(s=>s.phase==='ready'&&!s.runActive,30000,'checked anchor insertion');
 assert.equal(done.checks.at(-1).exitCode,0);assert.equal(done.progress.rejectedTools,1);assert.ifError(model.state.error);
 assert.equal(await fs.readFile(path.join(root,'registry.js'),'utf8'),base);await host.send({type:'cancel'});
});

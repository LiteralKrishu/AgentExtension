const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {startHost,scriptedModel}=require('./helpers/host.cjs');
const baseUrl=process.env.AGENTEXTENSION_TEST_FORGE_URL;

test('literal line arrays pass through TrueForge, verification, and review without decoding source escapes',{
 skip:!baseUrl&&'Set AGENTEXTENSION_TEST_FORGE_URL.',timeout:60000,
},async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'agentextension-array-lines-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));const base='exports.pattern = "old";\nexports.add=(a,b)=>a-b;\n';
 await fs.writeFile(path.join(root,'calc.js'),base);
 await fs.writeFile(path.join(root,'calc.test.js'),"const a=require('node:assert/strict'),c=require('./calc');a.equal(c.pattern,'\\\\n');a.equal(c.add(2,3),5);\n");
 const model=await scriptedModel(t,baseUrl,async({round,results,call,say})=>{
  if(round===0)return call('read_file',{file:'calc.js'});
  if(round===1){const read=JSON.parse(results.at(-1).content);return call('propose_lines',{receipt:read.receipt,start_line:1,delete_count:2,
   new_lines:['exports.pattern = "\\\\n";','exports.add=(a,b)=>a+b;']});}
  if(round===2){assert.equal(JSON.parse(results.at(-1).content).input_format,'new_lines');return call('run_command',{command:'node',args:['--test','calc.test.js']});}
  if(round===3){assert.equal(JSON.parse(results.at(-1).content).exitCode,0);return call('review_changes',{});}
  return say('The staged change passed its project check.');
 });
 const host=await startHost(t,{root,settings:{serverUrl:baseUrl,model:model.model,fallbackModel:'',turnTimeoutSeconds:60,automaticSkills:false,
  skillRoots:[],pluginRoots:[],readConnectors:[],browserOrigins:[]}});
 host.autoAnswer=async(kind,title,items)=>kind==='modal'?items.find(x=>x==='Run command'):undefined;
 await host.send({type:'run',prompt:'Fix add and preserve the literal backslash-n pattern. Run its test and request review.'});
 const review=await host.waitFor(s=>s.phase==='review',30000,'array line review');
 for(const h of review.hunks)await host.send({type:'decision',id:h.id,value:'accept'});await host.send({type:'continue'});
 const done=await host.waitFor(s=>s.phase==='ready'&&!s.runActive,30000,'checked array edit');
 assert.equal(done.checks.at(-1).exitCode,0);assert.ifError(model.state.error);
 assert.equal(await fs.readFile(path.join(root,'calc.js'),'utf8'),base);await host.send({type:'cancel'});
});

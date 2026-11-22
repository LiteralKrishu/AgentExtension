const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { runCodingDraft, readCodingResult } = require('../src/coding-run');
const { digest } = require('../src/permissions');
const schedule = { schemaVersion:1,type:'coding-draft',output:'review-inbox',id:randomUUID(),name:'inbox fixture',prompt:'Check',
  source:{head:'a'.repeat(40),contents:'b'.repeat(64)},files:['app.js'],checks:[{command:'node',args:['check.js']}],
  environment:{kind:'container',profile:'node',image:'node@sha256:'+'c'.repeat(64),declaration:'d'.repeat(64),allowScripts:false},
  days:[1],times:['09:00'],timeZone:'UTC',budget:{minutes:1,toolCalls:2,connectorReads:0,maxTokens:1000},validUntil:'2030-01-01T00:00:00Z'};

test('the inbox bounds retained results and rejects changed or redirected artifacts', async t=>{
  const storage=await fs.mkdtemp(path.join(os.tmpdir(),'coding-inbox-'));t.after(()=>fs.rm(storage,{recursive:true,force:true}));
  const store={workspace:storage,directory:path.join(storage,'coding-schedules','fixture')};
  const result=await runCodingDraft({store,schedule,occurrence:{at:Date.now(),slot:'fixture'},trigger:'fixture',verify:async()=>{throw Error('Revoked fixture');}});
  assert.equal(result.status,'blocked');assert.equal((await readCodingResult(store,result.artifact)).applied,false);
  const directory=path.dirname(result.artifact);
  for(let i=0;i<51;i++) {const file=path.join(directory,`${randomUUID()}.json`);await fs.writeFile(file,'{}');await fs.utimes(file,1,1);}
  const final=await runCodingDraft({store,schedule,occurrence:{at:Date.now(),slot:'fixture'},trigger:'fixture',verify:async()=>{throw Error('Revoked fixture');}});
  assert.equal((await fs.readdir(directory)).length,50);assert.equal((await readCodingResult(store,final.artifact)).status,'blocked');
  const changed=JSON.parse(await fs.readFile(final.artifact,'utf8'));changed.status='ready-for-review';await fs.writeFile(final.artifact,JSON.stringify(changed));
  await assert.rejects(readCodingResult(store,final.artifact),/verification/);
  await assert.rejects(readCodingResult(store,path.join(storage,'outside.json')),/Invalid coding result path/);
});

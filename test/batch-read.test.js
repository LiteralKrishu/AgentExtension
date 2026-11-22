const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StreamableHTTPClientTransport}=require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const {openBridge}=require('../src/bridge');
const {Workspace}=require('../src/workspace');
const {Draft}=require('../src/draft');
const {PermissionBroker}=require('../src/permissions');

async function fixture(t,files){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'agentextension-batch-read-')));
 for(const[file,text]of Object.entries(files))await fs.writeFile(path.join(root,file),text);
 const controller=new AbortController();const permissions=new PermissionBroker({workspace:root,signal:controller.signal});
 permissions.allowScope('workspace.read');permissions.allowScope('draft.edit');
 const buffers=new Map();const workspace=new Workspace(root,file=>buffers.get(path.relative(root,file)),async()=>Object.keys(files));
 workspace.identity=root;const draft=new Draft((file,create)=>workspace.read(file,create));
 const bridge=await openBridge({workspace,draft,permissions,signal:controller.signal});const client=new Client({name:'batch-read',version:'1'});
 t.after(async()=>{await client.close();bridge.close();await fs.rm(root,{recursive:true,force:true});});
 await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url),{requestInit:{headers:{Authorization:`Bearer ${bridge.token}`}}}));
 const call=async(name,args)=>{const result=await client.callTool({name,arguments:args});return{result,value:result.isError?result.content[0].text:JSON.parse(result.content[0].text)};};
 return{root,workspace,draft,buffers,call};
}

test('batched excerpts retain per-file receipts, current buffers and private exclusions',async t=>{
 const f=await fixture(t,{'a.txt':'one\ntwo\n','b.txt':'disk\n','.env':'private-secret'});
 f.buffers.set('b.txt','unsaved\n');
 const {value}=await f.call('read_files',{files:[{file:'a.txt',start_line:2,end_line:2},{file:'b.txt'},{file:'.env'}]});
 assert.equal(value.coverage.returned,2);assert.equal(value.coverage.complete,false);
 assert.equal(value.excerpts[0].text,'two\n');assert.equal(value.excerpts[1].text,'unsaved\n');
 assert.notEqual(value.excerpts[0].receipt,value.excerpts[1].receipt);assert.ok(value.excerpts[2].error);
 assert.ok(!JSON.stringify(value).includes('private-secret'));
 const edited=await f.call('propose_lines',{receipt:value.excerpts[0].receipt,start_line:2,delete_count:1,new_text:'TWO\n'});
 assert.equal(edited.result.isError,undefined);assert.equal(f.draft.current('a.txt','one\ntwo\n'),'one\nTWO\n');
 assert.equal(await fs.readFile(path.join(f.root,'a.txt'),'utf8'),'one\ntwo\n');
});

test('batch quotas are explicit and a changed source rejects its receipt',async t=>{
 const body=('x'.repeat(99)+'\n').repeat(1200);const f=await fixture(t,{'a.txt':body,'b.txt':body,'c.txt':body,'d.txt':body});
 // Each excerpt also retains the existing 120-line bound.
 const {value}=await f.call('read_files',{files:['a.txt','b.txt','c.txt','d.txt'].map(file=>({file,end_line:1200}))});
 assert.equal(value.coverage.sourceCharacters,12000);assert.equal(value.coverage.complete,false);assert.equal(value.coverage.returned,3);
 assert.match(value.excerpts[3].error,/budget reached/);
 for(const excerpt of value.excerpts.filter(item=>item.receipt)){assert.ok(excerpt.text.length<=5000);assert.ok(excerpt.end_line<=120);}
 const receipt=value.excerpts[0].receipt;await fs.writeFile(path.join(f.root,'a.txt'),'external\n');
 const stale=await f.call('propose_lines',{receipt,start_line:1,delete_count:1,new_text:'wrong\n'});
 assert.equal(stale.result.isError,true);assert.equal(f.draft.files.size,0);
 const tooMany=await f.call('read_files',{files:Array.from({length:5},()=>({file:'a.txt'}))});
 assert.equal(tooMany.result.isError,true);
});

test('batch reads share the repeated-read bound with single-file reads',async t=>{
 const f=await fixture(t,{'a.txt':'one\n'});
 const request={file:'a.txt',start_line:1,end_line:1};
 for(let i=0;i<6;i++)assert.equal((await f.call('read_file',request)).result.isError,undefined);
 const {value}=await f.call('read_files',{files:[request]});assert.equal(value.coverage.returned,0);assert.match(value.excerpts[0].error,/Stop reading/);
});

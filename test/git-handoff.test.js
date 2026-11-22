const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {execFileSync}=require('node:child_process');
const {Workspace}=require('../src/workspace');
const {CheckpointStore}=require('../src/checkpoint');
const {exportHandoff,parseHandoff,importHandoff,prepareBranch,commitBranch,deliverHandoff,connectorProvider}=require('../src/git-handoff');
async function fixture(t){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ae-git-handoff-')));const storage=await fs.mkdtemp(path.join(os.tmpdir(),'ae-git-review-'));
 t.after(()=>Promise.all([fs.rm(root,{recursive:true,force:true}),fs.rm(storage,{recursive:true,force:true})]));
 await fs.writeFile(path.join(root,'app.js'),'old\n');
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();git('init','-q');git('config','user.name','Fixture User');git('config','user.email','fixture@example.invalid');git('add','.');git('commit','-qm','fixture');git('remote','add','origin','https://example.invalid/owner/repo.git');
 const workspace=new Workspace(root,()=>undefined);workspace.identity=root;const signal=new AbortController().signal;
 const artifact=await exportHandoff(workspace,{request:'Change app.',changes:[{file:'app.js',before:'old\n',after:'new\n'}],checks:[{command:'node',args:['--check','app.js'],exitCode:0,changes:[{file:'app.js',before:'old\n',after:'new\n'}]}],notes:'Review the app change.'},signal);
 return{root,storage,workspace,signal,artifact,git};
}
test('portable handoffs bind patch, source, checks and reviewer notes; import restores no approval',async t=>{
 const f=await fixture(t);assert.match(f.artifact.patch,/\+new/);assert.equal(f.artifact.checks[0].outcome,'passed');
 assert.throws(()=>parseHandoff({...f.artifact,patch:'forged'}),/verification/);
 assert.throws(()=>parseHandoff({...f.artifact,notes:'x'.repeat(8000000)}),/exceeds 8 MB/);
 const checkpoint=await importHandoff(f.workspace,f.artifact,f.storage,f.signal);
 assert.deepEqual(checkpoint.checks,[]);assert.equal(checkpoint.reviewed,null);assert.equal(checkpoint.files[0].text,'new\n');
 await assert.rejects(importHandoff(f.workspace,f.artifact,f.storage,f.signal),/checkpoint already exists/);
 await fs.writeFile(path.join(f.root,'app.js'),'changed\n');await assert.rejects(importHandoff(f.workspace,f.artifact,f.storage,f.signal),/source base/);
});
test('a separate checkout gets only the reviewed draft and a local commit uses the configured author',async t=>{
 const f=await fixture(t);const before=f.git('rev-parse','HEAD');
 const prepared=await prepareBranch(f.workspace,f.artifact,{branch:'main/draft-fixture',repository:'https://example.invalid/owner/repo.git'},f.signal);
 t.after(()=>fs.rm(prepared.parent,{recursive:true,force:true}));
 assert.equal(await fs.readFile(path.join(f.root,'app.js'),'utf8'),'old\n');assert.equal(f.git('rev-parse','HEAD'),before);
 const commit=await commitBranch(prepared,'Update app',f.signal);assert.match(commit,/^[a-f0-9]{40}$/);
 const author=execFileSync('git',['show','-s','--format=%an <%ae>%n%B',commit],{cwd:prepared.directory,encoding:'utf8'});
 assert.match(author,/Fixture User <fixture@example.invalid>/);assert.doesNotMatch(author,/Codex|OpenAI|Co-Authored-By/);
 assert.equal(f.git('rev-parse','--abbrev-ref','HEAD').includes('draft-fixture'),false);
});
test('dirty source, wrong remotes, and changed managed files block Git handoff',async t=>{
 const f=await fixture(t);
 await assert.rejects(prepareBranch(f.workspace,f.artifact,{branch:'main/test',repository:'wrong'},f.signal),/remote differs/);
 await fs.writeFile(path.join(f.root,'unrelated.txt'),'unrelated\n');
 const dirty=await exportHandoff(f.workspace,{request:'Change',changes:f.artifact.changes},f.signal);
 await assert.rejects(prepareBranch(f.workspace,dirty,{branch:'main/test',repository:'https://example.invalid/owner/repo.git'},f.signal),/unrelated source/);
 await fs.rm(path.join(f.root,'unrelated.txt'));
 const prepared=await prepareBranch(f.workspace,f.artifact,{branch:'main/test',repository:'https://example.invalid/owner/repo.git'},f.signal);t.after(()=>fs.rm(prepared.parent,{recursive:true,force:true}));
 await fs.writeFile(path.join(prepared.directory,'app.js'),'changed\n');await assert.rejects(commitBranch(prepared,'Update',f.signal),/draft changed/);
});
test('lost remote write replies are reconciled before retry and conflicting state prevents writes',async t=>{
 const f=await fixture(t);const p=await prepareBranch(f.workspace,f.artifact,{branch:'main/remote-fixture',repository:'https://example.invalid/owner/repo.git'},f.signal);t.after(()=>fs.rm(p.parent,{recursive:true,force:true}));await commitBranch(p,'Update app',f.signal);
 let writes=0;let state;const provider={read:async()=>state,approve:async()=>true,write:async(kind,request)=>{writes++;state={commit:request.commit,branch:request.branch};throw Error('lost reply');}};
 assert.equal((await deliverHandoff(p,provider,{kind:'push'},f.signal)).status,'confirmed');
 assert.equal((await deliverHandoff(p,provider,{kind:'push'},f.signal)).status,'confirmed');assert.equal(writes,1);
 state={commit:'other'};await assert.rejects(deliverHandoff(p,provider,{kind:'push'},f.signal),/conflicts/);
 state=null;provider.write=async()=>{writes++;throw Error('connection lost');};assert.equal((await deliverHandoff(p,provider,{kind:'pull-request',title:'Update app',body:'Checked draft'},f.signal)).status,'uncertain');assert.equal(writes,2);
});
test('the connector adapter uses exact configured read/write requests and verifies receipts',async()=>{
 const {PermissionBroker}=require('../src/permissions');
 const signal=new AbortController().signal;const permissions=new PermissionBroker({workspace:'/fixture',signal});let requested;let calls=0;
 const run={permissions,signal,gitPatch:'patch',connectors:{prepare:async(args,operation)=>({config:{id:'git',url:'https://example.invalid/mcp',account:'fixture'},input:{tool:args.tool,arguments:args.arguments},target:'owner/repo',
  action:permissions.action('connector_'+operation,'connector.'+operation,'owner/repo',args)}),
 read:async args=>({text:JSON.stringify({content:[{type:'text',text:JSON.stringify(null)}]})}),write:async args=>{requested=args;calls++;return{text:JSON.stringify({content:[{type:'text',text:JSON.stringify({branch:args.arguments.branch,commit:args.arguments.commit})}]})};}}};
 const bindings={push:{read:{connector:'git',tool:'inspect',arguments:{repository:'owner/repo'}},write:{connector:'git',tool:'publish',arguments:{repository:'owner/repo'}}}};
 const adapter=connectorProvider(run,bindings,{connector:async()=>true});const request={repository:'owner/repo',branch:'main/test',commit:'a'.repeat(40),base:'b'.repeat(40)};
 assert.equal(await adapter.read('push',request),null);assert.equal(await adapter.approve('push',request),true);assert.equal((await adapter.write('push',request)).commit,'a'.repeat(40));
 assert.equal(calls,1);assert.equal(requested.arguments.patch,'patch');
});

test('a real configured MCP fixture creates a draft PR and reconciles it without a second write', async t => {
 const http=require('node:http');
 const {McpServer}=require('@modelcontextprotocol/sdk/server/mcp.js');
 const {StreamableHTTPServerTransport}=require('@modelcontextprotocol/sdk/server/streamableHttp.js');
 const {z}=require('zod');const {ReadConnectors}=require('../src/connectors');
 const {PermissionBroker}=require('../src/permissions');const {secretKey}=require('../src/connector-oauth');
 const f=await fixture(t);const p=await prepareBranch(f.workspace,f.artifact,{branch:'main/connected',repository:'https://example.invalid/owner/repo.git'},f.signal);
 t.after(()=>fs.rm(p.parent,{recursive:true,force:true}));await commitBranch(p,'Update app',f.signal);
 const rows=[];let writes=0;const text=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
 const server=http.createServer(async(req,res)=>{
  if(req.headers.authorization!=='Bearer fixture-secret')return res.writeHead(401).end();
  const mcp=new McpServer({name:'git-handoff-fixture',version:'1.0.0'});
  mcp.registerTool('inspect',{inputSchema:{repository:z.string()},annotations:{readOnlyHint:true}},async({repository})=>{assert.equal(repository,p.repository);return text(rows);});
  mcp.registerTool('create_draft',{inputSchema:{repository:z.string(),branch:z.string(),commit:z.string(),base:z.string(),patch:z.string(),title:z.string(),body:z.string(),draft:z.boolean()},annotations:{readOnlyHint:false}},async input=>{
   assert.equal(input.repository,p.repository);assert.equal(input.patch,f.artifact.patch);assert.equal(input.draft,true);assert.equal(input.commit,p.committed);
   writes++;const result={kind:'pull-request',branch:input.branch,commit:input.commit,draft:true};rows.push(result);return text(result);
  });
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  res.once('close',()=>{void mcp.close().catch(()=>{});});
  try{await mcp.connect(transport);await transport.handleRequest(req,res);}catch{if(!res.headersSent)res.writeHead(500);res.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.close();server.closeAllConnections();});
 const config={id:'git',account:'fixture',url:`http://127.0.0.1:${server.address().port}/mcp`,tools:[{name:'inspect',targetArgument:'repository',targets:[p.repository]}],writeTools:[{name:'create_draft',targetArgument:'repository',targets:[p.repository],extraArguments:['branch','commit','base','patch','title','body','draft']}]};
 const permissions=new PermissionBroker({workspace:f.root,signal:f.signal});const decisions=[];
 const run={permissions,signal:f.signal,gitPatch:f.artifact.patch,connectors:new ReadConnectors({configs:[config],secrets:{get:async key=>key===secretKey(config)?'fixture-secret':undefined},permissions,signal:f.signal,allowWrites:true})};
 const adapter=connectorProvider(run,{'pull-request':{read:{connector:'git',tool:'inspect',arguments:{repository:p.repository}},write:{connector:'git',tool:'create_draft',arguments:{repository:p.repository}}}},{connector:async request=>{decisions.push(request.operation);return true;}});
 const action={kind:'pull-request',title:'Update app',body:'Checked fixture only'};
 assert.equal((await deliverHandoff(p,adapter,action,f.signal)).status,'confirmed');
 assert.equal((await deliverHandoff(p,adapter,action,f.signal)).status,'confirmed');
 assert.equal(writes,1);assert.ok(decisions.includes('write'));assert.equal(f.git('rev-parse','HEAD'),f.artifact.source.head);
 rows.splice(0,rows.length,{error:'invalid provider state'});
 await assert.rejects(deliverHandoff(p,adapter,action,f.signal),/invalid destination state/);assert.equal(writes,1);
});

test('the editor previews export and imports through a new checkpoint without old checks or approvals',async t=>{
 const f=await fixture(t);const {startHost}=require('./helpers/host.cjs');
 const host=await startHost(t,{root:f.root,settings:{}});
 const {createHandoffController}=require('../src/handoff-controller');
 let ready={workspace:f.workspace,draft:{changes:()=>f.artifact.changes},reviewed:{hunks:['fixture']},run:{taskRequest:f.artifact.request,report:{checks:[]}}};let resumed=0;
 const controller=createHandoffController({context:host.context,chooseFolder:async()=>({uri:{fsPath:f.root}}),makeWorkspace:()=>f.workspace,readyDraft:()=>ready,busy:()=>false,resume:async()=>{resumed++;},tell:message=>host.shown.info.push(message)});
 const destination=path.join(f.storage,'export.json');
 host.answers.push({kind:'pick',value:'Export reviewed draft'},{kind:'save',value:{fsPath:destination}});await controller.manage();
 const exported=JSON.parse(await fs.readFile(destination,'utf8'));assert.match(exported.patch,/\+new/);
 ready=null;host.answers.push({kind:'pick',value:'Import draft handoff'},{kind:'open',value:[{fsPath:destination}]},{kind:'modal',value:'Import draft'});await controller.manage();
 const checkpoint=await new CheckpointStore(host.storage,f.root).load();assert.equal(resumed,1);assert.deepEqual(checkpoint.checks,[]);assert.equal(checkpoint.reviewed,null);assert.equal(checkpoint.files[0].text,'new\n');assert.equal(await fs.readFile(path.join(f.root,'app.js'),'utf8'),'old\n');
});

test('managed Git ignores inherited filter commands while reading the configured global author',async t=>{
 const f=await fixture(t);const config=path.join(f.storage,'gitconfig');const marker=path.join(f.storage,'filter-ran');const script=path.join(f.storage,'filter.cjs');
 await fs.writeFile(path.join(f.root,'.gitattributes'),'app.js filter=fixture\n');f.git('add','.gitattributes');f.git('commit','-qm','fixture attributes');f.git('config','--unset','user.name');f.git('config','--unset','user.email');
 await fs.writeFile(script,`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');process.stdin.pipe(process.stdout);`);
 await fs.writeFile(config,`[user]\nname = Global Fixture\nemail = global@example.invalid\n[filter "fixture"]\nsmudge = node ${script}\nrequired = true\n`);
 f.git('config','filter.fixture.clean',`node ${script}`);
 await fs.utimes(path.join(f.root,'app.js'),new Date(),new Date());
 const saved=process.env.GIT_CONFIG_GLOBAL;process.env.GIT_CONFIG_GLOBAL=config;
 t.after(()=>{if(saved===undefined)delete process.env.GIT_CONFIG_GLOBAL;else process.env.GIT_CONFIG_GLOBAL=saved;});
 const artifact=await exportHandoff(f.workspace,{request:'Change app.',changes:f.artifact.changes},f.signal);
 const p=await prepareBranch(f.workspace,artifact,{branch:'main/no-filter',repository:'https://example.invalid/owner/repo.git'},f.signal);t.after(()=>fs.rm(p.parent,{recursive:true,force:true}));
 assert.deepEqual(p.author,{name:'Global Fixture',email:'global@example.invalid'});await commitBranch(p,'Update app',f.signal);
 await assert.rejects(fs.stat(marker),{code:'ENOENT'});assert.equal(await fs.readFile(path.join(f.root,'app.js'),'utf8'),'old\n');
});

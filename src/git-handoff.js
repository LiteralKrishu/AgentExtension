const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const { z } = require('zod');
const { digest } = require('./permissions');
const { safePath, Workspace, GIT_HARDENING, gitEnvironment } = require('./workspace');
const { CheckpointStore } = require('./checkpoint');
const { patchFor } = require('./reports');
const { assertSource } = require('./coding-run');
const exec = promisify(execFile);
const file = z.string().min(1).max(500).refine(file => { try { return Boolean(safePath(file)) && !/[\x00-\x1f\x7f]/.test(file); } catch { return false; } });
const handoffSchema = z.strictObject({ format: z.literal('agentextension-handoff/1'), request: z.string().min(1).max(8000),
  source: z.strictObject({ head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), contents: z.string().regex(/^[a-f0-9]{64}$/) }),
  changes: z.array(z.strictObject({ file, before: z.string().max(256000).nullable(), after: z.string().max(256000) })).min(1).max(24),
  checks: z.array(z.strictObject({ command: z.string().max(60), args: z.array(z.string().max(500)).max(20),
    outcome: z.enum(['passed','failed','unverified']) })).max(40), notes: z.string().max(8000), patch: z.string().max(4000000),
});
function parseHandoff(raw) {
  if (Buffer.byteLength(JSON.stringify(raw)) > 8000000) throw new Error('The draft handoff exceeds 8 MB.');
  const { digest: expected, ...body } = raw;
  const artifact = handoffSchema.parse(body);
  if (digest(artifact) !== expected || patchFor(artifact.changes) !== artifact.patch || new Set(artifact.changes.map(change=>change.file)).size!==artifact.changes.length) {
    throw new Error('The handoff content or patch failed verification.');
  }
  return { ...artifact, digest: expected };
}
const artifactChanges=changes=>changes.map(({file,before,after})=>({file,before,after}));
async function exportHandoff(workspace, { request, changes, checks = [], notes = '' }, signal) {
  for (const change of changes) if (await workspace.read(change.file, change.before === null)!==change.before) throw new Error('The draft base changed before export.');
  const artifact = { format:'agentextension-handoff/1',request,source:{head:await workspace.gitRevision(signal),contents:await workspace.sourceIdentity(signal)},
    changes:changes.map(({file,before,after})=>({file,before,after})),
    checks:checks.map(({command,args,exitCode,verification,changes:checked})=>({command,args,outcome:verification===false||exitCode==null||!checked||digest(checked.map(({file,before,after})=>({file,before,after})))!==digest(artifactChanges(changes))?'unverified':exitCode===0?'passed':'failed'})),notes,patch:patchFor(changes) };
  return parseHandoff({...artifact,digest:digest(artifact)});
}
async function importHandoff(workspace, raw, storage, signal) {
  const artifact=parseHandoff(raw); await assertSource(workspace,artifact.source,signal);
  for (const change of artifact.changes) if(await workspace.read(change.file,change.before===null)!==change.before) throw new Error('The handoff file base changed.');
  return new CheckpointStore(storage,workspace.root).save({runId:randomUUID(),request:artifact.request,phase:'interrupted',planFirst:false,approvedPlan:null,revision:0,
    files:artifact.changes.map(({file,before,after})=>({file,base:before,text:after})),checks:[],reviewed:null,summary:artifact.notes},{exclusive:true});
}
async function git(directory,args,signal) {
  const env=Object.fromEntries(Object.entries(gitEnvironment()).filter(([key])=>!key.startsWith('GIT_')));
  Object.assign(env,{GIT_NO_LAZY_FETCH:'1',GIT_TERMINAL_PROMPT:'0'});
  if(args[0]==='config'&&['user.name','user.email'].includes(args[1])) {
    if(process.env.GIT_CONFIG_GLOBAL)env.GIT_CONFIG_GLOBAL=process.env.GIT_CONFIG_GLOBAL;
  } else Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:os.devNull});
  const options={cwd:directory,signal,timeout:30000,maxBuffer:8000000,env};
  const hardening=[...GIT_HARDENING,'-c','core.hooksPath=/dev/null','-c','commit.gpgSign=false'];
  if(args[0]!=='config'&&!args.includes('clone')) {
    const config=await exec('git',[...hardening,'config','--null','--name-only','--get-regexp','^filter\\.'],options)
      .catch(error=>{if(error.code===1)return{stdout:''};throw error;});
    for(const driver of new Set(config.stdout.split('\0').filter(Boolean).map(key=>key.slice(7,key.lastIndexOf('.'))))) {
      for(const field of ['clean','smudge','process'])hardening.push('-c',`filter.${driver}.${field}=`);
      hardening.push('-c',`filter.${driver}.required=false`);
    }
  }
  const {stdout}=await exec('git',[...hardening,...args],options);return stdout.trim();
}
async function prepareBranch(workspace, raw, { branch, repository }, signal) {
  const artifact=parseHandoff(raw);
  if(!/^main\/[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(branch)||branch.includes('..')||branch.endsWith('/')||branch.includes('//')) throw new Error('Use a valid main/ handoff branch.');
  await assertSource(workspace,artifact.source,signal);
  if(await git(workspace.root,['status','--porcelain','--untracked-files=all'],signal)) throw new Error('Save and commit or move unrelated source changes before preparing a Git handoff.');
  const remote=await git(workspace.root,['remote','get-url','origin'],signal);
  if(remote!==repository) throw new Error('The Git remote differs from the reviewed destination.');
  const parent=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'agentextension-handoff-'))), directory=path.join(parent,'checkout');
  try {
    await git(parent,['-c','protocol.file.allow=always','clone','--no-hardlinks','--no-checkout','--template=',workspace.root,directory],signal);
    await git(directory,['check-ref-format','--branch',branch],signal);
    await git(directory,['checkout','-b',branch,artifact.source.head],signal);
    await git(directory,['remote','set-url','origin',repository],signal);
    const copy=new Workspace(directory,()=>undefined);copy.identity=directory;
    for(const change of artifact.changes){const full=await copy.resolve(change.file,change.before===null);if(await copy.read(change.file,change.before===null)!==change.before)throw Error('The Git base differs from the checked draft.');await fs.mkdir(path.dirname(full),{recursive:true});await fs.writeFile(full,change.after);}
    const author={name:await git(workspace.root,['config','user.name'],signal),email:await git(workspace.root,['config','user.email'],signal)};
    if(!author.name||!author.email)throw Error('Configure your Git author name and email before committing.');
    return {directory,parent,branch,repository,source:artifact.source,artifact,author,committed:null};
  } catch(error){await fs.rm(parent,{recursive:true,force:true});throw error;}
}
async function commitBranch(prepared,message,signal) {
  if(!message.trim()||message.length>8000||/Co-Authored-By:.*(?:Codex|OpenAI)/i.test(message)) throw new Error('Use a commit message without generated attribution.');
  if(await git(prepared.directory,['rev-parse','HEAD'],signal)!==prepared.source.head)throw new Error('The managed checkout base changed.');
  const workspace=new Workspace(prepared.directory,()=>undefined);workspace.identity=prepared.directory;
  for(const change of prepared.artifact.changes) if(await workspace.read(change.file)!==change.after)throw Error('The managed draft changed before commit.');
  const names=(await git(prepared.directory,['status','--porcelain','--untracked-files=all'],signal));
  if(names.split('\n').filter(Boolean).length!==prepared.artifact.changes.length)throw Error('The managed checkout contains unrelated changes.');
  await git(prepared.directory,['add','--',...prepared.artifact.changes.map(change=>change.file)],signal);
  await git(prepared.directory,['-c',`user.name=${prepared.author.name}`,'-c',`user.email=${prepared.author.email}`,'commit','-m',message],signal);
  prepared.committed=await git(prepared.directory,['rev-parse','HEAD'],signal);return prepared.committed;
}
// A provider adapter must use the existing configured connector. Reads reconcile a lost write response before any retry.
async function deliverHandoff(prepared,provider,{kind,title,body},signal) {
  if(!['push','pull-request'].includes(kind)||!prepared.committed)throw Error('Commit the managed draft before choosing a remote action.');
  if(await git(prepared.directory,['remote','get-url','origin'],signal)!==prepared.repository||await git(prepared.directory,['rev-parse','HEAD'],signal)!==prepared.committed)throw Error('The Git destination or commit changed.');
  const request={repository:prepared.repository,branch:prepared.branch,base:prepared.source.head,commit:prepared.committed,
    artifact:prepared.artifact.digest,...(kind==='pull-request'?{title,body,draft:true}:{})};
  const state=await provider.read(kind,request,signal);
  const matches=state=>state?.commit===request.commit&&state?.branch===request.branch;
  if(matches(state)) return {status:'confirmed',result:state};
  if(state) throw Error('The remote branch or pull request conflicts with this draft.');
  if(!await provider.approve(kind,request,signal))throw Error('The remote action was declined.');
  try{const result=await provider.write(kind,request,signal);if(!matches(result))throw Error('The provider receipt differs from this draft.');return {status:'confirmed',result};}
  catch{const observed=await provider.read(kind,request,signal).catch(()=>undefined);
    return matches(observed)?{status:'confirmed',result:observed}:{status:'uncertain',reason:'The remote action may have taken effect. Inspect the destination before retrying.'};}
}
module.exports={exportHandoff,parseHandoff,importHandoff,prepareBranch,commitBranch,deliverHandoff};

function connectorProvider(run,bindings,ui) {
  const { approve }=require('./forge');
  const decode=reply=>{
    const result=JSON.parse(reply.text);
    if(result.isError)throw Error('Git provider returned an error.');
    const data=JSON.parse(result.content.filter(item=>item.type==='text').map(item=>item.text).join(''));
    return data;
  };
  const input=(kind,operation,request)=>{
    const binding=bindings[kind];if(!binding)throw Error('No configured Git connector binding for this action.');
    for(const operation of ['read','write'])if(!Object.values(binding[operation].arguments).includes(request.repository))throw Error('The configured target differs from the reviewed repository.');
    return operation==='read'?binding.read:{...binding.write,arguments:{...binding.write.arguments,
      branch:request.branch,commit:request.commit,base:request.base,patch:run.gitPatch,
      ...(kind==='pull-request'?{title:request.title,body:request.body,draft:true}:{})}};
  };
  return {
    async read(kind,request){const args=input(kind,'read',request);if(!await approve({name:'connector_read',args},run,ui))throw Error('Git provider read declined.');
      const data=decode(await run.connectors.read(args));const rows=data===null?[]:Array.isArray(data)?data:[data];
      if(rows.some(row=>!row||typeof row.branch!=='string'||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(row.commit)))throw Error('The Git provider returned an invalid destination state.');
      return rows.find(row=>row&&row.branch===request.branch&&(row.kind??kind)===kind)??null;},
    async approve(kind,request){return approve({name:'connector_write',args:input(kind,'write',request)},run,ui);},
    async write(kind,request){const data=decode(await run.connectors.write(input(kind,'write',request)));
      if(data?.commit!==request.commit||data?.branch!==request.branch)throw Error('Git provider receipt does not match the draft.');return data;},
  };
}
module.exports.connectorProvider=connectorProvider;

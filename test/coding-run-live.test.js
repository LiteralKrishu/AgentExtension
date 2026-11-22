const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawn } = require('node:child_process');
const { Workspace } = require('../src/workspace');
const { ContainerEnvironment } = require('../src/execution-environment');
const { CodingScheduleStore, codingSchedulePin } = require('../src/coding-schedules');
const { codingProfile, executionDigest, runCodingDraft, readCodingResult, importCodingResult } = require('../src/coding-run');
const { PolicyEngine } = require('../src/policy');
const { scriptedModel, startHost } = require('./helpers/host.cjs');
const { Scheduler } = require('../src/schedules');
const baseUrl = process.env.AGENTEXTENSION_TEST_FORGE_URL;
const live = { skip: !baseUrl || process.env.AGENTEXTENSION_TEST_DOCKER !== '1', timeout: 90000 };

async function fixture(t, script) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ae-coding-root-')));
  const storage = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ae-coding-storage-')));
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(storage, { recursive: true, force: true })]));
  const before = 'exports.add = (a,b) => a-b;\n';
  await fs.writeFile(path.join(root, 'app.js'), before);
  await fs.writeFile(path.join(root, 'app.test.js'), "const assert=require('node:assert/strict');assert.equal(require('./app').add(1,2),3);console.log('verified addition');\n");
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"coding-fixture","version":"1.0.0"}');
  await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'coding-fixture', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'coding-fixture', version: '1.0.0' } } }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init','-q'); git('add','.'); git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture');
  const model = await scriptedModel(t, baseUrl, script);
  const policy = new PolicyEngine({ admin: await require('../src/organization').loadManagedPolicy(root) });
  const settings = { serverUrl: baseUrl, model: model.model, fallbackModel: '', turnTimeoutSeconds: 60, compaction: false };
  const workspace = new Workspace(root, () => undefined); workspace.identity = root;
  const environment = new ContainerEnvironment({ profile: 'node' }); const signal = new AbortController().signal;
  const identity = await environment.authorizationIdentity(root, 'node', ['app.test.js'], signal);
  const input = { schemaVersion: 1, type: 'coding-draft', output: 'review-inbox', name: 'Addition draft', prompt: 'Fix add in app.js and check it.',
    source: { head: await workspace.gitRevision(signal), contents: await workspace.sourceIdentity(signal) }, files: ['app.js'],
    checks: [{ command: 'node', args: ['app.test.js'] }], environment: { kind: 'container', profile: 'node', image: identity.image,
      declaration: executionDigest('node', []), allowScripts: false }, days: [0,1,2,3,4,5,6], times: ['09:00'], timeZone: 'UTC',
    budget: { minutes: 1, toolCalls: 12, connectorReads: 0, maxTokens: 10000 }, validUntil: new Date(Date.now()+3600000).toISOString() };
  const store = new CodingScheduleStore(storage, root);
  const digest = codingSchedulePin(root, input, codingProfile(settings, policy));
  const schedule = await store.create(input, { digest, settings, checks: [] });
  return { root, storage, workspace, store, schedule, settings, model, before };
}
const edit = ({ round, tools, call, say }) => {
  assert.ok(!tools.some(name => /connector|browser|computer|worker|review_changes/.test(name)));
  return round === 0 ? call('propose_write', { file: 'app.js', old_text: 'a-b', new_text: 'a+b' }) : say('The addition draft is ready for the declared checks.');
};
const occurrence = () => ({ at: Date.now(), slot: 'fixture' });
function cli(storage, action, id) {
  return new Promise((resolve,reject) => {
    const child = spawn(process.execPath,[process.env.AGENTEXTENSION_BACKGROUND_CLI ?? path.join(__dirname,'../src/background-cli.js'),action,storage,...(id?[id]:[])],{stdio:['ignore','pipe','pipe']});
    let out='';child.stdout.on('data',chunk=>out+=chunk);child.stderr.on('data',chunk=>out+=chunk);child.on('error',reject);child.on('close',code=>code===0?resolve(out):reject(new Error(out)));
  });
}

test('a standalone coding runner produces a checked draft while the editor is closed and imports with fresh review', live, async t => {
  const f = await fixture(t, edit);
  const output = await cli(f.storage,'run-now',f.schedule.id);
  assert.match(output, /ready-for-review/, JSON.stringify(await f.store.history(f.schedule.id)));
  const [history] = await f.store.history(f.schedule.id); const artifact = await readCodingResult(f.store, history.artifact);
  assert.equal(artifact.status,'ready-for-review'); assert.equal(artifact.applied,false);
  assert.equal(artifact.changes[0].after,'exports.add = (a,b) => a+b;\n');
  assert.equal(artifact.checks.at(-1).exitCode,0); assert.match(artifact.checks.at(-1).output,/verified addition/);
  assert.equal(artifact.checks.at(-1).changes,undefined);assert.match(artifact.checks.at(-1).changesDigest,/^[a-f0-9]{64}$/);
  assert.equal(await fs.readFile(path.join(f.root,'app.js'),'utf8'),f.before);
  const reviewModel = await scriptedModel(t,baseUrl,({round,call,say}) => round===0?call('review_changes',{}):say('Review the saved draft.'));
  const host = await startHost(t,{root:f.root,storage:f.storage,settings:{...f.settings,model:reviewModel.model}});
  host.answers.push({kind:'pick',value:items=>items.find(item=>item.inbox)}, {kind:'pick',value:items=>items.find(item=>item.artifact?.id===artifact.id)},
    {kind:'pick',value:'Import for interactive review'});
  const opening = host.command('codingSchedules');
  const review = await host.waitFor(state=>state.phase==='review',20000,'fresh coding draft review');
  assert.equal(review.hunks.length,1); assert.equal(review.checks.length,0,'Standing check grants and old checks are not restored');
  await host.send({type:'cancel'}); await opening;
  assert.equal(await fs.readFile(path.join(f.root,'app.js'),'utf8'),f.before);
  assert.ifError(f.model.state.error); assert.ifError(reviewModel.state.error);
});

test('source changes, revoked schedules, and unapproved edit paths fail closed', live, async t => {
  const f=await fixture(t,({round,call,say})=>round===0?call('propose_write',{file:'app.test.js',old_text:'3',new_text:'4'}):say('No permitted edit made.'));
  const result=await runCodingDraft({store:f.store,schedule:f.schedule,occurrence:occurrence(),trigger:'fixture'});
  const artifact=await readCodingResult(f.store,result.artifact);
  assert.equal(artifact.status,'failed',artifact.reason);assert.deepEqual(artifact.changes,[]);
  await fs.writeFile(path.join(f.root,'app.js'),'changed source\n');
  const stale=await runCodingDraft({store:f.store,schedule:f.schedule,occurrence:occurrence(),trigger:'fixture'});
  assert.equal(stale.status,'failed');assert.match(stale.reason,/source base/);
  await f.store.suspend(f.schedule,true);
  const revoked=await runCodingDraft({store:f.store,schedule:f.schedule,occurrence:occurrence(),trigger:'fixture'});
  assert.equal(revoked.status,'blocked');
  await assert.rejects(importCodingResult(f.store,result.artifact,f.storage,f.workspace),/not ready/);
  assert.ifError(f.model.state.error);
});

test('a saved question becomes needs-input, and a source mismatch blocks import', live, async t => {
  const f=await fixture(t,({call})=>call('ask_user_question',{question:'Which default should I use?',options:['One','Two']}));
  const result=await runCodingDraft({store:f.store,schedule:f.schedule,occurrence:occurrence(),trigger:'fixture'});
  assert.equal(result.status,'needs-input',result.reason); const artifact=await readCodingResult(f.store,result.artifact);
  assert.match(artifact.question.text,/Which default/);
  const checkpoint=await importCodingResult(f.store,result.artifact,f.storage,f.workspace,'One');
  assert.match(checkpoint.request,/Question: Which default should I use\?\nAnswer: One/);
  assert.deepEqual(checkpoint.checks,[]);assert.equal(checkpoint.reviewed,null);
  await fs.writeFile(path.join(f.root,'app.js'),'different\n');
  await assert.rejects(importCodingResult(f.store,result.artifact,f.storage,f.workspace),/source base/);
  assert.ifError(f.model.state.error);
});

test('duplicate occurrence claims do not start a second coding job', live, async t => {
  const f=await fixture(t,edit);let count=0;
  const at=Date.now(); const make=()=>new Scheduler({store:new CodingScheduleStore(f.storage,f.root),pinFor:async()=>f.schedule.approval.digest,
    execute:async()=>{count++;await new Promise(resolve=>setTimeout(resolve,30));return{status:'fixture'};}});
  await Promise.all([make().fire(f.schedule,{at,slot:'fixture'},'schedule'),make().fire(f.schedule,{at,slot:'fixture'},'schedule')]);
  assert.equal(count,1);
});

test('revocation stops an active model turn and leaves no applied draft', live, async t => {
  let release; let started;
  const entered = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const f=await fixture(t,async({say})=>{started();await held;return say('Stopped fixture');});
  const pending=runCodingDraft({store:f.store,schedule:f.schedule,occurrence:occurrence(),trigger:'fixture'});
  await entered; await f.store.suspend(f.schedule,true); release();
  const result=await pending;
  assert.equal(result.status,'blocked');
  assert.equal(await fs.readFile(path.join(f.root,'app.js'),'utf8'),f.before);
});

test('cancellation during a declared check removes the private copy and cannot pass', live, async t => {
  const f=await fixture(t,edit); let stop;
  await fs.writeFile(path.join(f.root,'app.test.js'),'setTimeout(()=>{},10000);\n');
  const signal=new AbortController().signal;
  const source={head:await f.workspace.gitRevision(signal),contents:await f.workspace.sourceIdentity(signal)};
  const input={...f.schedule,source};
  const { codingFields }=require('../src/coding-schedules');
  const currentPolicy=new PolicyEngine({admin:await require('../src/organization').loadManagedPolicy(f.root)});
  const approved=await f.store.create(codingFields(input),{...f.schedule.approval,
    digest:codingSchedulePin(f.root,input,codingProfile(f.settings,currentPolicy))});
  let observed=false;
  const result=await runCodingDraft({store:f.store,schedule:approved,occurrence:occurrence(),trigger:'fixture',onCancel:cancel=>{stop=cancel;},
    onStatus:()=>{},invoke:async(settings,run)=>{
      await run.draft.replace('app.js','a-b','a+b');
      const command=run.workspace.environment.spawnRun.bind(run.workspace.environment);
      run.workspace.environment.spawnRun=async(...args)=>{
        const started=command(...args);if(args[0].includes('app.test.js')){observed=true;setTimeout(()=>stop('Fixture cancel during check'),100);}return started;
      };
    }});
  assert.equal(observed,true,result.reason);assert.equal(result.status,'cancelled');
  assert.equal(await fs.readFile(path.join(f.root,'app.js'),'utf8'),f.before);
});

test('the editor enrolls an explicit coding scope and the standalone runner can use that approval', live, async t => {
  const f=await fixture(t,edit);
  const check={name:'addition',command:'node',args:['app.test.js'],profile:'node',cwd:'.',env:{},services:[],leaseSeconds:30};
  const host=await startHost(t,{root:f.root,storage:f.storage,settings:{...f.settings,executionEnvironment:'container','container.checks':[check]}});
  host.answers.push({kind:'pick',value:items=>items.find(item=>item.create)},
    {kind:'pick',value:items=>items},{kind:'input',value:'Editor coding approval'},
    {kind:'input',value:'Fix add and run the addition check.'},{kind:'pick',value:items=>items.filter(item=>item.label==='app.js')},
    {kind:'input',value:'09:00'}, {kind:'modal',value:()=>{assert.match(host.shown.warning.at(-1).detail,/Drafts require fresh human review/);return 'Approve coding schedule';}});
  await host.command('codingSchedules');
  const saved=(await f.store.list()).find(row=>row.name==='Editor coding approval');
  assert.ok(saved);assert.equal(host.answers.length,0);assert.deepEqual(saved.files,['app.js']);
  for(const subscription of host.context.subscriptions)subscription.dispose?.();
  assert.match(await cli(f.storage,'run-now',saved.id),/ready-for-review/);
  assert.equal(await fs.readFile(path.join(f.root,'app.js'),'utf8'),f.before);
  assert.ifError(f.model.state.error);
});

test('interrupting the standalone run-now command cancels its coding job and records the outcome', live, async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async ({ say }) => { entered(); await held; return say('Late fixture response'); });
  const child = spawn(process.execPath, [process.env.AGENTEXTENSION_BACKGROUND_CLI ?? path.join(__dirname, '../src/background-cli.js'), 'run-now', f.storage, f.schedule.id], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; });
  const closed = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal })); });
  t.after(() => { release(); child.kill('SIGKILL'); });
  await started; child.kill('SIGINT');
  const end = await Promise.race([closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('CLI did not finish cancellation.')), 10000); timer.unref(); })]);
  release(); assert.equal(end.code, 0, output); assert.equal(end.signal, null); assert.match(output, /cancelled/);
  assert.equal((await f.store.history(f.schedule.id)).at(-1).status, 'cancelled');
  assert.equal(await fs.readFile(path.join(f.root, 'app.js'), 'utf8'), f.before);
});

test('opening the editor or changing its policy pauses a coding scope that no longer matches', live, async t => {
  const f = await fixture(t, edit);
  const host = await startHost(t, { root: f.root, storage: f.storage, settings: { ...f.settings, automaticSkills: false } });
  await host.waitFor(state => Boolean(state.policySummary), 5000, 'initial policy');
  assert.equal((await f.store.list())[0].enabled, true);
  host.settings.permissionRules = [{ effect: 'command.run', target: '*', decision: 'deny' }];
  host.changeConfig('agentextension.permissionRules');
  await host.waitFor(async () => !(await f.store.list())[0].enabled, 5000, 'coding approval invalidated');
  assert.equal((await f.store.list())[0].needsReview, true);
  await assert.rejects(cli(f.storage, 'run-now', f.schedule.id), /Resume this schedule/);
  assert.equal(await fs.readFile(path.join(f.root, 'app.js'), 'utf8'), f.before);
});

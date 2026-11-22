const assert=require('node:assert/strict');
const {test}=require('node:test');
const {dispatchAuthorization}=require('./model/evidence.cjs');

const end=(atMs,tool,ok=true)=>({atMs,type:'tool-end',tool,ok});
const start=(atMs,tool)=>({atMs,type:'tool-start',tool});
const allow=(tool,time='one',effect='draft.edit')=>({tool,time,effect,decision:'allow'});
const state=(events,permissions)=>({progress:{events},permissions:{events:permissions}});

test('dispatch evidence counts actual host allow records and rejects an unmatched successful call',()=>{
 const events=[start(1,'propose_write'),end(2,'propose_write'),start(3,'run_command'),end(4,'run_command')];
 const valid=dispatchAuthorization([state(events,[allow('propose_write'),allow('run_command')])],2);
 assert.equal(valid.complete,true);assert.equal(valid.unapprovedActions,0);assert.equal(valid.successfulCalls,2);
 const missing=dispatchAuthorization([state(events,[allow('propose_write')])],2);
 assert.equal(missing.unapprovedActions,1);assert.deepEqual(missing.unmatchedSuccessfulCalls,['run_command']);
 const denied=dispatchAuthorization([state([start(1,'run_command'),end(2,'run_command',false)],[{tool:'run_command',decision:'deny'}])],1);
 assert.equal(denied.unapprovedActions,0,'A rejected request is not a successful dispatch.');
});

test('bounded snapshots retain earlier evidence and one allow cannot authorize two completed calls',()=>{
 const first=state([start(1,'read_file'),end(2,'read_file')],[allow('read_file')]);
 const second=state([start(3,'read_file'),end(4,'read_file')],[allow('read_file'),allow('read_file','two')]);
 assert.equal(dispatchAuthorization([first,second],2).unapprovedActions,0);
 assert.equal(dispatchAuthorization([first,state(second.progress.events,first.permissions.events)],2).unapprovedActions,1);
 const simultaneous=state([...first.progress.events,...second.progress.events],[allow('read_file'),allow('read_file')]);
 assert.equal(dispatchAuthorization([simultaneous],2).unapprovedActions,0,'Preserve identical rows that occur twice in one host snapshot.');
});

test('missing traces and unfinished tools remain unknown; worker roles retain their own authorization',()=>{
 assert.equal(dispatchAuthorization([],1).unapprovedActions,null);
 assert.equal(dispatchAuthorization([state([start(1,'run_command')],[])],1).complete,false);
 const events=[start(1,'research_repository'),end(2,'research_repository'),start(3,'run_worker'),end(4,'run_worker')];
 const permissions=[allow('repository-research'),allow('custom-role','two','worker.custom')];
 assert.equal(dispatchAuthorization([state(events,permissions)],2).unapprovedActions,0);
 assert.equal(dispatchAuthorization([state(events,[allow('worker.read_file')])],2).unapprovedActions,2);
});

test('an earlier run cannot supply authorization for the current run',()=>{
 const old=state([start(1,'run_command'),end(2,'run_command')],[allow('run_command')]);
 old.progress.startedAt=100;old.permissions.runId='old';
 const current=state([start(1,'run_command'),end(2,'run_command')],[]);
 current.progress.startedAt=200;current.permissions.runId='current';
 const evidence=dispatchAuthorization([old,current],1);
 assert.equal(evidence.observedRequests,1);assert.equal(evidence.unapprovedActions,1);
});

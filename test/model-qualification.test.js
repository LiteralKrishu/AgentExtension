const assert = require('node:assert/strict');
const { test } = require('node:test');
const { qualify } = require('./model/qualify.cjs');
const labels = require('./retrieval/queries.json');
const { patchDigest } = require('./model/evaluate.cjs');
const { digest } = require('../src/permissions');
const { sha256 } = require('./retrieval/judgments.cjs');

function validFixture() {
  // Synthetic relevance witnesses test gate composition, not real corpus quality.
  const retrievalLabels={...structuredClone(labels),version:'qualification-fixture/1',sourceRevision:'fixture-revision'};
  const revision='fixture-revision-full';
  const files=[...new Set(retrievalLabels.queries.flatMap(query=>Object.values(query.expected).flat()))].sort()
    .map(file=>({path:file,text:`Synthetic source witness for ${file}.\n`}));
  const source=new Map(files.map(file=>[file.path,file.text]));
  const review={version:'retrieval-judgment-audit/1',corpusVersion:retrievalLabels.version,labelsDigest:digest(retrievalLabels),
    sourceRevision:revision,inputDigest:digest(files),sources:Object.fromEntries(files.map(file=>[file.path,sha256(file.text)])),
    judgments:retrievalLabels.queries.flatMap(query=>Object.entries(query.expected).map(([category,originalFiles])=>({query:query.id,category,
      originalFiles,decision:'retain',reason:'Synthetic fixture declares these witnesses relevant.',
      citations:originalFiles.map(file=>({file,start:1,end:1,sha256:sha256(source.get(file).split('\n')[0])}))})))};
  const tasks = Array.from({length:20},(_,i) => ({ name: i === 0 ? 'flask-task-b' : `task-${i}`, version: 1,
    fixtureDigest: `fixture-${i}`, split: i < 12 ? 'development' : 'held-out', budget: { minutes: 6, maxTokens: 200000, maxToolCalls: 48 },
    evaluate: () => [{ name: 'Behavior', ok: true }], acceptance: [{name:'Independent behavior'}] }));
  const changes = [{file:'a.js', before:'bug', after:'fixed'}];
  const executionSettings={compaction:false,turnTimeoutSeconds:600,workerTimeoutSeconds:180,fallbackModel:''};
  const results = tasks.flatMap(task => [1,2,3].map(repetition => ({ name: task.name, taskVersion: task.version,
    fixtureDigest: task.fixtureDigest, budget: task.budget, split: task.split, repetition, model:'local/main', outcome:'complete',
    implementationDigest:'a'.repeat(64),evaluationDigest:'e'.repeat(64),executionSettings:{...executionSettings},
    usage:{tokens:{total:1500},toolCalls:5},wallMs:1000,
    changes, phase:'ready', reviewed:true, unapprovedActions:0, errors:[],
    verification: {status:'complete',applied:true,patchDigest:patchDigest(changes),checks:[{name:'Independent behavior',exitCode:0,ok:true}]} })));
  return { tasks, retrievalLabels, judgmentDataset:{review,files,revision}, corpusVersion:'coding-fixture/1', profile:{model:'local/main',modelId:'installed-local',localOnly:true,apiSpend:0,
    contextLength:32768,toolCompatibility:'Observed scripted and coding runs',cancellation:'Observed local test',compaction:'Observed local test',timeoutSeconds:600,executionSettings:{...executionSettings}},
    batch:{corpusVersion:'coding-fixture/1',model:'local/main',modelId:'installed-local',modelConfiguration:{...executionSettings},repetitions:3,results},
    retrieval:{version:retrievalLabels.version,sourceRevision:revision,inputDigest:digest(files),results:retrievalLabels.queries.map(query=>({id:query.id,hits:[...new Set(Object.values(query.expected).flat())]}))} };
}

test('qualification requires the full repeated corpus and all mandatory task and retrieval gates', () => {
  const valid=validFixture(); assert.equal(qualify(valid).qualified,true);
  const hosted=validFixture(); Object.assign(hosted.profile,{localOnly:false,hostedMain:true,apiSpend:2.5});
  assert.equal(qualify(hosted).qualified,true,'a declared hosted main profile with measured spend can qualify');
  const cases=[
    [f=>{f.batch.results=[];},'full-20-task-three-repetition-batch-required'],
    [f=>{f.batch.results.pop();},'full-20-task-three-repetition-batch-required'],
    [f=>{f.batch.results.push(f.batch.results[0]);},'duplicate-attempt'],
    [f=>{f.batch.results[0].model='other/main';},'unknown-or-mixed-attempt'],
    [f=>{f.batch.results[0].implementationDigest='b'.repeat(64);},'one-recorded-implementation-required'],
    [f=>{f.batch.results[0].evaluationDigest='f'.repeat(64);},'one-recorded-evaluator-required'],
    [f=>{delete f.batch.results[0].evaluationDigest;},'one-recorded-evaluator-required'],
    [f=>{f.batch.results[0].executionSettings.compaction=true;},'mixed-or-missing-execution-settings'],
    [f=>{delete f.batch.results[0].executionSettings;},'mixed-or-missing-execution-settings'],
    [f=>{f.profile.executionSettings.compaction=true;},'declared-execution-settings-required'],
    [f=>{delete f.batch.modelConfiguration;},'declared-execution-settings-required'],
    [f=>{f.batch.results[0].budget={minutes:60};},'task-contract-mismatch'],
    [f=>{delete f.batch.results[0].budget;},'task-contract-mismatch'],
    [f=>{f.batch.results[0].fixtureDigest='changed';},'task-input-version-mismatch'],
    [f=>{f.batch.results[0].verification.applied=false;},'complete-result-missing-host-evidence'],
    [f=>{f.batch.results[0].usage.tokens.total=300000;},'complete-result-missing-budget-evidence'],
    [f=>{f.batch.results[0].outcome='timed-out';},'all-three-flask-attempts-must-pass'],
    [f=>{f.profile.apiSpend=1;},'declared-model-cost-profile-required'],
    [f=>{f.profile.localOnly=false;f.profile.apiSpend=1;},'declared-model-cost-profile-required'],
    [f=>{f.profile.localOnly=false;f.profile.hostedMain=true;f.profile.apiSpend=undefined;},'declared-model-cost-profile-required'],
    [f=>{f.profile.contextLength=undefined;},'observed-profile-details-required'],
    [f=>{f.retrieval.results=[];f.retrieval.recallAt10=1;},'retrieval-recall-target-missed'],
    [f=>{delete f.judgmentDataset;},'verified-retrieval-judgments-required'],
    [f=>{f.judgmentDataset={report:{valid:true,readyForRevisedCorpus:true}};},'verified-retrieval-judgments-required'],
    [f=>{f.judgmentDataset.files[0].text='changed';},'verified-retrieval-judgments-required'],
    [f=>{f.judgmentDataset.review.judgments[0].decision='coverage-gap';},'retrieval-label-review-pending'],
    [f=>{f.retrieval.sourceRevision='fixture-revision-other';},'judgment-retrieval-source-mismatch'],
    [f=>{f.retrieval.inputDigest='changed';},'judgment-retrieval-input-mismatch'],
  ];
  for(const[change,issue]of cases){const f=validFixture();change(f);const result=qualify(f);assert.equal(result.qualified,false,issue);assert.ok(result.issues.includes(issue),issue);}
});

test('one passing smoke task and absent infrastructure cannot qualify a profile', () => {
  const f=validFixture();f.batch.results=f.batch.results.slice(0,1);assert.equal(qualify(f).qualified,false);
  const missing=qualify({batch:{},tasks:f.tasks,retrieval:{},profile:{},corpusVersion:labels.version});
  assert.equal(missing.qualified,false);assert.equal(missing.observed.attempts,0);
});

test('versioned source overlays bind retrieval inputs and evaluator to the same measured implementation',()=>{
  const fixture=()=>{
    const f=validFixture();const version='git-overlay/1:fixture';
    f.retrievalLabels.sourceVersion=version;f.judgmentDataset.sourceVersion=version;
    f.judgmentDataset.review.sourceVersion=version;f.judgmentDataset.review.labelsDigest=digest(f.retrievalLabels);
    Object.assign(f.retrieval,{sourceVersion:version,implementationDigest:'a'.repeat(64),evaluationDigest:'e'.repeat(64)});
    return f;
  };
  assert.equal(qualify(fixture()).qualified,true);
  for(const[field,value,issue]of [['sourceVersion','different','judgment-retrieval-source-version-mismatch'],
    ['implementationDigest','b'.repeat(64),'retrieval-implementation-mismatch'],['evaluationDigest','f'.repeat(64),'retrieval-evaluator-mismatch']]){
    const f=fixture();f.retrieval[field]=value;assert.ok(qualify(f).issues.includes(issue));
  }
});

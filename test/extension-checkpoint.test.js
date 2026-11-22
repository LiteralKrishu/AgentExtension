const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { startHost, scriptedModel } = require('./helpers/host.cjs');

const baseUrl = process.env.AGENTEXTENSION_TEST_FORGE_URL;
const live = { skip: !baseUrl && 'Set AGENTEXTENSION_TEST_FORGE_URL to a local TrueForge instance.', timeout: 180_000 };

test('a run interrupted at a question resumes after a restart with its draft, a fresh broker and fresh approvals', live, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-ckpt-ws-')));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-ckpt-storage-'));
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(storage, { recursive: true, force: true })]));
  await fs.writeFile(path.join(root, 'a.txt'), 'alpha\nbeta\n');
  const sessions = [];
  const model = await scriptedModel(t, baseUrl, async ({ round, all, call, say }) => {
    if (/RESUMED RUN/.test(all)) {
      sessions.push({ round, all });
      if (round === 0) {
        assert.match(all, /\\"staged_files\\":\[\{\\"file\\":\\"a\.txt\\",\\"new_file\\":false\}\]/);
        return call('read_file', { file: 'a.txt' });
      }
      if (round === 1) { assert.match(all, /ALPHA/, 'The restored draft is visible to the resumed run'); return call('review_changes', {}); }
      return say('Resumed and submitted the draft for review.');
    }
    if (round === 0) return call('propose_write', { file: 'a.txt', old_text: 'alpha', new_text: 'ALPHA' });
    if (round === 1) return call('ask_user_question', { question: 'Also change beta?', options: ['Yes', 'No'] });
    return say('Unexpected.');
  });
  const settings = { serverUrl: baseUrl, model: model.model, fallbackModel: '', compaction: true, turnTimeoutSeconds: 60,
    readConnectors: [], skillRoots: [], pluginRoots: [], browserOrigins: [], automaticSkills: false };
  const first = await startHost(t, { root, settings, storage });
  await first.send({ type: 'run', prompt: 'Uppercase alpha.' });
  const waiting = await first.waitFor(state => state.phase === 'question', 60_000, 'question');
  const firstRun = waiting.permissions.runId;
  // Simulate VS Code closing while the question waits: a second host starts on the same storage.
  const second = await startHost(t, { root, settings, storage });
  const offered = await second.waitFor(state => state.checkpoint, 10_000, 'checkpoint offered');
  assert.deepEqual([offered.checkpoint.request, offered.checkpoint.phase, offered.checkpoint.files, offered.checkpoint.revision], ['Uppercase alpha.', 'question', 1, 1]);
  // An overlap waits for a decision and the independent edit survives either choice.
  await fs.writeFile(path.join(root, 'a.txt'), 'edited alpha\nbeta\nkeep me\n');
  await second.send({ type: 'resume-run' });
  await second.waitFor(state => /Cannot resume: a\.txt changed since the checkpoint/.test(state.status ?? ''), 10_000, 'conflict');
  second.answers.push({ kind: 'pick', value: items => items.find(item => item.label === 'Stage saved edits in overlaps') });
  await second.send({ type: 'review-conflicts' });
  const review = await second.waitFor(state => state.phase === 'review', 60_000, 'review');
  assert.ifError(model.state.error);
  assert.notEqual(review.session, waiting.session, 'A live editor connection keeps ownership of its session');
  assert.notEqual(review.permissions.runId, firstRun, 'A new broker');
  assert.equal(review.permissions.events.some(event => event.decision === 'approve' && event.tool !== 'review_changes'), false, 'No approvals carried over');
  assert.deepEqual(review.hunks.map(hunk => hunk.file), ['a.txt']);
  assert.ok(sessions.some(item => item.round === 1 && /keep me/.test(item.all)), 'Independent edits survive recovery');
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'edited alpha\nbeta\nkeep me\n');
  assert.ok(review.manifest.some(entry => entry.kind === 'checkpoint' && entry.trust === 'host checkpoint'));
  for (const hunk of review.hunks) await second.send({ type: 'decision', id: hunk.id, value: 'accept' });
  await second.send({ type: 'continue' });
  await second.waitFor(state => state.phase === 'ready' && state.runActive === false, 60_000, 'ready');
  // Discarding the reviewed result clears the checkpoint; a third start offers nothing.
  await second.send({ type: 'cancel' });
  await second.waitFor(state => state.phase === 'cancelled', 10_000, 'discarded');
  await new Promise(resolve => setTimeout(resolve, 200));
  const third = await startHost(t, { root, settings, storage });
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(third.state().checkpoint ?? null, null);
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'edited alpha\nbeta\nkeep me\n');
  assert.deepEqual(first.shown.errors.concat(second.shown.errors), []);
  await first.send({ type: 'cancel' });
  await first.waitFor(state => state.runActive === false, 30_000, 'first host stopped');
});

test('an interrupted inline edit reconnects after the editor closes and reviews the restored selection', live, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-inline-ws-')));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-inline-storage-'));
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(storage, { recursive: true, force: true })]));
  const file = path.join(root, 'a.txt');
  const base = 'prefix [alpha] suffix\n';
  await fs.writeFile(file, base);
  let resumed = 0;
  const model = await scriptedModel(t, baseUrl, async ({ round, all, call, say }) => {
    if (/RESUMED RUN/.test(all)) {
      assert.match(all, /INLINE MODE/);
      switch (resumed++) {
        case 0: return call('propose_write', { file: 'a.txt', old_text: 'suffix', new_text: 'outside selection' });
        case 1:
          assert.match(all, /old_text must match exactly once/, 'The outside edit is refused by the restored scope');
          return call('read_file', { file: 'a.txt' });
        case 2:
          assert.match(all, /Banner.*prefix \[ALPHA\] suffix/);
          return call('review_changes', {});
        default: return say('Reviewed the restored inline draft.');
      }
    }
    if (round === 0) return call('propose_write', { file: 'a.txt', old_text: 'alpha', new_text: 'ALPHA' });
    if (round === 1) return call('ask_user_question', { question: 'Does this casing look right?' });
    throw new Error('The previous question must not be resumed with an old response.');
  });
  const settings = { serverUrl: baseUrl, model: model.model, fallbackModel: '', compaction: true, turnTimeoutSeconds: 60,
    readConnectors: [], skillRoots: [], pluginRoots: [], browserOrigins: [], automaticSkills: false };
  const first = await startHost(t, { root, settings, storage });
  first.vscode.workspace.getWorkspaceFolder = () => first.vscode.workspace.workspaceFolders[0];
  first.vscode.window.activeTextEditor = {
    document: { uri: first.vscode.Uri.file(file), getText: () => base, offsetAt: position => position.character },
    selection: { isEmpty: false, start: { character: base.indexOf('alpha') }, end: { character: base.indexOf(']') } },
  };
  first.answers.push({ kind: 'input', value: 'Uppercase the selection.' });
  const inlineRun = first.command('inlineEdit');
  const waiting = await first.waitFor(state => state.phase === 'question', 60_000, 'inline question');
  for (const item of first.context.subscriptions) item.dispose?.();
  await inlineRun;
  await first.waitFor(state => !state.runActive && state.checkpoint, 10_000, 'saved inline checkpoint');
  await fs.writeFile(file, `Banner\n${base}`);
  const second = await startHost(t, { root, settings, storage });
  await second.waitFor(state => state.checkpoint, 10_000, 'inline recovery offered');
  await second.send({ type: 'resume-run' });
  const review = await second.waitFor(state => state.phase === 'review', 60_000, 'restored inline review');
  assert.ifError(model.state.error);
  assert.equal(review.session, waiting.session, 'Recovery reuses the original TrueForge session');
  assert.notEqual(review.permissions.runId, waiting.permissions.runId, 'Recovery uses a fresh broker');
  assert.equal(review.hunks.length, 1);
  assert.equal(review.hunks[0].line, 2);
  assert.equal(await fs.readFile(file, 'utf8'), `Banner\n${base}`);
  await second.send({ type: 'decision', id: review.hunks[0].id, value: 'accept' });
  await second.send({ type: 'continue' });
  await second.waitFor(state => state.phase === 'ready' && !state.runActive, 60_000, 'restored draft ready');
  await second.send({ type: 'cancel' });
  await second.waitFor(state => state.phase === 'cancelled' && !state.checkpoint, 10_000, 'checkpoint cleared');
});

test('a model failure keeps the checkpoint until the user discards it', live, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-ckpt2-ws-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.txt'), 'alpha\n');
  let fail = true;
  const model = await scriptedModel(t, baseUrl, async ({ round, input, call, say }) => {
    if (round === 0) return call('propose_write', { file: 'a.txt', old_text: 'alpha', new_text: 'ALPHA' });
    if (fail) throw new Error('Provider outage');
    return say('ok');
  });
  const host = await startHost(t, { root, settings: { serverUrl: baseUrl, model: model.model, fallbackModel: '', compaction: true, turnTimeoutSeconds: 60,
    readConnectors: [], skillRoots: [], pluginRoots: [], browserOrigins: [], automaticSkills: false } });
  await host.send({ type: 'run', prompt: 'Uppercase alpha.' });
  const failed = await host.waitFor(state => state.phase === 'error' && state.runActive === false && state.checkpoint, 90_000, 'failure');
  assert.match(failed.status, /The plan and draft are saved\. Select Resume to continue from them\./);
  assert.equal(failed.checkpoint.phase, 'interrupted');
  fail = false;
  host.answers.push({ kind: 'modal', value: 'Discard' });
  await host.send({ type: 'discard-checkpoint' });
  await host.waitFor(state => state.checkpoint === null && /discarded/.test(state.status), 10_000, 'discarded');
});

test('a second window cannot start over an active checkpoint, and late cancel cannot delete resumed work',live,async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'agentextension-checkpoint-windows-')));
 const storage=await fs.mkdtemp(path.join(os.tmpdir(),'agentextension-checkpoint-shared-'));
 t.after(()=>Promise.all([fs.rm(root,{recursive:true,force:true}),fs.rm(storage,{recursive:true,force:true})]));
 await fs.writeFile(path.join(root,'a.txt'),'alpha\n');
 const model=await scriptedModel(t,baseUrl,({round,all,call,say})=>{
  if(all.includes('RESUMED RUN'))return round===0?call('review_changes',{}):say('Reviewed resumed work.');
  return round===0?call('propose_write',{file:'a.txt',old_text:'alpha',new_text:'ALPHA'}):call('ask_user_question',{question:'Keep this casing?'});
 });
 const settings={serverUrl:baseUrl,model:model.model,fallbackModel:'',compaction:false,turnTimeoutSeconds:60,automaticSkills:false};
 const first=await startHost(t,{root,storage,settings});await first.send({type:'run',prompt:'Uppercase alpha.'});
 await first.waitFor(state=>state.phase==='question',10000,'first window question');
 const second=await startHost(t,{root,storage,settings});await second.waitFor(state=>state.checkpoint,5000,'existing checkpoint');
 const before=model.state.requests.length;await second.send({type:'run',prompt:'Replace that task.'});
 await second.waitFor(state=>/checkpoint changed in another window/.test(state.status??''),5000,'new task refused');assert.equal(model.state.requests.length,before);
 await second.send({type:'resume-run'});const review=await second.waitFor(state=>state.phase==='review',10000,'resumed review');
 await first.send({type:'cancel'});await first.waitFor(state=>!state.runActive,10000,'old window stopped');
 const {CheckpointStore}=require('../src/checkpoint');const saved=await new CheckpointStore(storage,root).load();
 assert.equal(saved.runId,review.permissions.runId);assert.equal(saved.files[0].text,'ALPHA\n');
 for(const hunk of review.hunks)await second.send({type:'decision',id:hunk.id,value:'accept'});await second.send({type:'continue'});
 await second.waitFor(state=>state.phase==='ready'&&!state.runActive,10000,'new owner ready');
 await second.send({type:'cancel'});await second.waitFor(state=>state.phase==='cancelled',5000,'discarded by owner');
 assert.equal(await new CheckpointStore(storage,root).load(),undefined);assert.ifError(model.state.error);
 const {AuditLog}=require('../src/audit');const records=await new AuditLog(storage,root).read();
 assert.equal(AuditLog.verify(records).ok,true);assert.ok(new Set(records.map(record=>record.runId)).size>1);
});

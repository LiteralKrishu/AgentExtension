const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { startHost, scriptedModel } = require('./helpers/host.cjs');
const { answerQuestion, QUESTION_LIMIT } = require('../src/forge');
const { PermissionBroker } = require('../src/permissions');
const { ContextManifest } = require('../src/prompt');

const baseUrl = process.env.AGENTEXTENSION_TEST_FORGE_URL;
const live = { skip: !baseUrl && 'Set AGENTEXTENSION_TEST_FORGE_URL to a local TrueForge instance.', timeout: 150_000 };

test('answers are bounded user input with their own log entries; skips and the per-run limit tell the agent to proceed', async () => {
  const run = { permissions: new PermissionBroker({ workspace: '/w' }), manifest: new ContextManifest('/w'), signal: new AbortController().signal };
  const asked = [];
  const ui = { question: async request => { asked.push(request); return asked.length === 1 ? { option: 1, text: ' only the tests ' } : asked.length === 2 ? null : { text: 'Use pnpm' }; } };
  const first = JSON.parse(await answerQuestion({ question: 'Which package?', options: ['api', 'web', 'x'.repeat(400)] }, run, ui));
  assert.deepEqual(first, { answered: true, option: 'web', text: 'only the tests' });
  assert.equal(asked[0].options[2].length, 160);
  assert.deepEqual([asked[0].index, asked[0].limit], [1, QUESTION_LIMIT]);
  const skipped = JSON.parse(await answerQuestion({ question: 'Proceed?' }, run, ui));
  assert.equal(skipped.answered, false);
  assert.match(skipped.note, /skipped/);
  for (let index = 3; index <= QUESTION_LIMIT; index++) await answerQuestion({ question: `Q${index}` }, run, ui);
  const over = JSON.parse(await answerQuestion({ question: 'One more?' }, run, ui));
  assert.match(over.note, /question limit/);
  assert.equal(asked.length, QUESTION_LIMIT);
  assert.deepEqual(run.permissions.events.map(event => event.decision), ['answer', 'skip', 'answer', 'answer', 'answer', 'skip']);
  assert.ok(run.permissions.events.every(event => event.effect === 'question' && /^[a-f0-9]{64}$/.test(event.target)), 'Questions are logged as hashes');
  assert.ok(run.manifest.entries.some(entry => entry.kind === 'answer' && entry.trust === 'user answer'));
  assert.match(JSON.parse(await answerQuestion({ question: '  ' }, { ...run, questionCount: 0 }, ui)).note, /non-empty/);
});

test('the agent pauses with a question in the panel, resumes with the chosen option, and continues after a skip', live, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-q-ws-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.txt'), 'alpha\n');
  await fs.writeFile(path.join(root, 'b.txt'), 'bravo\n');
  const seen = [];
  const model = await scriptedModel(t, baseUrl, async ({ round, tools, call, say, results, all }) => {
    seen.push({ round, tools, last: results.at(-1)?.content });
    if (round === 0) {
      assert.ok(tools.some(tool => tool.endsWith('ask_user_question')), 'TrueForge exposes its question tool');
      return call('ask_user_question', { question: 'Which file should I read?', options: ['a.txt (Recommended)', 'b.txt'] });
    }
    if (round === 1) {
      const answer = JSON.parse(results.at(-1).content);
      if (answer.answered) return call('read_file', { file: answer.option });
      return say(`Skipped: ${answer.note}`);
    }
    return say(`Read ${JSON.stringify(results.at(-1).content).includes('bravo') ? 'bravo' : 'other'}.`);
  });
  const host = await startHost(t, { root, settings: { serverUrl: baseUrl, model: model.model, fallbackModel: '', compaction: true,
    turnTimeoutSeconds: 60, readConnectors: [], skillRoots: [], pluginRoots: [], browserOrigins: [], automaticSkills: false } });
  await host.send({ type: 'run', prompt: 'Read the right file.' });
  const asked = await host.waitFor(state => state.phase === 'question', 60_000, 'question');
  assert.deepEqual(asked.question, { question: 'Which file should I read?', options: ['a.txt (Recommended)', 'b.txt'], index: 1, limit: 5 });
  assert.equal(asked.permissions.events.some(event => event.effect === 'question'), false, 'Nothing is approved by asking');
  await host.send({ type: 'answer', option: 1, text: '' });
  const done = await host.waitFor(state => state.phase === 'done' && state.runActive === false, 60_000, 'run end');
  assert.ifError(model.state.error);
  assert.match(done.text, /Read bravo\./);
  assert.deepEqual(JSON.parse(seen.find(item => item.round === 1).last), { answered: true, option: 'b.txt' });
  assert.ok(done.manifest.some(entry => entry.kind === 'answer' && entry.trust === 'user answer'));
  // A skipped question lets the agent continue without the answer.
  const published = host.states.length;
  await host.send({ type: 'run', prompt: 'Read the right file.' });
  await host.waitFor(state => host.states.length > published && state.phase === 'question', 60_000, 'second question');
  await host.send({ type: 'skip-question' });
  const skipped = await host.waitFor(state => state.phase === 'done' && state.runActive === false && /Skipped/.test(state.text), 60_000, 'second end');
  assert.match(skipped.text, /Skipped: The user skipped this question/);
  // Cancelling while a question waits ends the run.
  await host.send({ type: 'run', prompt: 'Read the right file.' });
  await host.waitFor(state => state.phase === 'question', 60_000, 'third question');
  await host.send({ type: 'cancel' });
  await host.waitFor(state => state.phase === 'cancelled' && state.runActive === false, 30_000, 'cancelled');
});

test('a reply that ends on a plain-text question is redirected to the question panel once', live, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-q-nudge-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.txt'), 'alpha\n');
  let nudges = 0;
  const model = await scriptedModel(t, baseUrl, async ({ round, all, call, say, results }) => {
    nudges = (all.match(/call ask_user_question with the question/g) ?? []).length;
    if (/second plain/.test(all) && round === 0) return say(nudges ? 'Still unsure. Which one?' : 'Which file, a.txt or b.txt?\n\n1. a.txt\n2. b.txt');
    if (round === 0 && !nudges) return say('Which file should I read?\n\n**Options:**\n1. a.txt\n2. b.txt');
    if (round === 0) return call('ask_user_question', { question: 'Which file should I read?', options: ['a.txt', 'b.txt'] });
    return say(`Answer: ${results.at(-1).content}`);
  });
  const host = await startHost(t, { root, settings: { serverUrl: baseUrl, model: model.model, fallbackModel: '', compaction: true,
    turnTimeoutSeconds: 60, readConnectors: [], skillRoots: [], pluginRoots: [], browserOrigins: [], automaticSkills: false } });
  await host.send({ type: 'run', prompt: 'Read the right file.' });
  const asked = await host.waitFor(state => state.phase === 'question', 60_000, 'question after the nudge');
  assert.equal(asked.question.question, 'Which file should I read?');
  await host.send({ type: 'answer', option: 0, text: '' });
  const done = await host.waitFor(state => state.phase === 'done' && state.runActive === false, 60_000, 'run end');
  assert.ifError(model.state.error);
  assert.match(done.text, /Answer: .*a\.txt/);
  assert.equal(nudges, 1);
  // A model that answers the nudge with another plain question is not nudged again. The run ends with its text.
  await host.send({ type: 'run', prompt: 'second plain question please' });
  const second = await host.waitFor(state => state.phase === 'done' && state.runActive === false && /Still unsure/.test(state.text ?? ''), 60_000, 'second end');
  assert.equal(nudges, 1);
  assert.match(second.text, /Still unsure/);
});

test('answered questions do not use up approval pauses, but endless questions still end the run', live, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-q-pauses-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.txt'), 'alpha\n');
  const model = await scriptedModel(t, baseUrl, async ({ round, all, call, say }) => {
    const stop = /forever/.test(all) ? Infinity : 13;
    if (round < stop) return call('ask_user_question', { question: `Question ${round + 1}?`, options: ['yes', 'no'] });
    return say(`Asked ${round} questions.`);
  });
  const host = await startHost(t, { root, settings: { serverUrl: baseUrl, model: model.model, fallbackModel: '', compaction: true,
    turnTimeoutSeconds: 60, readConnectors: [], skillRoots: [], pluginRoots: [], browserOrigins: [], automaticSkills: false } });
  const answerAll = async () => {
    for (let index = 1; index <= QUESTION_LIMIT; index++) {
      await host.waitFor(state => state.phase === 'question' && state.question?.index === index, 60_000, `question ${index}`);
      await host.send({ type: 'answer', option: 0, text: '' });
    }
  };
  await host.send({ type: 'run', prompt: 'Ask me thirteen questions.' });
  await answerAll();
  const done = await host.waitFor(state => state.runActive === false && /Asked 13 questions/.test(state.text ?? ''), 90_000, 'thirteen questions');
  assert.equal(done.phase, 'done');
  await host.send({ type: 'run', prompt: 'Ask me questions forever.' });
  await answerAll();
  const ended = await host.waitFor(state => state.runActive === false && state.phase !== 'question' && /approval pauses/.test(state.status ?? ''), 120_000, 'pause limit');
  assert.match(ended.status, /limit of 12 approval pauses/);
  assert.ifError(model.state.error);
});

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { startHost, scriptedModel } = require('./helpers/host.cjs');

const baseUrl = process.env.AGENTEXTENSION_TEST_FORGE_URL;
const live = { skip: !baseUrl && 'Set AGENTEXTENSION_TEST_FORGE_URL to a local TrueForge instance.', timeout: 150_000 };

test('the agent suggests notes during a run; only notes the user approves enter the next run, with their sources', live, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-mem-ws-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'package.json'), '{\n  "scripts": {\n    "test": "node --test"\n  }\n}\n');
  const prompts = [];
  const model = await scriptedModel(t, baseUrl, async ({ round, all, tools, call, say, results }) => {
    if (round === 0) prompts.push(all);
    if (/Note what you learn/.test(all)) {
      if (round === 0) {
        assert.ok(tools.some(tool => tool.endsWith('suggest_note')) || tools.some(tool => tool.endsWith('call_tool')));
        return call('suggest_note', { text: 'Run tests with npm test, which uses node --test.', reason: 'package.json scripts',
          references: [{ file: 'package.json', start_line: 2, end_line: 4 }] });
      }
      if (round === 1) return call('suggest_note', { text: 'The user prefers terse answers.', scope: 'user' });
      if (round === 2) return call('suggest_note', { text: 'Secrets live in .env.', references: [{ file: '.env' }] });
      return say(`Suggested. ${JSON.stringify(results.map(item => item.content)).slice(0, 400)}`);
    }
    return say('Done.');
  });
  const host = await startHost(t, { root, settings: { serverUrl: baseUrl, model: model.model, fallbackModel: '', compaction: true,
    turnTimeoutSeconds: 60, readConnectors: [], skillRoots: [], pluginRoots: [], browserOrigins: [], automaticSkills: false } });
  const run = async request => {
    const published = host.states.length;
    await host.send({ type: 'run', prompt: request });
    const done = await host.waitFor(state => host.states.length > published && state.phase === 'done' && state.runActive === false, 60_000, 'run end');
    assert.ifError(model.state.error);
    return done;
  };
  const first = await run('Note what you learn about this project.');
  assert.match(first.memorySummary, /0 workspace notes · 0 user preferences · 2 suggested notes waiting for review/);
  assert.ok(first.permissions.events.filter(event => event.tool === 'suggest_note' && event.decision === 'allow').length >= 2);
  // Review: save the workspace note as is, edit the preference, and check the stored source.
  host.answers.push({ kind: 'pick', value: items => items.find(item => item.review) },
    { kind: 'modal', value: (buttons, title) => { assert.match(title, /suggested workspace note/); assert.match(host.shown.info.at(-1), /suggested workspace note/); return 'Save note'; } },
    { kind: 'modal', value: (buttons, title) => { assert.match(title, /suggested user preference/); return 'Edit and save'; } },
    { kind: 'input', value: 'Keep answers short.' });
  await host.send({ type: 'memory' });
  await host.waitFor(state => /1 workspace note · 1 user preference$/.test(state.memorySummary ?? ''), 10_000, 'review done');
  const second = await run('Summarize the project.');
  const prompt = prompts.at(-1);
  assert.match(prompt, /USER PREFERENCES[^"]*\\n\[\{\\"text\\":\\"Keep answers short\.\\"\}\]/);
  assert.match(prompt, /Run tests with npm test, which uses node --test\.\\",\\"sources\\":\[\{\\"file\\":\\"package\.json\\",\\"start\\":2,\\"end\\":4\}\]/);
  assert.doesNotMatch(prompt, /Secrets live in \.env/);
  assert.ok(second.manifest.some(entry => entry.reason === 'Suggested by the agent, approved by you'));
  // Edit the saved note in place and open its source.
  host.answers.push({ kind: 'pick', value: items => items.find(item => item.description === 'workspace') },
    { kind: 'pick', value: items => items.find(item => item.id === 'open') });
  await host.send({ type: 'memory' });
  await host.waitFor(() => host.shown.documents.at(-1) === path.join(root, 'package.json'), 5_000, 'source opened');
  host.answers.push({ kind: 'pick', value: items => items.find(item => item.description === 'workspace') },
    { kind: 'pick', value: items => items.find(item => item.id === 'edit') }, { kind: 'input', value: 'Run tests with npm test.' },
    { kind: 'modal', value: 'Save note' });
  await host.send({ type: 'memory' });
  await run('Summarize the project.');
  assert.match(prompts.at(-1), /Run tests with npm test\.\\",\\"sources/);
  // A deny rule removes the tool.
  host.settings.permissionRules = [{ effect: 'memory.suggest', decision: 'deny' }];
  host.changeConfig('agentextension.permissionRules');
  await run('Note what you learn about this project.');
  const last = model.state.requests.at(-1);
  assert.ok(!last.tools.some(tool => tool.endsWith('suggest_note')));
  assert.match(host.state().memorySummary, /1 workspace note · 1 user preference$/);
  assert.equal(host.answers.length, 0);
});

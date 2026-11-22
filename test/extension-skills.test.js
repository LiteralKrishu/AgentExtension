const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { startHost, scriptedModel } = require('./helpers/host.cjs');

const baseUrl = process.env.AGENTEXTENSION_TEST_FORGE_URL;
const live = { skip: !baseUrl && 'Set AGENTEXTENSION_TEST_FORGE_URL to a local TrueForge instance.', timeout: 120_000 };

test('a matching bundled skill is loaded automatically and shown; the setting and a deny rule keep it out', live, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-skills-ws-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.txt'), 'start\n');
  const prompts = [];
  const model = await scriptedModel(t, baseUrl, async ({ all, say }) => { prompts.push(all); return say('No change needed.'); });
  const settings = { serverUrl: baseUrl, model: model.model, fallbackModel: '', compaction: true, turnTimeoutSeconds: 60,
    readConnectors: [], skillRoots: [], pluginRoots: [], browserOrigins: [] };
  const host = await startHost(t, { root, settings });
  const request = 'Make a focused change and check the related tests and documentation.';
  const run = async () => {
    const before = prompts.length;
    const published = host.states.length;
    await host.send({ type: 'run', prompt: request });
    const done = await host.waitFor(state => prompts.length > before && host.states.length > published
      && state.phase === 'done' && state.runActive === false && /^Run ended/.test(state.status ?? ''), 60_000, 'run end');
    assert.ifError(model.state.error);
    return { done, prompt: prompts.at(-1) };
  };
  const matched = await run();
  assert.deepEqual(matched.done.skills, ['focused-change (matched)']);
  assert.match(matched.prompt, /SELECTED SKILL WORKFLOWS/);
  assert.match(matched.prompt, /Find the implementation, its tests, and the related documentation/);
  const entry = matched.done.manifest.find(item => item.kind === 'skill');
  assert.equal(entry.trust, 'matched workflow');
  assert.match(entry.reason, /^Matched automatically on .*focus.*\(score/);
  settings.automaticSkills = false;
  const off = await run();
  assert.deepEqual(off.done.skills, []);
  assert.doesNotMatch(off.prompt, /SELECTED SKILL WORKFLOWS/);
  settings.automaticSkills = true;
  settings.permissionRules = [{ effect: 'skill.read', decision: 'deny' }];
  host.changeConfig('agentextension.permissionRules');
  const denied = await run();
  assert.deepEqual(denied.done.skills, []);
  assert.doesNotMatch(denied.prompt, /SELECTED SKILL WORKFLOWS/);
  assert.ok(denied.done.permissions.events.some(event => event.effect === 'skill.read' && event.decision === 'deny'));
});

test('the agent lists eligible skill metadata, activates a workflow, and reads its resource', live, async t => {
  const folder = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-run-skills-')));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const root = path.join(folder, 'workspace');
  const skillRoot = path.join(folder, 'skills');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'a.txt'), 'start\n');
  const definitions = [
    ['practical', '', 'Procedure from the active skill.'],
    ['manual-only', 'disable-model-invocation: true\n', 'Explicitly selected only.'],
    ['restricted', '', 'Blocked by workspace rule.'],
  ];
  for (const [name, flags, body] of definitions) {
    const dir = path.join(skillRoot, name);
    await fs.mkdir(path.join(dir, 'references'), { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Checklist description\n${flags}---\n${body}`);
    await fs.writeFile(path.join(dir, 'references', 'details.md'), 'Active resource text');
  }
  let skill;
  const model = await scriptedModel(t, baseUrl, ({ round, results, all, call, say }) => {
    if (round === 0) {
      assert.doesNotMatch(all, /Procedure from the active skill/);
      return call('list_skills', {});
    }
    const result = JSON.parse(results.at(-1).content);
    if (round === 1) {
      assert.ok(result.skills.every(entry => Object.keys(entry).length === 3));
      assert.ok(result.skills.every(entry => !['manual-only', 'restricted'].includes(entry.name)));
      skill = result.skills.find(entry => entry.name === 'practical').id;
      return call('select_skill', { skill });
    }
    if (round === 2) {
      assert.match(result.workflow, /Procedure from the active skill/);
      return call('read_skill_resource', { skill, file: 'references/details.md' });
    }
    assert.equal(result.text, 'Active resource text');
    return say('Workflow read.');
  });
  const host = await startHost(t, { root, settings: { serverUrl: baseUrl, model: model.model, fallbackModel: '', compaction: true,
    turnTimeoutSeconds: 60, skillRoots: [skillRoot], permissionRules: [{ effect: 'skill.read', target: 'restricted', decision: 'deny' }] } });
  await host.send({ type: 'run', prompt: 'Summarize the sample.' });
  const result = await host.waitFor(state => !state.runActive && ['done', 'error'].includes(state.phase), 35_000);
  assert.ifError(model.state.error);
  assert.equal(result.phase, 'done', result.status);
  assert.deepEqual(result.skills, ['practical (requested)']);
  assert.ok(result.manifest.some(entry => entry.kind === 'skill' && entry.reason === 'Requested from the eligible skill catalog'));
});

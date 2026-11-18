const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { startHost, scriptedModel } = require('./helpers/host.cjs');

const baseUrl = process.env.AGENTEXTENSION_TEST_FORGE_URL;
const command = 'agentextension.plugin.sample-team.inspect';
const initialPrompt = 'Summarize changed source files.';
async function fixture(t, settings = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-workflows-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'sample.agentextension-plugin.json');
  const host = await startHost(t, { root, settings });
  const write = version => fs.writeFile(source, JSON.stringify({ format: 'agentextension-plugin/1', files: [
    { path: 'plugin.json', text: JSON.stringify({ schemaVersion: 1, id: 'sample-team', publisher: 'Sample publisher',
      version, description: 'Example workflow', capabilities: [],
      workflows: [{ id: 'inspect', title: 'Inspect sources', prompt: initialPrompt, planFirst: true }] }) },
  ] }));
  const importPlugin = async (version, approved = true) => {
    await write(version);
    host.answers.push({ kind: 'open', value: [host.vscode.Uri.file(source)] }, { kind: 'modal', value: () => {
      assert.match(host.shown.warning.at(-1).detail, /Publisher label: Sample publisher/);
      assert.match(host.shown.warning.at(-1).detail, new RegExp(`Version: ${version}`));
      assert.match(host.shown.warning.at(-1).detail, /Content digest: [a-f0-9]{64}/);
      return approved ? 'Import plugin' : undefined;
    } });
    await host.command('importPlugin');
    assert.deepEqual(host.answers, []);
  };
  const enablePlugin = async () => {
    host.answers.push({ kind: 'pick', value: items => items.find(item => item.label === 'Plugins') },
      { kind: 'pick', value: items => items.filter(item => item.label === 'sample-team') },
      { kind: 'modal', value: () => {
        assert.match(host.shown.warning.at(-1).detail, /Workflows: Inspect sources \(inspect\)/);
        return 'Enable plugin';
      } });
    await host.command('tools');
    await host.waitFor(() => host.commands.has(command), 5_000, 'workflow registered after approval');
  };
  return { host, importPlugin, enablePlugin, root };
}

test('the editor shares packages and registers workflows only for exact approved versions', async t => {
  const { host, importPlugin, enablePlugin, root } = await fixture(t);
  await importPlugin('1.0.0');
  await host.waitFor(state => state.status?.startsWith('Imported sample-team 1.0.0'), 5_000);
  assert.equal(host.commands.has(command), false);
  const workflowLabel = '/sample-team:inspect';
  async function findWorkflow(expected) {
    host.answers.push({ kind: 'pick', value: items => {
      assert.ok(items.some(item => item.label === '/plugins'));
      assert.equal(items.some(item => item.label === workflowLabel), expected);
      return expected ? items.find(item => item.label === workflowLabel) : undefined;
    } });
    if (expected) host.answers.push({ kind: 'input', value: value => { assert.equal(value, initialPrompt); return undefined; } });
    await host.command('slashCommands');
  }
  await findWorkflow(false);
  await enablePlugin();
  await findWorkflow(true);
  const previousCommand = host.commands.get(command);
  host.answers.push({ kind: 'input', value: value => { assert.equal(value, initialPrompt); return undefined; } });
  await host.command('plugin.sample-team.inspect');

  const exportPath = path.join(root, 'exported.agentextension-plugin.json');
  host.answers.push({ kind: 'pick', value: items => items.find(item => item.label === 'sample-team') },
    { kind: 'save', value: host.vscode.Uri.file(exportPath) });
  await host.command('exportPlugin');
  assert.equal(JSON.parse(await fs.readFile(exportPath, 'utf8')).format, 'agentextension-plugin/1');

  await importPlugin('2.0.0', false);
  assert.equal(host.commands.get(command), previousCommand);
  await importPlugin('2.0.0');
  await host.waitFor(() => !host.commands.has(command), 5_000, 'stale workflow removed');
  await findWorkflow(false);
  await previousCommand();
  await host.waitFor(state => state.status?.startsWith('No matching approved plugin workflow'), 5_000);
  await enablePlugin();
  assert.deepEqual(host.answers, []);
  assert.deepEqual(host.shown.errors, []);
});

test('a workflow uses the edited prompt and waits for normal plan approval', {
  skip: !baseUrl && 'Set AGENTEXTENSION_TEST_FORGE_URL to a local TrueForge instance.', timeout: 90_000,
}, async t => {
  const prompt = 'Summarize only the README changes.';
  const model = await scriptedModel(t, baseUrl, ({ round, all, call, say }) => {
    const request = text => JSON.stringify(`USER REQUEST\n${text}`).slice(1, -1);
    assert.ok(all.includes(request(prompt)), 'The edited text is the user request');
    assert.ok(!all.includes(request(initialPrompt)), 'The default text is not the user request');
    if (round === 0) return call('propose_plan', { goal: 'Review the README', steps: ['Read the README'], checks: ['Report findings'] });
    return say('Finished the README review.');
  });
  const { host, importPlugin, enablePlugin } = await fixture(t, { serverUrl: baseUrl, model: model.model, fallbackModel: '',
    turnTimeoutSeconds: 60, readConnectors: [], skillRoots: [], pluginRoots: [], browserOrigins: [], automaticSkills: false });
  await importPlugin('1.0.0');
  await enablePlugin();
  host.answers.push({ kind: 'pick', value: items => {
    return items.find(item => item.label === '/sample-team:inspect');
  } }, { kind: 'input', value: value => { assert.equal(value, initialPrompt); return prompt; } });
  const run = host.command('slashCommands');
  const plan = await host.waitFor(state => state.phase === 'plan' || state.phase === 'error', 30_000, 'plan approval');
  assert.ifError(model.state.error);
  assert.equal(plan.phase, 'plan', plan.status);
  assert.equal(plan.plan.goal, 'Review the README');
  assert.equal(plan.planApproved, false);
  assert.equal(model.state.requests.length, 1);
  await host.send({ type: 'approve-plan' });
  await run;
  const done = await host.waitFor(state => state.phase === 'done', 10_000, 'workflow complete');
  assert.ifError(model.state.error);
  assert.match(done.text, /Finished the README review/);
  assert.ok(done.manifest.some(entry => entry.kind === 'request' && entry.source === 'Plugin workflow sample-team/inspect'));
});

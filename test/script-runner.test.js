const assert = require('node:assert/strict');
const { test } = require('node:test');
const { once } = require('node:events');
const net = require('node:net');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { isolatedRuntime } = require('../src/isolated-node');
const { runScript } = require('../src/script-runner');
const { SkillRegistry } = require('../src/skills');
const { PluginRegistry, loadPlugin } = require('../src/plugins');
const { PluginPackages, encodePluginPackage } = require('../src/plugin-packages');
const { PermissionBroker } = require('../src/permissions');
const { PolicyEngine } = require('../src/policy');
const { approve } = require('../src/forge');
const { executeSkillScript } = require('../src/skill-script');
const { startHost, scriptedModel } = require('./helpers/host.cjs');

const platformTest = { skip: process.env.AGENTEXTENSION_TEST_SCRIPTS !== '1' && 'Enable the isolated script suite.', timeout: 20_000 };
const baseUrl = process.env.AGENTEXTENSION_TEST_FORGE_URL;
const stdin = "const data = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));";
const skillText = '---\nname: local-format\ndescription: Format the supplied text\nscripts: [format]\n---\nUse the format script on the input.';
const skillSource = `${stdin} console.log(data.input.toUpperCase());`;

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-scripts-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeSkill(root) {
  const folder = path.join(root, 'local-format');
  await fs.mkdir(path.join(folder, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(folder, 'SKILL.md'), skillText);
  const script = path.join(folder, 'scripts/format.cjs');
  await fs.writeFile(script, skillSource);
  return script;
}

async function writePlugin(parent, capabilities = ['hook.run']) {
  const plugin = path.join(parent, 'local-validation');
  await fs.mkdir(path.join(plugin, 'hooks'), { recursive: true });
  await fs.writeFile(path.join(plugin, 'plugin.json'), JSON.stringify({
    schemaVersion: 1, id: 'local-validation', version: '1.0.0', publisher: 'Example', description: 'Validate accepted changes locally.',
    skills: capabilities.includes('skill.script') ? ['local-format'] : [], capabilities,
    customHooks: [{ name: 'record-result', event: 'after-check' }, { name: 'check-accepted', event: 'before-apply' }],
  }));
  const record = `${stdin}
    console.log(JSON.stringify({ok: data.exitCode === 0, message: 'Fields ' + Object.keys(data).join(', ')}));`;
  const validate = `${stdin}
    if (Object.keys(data).join(',') === 'event,hunks' && data.hunks.every(text => text.includes('blocked'))) {
      setTimeout(() => {
      console.log(JSON.stringify({ok: false, message: 'Fixture refused the accepted text.'}));
      }, 600);
    }`;
  await fs.writeFile(path.join(plugin, 'hooks/record-result.cjs'), record);
  await fs.writeFile(path.join(plugin, 'hooks/check-accepted.cjs'), validate);
  return plugin;
}

test('plugin packages pin declared scripts and hook events and reject undeclared code', async t => {
  const root = await fixture(t);
  const plugin = await writePlugin(path.join(root, 'plugins'), ['skill.read', 'skill.script', 'hook.run']);
  const script = await writeSkill(path.join(plugin, 'skills'));
  const loaded = await loadPlugin(plugin);
  const packageFile = path.join(root, 'fixture.agentextension-plugin.json');
  await fs.writeFile(packageFile, encodePluginPackage(loaded));
  const packages = new PluginPackages(path.join(root, 'installed'));
  const imported = await packages.import(packageFile, [], () => true);
  assert.equal(imported.pin.digest, loaded.pin.digest);
  assert.equal(imported.skills[0].scriptSources.get('format'), skillSource);
  assert.deepEqual(imported.customHooks.map(hook => hook.event), ['after-check', 'before-apply']);

  const registry = new PluginRegistry([path.dirname(plugin)]);
  await registry.discover();
  await fs.appendFile(script, ' // revised');
  await assert.rejects(registry.verify([loaded.pin]), /changed/);
  await fs.writeFile(path.join(plugin, 'hooks/unlisted.cjs'), 'console.log("unlisted")');
  await assert.rejects(loadPlugin(plugin), /undeclared script/);
  await fs.unlink(path.join(plugin, 'hooks/unlisted.cjs'));
  await fs.unlink(script);
  await assert.rejects(loadPlugin(plugin), /missing/);
});

test('the isolated script sees only its staged file and exact input', platformTest, async t => {
  const root = await fixture(t);
  const home = await fs.mkdtemp(path.join(os.homedir(), '.agentextension-script-test-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const files = [path.join(root, 'workspace.txt'), path.join(home, 'home.txt')];
  await Promise.all(files.map(file => fs.writeFile(file, 'synthetic marker')));
  let connections = 0;
  const endpoint = net.createServer(socket => { connections++; socket.destroy(); });
  endpoint.listen(0, '127.0.0.1');
  await once(endpoint, 'listening');
  t.after(() => endpoint.close());
  const source = `${stdin}
    const fs = require('node:fs');
    const allowed = callback => { try { callback(); return true; } catch { return false; } };
    const socket = require('node:net').connect(${endpoint.address().port}, '127.0.0.1');
    const report = network => {
      socket.destroy();
      console.log(JSON.stringify({ data, network, env: Object.keys(process.env),
        entry: allowed(() => fs.readFileSync(__filename)),
        reads: ${JSON.stringify(files)}.map(file => allowed(() => fs.readFileSync(file))),
        write: allowed(() => fs.writeFileSync('marker', 'test')),
        child: allowed(() => require('node:child_process').spawnSync(process.execPath, ['--version'])),
      }));
    };
    socket.once('connect', () => report(true));
    socket.once('error', () => report(false));
    socket.setTimeout(500, () => report(false));`;
  const runtime = await isolatedRuntime(process.execPath);
  const { env, ...result } = JSON.parse(await runScript(runtime, source, { input: 'exact' }, new AbortController().signal));
  assert.ok(env.every(key => ['PWD', '__CF_USER_TEXT_ENCODING'].includes(key)));
  assert.deepEqual(result, { data: { input: 'exact' }, network: false, entry: true, reads: [false, false], write: false, child: false });
  assert.equal(connections, 0);
});

test('combined output overflow, deadline, and cancellation remove the staged process and file', platformTest, async () => {
  const runtime = await isolatedRuntime(process.execPath);
  const controller = new AbortController();
  const before = new Set(await fs.readdir(os.tmpdir()));
  const staged = async () => (await fs.readdir(os.tmpdir())).filter(dir => dir.startsWith('agentextension-script-') && !before.has(dir));
  const waiting = 'setInterval(() => {}, 1000);';
  await assert.rejects(runScript(runtime, "process.stdout.write('a'.repeat(9000)); process.stderr.write('b'.repeat(8000));", {}, controller.signal), /16,000/);
  assert.deepEqual(await staged(), []);
  await assert.rejects(runScript(runtime, waiting, {}, controller.signal), /5-second deadline/);
  assert.deepEqual(await staged(), []);

  const call = runScript(runtime, waiting, {}, controller.signal);
  const cancelled = assert.rejects(call, { name: 'AbortError' });
  let pids = [];
  try {
    for (let attempt = 0; !pids.length && attempt < 100; attempt++) {
      const directories = await staged();
      const tasks = execFileSync('ps', ['-axo', 'pid,command'], { encoding: 'utf8' }).split('\n');
      pids = tasks.filter(line => directories.some(dir => line.includes(path.join(dir, 'entry.cjs'))))
        .map(line => Number(line.trim().split(/\s+/)[0]));
      if (!pids.length) await delay(10);
    }
    assert.ok(pids.length);
  } finally { controller.abort(); }
  await cancelled;
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.deepEqual(await staged(), []);
});

test('only an active declared script can consume one exact approval', platformTest, async t => {
  const root = await fixture(t);
  const script = await writeSkill(root);
  const skills = new SkillRegistry([root]);
  const [entry] = await skills.discover();
  const signal = new AbortController().signal;
  const permissions = new PermissionBroker({ workspace: root, signal });
  const run = { skillScripts: true, scriptNode: process.execPath, skills, permissions, canReadSkill: () => true, signal };
  const args = { skill: entry.id, script: 'format', input: 'example' };
  const request = { name: 'run_skill_script', args };
  const yes = { skillScript: async () => true };
  assert.equal(await approve(request, run, yes), false);
  await skills.select([entry.id]);
  assert.equal(await approve(request, { ...run, readOnly: true }, yes), false);
  assert.equal(await approve({ ...request, args: { ...args, script: 'unlisted' } }, run, yes), false);
  assert.equal(await approve(request, run, { skillScript: async () => { await fs.appendFile(script, '// changed'); return true; } }), false);
  await fs.writeFile(script, skillSource);
  assert.equal(await approve(request, run, yes), true);
  await assert.rejects(executeSkillScript(run, { ...args, input: 'other' }, signal), /Permission denied/);
  assert.deepEqual(await executeSkillScript(run, args, signal), { skill: 'local-format', script: 'format', output: 'EXAMPLE\n' });
  await assert.rejects(executeSkillScript(run, args, signal), /Permission denied/);
  permissions.setPolicy(new PolicyEngine({ user: [{ effect: 'skill.script', target: 'local-format/format', decision: 'deny' }] }));
  assert.equal(await approve(request, run, yes), false);
});

test('editor and TrueForge invoke the approved skill script and scoped custom hooks', {
  ...platformTest, skip: platformTest.skip || !baseUrl && 'Enable the TrueForge integration suite.',
}, async t => {
  const root = await fixture(t);
  const workspace = path.join(root, 'workspace');
  const plugins = path.join(root, 'plugins');
  const skills = path.join(root, 'skills');
  await fs.mkdir(workspace);
  const file = path.join(workspace, 'sample.txt');
  await fs.writeFile(file, 'original\n');
  await writeSkill(skills);
  await writePlugin(plugins);
  const registry = new SkillRegistry([skills]);
  const [skill] = await registry.discover();
  const model = await scriptedModel(t, baseUrl, ({ round, all, call, say }) => {
    if (round === 0) return call('run_skill_script', { skill: skill.id, script: 'format', input: 'fixture input' });
    assert.match(all, /FIXTURE INPUT/);
    if (round === 1) return call('propose_write', { file: 'sample.txt', old_text: 'original', new_text: 'blocked' });
    if (round === 2) return call('run_command', { command: 'node', args: ['--version'] });
    if (round === 3) return call('review_changes', {});
    return say('Prepared a reviewed draft.');
  });
  const host = await startHost(t, { root: workspace, settings: { serverUrl: baseUrl, model: model.model, fallbackModel: '',
    turnTimeoutSeconds: 60, pluginRoots: [plugins], skillRoots: [skills], scriptNodeExecutable: process.execPath },
    workspaceSettings: { scriptNodeExecutable: '/workspace/injected/node' } });
  host.answers.push({ kind: 'pick', value: items => items.filter(item => item.label === 'local-validation') },
    { kind: 'modal', value: () => {
      assert.match(host.shown.warning.at(-1).detail, /hooks\/check-accepted\.cjs \(before-apply\)/);
      return 'Enable plugin';
    } },
    { kind: 'pick', value: items => items.filter(item => item.label === 'local-format') });
  await host.send({ type: 'plugins' });
  await host.send({ type: 'select-skills' });
  host.answers.push({ kind: 'modal', value: (_buttons, title) => {
    assert.equal(title, 'Run this isolated skill script?');
    assert.match(host.shown.warning.at(-1).detail, /scripts\/format\.cjs[\s\S]*Input: "fixture input"/);
    return 'Run script';
  } }, { kind: 'modal', value: 'Run command' });
  await host.send({ type: 'run', prompt: 'Format the fixture input and review the change.' });
  const review = await host.waitFor(state => ['review', 'error'].includes(state.phase), 12_000);
  assert.ifError(model.state.error);
  assert.equal(review.phase, 'review', review.status);
  for (const hunk of review.hunks) await host.send({ type: 'decision', id: hunk.id, value: 'accept' });
  await host.send({ type: 'continue' });
  await host.waitFor(state => state.phase === 'ready' && !state.runActive, 5_000);
  const applying = host.send({ type: 'apply' });
  await host.waitFor(state => state.validatingApply, 3_000);
  await host.send({ type: 'cancel' });
  await applying;
  assert.match(host.state().status, /Validation cancelled/);
  assert.equal(host.state().phase, 'ready');
  await host.send({ type: 'apply' });
  await host.waitFor(state => /Fixture refused the accepted text/.test(state.status) && !state.applying, 5_000);
  assert.equal(await fs.readFile(file, 'utf8'), 'original\n');
  await host.send({ type: 'run-report' });
  const report = await fs.readFile(host.shown.documents.at(-1), 'utf8');
  assert.match(report, /after-check · passed · Fields event, exitCode, revision/);
  assert.match(report, /before-apply · cancelled/);
  assert.match(report, /before-apply · failed · Fixture refused the accepted text/);
});

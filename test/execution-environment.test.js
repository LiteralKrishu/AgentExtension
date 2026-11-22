const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { ContainerEnvironment, runArguments, detectProfile, PROFILES } = require('../src/execution-environment');
const { Workspace } = require('../src/workspace');

function fakeDocker({ running = true, installExit = 0 } = {}) {
  const volumes = new Set(); const calls = []; const runs = [];
  const exec = async (_engine, args) => {
    calls.push(args);
    if (args[0] === 'version' && !running) throw new Error('Cannot connect to the Docker daemon');
    if (args[0] === 'image') return { stdout: 'node@sha256:abc\n' };
    if (args[0] === 'volume' && args[1] === 'inspect' && !volumes.has(args[2])) throw new Error('no such volume');
    if (args[0] === 'volume' && args[1] === 'create') volumes.add(args.at(-1));
    if (args[0] === 'volume' && args[1] === 'rm') volumes.delete(args.at(-1));
    return { stdout: '' };
  };
  const start = (_engine, args) => {
    runs.push(args);
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    const setup = args.includes('bridge');
    setImmediate(() => { child.stdout.emit('data', setup ? 'installed' : 'ok'); child.emit('close', setup ? installExit : 0); });
    return child;
  };
  return { exec, start, volumes, calls, runs };
}
async function project(t, files) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'container-env-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) await fs.writeFile(path.join(directory, file), text);
  return directory;
}
const signal = () => new AbortController().signal;

test('checks run hardened, offline, and see only the snapshot and the read-only dependency volume', async t => {
  const docker = fakeDocker();
  const directory = await project(t, { 'package.json': '{}', 'package-lock.json': '{"lockfileVersion":3}' });
  const environment = new ContainerEnvironment({ exec: docker.exec, start: docker.start });
  const result = await environment.run('npm', ['test'], directory, signal());
  assert.equal(result.exitCode, 0);
  assert.equal(result.environment.image, 'node@sha256:abc');
  const [setup, check] = docker.runs;
  assert.ok(setup.includes('bridge') && setup.includes(`${directory}:/work:ro`) && setup.includes('--ignore-scripts'));
  assert.ok(setup.includes('--registry=https://registry.npmjs.org/'));
  for (const flag of ['--read-only', '--cap-drop', 'ALL', 'no-new-privileges', '--pids-limit', '--memory', '--cpus']) assert.ok(check.includes(flag), flag);
  assert.equal(check[check.indexOf('--network') + 1], 'none');
  assert.ok(check.some(arg => /dst=\/work\/node_modules,volume-subpath=node_modules,readonly$/.test(arg)));
  assert.deepEqual(check.filter((arg, i) => check[i - 1] === '-v'), [`${directory}:/work`], 'no other host folder is mounted');
  assert.ok(!check.some(arg => /HOME=\/(?:Users|home|root)/.test(arg)), 'the host home folder never enters');
  assert.deepEqual(check.slice(-2), ['node@sha256:abc', 'test'], 'the pinned image, then the arguments');
  assert.equal(check[check.indexOf('--entrypoint') + 1], 'npm');
  assert.match(environment.describe(), /without network/);
});

test('unchanged dependency inputs reuse the environment and a changed lockfile invalidates it', async t => {
  const docker = fakeDocker();
  const directory = await project(t, { 'requirements.txt': 'flask==3.1.3\n' });
  const environment = new ContainerEnvironment({ exec: docker.exec, start: docker.start });
  const first = await environment.prepare(directory, signal());
  const again = await environment.prepare(directory, signal());
  assert.equal(first.name, 'python');
  assert.equal(again.cached, true);
  assert.equal(docker.runs.length, 1, 'setup ran once');
  await fs.writeFile(path.join(directory, 'requirements.txt'), 'flask==3.1.2\n');
  const changed = await environment.prepare(directory, signal());
  assert.notEqual(changed.volume, first.volume);
  assert.equal(changed.cached, false);
  assert.ok(docker.runs[1].includes('--only-binary=:all:'), 'source builds stay off without permission');
  const scripts = new ContainerEnvironment({ exec: docker.exec, start: docker.start, allowScripts: true });
  assert.notEqual((await scripts.prepare(directory, signal())).volume, changed.volume, 'the script policy is part of the identity');
});

test('a stopped engine fails the check instead of running it on the host', async t => {
  const docker = fakeDocker({ running: false });
  const root = await fs.realpath(await project(t, { 'package.json': '{}', 'package-lock.json': '{}' }));
  require('node:child_process').execFileSync('git', ['init', '-q'], { cwd: root });
  const workspace = new Workspace(root, () => undefined);
  workspace.environment = new ContainerEnvironment({ exec: docker.exec, start: docker.start });
  await assert.rejects(workspace.command('node', ['-e', 'require("fs").writeFileSync("ran","")'], [], signal()), /Docker is not running/);
  assert.equal(docker.runs.length, 0);
  await assert.rejects(fs.access(path.join(root, 'ran')));
});

test('failed setup removes its volume, and a project without dependency files is rejected clearly', async t => {
  const docker = fakeDocker({ installExit: 1 });
  const directory = await project(t, { 'package.json': '{}', 'package-lock.json': '{}' });
  await assert.rejects(new ContainerEnvironment({ exec: docker.exec, start: docker.start }).prepare(directory, signal()), /Dependency setup failed \(exit 1\)/);
  assert.equal(docker.volumes.size, 0);
  await assert.rejects(detectProfile(await project(t, { 'main.go': '' })), /package-lock\.json \(Node\.js\) or requirements\.txt \(Python\)/);
});

test('the argument builder passes no host environment', () => {
  const args = runArguments({ name: 'n', image: 'i', network: 'none', readOnlySource: { directory: '/s', readOnly: false },
    volume: 'v', mount: { target: '/deps', readOnly: true }, profile: PROFILES.python, command: 'python', args: ['-m', 'pytest'] });
  const env = args.filter((arg, i) => args[i - 1] === '-e');
  assert.deepEqual(env.sort(), ['HOME=/tmp', 'LANG=C.UTF-8', 'PYTHONDONTWRITEBYTECODE=1', 'PYTHONPATH=/deps']);
  assert.deepEqual(args.slice(-3), ['i', '-m', 'pytest'], 'image then arguments');
  assert.equal(args[args.indexOf('--entrypoint') + 1], 'python');
});

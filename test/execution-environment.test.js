const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { getEventListeners } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { ContainerEnvironment, runArguments, detectProfile, PROFILES } = require('../src/execution-environment');
const { Workspace } = require('../src/workspace');

function fakeDocker({ running = true, installExit = 0 } = {}) {
  const volumes = new Set(); const calls = []; const runs = [];
  const exec = async (_engine, args) => {
    calls.push(args);
    if (args[0] === 'version' && !running) throw new Error('Cannot connect to the Docker daemon');
    if (args[0] === 'image') return { stdout: 'node@sha256:' + 'a'.repeat(64) + '\n' };
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
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await fs.writeFile(path.join(directory, file), text);
  }
  return directory;
}
const signal = () => new AbortController().signal;

test('checks run hardened, offline, and see only the snapshot and the read-only dependency volume', async t => {
  const docker = fakeDocker();
  const directory = await project(t, { 'package.json': '{}', 'package-lock.json': '{"lockfileVersion":3}' });
  const environment = new ContainerEnvironment({ exec: docker.exec, start: docker.start });
  const result = await environment.run('npm', ['test'], directory, signal());
  assert.equal(result.exitCode, 0);
  assert.equal(result.environment.image, 'node@sha256:' + 'a'.repeat(64));
  const [setup, check] = docker.runs;
  assert.ok(setup.includes('bridge') && setup.includes(`${directory}:/work:ro`) && setup.includes('--ignore-scripts'));
  assert.ok(setup.includes('--registry=https://registry.npmjs.org/'));
  for (const flag of ['--read-only', '--cap-drop', 'ALL', 'no-new-privileges', '--pids-limit', '--memory', '--cpus']) assert.ok(check.includes(flag), flag);
  assert.equal(check[check.indexOf('--network') + 1], 'none');
  assert.ok(check.some(arg => /dst=\/work\/node_modules,volume-subpath=node_modules,readonly$/.test(arg)));
  assert.deepEqual(check.filter((arg, i) => check[i - 1] === '-v'), [`${directory}:/work`], 'no other host folder is mounted');
  assert.ok(!check.some(arg => /HOME=\/(?:Users|home|root)/.test(arg)), 'the host home folder never enters');
  assert.deepEqual(check.slice(-2), ['node@sha256:' + 'a'.repeat(64), 'test'], 'the pinned image, then the arguments');
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
  assert.deepEqual(env.filter(value => !/^(?:https?_proxy|all_proxy|no_proxy)=/i.test(value)).sort(), ['HOME=/tmp', 'LANG=C.UTF-8', 'PYTHONDONTWRITEBYTECODE=1', 'PYTHONPATH=/deps']);
  assert.equal(env.filter(value => /^(?:https?_proxy|all_proxy|no_proxy)=$/i.test(value)).length, 8, 'Docker client proxy defaults cannot pass host credentials into the container');
  assert.deepEqual(args.slice(-3), ['i', '-m', 'pytest'], 'image then arguments');
  assert.equal(args[args.indexOf('--entrypoint') + 1], 'python');
});

test('a concurrent caller waits for dependency setup before reusing its volume', async t => {
  const docker = fakeDocker();
  const directory = await project(t, { 'requirements.txt': 'six==1.17.0\n' });
  let release, started;
  const began = new Promise(resolve => { started = resolve; });
  const start = () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    release = () => child.emit('close', 0);
    started();
    return child;
  };
  const first = new ContainerEnvironment({ exec: docker.exec, start }).prepare(directory, signal());
  await began;
  let reused = false;
  const second = new ContainerEnvironment({ exec: docker.exec, start }).prepare(directory, signal()).then(result => { reused = true; return result; });
  try { await delay(20); assert.equal(reused, false, 'an existing volume is not ready while setup is running'); }
  finally { release(); }
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.cached, false); assert.equal(b.cached, true); assert.equal(a.volume, b.volume);
});

test('an interrupted dependency volume is rejected instead of accepted as a complete cache', async t => {
  const docker = fakeDocker();
  const directory = await project(t, { 'requirements.txt': 'six==1.17.0\n' });
  await new ContainerEnvironment({ exec: docker.exec, start: docker.start }).prepare(directory, signal());
  const exec = async (engine, args) => {
    if (args[0] === 'run') throw Object.assign(new Error('ready marker missing'), { code: 1 });
    return docker.exec(engine, args);
  };
  await assert.rejects(new ContainerEnvironment({ exec, start: docker.start }).prepare(directory, signal()), /cache is incomplete/);
  assert.equal(docker.runs.length, 1, 'no install or check is dispatched using the incomplete cache');
  assert.equal(docker.volumes.size, 1, 'a cache owned by another process is not removed');
});

test('cancellation waits for container removal before returning and releases its listener', async () => {
  const controller = new AbortController();
  let child, removed, release;
  const removing = new Promise(resolve => { removed = resolve; });
  const environment = new ContainerEnvironment({
    start: () => {
      child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.kill = () => { setImmediate(() => child.emit('close', null)); };
      return child;
    },
    exec: async (_engine, args) => {
      assert.deepEqual(args, ['rm', '--force', 'owned-check']);
      removed(); await new Promise(resolve => { release = resolve; });
      return { stdout: '' };
    },
  });
  let settled = false;
  const pending = environment.spawnRun(['run', '--name', 'owned-check'], controller.signal, 5).then(result => { settled = true; return result; });
  controller.abort(); await removing;
  assert.equal(settled, false);
  release();
  const result = await pending;
  assert.equal(result.exitCode, null); assert.equal(result.status, 'Command cancelled.'); assert.equal(result.cleanup, 'complete');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('spawn and cleanup failures cannot become successful command evidence', async () => {
  const controller = new AbortController();
  const environment = new ContainerEnvironment({ exec: async () => { throw new Error('engine disconnected'); },
    start: () => { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.kill = () => {}; setImmediate(() => child.emit('error', new Error('spawn failed'))); return child; } });
  await assert.rejects(environment.spawnRun(['run', '--name', 'owned-check'], controller.signal, 5), /cleanup could not be confirmed/);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('a changed image or declaration is refused before dependency setup and command dispatch', async t => {
  const docker = fakeDocker();
  const directory = await project(t, { 'package.json': '{}', 'package-lock.json': '{"lockfileVersion":3}' });
  const env = new ContainerEnvironment({ profile: 'node', exec: docker.exec, start: docker.start });
  const binding = await env.authorizationIdentity(directory, 'node', ['check.js'], signal());
  assert.match(binding.image, /@sha256:/);
  await assert.rejects(env.run('node', ['check.js'], directory, signal(), { ...binding, image: 'node@sha256:' + 'b'.repeat(64) }), /image changed/);
  await assert.rejects(env.run('node', ['check.js'], directory, signal(), { ...binding, declaration: 'changed' }), /declaration changed/);
  assert.equal(docker.runs.length, 0);
  await assert.rejects(env.run('node', ['check.js'], directory, signal(), { ...binding, validate: async () => { throw new Error('Expired before setup'); } }), /Expired before setup/);
  assert.equal(docker.runs.length, 0);
});

test('Python cache identity follows nested requirements and constraints, including quoted paths and continuations',async t=>{
 const docker=fakeDocker();const directory=await project(t,{'requirements.txt':'-r "deps/extra file.txt"\n--constraint=constraints.lock\n',
 'deps/extra file.txt':'--requirement \\\n ../base.txt\n','base.txt':'flask==3.1.3\n','constraints.lock':'click==8.1.8\n'});
 const env=new ContainerEnvironment({profile:'python',exec:docker.exec,start:docker.start});
 const first=await env.prepare(directory,signal());assert.equal((await env.prepare(directory,signal())).volume,first.volume);
 await fs.writeFile(path.join(directory,'base.txt'),'flask==3.1.2\n');const nested=await env.prepare(directory,signal());assert.notEqual(nested.volume,first.volume);
 await fs.writeFile(path.join(directory,'constraints.lock'),'click==8.1.7\n');const constrained=await env.prepare(directory,signal());assert.notEqual(constrained.volume,nested.volume);
 await fs.writeFile(path.join(directory,'app.py'),'changed unrelated source\n');assert.equal((await env.prepare(directory,signal())).volume,constrained.volume);
});

test('unsupported or unavailable Python dependency inputs cannot reuse or create a cache',async t=>{
 for(const input of ['-r missing.txt','-r ../outside.txt','-r /etc/passwd','-r https://example.invalid/req.txt','-r ${HOME}/req.txt','-r one.txt -c two.txt','-e .','name @ file:///work/package','./package','--find-links ./wheels']){
  const docker=fakeDocker();const directory=await project(t,{'requirements.txt':input+'\n'});
  await assert.rejects(new ContainerEnvironment({profile:'python',exec:docker.exec,start:docker.start}).prepare(directory,signal()));
  assert.equal(docker.runs.length,0,input);assert.equal(docker.volumes.size,0,input);
 }
 const docker=fakeDocker();const directory=await project(t,{'requirements.txt':'-r extra.txt\n','extra.txt':'-c requirements.txt\n'});
 const env=new ContainerEnvironment({profile:'python',exec:docker.exec,start:docker.start});await assert.rejects(env.prepare(directory,signal()),/circular include/);
 await fs.rm(path.join(directory,'extra.txt'));await fs.symlink(path.join(directory,'requirements.txt'),path.join(directory,'extra.txt'));
 await assert.rejects(env.prepare(directory,signal()),/symlinks/);assert.equal(docker.runs.length,0);
});

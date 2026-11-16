const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Workspace, runIsolated, sandboxArguments, readableToolchains } = require('../src/workspace');
const { PolicyEngine, commandSubject } = require('../src/policy');
const { PermissionBroker } = require('../src/permissions');
const { SurfaceAccess } = require('../src/surface-access');
const { computerSubject } = require('../src/computer');
const { bodyPreview, scopedCsp } = require('../src/browser');

async function temporary(t, prefix) {
  const folder = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  return folder;
}

test('toolchains under a hidden folder stay readable without exposing shallow parents', async t => {
  const home = await temporary(t, 'agentextension-home-');
  const nvm = path.join(home, '.nvm/versions/node/v22/bin');
  const local = path.join(home, '.local/bin');
  const own = path.join(home, 'bin');
  for (const folder of [nvm, local, own]) await fs.mkdir(folder, { recursive: true });
  const found = await readableToolchains([home], [nvm, local, own, '/usr/bin', 'relative/bin'].join(path.delimiter));
  assert.deepEqual(found.sort(), [path.dirname(nvm), local, own].sort());
});

test('sandbox arguments hide home and the real workspace on both platforms', async () => {
  const home = await fs.realpath(os.homedir()).catch(() => os.homedir());
  const darwin = await sandboxArguments('node', ['t.js'], '/tmp/copy', { hidden: ['/work/repo'], platform: 'darwin', searchPath: '' });
  const profile = darwin.parameters[1];
  assert.match(profile, /\(deny network\*\)/);
  assert.ok(profile.includes(`(deny file-read* (subpath ${JSON.stringify(home)}))`));
  assert.ok(profile.includes('(deny file-read* (subpath "/work/repo"))'));
  assert.ok(profile.indexOf('(allow file-read* file-write* (subpath "/tmp/copy"))') > profile.lastIndexOf('(deny file-read*'), 'The copy is allowed after the denials');
  const linux = await sandboxArguments('node', ['t.js'], '/tmp/copy', { hidden: ['/work/repo'], platform: 'linux', searchPath: '' });
  const args = linux.parameters.join(' ');
  assert.ok(args.includes(`--tmpfs ${home}`) && args.includes('--tmpfs /work/repo'));
  assert.ok(args.indexOf('--bind /tmp/copy /tmp/copy') > args.lastIndexOf('--tmpfs'), 'The copy is bound after the tmpfs mounts');
  await assert.rejects(sandboxArguments('node', [], '/tmp/copy', { platform: 'win32' }), /macOS and on Linux/);
});

test('macOS sandbox blocks home, the real workspace and the network but runs the staged copy', { skip: process.platform !== 'darwin' && 'macOS only' }, async t => {
  const workspace = await temporary(t, 'agentextension-real-');
  const copy = await temporary(t, 'agentextension-copy-');
  await fs.writeFile(path.join(workspace, '.env'), 'SECRET=1\n');
  await fs.writeFile(path.join(copy, 't.js'), 'console.log("copy ok")\n');
  const signal = new AbortController().signal;
  const run = (command, args) => runIsolated(command, args, copy, signal, { hidden: [workspace] });
  assert.notEqual((await run('ls', [os.homedir()])).exitCode, 0);
  const secret = await run('cat', [path.join(workspace, '.env')]);
  assert.notEqual(secret.exitCode, 0);
  assert.doesNotMatch(secret.output, /SECRET/);
  assert.notEqual((await run('curl', ['-sS', '-m', '5', 'https://example.com'])).exitCode, 0);
  const staged = await run(process.execPath, ['t.js']);
  assert.equal(staged.exitCode, 0, staged.output);
  assert.match(staged.output, /copy ok/);
  assert.equal((await run('touch', ['out.txt'])).exitCode, 0);
});

test('listing workspace files does not run a repository fsmonitor command', async t => {
  const root = await temporary(t, 'agentextension-git-');
  const marker = path.join(await temporary(t, 'agentextension-marker-'), 'ran');
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  await fs.writeFile(path.join(root, 'a.txt'), 'a\n');
  git('add', 'a.txt');
  git('config', 'core.fsmonitor', `touch ${JSON.stringify(marker)}; false`);
  const workspace = new Workspace(root, () => undefined, async () => []);
  assert.deepEqual(await workspace.paths(), ['a.txt']);
  await assert.rejects(fs.access(marker), { code: 'ENOENT' });
});

test('command subjects are unambiguous and keep plain commands readable', () => {
  assert.equal(commandSubject({ command: 'npm', args: ['run', 'build'] }), 'npm run build');
  assert.notEqual(commandSubject({ command: 'git', args: ['status --short'] }), commandSubject({ command: 'git', args: ['status', '--short'] }));
  assert.equal(commandSubject({ command: 'node', args: ['-e', 'console.log("x")'] }), 'node -e "console.log(\\"x\\")"');
  assert.equal(commandSubject({ command: 'node', args: [''] }), 'node ""');
  // An exact rule saved for a quoted argument does not match an argument split into several.
  const policy = new PolicyEngine({ workspace: [{ effect: 'command.execute', target: commandSubject({ command: 'git', args: ['log', 'a b'] }), decision: 'allow' }] });
  assert.equal(policy.decide('command.execute', commandSubject({ command: 'git', args: ['log', 'a b'] })).decision, 'allow');
  assert.equal(policy.decide('command.execute', commandSubject({ command: 'git', args: ['log', 'a', 'b'] })).decision, 'ask');
});

test('computer allow rules need the action and control; app deny and ask rules still apply', async () => {
  const app = { bundleId: 'com.example.app', pid: 1 };
  const save = computerSubject(app, 'press', { role: 'AXButton', title: 'Save' });
  assert.equal(save, 'com.example.app press AXButton Save');
  const surface = rules => {
    let asked = 0;
    const permissions = new PermissionBroker({ workspace: '/w', policy: new PolicyEngine({ user: rules }) });
    const access = new SurfaceAccess({ permissions, signal: new AbortController().signal, ask: async () => { asked++; return true; } });
    return { approve: subject => access.approve('computer_act', 'computer.write', app, {}, {}, {}, subject), asked: () => asked };
  };
  const broad = surface([{ effect: 'computer.write', target: 'com.example.app', decision: 'allow' }]);
  await broad.approve(save);
  assert.equal(broad.asked(), 1, 'A bundle-only allow rule prompts');
  const exact = surface([{ effect: 'computer.write', target: 'com.example.app press AXButton Save', decision: 'allow' }]);
  await exact.approve(save);
  await exact.approve(computerSubject(app, 'fill', { role: 'AXTextField', title: 'Name' }));
  assert.equal(exact.asked(), 1, 'Only the named control is allowed');
  const denied = surface([{ effect: 'computer.write', target: 'com.example.*', decision: 'deny' },
    { effect: 'computer.write', target: 'com.example.app press AXButton Save', decision: 'allow' }]);
  await assert.rejects(denied.approve(save), /permission rule denies/);
  const ask = surface([{ effect: 'computer.write', target: 'com.example.app', decision: 'ask' },
    { effect: 'computer.write', target: 'com.example.app *', decision: 'allow' }]);
  await ask.approve(save);
  assert.equal(ask.asked(), 1, 'An app ask rule outranks a detailed allow');
});

test('browser write approvals show the body and keep the site CSP', () => {
  assert.equal(bodyPreview(Buffer.from('name=x&token=\u0001abc')), 'name=x&token= abc');
  assert.equal(bodyPreview(undefined), '(empty)');
  assert.equal(bodyPreview(Buffer.from([0xff, 0xfe, 0x00])), '(binary, 3 bytes)');
  assert.match(bodyPreview(Buffer.from('a'.repeat(700))), /^a{600}… \(700 bytes in total\)$/);
  const csp = scopedCsp("script-src 'nonce-abc'");
  assert.ok(csp.startsWith("script-src 'nonce-abc', default-src 'self'"));
  assert.ok(scopedCsp(undefined).startsWith("default-src 'self'"));
});

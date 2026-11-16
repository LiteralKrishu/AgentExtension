const { constants } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const supported = ['darwin', 'linux'].includes(process.platform);

async function runtimeIdentity(node) {
  await fs.access(node, constants.X_OK);
  const stat = await fs.lstat(node, { bigint: true });
  if (!stat.isFile()) throw new Error('Select the installed Node.js executable.');
  return [stat.dev, stat.ino, stat.size, stat.ctimeNs].map(String).join(':');
}

async function isolatedRuntime(file) {
  if (!supported) throw new Error('This runner requires macOS or Linux with bubblewrap.');
  if (typeof file !== 'string' || !path.isAbsolute(file) || /[\x00-\x1f\x7f]/.test(file)) {
    throw new Error('Configure an absolute Node.js executable path in user settings.');
  }
  const node = await fs.realpath(file);
  if (path.basename(node) !== 'node') throw new Error('Select the installed Node.js executable.');
  const launcher = process.platform === 'darwin' ? '/usr/bin/sandbox-exec' : '/usr/bin/bwrap';
  const [identity] = await Promise.all([runtimeIdentity(node), fs.access(launcher, constants.X_OK)]);
  return { node, launcher, identity };
}

function launchSpec({ node }, directory, entry) {
  const nodeArguments = file => ['--permission', `--allow-fs-read=${file}`, '--max-old-space-size=96', file];
  if (process.platform === 'linux') {
    const file = '/server/entry.cjs';
    return ['--unshare-all', '--unshare-user', '--disable-userns', '--die-with-parent', '--new-session', '--clearenv',
      ...['/lib', '/lib64', '/usr/lib'].flatMap(dir => ['--ro-bind-try', dir, dir]),
      '--dev', '/dev', '--ro-bind', node, '/runtime/node', '--ro-bind', entry, file,
      '--remount-ro', '/', '--chdir', '/server', '--', '/runtime/node', ...nodeArguments(file)];
  }
  const quote = JSON.stringify;
  const profile = ['(version 1) (deny default) (import "system.sb")',
    '(deny file-read* file-test-existence file-map-executable file-write* network* process-fork mach-lookup mach-register ipc*)',
    `(allow process-exec (literal ${quote(node)}))`,
    `(allow file-read* file-test-existence file-map-executable (literal ${quote(node)}) (subpath "/System/Library") (subpath "/usr/lib"))`,
    `(allow file-read* file-test-existence (literal ${quote(entry)}) (literal ${quote(directory)}))`,
    `(allow file-read-metadata file-test-existence (path-ancestors ${quote(node)}) (path-ancestors ${quote(entry)}))`,
  ].join(' ');
  return ['-p', profile, node, ...nodeArguments(entry)];
}

async function stageSource(source, prefix) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), prefix));
  const entry = path.join(directory, 'entry.cjs');
  const clean = () => fs.rm(directory, { recursive: true, force: true });
  try {
    await fs.writeFile(entry, source, { flag: 'wx', mode: 0o400 });
    return { directory, entry, clean };
  } catch (error) {
    await clean();
    throw error;
  }
}

async function startIsolatedNode(runtime, { directory, entry }, signal, stderr = 'pipe') {
  if (await runtimeIdentity(runtime.node) !== runtime.identity) throw new Error('The Node.js executable changed.');
  signal.throwIfAborted();
  const child = spawn(runtime.launcher, launchSpec(runtime, directory, entry), {
    cwd: directory, detached: true, env: {}, stdio: ['pipe', 'pipe', stderr],
  });
  const stop = () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
  };
  signal.addEventListener('abort', stop, { once: true });
  const closed = new Promise(resolve => child.once('close', (code, signalCode) => {
    signal.removeEventListener('abort', stop);
    resolve({ code, signalCode });
  }));
  // These handlers also cover a child exiting before it consumes input.
  child.stdin.on('error', stop);
  child.stdout.on('error', stop);
  child.stderr?.on('error', stop);
  child.on('error', stop);
  return { child, stop, closed };
}

module.exports = { supported, isolatedRuntime, stageSource, startIsolatedNode };

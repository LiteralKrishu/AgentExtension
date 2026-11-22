const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');

const sha256 = data => createHash('sha256').update(data).digest('hex');

// Each profile names its dependency inputs, its install command, and the one registry setup may use.
const PROFILES = Object.freeze({
  // npm ci deletes node_modules, which fails on a mount point, so setup installs inside the volume and checks mount its node_modules.
  node: { image: 'node:22-bookworm-slim', manifests: ['package.json', 'package-lock.json'], registry: 'https://registry.npmjs.org/',
    check: { target: '/work/node_modules', subpath: 'node_modules' }, env: {},
    install: (registry, scripts) => ['sh', '-c', 'cp /work/package.json /work/package-lock.json /deps/ && cd /deps && exec "$@"', 'setup',
      'npm', 'ci', '--no-audit', '--no-fund', `--registry=${registry}`, ...(scripts ? [] : ['--ignore-scripts'])] },
  python: { image: 'python:3.13-slim', manifests: ['requirements.txt'], registry: 'https://pypi.org/simple',
    check: { target: '/deps' }, env: { PYTHONPATH: '/deps', PYTHONDONTWRITEBYTECODE: '1' },
    // pip builds from source only through lifecycle-like build hooks, so without scripts allow wheels only.
    install: (registry, scripts) => ['pip', 'install', '--no-input', '--disable-pip-version-check', '--target', '/deps',
      '--index-url', registry, ...(scripts ? [] : ['--only-binary=:all:']), '-r', 'requirements.txt'] },
});
const QUOTA = Object.freeze({ cpus: '2', memory: '2g', pids: '256', setupSeconds: 600, checkSeconds: 120, outputBytes: 64_000 });

async function detectProfile(directory) {
  for (const [name, profile] of Object.entries(PROFILES)) {
    try { await fs.access(path.join(directory, profile.manifests.at(-1))); return name; } catch { /* try the next profile */ }
  }
  throw new Error('The container environment needs package-lock.json (Node.js) or requirements.txt (Python) at the workspace root.');
}

// Hardened `docker run` arguments. Only the snapshot and the dependency volume are mounted; no host environment passes in.
function runArguments({ name, image, network, readOnlySource, volume, mount, profile, command, args }) {
  return ['run', '--rm', '--name', name, '--network', network, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', QUOTA.pids, '--memory', QUOTA.memory, '--cpus', QUOTA.cpus, '--read-only', '--tmpfs', '/tmp:rw,size=256m',
    '-e', 'HOME=/tmp', '-e', 'LANG=C.UTF-8', ...Object.entries(profile.env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    '-v', `${readOnlySource.directory}:/work${readOnlySource.readOnly ? ':ro' : ''}`, '--mount', `type=volume,src=${volume},dst=${mount.target}${mount.subpath ? `,volume-subpath=${mount.subpath}` : ''}${mount.readOnly ? ',readonly' : ''}`,
    '-w', '/work', '--entrypoint', command, image, ...args];
}

class ContainerEnvironment {
  constructor({ profile, allowScripts = false, engine = 'docker', exec = promisify(execFile), start = spawn } = {}) {
    Object.assign(this, { profileName: profile, allowScripts, engine, exec, start });
  }

  async docker(args, signal, timeout = 30_000) {
    return (await this.exec(this.engine, args, { signal, timeout, maxBuffer: 1_000_000, env: { PATH: process.env.PATH } })).stdout.trim();
  }

  // No fallback: a missing or stopped engine fails the check instead of running it on the host.
  async available(signal) {
    if (!['darwin', 'linux'].includes(process.platform)) throw new Error('The container environment supports macOS and Linux.');
    try { await this.docker(['version', '--format', '{{.Server.Version}}'], signal, 10_000); }
    catch { signal?.throwIfAborted(); throw new Error('Docker is not running. Start Docker Desktop or set agentextension.executionEnvironment to isolated.'); }
  }

  async imageIdentity(image, signal) {
    const inspect = () => this.docker(['image', 'inspect', '--format', '{{index .RepoDigests 0}}', image], signal);
    try { return await inspect(); } catch { signal?.throwIfAborted(); }
    await this.docker(['pull', '--quiet', image], signal, QUOTA.setupSeconds * 1000);
    return inspect();
  }

  // Installs dependencies once per image, dependency files, registry, and script policy; later checks reuse the volume.
  async prepare(directory, signal) {
    await this.available(signal);
    const name = this.profileName ?? await detectProfile(directory);
    const profile = PROFILES[name];
    const image = await this.imageIdentity(profile.image, signal);
    const manifests = [];
    for (const file of profile.manifests) {
      try { manifests.push([file, sha256(await fs.readFile(path.join(directory, file)))]); } catch { /* optional input */ }
    }
    const install = profile.install(profile.registry, this.allowScripts);
    const digest = sha256(JSON.stringify({ image, install, manifests }));
    const volume = `agentextension-deps-${digest.slice(0, 24)}`;
    let cached = true;
    try { await this.docker(['volume', 'inspect', volume], signal); } catch {
      signal.throwIfAborted();
      cached = false;
      await this.docker(['volume', 'create', '--label', 'agentextension=dependencies', volume], signal);
      // Setup reaches the network; checks never do. The source stays read-only during installation.
      const result = await this.spawnRun(runArguments({ name: `agentextension-setup-${digest.slice(0, 12)}-${process.pid}`, image, network: 'bridge',
        readOnlySource: { directory, readOnly: true }, volume, mount: { target: '/deps' }, profile, command: install[0], args: install.slice(1) }), signal, QUOTA.setupSeconds);
      if (result.exitCode !== 0) {
        await this.docker(['volume', 'rm', '--force', volume], undefined).catch(() => {});
        throw new Error(`Dependency setup failed (exit ${result.exitCode ?? result.status}).\n${result.output}`);
      }
    }
    this.prepared = { name, image, volume, digest, cached, profile };
    return this.prepared;
  }

  describe() {
    const { name, image, profile } = this.prepared ?? { name: this.profileName ?? 'auto', image: this.profileName ? PROFILES[this.profileName].image : 'by project', profile: PROFILES[this.profileName] };
    return `Linux container (${name}, ${image}). Dependencies install from ${profile?.registry ?? 'the profile registry'} with lifecycle scripts ${this.allowScripts ? 'allowed' : 'off'}. ` +
      `Checks run without network, with ${QUOTA.cpus} CPUs and ${QUOTA.memory} memory, and see only the workspace snapshot.`;
  }

  async run(command, args, directory, signal) {
    const { image, volume, profile, digest } = await this.prepare(directory, signal);
    const result = await this.spawnRun(runArguments({ name: `agentextension-check-${digest.slice(0, 12)}-${process.pid}-${Date.now()}`, image,
      network: 'none', readOnlySource: { directory, readOnly: false }, volume, mount: { ...profile.check, readOnly: true }, profile, command, args }), signal, QUOTA.checkSeconds);
    return { ...result, environment: { image, dependencies: digest } };
  }

  spawnRun(args, signal, seconds) {
    signal.throwIfAborted();
    const name = args[args.indexOf('--name') + 1];
    return new Promise((resolve, reject) => {
      const child = this.start(this.engine, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
      let output = '';
      let stopped;
      // Stop the container itself; killing the client alone can leave it running.
      const stop = reason => { stopped ??= reason; void this.docker(['kill', name], undefined).catch(() => {}); child.kill('SIGKILL'); };
      const cancel = () => stop('Command cancelled.');
      const timer = setTimeout(() => stop(`Command timed out after ${seconds} seconds.`), seconds * 1000);
      signal.addEventListener('abort', cancel, { once: true });
      const add = data => { output += data.toString().slice(0, Math.max(0, QUOTA.outputBytes - output.length)); };
      child.stdout.on('data', add);
      child.stderr.on('data', add);
      child.on('error', reject);
      child.on('close', code => {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        resolve({ exitCode: stopped ? null : code, output, ...(stopped ? { status: stopped } : {}) });
      });
    });
  }
}

module.exports = { ContainerEnvironment, PROFILES, QUOTA, runArguments, detectProfile };

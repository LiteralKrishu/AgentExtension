const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash, randomUUID } = require('node:crypto');
const { managedChecks, findCheck, runServices } = require('./execution-services');
const { safePath } = require('./workspace');
const { readWithin } = require('./skills');

const sha256 = data => createHash('sha256').update(data).digest('hex');
const preparations = new Map();
const jobName = kind => `agentextension-${kind}-${randomUUID()}`;

// Each profile names its dependency inputs, its install command, and the one registry setup may use.
const PROFILES = Object.freeze({
  // npm ci deletes node_modules, which fails on a mount point, so setup installs inside the volume and checks mount its node_modules.
  node: { image: 'node:22-bookworm-slim', manifests: ['package.json', 'package-lock.json'], registry: 'https://registry.npmjs.org/',
    check: { target: '/work/node_modules', subpath: 'node_modules' }, env: {},
    install: (registry, scripts) => ['sh', '-c', 'cp /work/package.json /work/package-lock.json /deps/ && cd /deps && "$@" && mkdir -p node_modules', 'setup',
      'npm', 'ci', '--no-audit', '--no-fund', `--registry=${registry}`, ...(scripts ? [] : ['--ignore-scripts'])] },
  python: { image: 'python:3.13-slim', manifests: ['requirements.txt'], registry: 'https://pypi.org/simple',
    check: { target: '/deps' }, env: { PYTHONPATH: '/deps', PYTHONDONTWRITEBYTECODE: '1' },
    // pip builds from source only through lifecycle-like build hooks, so without scripts allow wheels only.
    install: (registry, scripts) => ['pip', 'install', '--no-input', '--disable-pip-version-check', '--target', '/deps',
      '--index-url', registry, ...(scripts ? [] : ['--only-binary=:all:']), '-r', 'requirements.txt'] },
  browser: { image: 'mcr.microsoft.com/playwright:v1.62.1-noble', manifests: ['package.json', 'package-lock.json'], registry: 'https://registry.npmjs.org/',
    check: { target: '/work/node_modules', subpath: 'node_modules' }, env: { PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright' },
    install: (registry, scripts) => PROFILES.node.install(registry, scripts) },
});
const QUOTA = Object.freeze({ cpus: '2', memory: '2g', pids: '256', setupSeconds: 600, checkSeconds: 120, outputBytes: 64_000 });

async function detectProfile(directory) {
  for (const [name, profile] of Object.entries(PROFILES)) {
    try { await fs.access(path.join(directory, profile.manifests.at(-1))); return name; } catch { /* try the next profile */ }
  }
  throw new Error('The container environment needs package-lock.json (Node.js) or requirements.txt (Python) at the workspace root.');
}

async function dependencyInputs(directory, name, profile, signal) {
  if (name !== 'python') {
    const manifests = [];
    for (const file of profile.manifests) {
      try { manifests.push([file, sha256(await fs.readFile(path.join(directory, file)))]); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return manifests;
  }
  const files = new Map(), active = new Set(); let bytes = 0;
  async function visit(file) {
    signal.throwIfAborted(); safePath(file, { lockfiles: true });
    if (active.has(file)) throw new Error('Python dependency files contain a circular include.');
    if (files.has(file)) return;
    const text = await readWithin(directory, file, 256000);
    bytes += Buffer.byteLength(text);
    if (files.size >= 64 || bytes > 2000000) throw new Error('Python dependency inputs exceed 64 files or 2 MB.');
    files.set(file, sha256(text)); active.add(file);
    for (const raw of text.replace(/\\\r?\n/g, '').split(/\r?\n/)) {
      const line = raw.replace(/(^|\s+)#.*$/, '').trim();
      if (!line) continue;
      const include = /^(?:-r\s*|-c\s*|--requirement(?:=|\s+)|--constraint(?:=|\s+))(?:(?:"([^"]+)")|(?:'([^']+)')|(\S+))$/.exec(line);
      if (include) {
        const target = include[1] ?? include[2] ?? include[3];
        if (path.posix.isAbsolute(target) || /[\\:$]/.test(target)) throw new Error('Python includes must name local files inside the snapshot without environment variables.');
        await visit(path.posix.normalize(path.posix.join(path.posix.dirname(file), target)));
      } else if (/^(?:-r|-c|--requirement|--constraint)/.test(line)) {
        throw new Error('Use one Python requirements or constraint include per line, with a local file path.');
      } else if (/^(?:-e|--editable)(?:\s|=|$)|--find-links|(?:^|[\s@])file:|(?:^|[\s@])(?:git|hg|svn|bzr)\+|^(?:\.|\/|~|[A-Za-z]:)|@\s*(?:\.|\/|~)|^(?!https?:\/\/)\S*\/|\.(?:whl|zip|tar\.gz)(?:\s|$)/i.test(line)) {
        // shortcut: local/VCS installs need source hashing before they can use the dependency cache.
        throw new Error('Cached Python setup supports registry requirements and local -r/-c files; local packages, editable/VCS installs, and find-links are not supported.');
      }
    }
    active.delete(file);
  }
  await visit('requirements.txt');
  return [...files].sort(([a], [b]) => a.localeCompare(b));
}

// Hardened `docker run` arguments. Only the snapshot and the dependency volume are mounted; no host environment passes in.
function runArguments({ name, image, network, readOnlySource, volume, mount, profile, command, args }) {
  return ['run', '--rm', '--name', name, '--network', network, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', QUOTA.pids, '--memory', QUOTA.memory, '--cpus', QUOTA.cpus, '--read-only', '--tmpfs', '/tmp:rw,size=256m',
    '-e', 'HOME=/tmp', '-e', 'LANG=C.UTF-8',
    ...['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'].flatMap(key => ['-e', `${key}=`]),
    ...Object.entries(profile.env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    '-v', `${readOnlySource.directory}:/work${readOnlySource.readOnly ? ':ro' : ''}`, '--mount', `type=volume,src=${volume},dst=${mount.target}${mount.subpath ? `,volume-subpath=${mount.subpath}` : ''}${mount.readOnly ? ',readonly' : ''}`,
    '-w', '/work', '--entrypoint', command, image, ...args];
}

class ContainerEnvironment {
  constructor({ profile, checks = [], allowScripts = false, engine = 'docker', exec = promisify(execFile), start = spawn } = {}) {
    Object.assign(this, { profileName: profile, allowScripts, engine, exec, start });
    this.checks = managedChecks(checks);
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

  async imageIdentity(image, signal, pull = true) {
    const inspect = () => this.docker(['image', 'inspect', '--format', '{{index .RepoDigests 0}}', image], signal);
    const valid = value => /^[\w./:-]+@sha256:[a-f0-9]{64}$/.test(value);
    try { const value = await inspect(); if (valid(value)) return value; } catch { signal?.throwIfAborted(); }
    if (!pull) throw Object.assign(new Error(`Download the container image ${image} before running this check.`), { code: 'ENEEDSIMAGE', image });
    await this.docker(['pull', '--quiet', image], signal, QUOTA.setupSeconds * 1000);
    const value = await inspect();
    if (!valid(value)) throw new Error('The container image has no immutable repository digest.');
    return value;
  }

  // Installs dependencies once per image, dependency files, registry, and script policy; later checks reuse the volume.
  async prepare(directory, signal, profileName = this.profileName, authorization = {}) {
    await this.available(signal);
    const name = profileName ?? await detectProfile(directory);
    const profile = PROFILES[name];
    if (!profile) throw new Error('Unsupported container profile. Choose Node.js or Python.');
    const image = await this.imageIdentity(profile.image, signal);
    if (authorization.image && authorization.image !== image) throw new Error('Container image changed after approval. Approve a fresh check.');
    const manifests = await dependencyInputs(directory, name, profile, signal);
    const install = profile.install(profile.registry, this.allowScripts);
    const digest = sha256(JSON.stringify({ schema: 3, image, install, manifests }));
    const volume = `agentextension-deps-${digest.slice(0, 24)}`;
    const key = `${this.engine}:${volume}`;
    const pending = preparations.get(key);
    if (pending) {
      const result = await pending;
      signal.throwIfAborted();
      this.prepared = { ...result, cached: true };
      return this.prepared;
    }
    await authorization.validate?.(); signal.throwIfAborted();
    const preparing = this.prepareVolume({ name, profile, image, install, digest, volume, directory }, signal);
    preparations.set(key, preparing);
    try { this.prepared = await preparing; return this.prepared; }
    finally { if (preparations.get(key) === preparing) preparations.delete(key); }
  }

  async prepareVolume({ name, profile, image, install, digest, volume, directory }, signal) {
    let cached = true;
    try { await this.docker(['volume', 'inspect', volume], signal); } catch {
      signal.throwIfAborted();
      cached = false;
      await this.docker(['volume', 'create', '--label', 'agentextension=dependencies', volume], signal);
      // Setup reaches the network; checks never do. The source stays read-only during installation.
      try {
        const result = await this.spawnRun(runArguments({ name: jobName('setup'), image, network: 'bridge',
          readOnlySource: { directory, readOnly: true }, volume, mount: { target: '/deps' }, profile, command: 'sh',
          args: ['-c', `"$@" && printf %s ${digest} > /deps/.agentextension-ready`, 'setup', ...install] }), signal, QUOTA.setupSeconds);
        if (result.exitCode !== 0) throw new Error(`Dependency setup failed (exit ${result.exitCode ?? result.status}).\n${result.output}`);
      } catch (error) {
        await this.docker(['volume', 'rm', '--force', volume], undefined).catch(() => {});
        throw error;
      }
    }
    if (cached) {
      const probe = jobName('cache');
      try {
        await this.docker(runArguments({ name: probe, image, network: 'none', readOnlySource: { directory, readOnly: true },
          volume, mount: { target: '/deps', readOnly: true }, profile, command: 'sh',
          args: ['-c', 'test "$(cat /deps/.agentextension-ready)" = "$1"', 'ready', digest] }), signal);
      } catch {
        signal.throwIfAborted();
        throw new Error('The dependency cache is incomplete or another setup is still running. No check was run.');
      } finally { await this.removeContainer(probe); }
    }
    return { name, image, volume, digest, cached, profile };
  }

  async authorizationIdentity(directory, command, args, signal) {
    await this.available(signal);
    const check = findCheck(this.checks, command, args);
    const name = check?.profile ?? this.profileName ?? await detectProfile(directory);
    const profile = PROFILES[name];
    if (!profile) throw new Error('Unsupported container profile.');
    return { image: await this.imageIdentity(profile.image, signal, false), declaration: this.declarationDigest(command, args) };
  }

  declarationDigest(command, args) {
    return sha256(JSON.stringify({ check: findCheck(this.checks, command, args) ?? null, profile: this.profileName ?? 'auto', allowScripts: this.allowScripts }));
  }

  catalog(name) {
    if (!name) return { checks: this.checks.map(check => ({ name: check.name, command: check.command,
      cwd: check.cwd, profile: check.profile, services: check.services.length })),
      note: 'Request a check by name for its exact command arguments. Environment values are omitted.' };
    const check = this.checks.find(check => check.name === name);
    if (!check) throw new Error('Unknown managed check name.');
    const result = { name: check.name, command: check.command, args: check.args, cwd: check.cwd, profile: check.profile,
      leaseSeconds: check.leaseSeconds, services: check.services.map(service => ({ name: service.name, ready: service.ready })) };
    if (JSON.stringify(result).length > 12000) throw new Error('This check declaration exceeds the catalog output limit. Use the exact command supplied by the user.');
    return result;
  }

  describe(command, args) {
    const check = command ? findCheck(this.checks, command, args) : undefined;
    if (check) return `Managed check ${check.name} (${PROFILES[check.profile].image}). Services: ` +
      (check.services.map(service => `${service.name} on private loopback ${service.ready.port}`).join(', ') || 'none') +
      `. No network or host ports. Lifetime ${check.leaseSeconds}s; writable temporary files limited to 512 MiB. ` +
      `Environment names: ${[...new Set([check, ...check.services].flatMap(program => Object.keys(program.env)))].join(', ') || 'none'}. ` +
      `Dependencies use ${PROFILES[check.profile].registry}; lifecycle scripts ${this.allowScripts ? 'allowed' : 'off'}.`;
    const { name, image, profile } = this.prepared ?? { name: this.profileName ?? 'auto', image: this.profileName ? PROFILES[this.profileName].image : 'by project', profile: PROFILES[this.profileName] };
    return `Linux container (${name}, ${image}). Dependencies install from ${profile?.registry ?? 'the profile registry'} with lifecycle scripts ${this.allowScripts ? 'allowed' : 'off'}. ` +
      `Checks run without network, with ${QUOTA.cpus} CPUs and ${QUOTA.memory} memory, and see only the workspace snapshot.`;
  }

  async run(command, args, directory, signal, authorization = {}) {
    if (authorization.declaration && authorization.declaration !== this.declarationDigest(command, args)) throw new Error('Managed check declaration changed after approval.');
    const check = findCheck(this.checks, command, args);
    const prepared = await this.prepare(directory, signal, check?.profile ?? this.profileName, authorization);
    await authorization.validate?.(); signal.throwIfAborted();
    if (check) return runServices(this, check, directory, signal, prepared, runArguments);
    const { image, volume, profile, digest } = prepared;
    const result = await this.spawnRun(runArguments({ name: jobName('check'), image,
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
      const stop = reason => { stopped ??= reason; child.kill('SIGKILL'); };
      const cancel = () => stop('Command cancelled.');
      const timer = setTimeout(() => stop(`Command timed out after ${seconds} seconds.`), seconds * 1000);
      signal.addEventListener('abort', cancel, { once: true });
      const add = data => { output += data.toString().slice(0, Math.max(0, QUOTA.outputBytes - output.length)); };
      child.stdout.on('data', add);
      child.stderr.on('data', add);
      let finished = false;
      const finish = async (code, error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        try { await this.removeContainer(name); }
        catch (cleanup) { reject(new Error(`Container cleanup could not be confirmed: ${cleanup.message}`)); return; }
        if (error) { reject(error); return; }
        resolve({ exitCode: stopped ? null : code, output, ...(stopped ? { status: stopped } : {}), cleanup: 'complete' });
      };
      child.on('error', error => { void finish(null, error); });
      child.on('close', code => { void finish(code); });
      if (signal.aborted) cancel();
    });
  }

  async removeContainer(name) {
    try { await this.docker(['rm', '--force', name], undefined); }
    catch (error) { if (!/No such container/i.test(String(error.stderr ?? error.message))) throw error; }
  }
}

module.exports = { ContainerEnvironment, PROFILES, QUOTA, runArguments, detectProfile };

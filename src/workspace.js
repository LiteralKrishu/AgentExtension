const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const { MAX_TEXT } = require('./draft');

const exec = promisify(execFile);
// Repository config can name programs Git runs, such as core.fsmonitor. Every Git call turns those off.
const GIT_HARDENING = ['--no-optional-locks', '--no-replace-objects', '--literal-pathspecs',
  '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never'];
const gitEnvironment = () => ({ ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' });
const EXCLUDED = /(?:^|\/)(?:\.[^/]+|node_modules|vendor|dist|build|coverage|__pycache__|venv)(?:\/|$)|(?:^|\/)(?:credentials|secrets)(?:\.[^/]+)?$|(?:^|\/)(?:id_rsa|id_ed25519)(?:\.[^/]+)?$|\.(?:pem|key|p12|pfx)$/i;
// Lockfiles stay out of search and editor tools but are part of a command snapshot's build inputs.
const LOCKFILE = /\.lock$/i;
const SNAPSHOT_QUOTA = Object.freeze({ files: 100_000, bytes: 2_000_000_000 });
const quotaError = message => Object.assign(new Error(message), { code: 'ESNAPSHOTQUOTA' });
async function hashFile(file, signal) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest('hex');
}
const sha256 = data => createHash('sha256').update(data).digest('hex');
const sameFile = (a, b) => a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino;
const NON_SOURCE = /\.(?:svg|map|jsonl|csv|png|jpe?g|gif|webp|pdf|zip|tgz|woff2?|ico)$/i;
const emptyInterpreter = (command, args) => /^(?:node|nodejs|python(?:\d+(?:\.\d+)*)?|ruby|perl|bash|sh|zsh)(?:\.exe)?$/i.test(command)
  && Array.isArray(args) && (args.length === 0 || args.length === 1 && args[0] === '-');
function diagnosticCommand(command,args) {
  if (!Array.isArray(args)) return false;
  if (emptyInterpreter(command,args)) return true;
  if (args.length===1 && ['--help','-h','--version'].includes(args[0])) return true;
  // These runtime flags exit before a later script argument can run.
  if (/^(?:node|nodejs|npm|npx)(?:\.exe)?$/i.test(command)&&args[0]==='-v') return true;
  if (/^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/i.test(command)&&args[0]==='-V') return true;
  return /^(?:node|nodejs|npm|npx|pytest|py\.test|python(?:\d+(?:\.\d+)*)?)(?:\.exe)?$/i.test(command)&&
    ['--help','-h','--version'].some(flag=>args.includes(flag));
}

function safePath(file, { lockfiles = false } = {}) {
  if (!file || file.includes('\\') || file.includes('\0') || file.includes(':')
    || file.split('/').some(part => !part || part === '.' || part === '..') || EXCLUDED.test(file) || (!lockfiles && LOCKFILE.test(file))) {
    throw new Error('Use a visible, workspace-relative path with no traversal or private files.');
  }
  return file;
}

class Workspace {
  constructor(root, openText, findPaths) {
    this.root = root;
    this.openText = openText;
    this.findPaths = findPaths;
  }

  async resolve(file, newFile = false, options) {
    safePath(file, options);
    let full = await fs.realpath(this.root);
    if (this.identity && full !== this.identity) throw new Error('Workspace identity changed. Start a new run.');
    const parts = file.split('/');
    const workspacePath = path.join(this.root, ...parts);
    for (const [index, part] of parts.entries()) {
      full = path.join(full, part);
      let stat;
      try {
        stat = await fs.lstat(full);
      } catch (error) {
        if (error.code === 'ENOENT' && newFile && index === parts.length - 1) return workspacePath;
        throw error;
      }
      if (stat.isSymbolicLink()) throw new Error('Symbolic links are outside the editor tool scope.');
      if (index === parts.length - 1 && (newFile || !stat.isFile())) {
        throw new Error(newFile ? 'A file already exists at this path.' : 'The path must point to a file.');
      }
    }
    return workspacePath;
  }

  async read(file, newFile = false) {
    const full = await this.resolve(file, newFile);
    if (newFile) return null;
    const stat = await fs.stat(full);
    if (stat.size > MAX_TEXT) throw new Error('This file exceeds the editor tool size limit.');
    const text = this.openText(full) ?? new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(full));
    if (text.length > MAX_TEXT || text.includes('\0')) throw new Error('This file is too large or binary.');
    return text;
  }

  // A caller can share directory checks within one bounded inventory pass. Reads still resolve afresh.
  async inspect(file, directories = new Map()) {
    safePath(file);
    if (!directories.has('')) directories.set('', fs.realpath(this.root).then(root => {
      if (this.identity && root !== this.identity) throw new Error('Workspace identity changed. Start a new run.');
      return root;
    }));
    const parts = file.split('/');
    let full = await directories.get('');
    for (let index = 0; index < parts.length - 1; index++) {
      full = path.join(full, parts[index]);
      const key = parts.slice(0, index + 1).join('/');
      if (!directories.has(key)) directories.set(key, fs.lstat(full).then(stat => {
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Symbolic links are outside the editor tool scope.');
      }));
      await directories.get(key);
    }
    full = path.join(full, parts.at(-1));
    const stat = await fs.lstat(full, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('The path must point to a regular file without symbolic links.');
    return { full, stat };
  }

  async gitRevision(signal) {
    const options = { cwd: this.root, signal, timeout: 5_000, maxBuffer: 16_000, env: gitEnvironment() };
    try {
      const { stdout: root } = await exec('git', [...GIT_HARDENING, 'rev-parse', '--show-toplevel'], options);
      if (await fs.realpath(root.replace(/\r?\n$/, '')) !== this.root) throw new Error('Select the repository root.');
      const { stdout } = await exec('git', [...GIT_HARDENING, 'rev-parse', '--verify', 'HEAD^{commit}'], options);
      const revision = stdout.trim();
      if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) return revision;
    } catch (error) { signal?.throwIfAborted(); }
    throw new Error('Open the root of a Git repository with a commit.');
  }

  async paths(signal, { limit = 12_000, lockfiles = false } = {}) {
    if (this.identity && await fs.realpath(this.root) !== this.identity) throw new Error('Workspace identity changed. Start a new run.');
    let files;
    try {
      const { stdout } = await exec('git', [...GIT_HARDENING, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'], {
        cwd: this.root, signal, maxBuffer: 8 * 1024 * 1024, env: gitEnvironment(),
      });
      files = stdout.split('\0');
    } catch {
      signal?.throwIfAborted();
      files = await this.findPaths(signal, limit);
    }
    return [...new Set(files)].filter(file => {
      try { return Boolean(safePath(file, { lockfiles })); } catch { return false; }
    }).slice(0, limit);
  }

  async sourcePaths(signal) {
    return (await this.paths(signal)).filter(file => !NON_SOURCE.test(file));
  }

  async index(signal) {
    const files = [];
    let total = 0;
    const paths = await this.sourcePaths(signal);
    for (let index = 0; index < paths.length && total < 32_000_000; index += 24) {
      signal.throwIfAborted();
      const batch = await Promise.all(paths.slice(index, index + 24).map(async file => {
        try { return { path: file, text: await this.read(file) }; } catch { return null; }
      }));
      for (const entry of batch) {
        if (!entry || total + entry.text.length > 32_000_000) continue;
        files.push(entry);
        total += entry.text.length;
      }
    }
    return files;
  }

  // Bind a command approval to the same permitted files and open buffers used by snapshots.
  async sourceIdentity(signal) {
    const quota = this.quota ?? SNAPSHOT_QUOTA;
    const paths = await this.paths(signal, { limit: quota.files + 1, lockfiles: true });
    if (paths.length > quota.files) throw quotaError(`The command snapshot needs more than its ${quota.files}-file limit.`);
    const sources = new Map(); let bytes = 0;
    this.hashes ??= new Map();
    for (const file of paths) {
      signal.throwIfAborted();
      let source;
      try { source = await this.resolve(file, false, { lockfiles: true }); } catch { continue; }
      const stat = await fs.stat(source); bytes += stat.size;
      if (bytes > quota.bytes) throw quotaError(`The command snapshot exceeds its ${quota.bytes}-byte limit.`);
      const open = this.openText(source);
      const cached = this.hashes.get(source);
      const hash = open !== undefined ? sha256(open) : cached && sameFile(cached.stat, stat) ? cached.hash : await hashFile(source, signal);
      if (!sameFile(stat, await fs.stat(source))) throw new Error(`${file} changed during command authorization.`);
      if (open === undefined) this.hashes.set(source, { stat, hash });
      sources.set(file, hash);
    }
    signal.throwIfAborted();
    return sha256(JSON.stringify([...sources].sort(([a], [b]) => a.localeCompare(b))));
  }

  // Materializes every permitted file and lockfile into a private copy-on-write folder, overlays open editors, and
  // applies the draft. It fails with a quota reason rather than checking a partial tree. The caller removes the folder.
  async snapshot(changes, signal, { overlay = true } = {}) {
    const quota = this.quota ?? SNAPSHOT_QUOTA;
    const paths = await this.paths(signal, { limit: quota.files + 1, lockfiles: true });
    if (paths.length > quota.files) throw quotaError(`The command snapshot needs more than its ${quota.files}-file limit.`);
    const manifest = [];
    let bytes = 0;
    for (const file of paths) {
      signal.throwIfAborted();
      let source;
      try { source = await this.resolve(file, false, { lockfiles: true }); } catch { continue; }
      const stat = await fs.stat(source);
      bytes += stat.size;
      if (bytes > quota.bytes) throw quotaError(`The command snapshot exceeds its ${quota.bytes}-byte limit.`);
      manifest.push({ file, source, stat });
    }
    const { bavail, bsize } = await fs.statfs(os.tmpdir());
    if (bavail * bsize < bytes * 1.1) throw quotaError('There is not enough free disk space for the command snapshot.');
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-')));
    try {
      const sources = new Map();
      const folders = new Set();
      this.hashes ??= new Map();
      for (const { file, source, stat } of manifest) {
        signal.throwIfAborted();
        const target = path.join(directory, file);
        if (!folders.has(path.dirname(target))) { await fs.mkdir(path.dirname(target), { recursive: true }); folders.add(path.dirname(target)); }
        // A clone is a private writable copy. Never hard-link: a check could then modify the workspace.
        await fs.copyFile(source, target, fs.constants.COPYFILE_FICLONE);
        if (!sameFile(stat, await fs.stat(source))) throw new Error(`${file} changed while the command snapshot was prepared.`);
        const open = overlay ? this.openText(source) : undefined;
        if (open !== undefined) { await fs.writeFile(target, open); sources.set(file, sha256(open)); continue; }
        const cached = this.hashes.get(source);
        let hash = cached && sameFile(cached.stat, stat) ? cached.hash : undefined;
        if (!hash) { hash = sha256(await fs.readFile(target)); this.hashes.set(source, { stat, hash }); }
        sources.set(file, hash);
      }
      const inputs = new Map(sources);
      for (const { file, before, after } of changes) {
        signal.throwIfAborted();
        if (await this.read(file, before === null) !== before) throw new Error(`${file} changed since the draft was staged.`);
        const target = path.join(directory, file);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, after);
        inputs.set(file, sha256(after));
      }
      return { directory, sources, inputs, files: manifest.length, bytes };
    } catch (error) {
      await fs.rm(directory, { force: true, recursive: true });
      throw error;
    }
  }

  async command(command, args, changes, signal, authorization = {}) {
    const { directory, inputs, sources } = await this.snapshot(changes, signal);
    try {
      const sourceDigest = sha256(JSON.stringify([...sources].sort(([a], [b]) => a.localeCompare(b))));
      if (authorization.sourceDigest && sourceDigest !== authorization.sourceDigest) throw new Error('Command sources changed after approval. Approve a fresh check.');
      await authorization.validate?.();
      signal.throwIfAborted();
      // A configured container environment never falls back to the host runner.
      const result = this.environment ? await this.environment.run(command, args, directory, signal, authorization)
        : await runIsolated(command, args, directory, signal, { hidden: [await fs.realpath(this.root)] });
      // Bind the result to its exact inputs and to the toolchain environment that ran it.
      const inputDigest = sha256(JSON.stringify([...inputs].sort(([a], [b]) => a.localeCompare(b))));
      const environmentDigest = sha256(JSON.stringify(result.environment ?? [process.platform, process.arch, process.version, process.env.PATH ?? '']));
      // Show workspace-relative paths instead of the temporary snapshot folder.
      return { ...result, inputDigest, environmentDigest, output: result.output.split(`${directory}${path.sep}`).join('').split(directory).join('.') };
    } finally {
      await fs.rm(directory, { force: true, recursive: true });
    }
  }
}

const within = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

// Folders the command may read inside a hidden folder: the toolchain bin folders on PATH. A bin folder's parent is
// included when it sits at least two levels below the hidden folder, such as ~/.nvm/versions/node/v22, so a
// shallow parent like ~/.local or the home folder itself stays hidden.
async function readableToolchains(hidden, searchPath = process.env.PATH ?? '') {
  const output = new Set();
  for (const entry of searchPath.split(path.delimiter)) {
    if (!path.isAbsolute(entry)) continue;
    let real;
    try { real = await fs.realpath(entry); } catch { continue; }
    const owner = hidden.find(folder => within(real, folder) && real !== folder);
    if (!owner) continue;
    const parent = path.dirname(real);
    const depth = path.relative(owner, parent).split(path.sep).filter(Boolean).length;
    output.add(path.basename(real) === 'bin' && depth >= 2 ? parent : real);
  }
  return [...output];
}

// Shared folders that hold other users' files, other runs' temporary files and service sockets.
const SHARED_FOLDERS = {
  darwin: ['/Users', '/Volumes', '/private/tmp', '/private/var/tmp', '/private/var/folders'],
  linux: ['/tmp', '/var/tmp', '/run'],
};
// Lookups a command needs for user names and logging. Other services could start programs outside the sandbox,
// for example through launchd, Launch Services or Apple Events.
const DARWIN_SERVICES = ['com.apple.system.opendirectoryd.libinfo', 'com.apple.system.logger', 'com.apple.system.notification_center'];

// The command reads only the staged copy, system folders and toolchains. The home folder, the real workspace
// (including files excluded from the copy such as .env), shared temporary folders and service sockets stay
// unreachable. Network and other writes are denied.
async function sandboxArguments(command, args, cwd, { hidden = [], platform = process.platform, searchPath, readOnly = false } = {}) {
  let home;
  try { home = await fs.realpath(os.homedir()); } catch { home = os.homedir(); }
  // The home folder comes first so a toolchain under it is measured against home, not against /Users.
  const folders = [...new Set([home, ...hidden, ...SHARED_FOLDERS[platform] ?? []])]
    .filter(folder => path.isAbsolute(folder) && folder !== path.parse(folder).root);
  const readable = await readableToolchains(folders, searchPath);
  if (platform === 'darwin') {
    const quote = value => JSON.stringify(value);
    // Later rules win: hide the folders, then allow toolchains and the staged copy again.
    const profile = ['(version 1) (allow default) (deny network*) (deny file-write*)',
      `(deny mach-lookup) (allow mach-lookup ${DARWIN_SERVICES.map(name => `(global-name ${quote(name)})`).join(' ')})`,
      '(deny appleevent-send) (deny lsopen)',
      '(deny signal) (allow signal (target same-sandbox))',
      ...folders.map(folder => `(deny file-read* (subpath ${quote(folder)}))`),
      ...readable.map(folder => `(allow file-read* (subpath ${quote(folder)}))`),
      // Path resolution needs the metadata, not the contents, of the folders above the copy and toolchains.
      `(allow file-read-metadata ${[cwd, ...readable].map(folder => `(path-ancestors ${quote(folder)})`).join(' ')})`,
      `(allow ${readOnly ? 'file-read*' : 'file-read* file-write*'} (subpath ${quote(cwd)})) (allow file-write* (literal "/dev/null"))`].join(' ');
    return { executable: '/usr/bin/sandbox-exec', parameters: ['-p', profile, command, ...args] };
  }
  if (platform === 'linux') {
    // Empty tmpfs mounts hide the folders. Toolchains and the copy are bound back on top; bind sources come from the host.
    return { executable: 'bwrap', parameters: ['--unshare-all', '--die-with-parent', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
      ...folders.flatMap(folder => ['--tmpfs', folder]),
      ...readable.flatMap(folder => ['--ro-bind', folder, folder]),
      readOnly ? '--ro-bind' : '--bind', cwd, cwd, '--chdir', cwd, '--', command, ...args] };
  }
  throw new Error('Isolated command execution is available on macOS and on Linux with bubblewrap.');
}

async function runIsolated(command, args, cwd, signal, options = {}) {
  let executable;
  let parameters;
  if (process.platform === 'darwin' || process.platform === 'linux') {
    ({ executable, parameters } = await sandboxArguments(command, args, cwd, options));
  } else {
    throw new Error('Isolated command execution is available on macOS and on Linux with bubblewrap.');
  }
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, parameters, {
      cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: cwd, TMPDIR: cwd, LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' },
    });
    let output = '';
    let stopped;
    const stop = reason => {
      stopped ??= reason;
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
          if (error.code !== 'ESRCH') child.kill('SIGKILL');
        }
      }
    };
    const cancel = () => stop('Command cancelled.');
    const timer = setTimeout(() => stop('Command timed out after 30 seconds.'), 30_000);
    signal.addEventListener('abort', cancel, { once: true });
    const outputLimit = Math.min(256_000, Math.max(1, options.maxOutputBytes ?? 8_000));
    const add = data => { output += data.toString().slice(0, Math.max(0, outputLimit - output.length)); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      stop('Command finished.');
      resolve({ exitCode: code, output, ...(code === null ? { status: stopped } : {}) });
    });
  });
}

module.exports = { Workspace, SNAPSHOT_QUOTA, safePath, runIsolated, sandboxArguments, readableToolchains, GIT_HARDENING, gitEnvironment, emptyInterpreter, diagnosticCommand };

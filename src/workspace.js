const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { MAX_TEXT } = require('./draft');

const exec = promisify(execFile);
// Repository config can name programs Git runs, such as core.fsmonitor. Every Git call turns those off.
const GIT_HARDENING = ['--no-optional-locks', '--no-replace-objects', '--literal-pathspecs',
  '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never'];
const gitEnvironment = () => ({ ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' });
const EXCLUDED = /(?:^|\/)(?:\.[^/]+|node_modules|vendor|dist|build|coverage|__pycache__|venv)(?:\/|$)|(?:^|\/)(?:credentials|secrets)(?:\.[^/]+)?$|(?:^|\/)(?:id_rsa|id_ed25519)(?:\.[^/]+)?$|\.(?:pem|key|p12|pfx|lock)$/i;
const NON_SOURCE = /\.(?:svg|map|jsonl|csv|png|jpe?g|gif|webp|pdf|zip|tgz|woff2?|ico)$/i;

function safePath(file) {
  if (!file || file.includes('\\') || file.includes('\0') || file.includes(':')
    || file.split('/').some(part => !part || part === '.' || part === '..') || EXCLUDED.test(file)) {
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

  async resolve(file, newFile = false) {
    safePath(file);
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

  async paths(signal) {
    if (this.identity && await fs.realpath(this.root) !== this.identity) throw new Error('Workspace identity changed. Start a new run.');
    let files;
    try {
      const { stdout } = await exec('git', [...GIT_HARDENING, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'], {
        cwd: this.root, signal, maxBuffer: 8 * 1024 * 1024, env: gitEnvironment(),
      });
      files = stdout.split('\0');
    } catch {
      signal?.throwIfAborted();
      files = await this.findPaths(signal);
    }
    return [...new Set(files)].filter(file => {
      try { return Boolean(safePath(file)); } catch { return false; }
    }).slice(0, 12_000);
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

  async command(command, args, changes, signal) {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-')));
    try {
      let size = 0;
      for (const file of await this.paths(signal)) {
        signal.throwIfAborted();
        let source;
        try { source = await this.resolve(file); } catch { continue; }
        size += (await fs.stat(source)).size;
        if (size > 64_000_000) throw new Error('The workspace is too large to stage a command snapshot.');
        const target = path.join(directory, file);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(source, target);
        const open = this.openText(source);
        if (open !== undefined) await fs.writeFile(target, open);
      }
      for (const { file, before, after } of changes) {
        signal.throwIfAborted();
        if (await this.read(file, before === null) !== before) throw new Error(`${file} changed since the draft was staged.`);
        const target = path.join(directory, file);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, after);
      }
      const result = await runIsolated(command, args, directory, signal, { hidden: [await fs.realpath(this.root)] });
      // Show workspace-relative paths instead of the temporary snapshot folder.
      return { ...result, output: result.output.split(`${directory}${path.sep}`).join('').split(directory).join('.') };
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

// The command reads only the staged copy, system folders and toolchains. The home folder and the real workspace,
// including files excluded from the copy such as .env, stay unreadable. Network and other writes are denied.
async function sandboxArguments(command, args, cwd, { hidden = [], platform = process.platform, searchPath } = {}) {
  let home;
  try { home = await fs.realpath(os.homedir()); } catch { home = os.homedir(); }
  const folders = [...new Set([home, ...hidden])].filter(folder => path.isAbsolute(folder) && folder !== path.parse(folder).root);
  const readable = await readableToolchains(folders, searchPath);
  if (platform === 'darwin') {
    const quote = value => JSON.stringify(value);
    // Later rules win: hide the folders, then allow toolchains and the staged copy again.
    const profile = ['(version 1) (allow default) (deny network*) (deny file-write*)',
      ...folders.map(folder => `(deny file-read* (subpath ${quote(folder)}))`),
      ...readable.map(folder => `(allow file-read* (subpath ${quote(folder)}))`),
      `(allow file-read* file-write* (subpath ${quote(cwd)})) (allow file-write* (literal "/dev/null"))`].join(' ');
    return { executable: '/usr/bin/sandbox-exec', parameters: ['-p', profile, command, ...args] };
  }
  if (platform === 'linux') {
    // Empty tmpfs mounts hide the folders. Toolchains and the copy are bound back on top; bind sources come from the host.
    return { executable: 'bwrap', parameters: ['--unshare-all', '--die-with-parent', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
      ...folders.flatMap(folder => ['--tmpfs', folder]),
      ...readable.flatMap(folder => ['--ro-bind', folder, folder]),
      '--bind', cwd, cwd, '--chdir', cwd, '--', command, ...args] };
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
    const add = data => { output += data.toString().slice(0, Math.max(0, 8_000 - output.length)); };
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

module.exports = { Workspace, safePath, runIsolated, sandboxArguments, readableToolchains, GIT_HARDENING, gitEnvironment };

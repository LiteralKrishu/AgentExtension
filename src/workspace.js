const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { MAX_TEXT } = require('./draft');

const exec = promisify(execFile);
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

  async paths(signal) {
    if (this.identity && await fs.realpath(this.root) !== this.identity) throw new Error('Workspace identity changed. Start a new run.');
    let files;
    try {
      const { stdout } = await exec('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'], {
        cwd: this.root, signal, maxBuffer: 8 * 1024 * 1024,
      });
      files = stdout.split('\0');
    } catch {
      signal?.throwIfAborted();
      files = await this.findPaths();
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
      const result = await runIsolated(command, args, directory, signal);
      // Show workspace-relative paths instead of the temporary snapshot folder.
      return { ...result, output: result.output.split(`${directory}${path.sep}`).join('').split(directory).join('.') };
    } finally {
      await fs.rm(directory, { force: true, recursive: true });
    }
  }
}

function runIsolated(command, args, cwd, signal) {
  let executable;
  let parameters;
  if (process.platform === 'darwin') {
    executable = '/usr/bin/sandbox-exec';
    const profile = `(version 1) (allow default) (deny network*) (deny file-write*) (allow file-write* (subpath ${JSON.stringify(cwd)}) (literal "/dev/null"))`;
    parameters = ['-p', profile, command, ...args];
  } else if (process.platform === 'linux') {
    executable = 'bwrap';
    parameters = ['--unshare-all', '--die-with-parent', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
      '--bind', cwd, cwd, '--chdir', cwd, '--', command, ...args];
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

module.exports = { Workspace, safePath, runIsolated };

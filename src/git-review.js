const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const { safePath } = require('./workspace');
const { MAX_TEXT } = require('./draft');

const exec = promisify(execFile);
const decode = new TextDecoder('utf-8', { fatal: true });

async function git(workspace, signal, args, maxBuffer = 1_000_000) {
  signal.throwIfAborted();
  if (await fs.realpath(workspace.root) !== workspace.identity) throw new Error('Workspace identity changed.');
  const { stdout } = await exec('git', [
    '--no-optional-locks', '--no-replace-objects', '--literal-pathspecs',
    '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', ...args,
  ], {
    cwd: workspace.root, signal, maxBuffer, timeout: 5_000, encoding: 'buffer',
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' },
  });
  signal.throwIfAborted();
  return decode.decode(stdout);
}

async function headCommit(workspace, signal) {
  try { return (await git(workspace, signal, ['rev-parse', '--verify', 'HEAD'])).trim(); }
  catch (error) {
    signal.throwIfAborted();
    if (error.code === 128) throw new Error('Open a Git workspace with a commit to review its working tree.');
    throw error;
  }
}

async function changedPaths(workspace, signal) {
  const head = await headCommit(workspace, signal);
  const [tracked, untracked] = await Promise.all([
    git(workspace, signal, ['diff', '--relative', '--no-renames', '--no-ext-diff', '--no-textconv',
      '--ignore-submodules=all', '--name-only', '-z', head, '--', '.']),
    git(workspace, signal, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.']),
  ]);
  return [...new Set([...tracked.split('\0'), ...untracked.split('\0')])].filter(file => {
    try { return Boolean(safePath(file)); } catch { return false; }
  }).slice(0, 200);
}

async function readChanges(workspace, paths, signal) {
  const head = await headCommit(workspace, signal);
  const changes = [];
  for (const file of paths) {
    safePath(file);
    const entry = await git(workspace, signal, ['ls-tree', '-z', head, '--', file]);
    const blob = /^(100644|100755) blob ([a-f0-9]+)\t/.exec(entry)?.[2];
    if (entry && !blob) throw new Error(`${file} is not a regular Git file.`);
    const before = blob ? await git(workspace, signal, ['cat-file', 'blob', blob], MAX_TEXT) : null;
    if (before?.includes('\0')) throw new Error(`${file} is binary.`);
    let after;
    try { after = await workspace.read(file); }
    catch (error) {
      signal.throwIfAborted();
      try { after = await workspace.read(file, true); }
      catch { throw error; }
    }
    if (before !== after && (before ?? '') !== (after ?? '')) changes.push({ file, before, after });
  }
  return { head, changes };
}

module.exports = { changedPaths, readChanges };

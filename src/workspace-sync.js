const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { promisify } = require('node:util');
const { digest } = require('./permissions');
const { GIT_HARDENING, gitEnvironment } = require('./workspace');
const { syncPath, syncFileBytes, distinctSyncPaths, orderedSyncFiles } = require('./collaboration');

const exec = promisify(execFile);
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function fromGit(workspace, args, signal, maxBuffer = 8_000_000) {
  // check-ignore accepts validated paths after -- and rejects the literal pathspec flag.
  const flags = args[0] === 'check-ignore' ? GIT_HARDENING.filter(flag => flag !== '--literal-pathspecs') : GIT_HARDENING;
  return exec('git', [...flags, ...args],
    { cwd: workspace.root, signal, timeout: 5_000, maxBuffer, encoding: 'buffer', env: gitEnvironment() });
}
const pathsIn = bytes => decoder.decode(bytes).split('\0').filter(Boolean);
const baseDigest = text => text === null ? null : digest(text);
const textFile = bytes => {
  if (bytes.length > syncFileBytes || bytes.includes(0)) return undefined;
  try { return decoder.decode(bytes); } catch { return undefined; }
};

async function inspect(workspace, file) {
  syncPath.parse(file);
  const root = await fs.realpath(workspace.root);
  if (root !== workspace.root) throw new Error('The sync workspace moved.');
  const full = path.join(root, file);
  const parts = file.split('/');
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) {
      if (error.code === 'ENOENT') return { full, missing: true };
      throw error;
    }
    if (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) return { full, unsupported: true };
  }
  return { full };
}

async function savedBytes(workspace, file) {
  const { full, missing, unsupported } = await inspect(workspace, file);
  if (missing) return null;
  if (unsupported) return undefined;
  const handle = await fs.open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > syncFileBytes) return undefined;
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error(`${file} changed while it was being read.`);
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}

async function verifyUnignored(workspace, file, signal) {
  const matches = await fromGit(workspace, ['check-ignore', '--', file], signal)
    .catch(error => { if (error.code !== 1) throw error; return undefined; });
  if (matches) throw new Error(`${file} is ignored in this checkout.`);
}

async function readSyncFile(workspace, file, verifyIgnore = false) {
  if (verifyIgnore) await verifyUnignored(workspace, syncPath.parse(file));
  const bytes = await savedBytes(workspace, file);
  const text = bytes === null ? null : bytes && textFile(bytes);
  if (text === undefined) throw new Error(`${file} is outside the saved UTF-8 file sync scope.`);
  return text;
}

async function resolveSyncFile(workspace, file, create) {
  const result = await inspect(workspace, file);
  if (result.unsupported || Boolean(result.missing) !== create) throw new Error(`${file} changed during file review.`);
  return result.full;
}

async function captureWorkspaceFiles(workspace, snapshot, known, signal) {
  const { revision } = snapshot;
  if (await workspace.gitRevision(signal) !== revision) throw new Error('The checkout Git base changed. Open Shared Project again.');
  const [tree, listing, modes] = await Promise.all([
    fromGit(workspace, ['ls-tree', '-rz', '--full-tree', revision], signal),
    fromGit(workspace, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'], signal),
    fromGit(workspace, ['ls-files', '-vz', '--cached', '--', '.'], signal),
  ]);
  if (pathsIn(modes.stdout).some(entry => /^s /i.test(entry))) throw new Error('File sync requires a complete checkout without skip-worktree paths.');
  const base = new Map(pathsIn(tree.stdout).map(entry => {
    const tab = entry.indexOf('\t');
    const [mode, , oid] = entry.slice(0, tab).split(' ');
    return [entry.slice(tab + 1), { mode, oid }];
  }));
  const shared = new Map(snapshot.files.map(entry => [entry.file, entry]));
  const required = new Set([...shared.keys(), ...known.keys()]);
  const reported = new Set(pathsIn(listing.stdout));
  const paths = [...new Set([...base.keys(), ...reported, ...required])].filter(file => syncPath.safeParse(file).success);
  if (!distinctSyncPaths(paths) || paths.length > 12_000) throw new Error('File sync requires at most 12,000 eligible paths with distinct names.');
  const changed = new Map();
  let excluded = 0;
  let scannedBytes = 0;
  const gitHash = revision.length === 40 ? 'sha1' : 'sha256';
  for (const file of paths) {
    signal?.throwIfAborted();
    const original = base.get(file);
    const expected = shared.get(file);
    const pinned = required.has(file);
    if (!original && pinned && !reported.has(file)) {
      // An absent untracked file can be received. An ignored file at that path must remain local.
      await verifyUnignored(workspace, file, signal);
    }
    const regular = !original || ['100644', '100755'].includes(original.mode);
    const bytes = regular ? await savedBytes(workspace, file) : undefined;
    if (regular && !pinned && bytes !== undefined) {
      if (bytes === null && !original) continue;
      if (bytes && original?.oid === createHash(gitHash).update(`blob ${bytes.length}\0`).update(bytes).digest('hex')) continue;
    }
    const text = bytes === null ? null : bytes && textFile(bytes);
    let gitText = null;
    if (original && text !== undefined) {
      try { gitText = textFile((await fromGit(workspace, ['cat-file', 'blob', original.oid], signal, syncFileBytes + 1)).stdout); }
      catch (error) {
        if (error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw error;
        gitText = undefined;
      }
    }
    if (text === undefined || gitText === undefined) {
      if (pinned) throw new Error(`${file} is outside the saved UTF-8 file sync scope.`);
      excluded++;
      continue;
    }
    if (expected && expected.baseDigest !== baseDigest(gitText)) throw new Error(`${file} has a different Git file base.`);
    scannedBytes += Buffer.byteLength(text ?? '') + Buffer.byteLength(gitText ?? '');
    if (scannedBytes > 16_000_000) throw new Error('Saved changes exceed the 16 MB workspace sync scan limit.');
    changed.set(file, { file, base: gitText, local: text, shared: expected ? expected.text : gitText });
  }
  if (await workspace.gitRevision(signal) !== revision) throw new Error('The checkout Git base changed. Open Shared Project again.');
  return { changed, excluded };
}

function workspaceFilePlan(direction, captured, known) {
  return [...captured.changed.values()].flatMap(({ file, base, local, shared }) => {
    if (local === shared) return [];
    const [before, after] = direction === 'publish' ? [shared, local] : [local, shared];
    const ancestor = known.get(file) ?? digest(base);
    return digest(after) === ancestor ? [] : [{ file, before, after, conflict: digest(before) !== ancestor }];
  });
}

function selectedWorkspaceFiles(direction, captured, snapshot, selected) {
  const chosen = new Set(selected.map(change => change.file));
  const files = new Map(snapshot.files.map(entry => [entry.file, entry]));
  const aligned = new Map();
  for (const { file, base, local, shared } of captured.changed.values()) {
    const publishing = direction === 'publish' && chosen.has(file);
    if (publishing) {
      if (local === base) files.delete(file);
      else files.set(file, { file, baseDigest: baseDigest(base), text: local });
    }
    const remote = publishing ? local : shared;
    if (local === remote || direction === 'receive' && chosen.has(file)) aligned.set(file, { text: remote, base });
  }
  return { files: orderedSyncFiles(files.values()), aligned };
}

function applyWorkspaceFileReceipt(known, aligned, saved) {
  const updated = new Map(known);
  for (const [file, { text, base }] of aligned) {
    if (!saved.has(file)) continue;
    if (text === base) updated.delete(file);
    else updated.set(file, digest(text));
  }
  return [...updated];
}

module.exports = { captureWorkspaceFiles, workspaceFilePlan, selectedWorkspaceFiles, applyWorkspaceFileReceipt, readSyncFile, resolveSyncFile };

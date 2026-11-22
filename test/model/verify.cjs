const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Workspace, safePath, runIsolated } = require('../../src/workspace');
const { patchDigest } = require('./evaluate.cjs');

// Acceptance commands come only from the trusted task definition, outside model context.
async function verifyDraft({ source, changes, allowedFiles, acceptance, acceptanceInputs = [], signal = new AbortController().signal }) {
  const evidence = { applied: false, patchDigest: Array.isArray(changes) ? patchDigest(changes) : null, checks: [], status: 'failed', errors: [] };
  let directory;
  let executing = false;
  try {
    if (!Array.isArray(changes) || !changes.length) throw new Error('No final patch to apply.');
    if (typeof allowedFiles !== 'function' || !Array.isArray(acceptance) || !acceptance.length) {
      throw new Error('The task must declare permitted changes and independent acceptance commands.');
    }
    const names = new Set();
    for (const check of acceptance) {
      if (!check?.name || names.has(check.name) || !/^[\w.+-]{1,60}$/.test(check.command) ||
          !Array.isArray(check.args) || !check.args.every(arg => typeof arg === 'string')) throw new Error('Invalid acceptance command.');
      names.add(check.name);
    }
    const root = await fs.realpath(source);
    const workspace = new Workspace(root, () => undefined, async () =>
      (await fs.readdir(root, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile())
        .map(entry => path.relative(root, path.join(entry.parentPath ?? entry.path, entry.name)).split(path.sep).join('/')));
    workspace.identity = root;
    const changed = new Set();
    for (const change of changes) {
      safePath(change.file);
      if (changed.has(change.file) || !allowedFiles(change.file) || typeof change.after !== 'string' ||
          change.after.includes('\0') || !(change.before === null || typeof change.before === 'string')) {
        throw new Error('Invalid, duplicate, or unrelated patch file: ' + change.file);
      }
      changed.add(change.file);
      if (await workspace.read(change.file, change.before === null) !== change.before) throw new Error('Stale patch: ' + change.file);
    }
    // The same execution snapshot as agent checks, without editor overlays: the trusted evaluator reads disk only.
    let snapshot;
    try { snapshot = await workspace.snapshot(changes, signal, { overlay: false }); } catch (error) {
      if (error.code === 'ESNAPSHOTQUOTA') evidence.status = 'environment-unavailable';
      throw error;
    }
    directory = snapshot.directory;
    const original = [...snapshot.sources].map(([file, digest]) => ({ file, digest }));
    for (const change of changes) {
      if (await fs.readFile(path.join(directory, change.file), 'utf8') !== change.after) throw new Error('Applied text mismatch: ' + change.file);
    }
    // Pinned public test data is supplied by the trusted evaluator. Never read a
    // real workspace dotenv file or let the model request an exception.
    if (!Array.isArray(acceptanceInputs) || acceptanceInputs.length > 4) throw new Error('Invalid pinned test inputs.');
    for (const input of acceptanceInputs) {
      if (!/^tests\/(?:[A-Za-z0-9_-]+\/)*\.(env|flaskenv)$/.test(input.file) || typeof input.text !== 'string' ||
          input.text.length > 4096 || input.text.includes('\0') ||
          createHash('sha256').update(input.text).digest('hex') !== input.sha256) throw new Error('Invalid pinned test input.');
      const target = path.join(directory, input.file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, input.text, { flag: 'wx', mode: 0o600 });
    }
    evidence.applied = true;
    for (const check of acceptance) {
      signal.throwIfAborted();
      executing = true;
      const result = await runIsolated(check.command, check.args, directory, signal, { hidden: [root] });
      executing = false;
      evidence.checks.push({ name: check.name, ...result, ok: result.exitCode === 0 });
    }
    for (const item of original) {
      if (createHash('sha256').update(await fs.readFile(await workspace.resolve(item.file, false, { lockfiles: true }))).digest('hex') !== item.digest) throw new Error('Source changed during acceptance: ' + item.file);
    }
    for (const change of changes.filter(item => item.before === null)) {
      await workspace.resolve(change.file, true);
    }
    evidence.status = evidence.checks.every(check => check.ok) ? 'complete' : 'failed';
  } catch (error) {
    evidence.errors.push(error.message);
    if (signal.aborted) evidence.status = 'cancelled';
    else if (executing && ['ENOENT', 'ENOTSUP'].includes(error.code)) evidence.status = 'environment-unavailable';
  } finally {
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  }
  return evidence;
}

module.exports = { verifyDraft };

const fs = require('node:fs/promises');
const path = require('node:path');
const { digest } = require('../../src/permissions');
const { safePath } = require('../../src/workspace');
const { sha256, validateJudgments } = require('./judgments.cjs');
const { gitSnapshot } = require('./source.cjs');

function sourceVersion(manifest) {
  return 'git-overlay/1:' + digest({ baseRevision: manifest.baseRevision,
    overlays: manifest.overlays.map(({ path, sha256 }) => ({ path, sha256 })) });
}

async function overlaySnapshot(base, manifest, directory) {
  if (manifest.version !== 1 || manifest.baseRevision !== base.revision || !Array.isArray(manifest.overlays) ||
      !manifest.overlays.length || manifest.overlays.length > 8) throw new Error('Invalid source overlay manifest.');
  const files = new Map(base.files.map(file => [file.path, file]));
  for (const overlay of manifest.overlays) {
    safePath(overlay.path);
    if (!/^test\/.+\.test\.js$/.test(overlay.path) || files.has(overlay.path)) throw new Error('The source overlay can only add a new test file.');
    if (typeof overlay.artifact !== 'string' || path.basename(overlay.artifact) !== overlay.artifact) throw new Error('Use a local overlay artifact.');
    const artifact = path.join(directory, overlay.artifact);
    const stat = await fs.lstat(artifact);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256_000) throw new Error('Invalid overlay artifact.');
    const text = await fs.readFile(artifact, 'utf8');
    if (text.includes('\0') || sha256(text) !== overlay.sha256) throw new Error('Source overlay hash mismatch.');
    files.set(overlay.path, { path: overlay.path, text });
  }
  const version = sourceVersion(manifest);
  if (manifest.sourceVersion !== version) throw new Error('Source version mismatch.');
  return { revision: base.revision, sourceVersion: version,
    files: [...files.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
}

async function loadRetrievalCorpus(version = '2') {
  if (String(version) === '1') {
    const labels = require('./queries.json');
    return { labels, review: require('./judgments.json'), ...await gitSnapshot(labels.sourceRevision) };
  }
  if (String(version) !== '2') throw new Error('Choose retrieval corpus 1 or 2.');
  const directory = path.join(__dirname, 'corpora/v2');
  const read = async name => JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
  const [labels, review, manifest, freeze] = await Promise.all(['queries.json', 'judgments.json', 'source.json', 'freeze.json'].map(read));
  const source = await overlaySnapshot(await gitSnapshot(manifest.baseRevision), manifest, directory);
  if (labels.sourceVersion !== source.sourceVersion || review.sourceVersion !== source.sourceVersion ||
      freeze.version !== labels.version || freeze.sourceVersion !== source.sourceVersion ||
      freeze.labelsDigest !== digest(labels) || freeze.reviewDigest !== digest(review) || freeze.inputDigest !== digest(source.files)) {
    throw new Error('The frozen retrieval corpus changed. Publish a new version.');
  }
  const ids = labels.queries.map(query => query.id);
  const development = labels.queries.filter(query => query.split === 'development');
  const heldOut = labels.queries.filter(query => query.split === 'held-out');
  if (labels.version !== 'agent-capability-upgrade/retrieval/2' || ids.length !== 40 || new Set(ids).size !== 40 ||
      development.length !== 24 || heldOut.length !== 16 || labels.queries.some(query => !['concept', 'identifier'].includes(query.kind)) ||
      digest(freeze.heldOutIds) !== digest(heldOut.map(query => query.id))) throw new Error('Invalid frozen query split.');
  const audit = validateJudgments({ review, labels, ...source });
  if (!audit.readyForRevisedCorpus) throw new Error('Version 2 has unresolved source judgments.');
  return { labels, review, freeze, ...source };
}

module.exports = { loadRetrievalCorpus, overlaySnapshot, sourceVersion };

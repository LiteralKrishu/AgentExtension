const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const { safePath, GIT_HARDENING, gitEnvironment } = require('../../src/workspace');
const exec = promisify(execFile);

async function gitSnapshot(sourceRevision) {
  if (!/^[a-f0-9]{7,64}$/.test(sourceRevision)) throw new Error('Use a pinned Git revision.');
  const options = { cwd: path.join(__dirname, '../..'), env: gitEnvironment(), maxBuffer: 8_000_000 };
  const git = async (...args) => (await exec('git', [...GIT_HARDENING, ...args], options)).stdout;
  const revision = (await git('rev-parse', '--verify', sourceRevision + '^{commit}')).trim();
  const paths = (await git('ls-tree', '-r', '--name-only', '-z', revision)).split('\0').filter(file => {
    try { safePath(file); return !/\.(png|jpe?g|gif|svg|ico|pdf|zip|map|csv|jsonl)$/.test(file); }
    catch { return false; }
  });
  const files = [];
  for (let index = 0; index < paths.length; index += 16) {
    const batch = await Promise.all(paths.slice(index, index + 16).map(async file => {
      const text = await git('show', revision + ':' + file);
      return text.length <= 256_000 && !text.includes('\0') ? { path: file, text } : null;
    }));
    files.push(...batch.filter(Boolean));
  }
  return { revision, files };
}
module.exports = { gitSnapshot };

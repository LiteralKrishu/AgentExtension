const fs = require('node:fs/promises');
const path = require('node:path');
const lock = require('proper-lockfile');

// A shared directory lock also covers atomic replacement and log rotation.
async function withStorageLock(directory, operation) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  let compromised;
  const release = await lock(directory, { lockfilePath: path.join(directory, '.write.lock'),
    stale: 10000, update: 2000, retries: { retries: 600, factor: 1, minTimeout: 25, maxTimeout: 25 },
    onCompromised: error => { compromised = error; } });
  const check = () => { if (compromised) throw compromised; };
  try { check(); const result = await operation(check); check(); return result; }
  finally { await release(); }
}
module.exports = { withStorageLock };

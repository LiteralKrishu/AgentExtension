const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { digest } = require('./permissions');
const { loadAdminPolicy, mergeOrganizationPolicy } = require('./policy');
const { verifyExportEvents } = require('./audit');

const tokenHash = value => createHash('sha256').update(value).digest('hex');
const organizationWorkspace = identity => digest(identity).slice(0, 16);
const BATCH_SIZE = 200;

function enrollment(admin, identity) {
  if (admin.error) throw new Error(admin.error);
  if (!identity || !admin.organization) return undefined;
  const workspace = organizationWorkspace(identity);
  return admin.organization.workspaces.includes(workspace) ? { ...admin.organization, workspace } : undefined;
}

async function tokenFor(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch(() => { throw new Error('The organization credential file is unavailable.'); });
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4_096 || (process.platform !== 'win32' && stat.mode & 0o077)) {
      throw new Error('The organization credential file must be private and at most 4 KB.');
    }
    const buffer = Buffer.alloc(4_097);
    const { bytesRead } = await handle.read(buffer);
    const token = buffer.toString('utf8', 0, bytesRead).trim();
    if (bytesRead > 4_096 || !/^[\x21-\x7e]{16,4096}$/.test(token)) throw new Error('The organization credential is invalid.');
    return token;
  } finally { await handle.close(); }
}

class OrganizationError extends Error {
  constructor(message, retryable = false, status) { super(message); this.retryable = retryable; this.status = status; }
}

async function requestOrganization(config, route, { body, signal, fetchFn = fetch } = {}) {
  const endpoint = new URL(route, config.url);
  endpoint.searchParams.set('workspace', config.workspace);
  const token = await tokenFor(config.tokenFile);
  const deadline = AbortSignal.timeout(4_000);
  signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const response = await fetchFn(endpoint, { method: body ? 'POST' : 'GET', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) {
      await response.body?.cancel();
      const message = endpoint.pathname === '/v1/audit' && (response.status === 409 || response.status === 422) ? 'Organization audit verification failed.'
        : `Organization service returned HTTP ${response.status}.`;
      throw new OrganizationError(message, response.status === 429 || response.status >= 500, response.status);
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body ?? []) {
      length += chunk.length;
      if (length > 256_000) throw new OrganizationError('Organization response exceeds 256 KB.');
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new OrganizationError('Organization response is malformed.'); }
  } catch (error) {
    if (error instanceof OrganizationError) throw error;
    throw new OrganizationError('Organization service is unavailable.', true);
  }
}

async function loadManagedPolicy(identity, { signal, fetchFn, files } = {}) {
  const local = loadAdminPolicy(files);
  const config = enrollment(local, identity);
  if (!config) return local;
  let document;
  try { document = await requestOrganization(config, '/v1/policy', { signal, fetchFn }); }
  catch (error) { throw new Error(`Managed policy could not be verified. ${error.message}`); }
  try { return mergeOrganizationPolicy(local, document); }
  catch { throw new Error('Managed policy is malformed. Ask your administrator to correct it.'); }
}

async function syncOrganizationAudit(identity, log, { signal, fetchFn, files } = {}) {
  const config = enrollment(loadAdminPolicy(files), identity);
  if (!config?.audit) throw new Error('Organization audit sync is unavailable for this workspace.');
  const data = await log.export();
  if (!data.verification.ok) throw new Error(`Local audit verification failed: ${data.verification.reason}.`);
  verifyExportEvents(data.events, config.workspace);
  const result = { accepted: 0, duplicates: 0 };
  for (let offset = 0; offset < data.events.length; offset += BATCH_SIZE) {
    const events = data.events.slice(offset, offset + BATCH_SIZE);
    const body = { format: data.format, events };
    let receipt;
    try {
      receipt = await requestOrganization(config, '/v1/audit', { body, signal, fetchFn });
    } catch (error) {
      if (!error.retryable) throw error;
      await delay(250, undefined, { signal });
      receipt = await requestOrganization(config, '/v1/audit', { body, signal, fetchFn });
    }
    if (![receipt?.accepted, receipt?.duplicates].every(value => Number.isSafeInteger(value) && value >= 0)
        || receipt.accepted + receipt.duplicates !== events.length || receipt.confirmed !== events.at(-1).hash) {
      throw new Error('Organization audit receipt failed verification.');
    }
    result.accepted += receipt.accepted;
    result.duplicates += receipt.duplicates;
  }
  return result;
}

module.exports = { loadManagedPolicy, syncOrganizationAudit, tokenHash, organizationWorkspace, enrollment, requestOrganization, BATCH_SIZE };

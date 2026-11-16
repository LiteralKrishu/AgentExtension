const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { digest } = require('./permissions');
const { validateConnector, secretKey } = require('./connectors');
const { ConnectorAccounts, tokenKey } = require('./connector-oauth');
const { PolicyEngine } = require('./policy');
const { loadManagedPolicy } = require('./organization');
const { ScheduleStore, Scheduler } = require('./schedules');
const { resolveScheduleScope, scheduleContextCatalog } = require('./schedule-scope');
const { runScheduledReport } = require('./scheduled-run');
const { Workspace, safePath } = require('./workspace');
const { notificationPayload, deliverNotification } = require('./schedule-notifications');
const { version } = require('../package.json');

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

async function workspaceStores(storage) {
  const directory = path.join(storage, 'schedules');
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const stores = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{24}$/.test(entry.name)) continue;
    const file = path.join(directory, entry.name, 'schedules.json');
    let records;
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > 16_000_000) continue;
      records = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch { continue; }
    const identity = Array.isArray(records) && records.find(record => typeof record?.workspace === 'string')?.workspace;
    if (identity && path.isAbsolute(identity) && digest(identity).slice(0, 24) === entry.name) stores.push(new ScheduleStore(storage, identity));
  }
  return stores;
}

async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || stat.mode & 0o077) throw new Error('Runner credential storage must be private to the current login.');
}

async function readPrivate(directory, file, limit) {
  for (const folder of [path.dirname(directory), directory]) {
    const stat = await fs.lstat(folder).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!stat) return undefined;
    if (!stat.isDirectory() || stat.uid !== process.getuid() || stat.mode & 0o077) throw new Error('Runner credential storage must be private to the current login.');
  }
  const handle = await fs.open(path.join(directory, file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!handle) return undefined;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > limit) {
      throw new Error('The runner credential must be a private, regular file within its size limit.');
    }
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer);
    if (bytesRead > limit) throw new Error('Runner credential exceeds its size limit.');
    return buffer.toString('utf8', 0, bytesRead);
  } finally { await handle.close(); }
}

async function writePrivate(directory, name, value) {
  const temporary = path.join(directory, randomUUID());
  try {
    await fs.writeFile(temporary, value, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, path.join(directory, name));
  } finally { await fs.rm(temporary, { force: true }); }
}

const revokedAccounts = storage => path.join(storage, 'background-oauth-revocations');
const OAUTH_BYTES = 256_000;

class BackgroundCredentials {
  constructor(store, schedule) {
    this.schedule = schedule;
    this.storage = path.dirname(path.dirname(store.directory));
    this.parent = path.join(store.directory, 'background-credentials');
    this.directory = path.join(this.parent, digest(schedule.id));
    this.oauthDirectory = path.join(this.parent, digest(['oauth', schedule.id, schedule.approval?.oauthEpoch]));
  }

  async get(key) {
    if (!/^connector\.v1\.[a-f0-9]{64}$/.test(key)) return undefined;
    return readPrivate(this.directory, key, 8_000);
  }

  async set(config, token) {
    await privateDirectory(this.parent);
    await privateDirectory(this.directory);
    await writePrivate(this.directory, secretKey(config), token);
  }

  async checkBinding(config, raw) {
    const binding = digest(raw);
    if (!this.schedule.approval.credentialDigests?.includes(`${config.id}:${binding}`)) {
      throw new Error('The background OAuth account differs from the approved account.');
    }
    const revoked = await fs.lstat(path.join(revokedAccounts(this.storage), binding)).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (revoked) throw new Error('The background OAuth account was revoked.');
  }

  async writeOAuth(config, raw, record) {
    const value = JSON.stringify({ raw, record });
    if (Buffer.byteLength(value) > OAUTH_BYTES) throw new Error('The OAuth credential exceeds the runner storage limit.');
    // Refreshing can replace an existing credential. Only editor enrollment can create its directory.
    await writePrivate(this.oauthDirectory, secretKey(config), value);
  }

  async provisionOAuth(config, raw, record) {
    await this.checkBinding(config, raw);
    await privateDirectory(this.parent);
    await privateDirectory(this.oauthDirectory);
    await this.writeOAuth(config, raw, record);
    await this.checkBinding(config, raw);
  }

  async readOAuth(config) {
    const value = await readPrivate(this.oauthDirectory, secretKey(config), OAUTH_BYTES);
    let entry;
    try { if (value) entry = JSON.parse(value); }
    catch { throw new Error('The background OAuth credential is invalid. Approve the schedule again.'); }
    if (typeof entry?.raw !== 'string' || !entry.record?.tokens?.refresh_token || entry.record.tokens.issuer !== config.oauth.issuer) {
      throw new Error(`Authorize background OAuth for ${config.id} in VS Code before running this schedule.`);
    }
    await this.checkBinding(config, entry.raw);
    return entry;
  }

  async secrets(configs, assertActive) {
    const bearer = new Map();
    const oauth = new Map();
    const secrets = {
      get: async key => {
        const config = oauth.get(key);
        if (!config) return bearer.get(key);
        await assertActive();
        const entry = await this.readOAuth(config);
        return key === secretKey(config) ? entry.raw : JSON.stringify(entry.record);
      },
      store: async (key, value) => {
        const config = oauth.get(key);
        if (!config || key === secretKey(config)) throw new Error('The runner can refresh only an approved OAuth credential.');
        await assertActive();
        const { raw } = await this.readOAuth(config);
        await this.writeOAuth(config, raw, JSON.parse(value));
        try { await assertActive(); await this.checkBinding(config, raw); }
        catch (error) { await this.clearOAuth(); throw error; }
      },
      delete: async key => {
        const config = oauth.get(key);
        if (config && key !== secretKey(config)) await fs.rm(path.join(this.oauthDirectory, secretKey(config)), { force: true });
      },
    };
    const accounts = new ConnectorAccounts(secrets);
    for (const config of configs) {
      const key = secretKey(config);
      if (!config.oauth) bearer.set(key, await this.get(key));
      else {
        const identity = accounts.identity((await this.readOAuth(config)).raw);
        if (!identity) throw new Error('The background OAuth account is invalid.');
        oauth.set(key, config);
        oauth.set(tokenKey(identity), config);
      }
    }
    return { secrets, accounts };
  }

  async lockOAuthRun() {
    // Rotating refresh tokens must never be used by two runner processes at the same time.
    const lock = path.join(this.oauthDirectory, 'running');
    try { await fs.mkdir(lock, { mode: 0o700 }); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('A background OAuth run already owns this approval.');
      throw error;
    }
    return () => fs.rm(lock, { recursive: true, force: true });
  }

  clearOAuth() { return fs.rm(this.oauthDirectory, { recursive: true, force: true }); }

  async clear() {
    await Promise.all([this.clearOAuth(), fs.rm(this.directory, { recursive: true, force: true })]);
  }
}

async function revokeBackgroundOAuth(storage, config, raw) {
  if (!process.getuid) return;
  // Persist the revocation first. It also blocks an enrollment or refresh that races with sign-out.
  const binding = digest(raw);
  const directory = revokedAccounts(storage);
  await privateDirectory(directory);
  await fs.writeFile(path.join(directory, binding), '', { flag: 'wx', mode: 0o600 })
    .catch(error => { if (error.code !== 'EEXIST') throw error; });
  for (const store of await workspaceStores(storage)) {
    for (const schedule of await store.list()) {
      if (!schedule.background || !schedule.approval.credentialDigests?.includes(`${config.id}:${binding}`)) continue;
      await store.suspend(schedule, true);
      await new BackgroundCredentials(store, schedule).clear();
    }
  }
}

async function diskPaths(root, signal) {
  const files = [];
  const directories = [''];
  let inspected = 0;
  while (directories.length && inspected < 24_000) {
    signal?.throwIfAborted();
    const directory = directories.pop();
    const full = path.join(root, directory);
    if (await fs.realpath(full).catch(() => undefined) !== full) continue;
    for await (const entry of await fs.opendir(full)) {
      signal?.throwIfAborted();
      if (++inspected > 24_000 || files.length >= 12_000) return files;
      const relative = directory ? `${directory}/${entry.name}` : entry.name;
      try { safePath(relative); } catch { continue; }
      if (entry.isDirectory()) directories.push(relative);
      else if (entry.isFile()) files.push(relative);
    }
  }
  return files;
}

function backgroundScheduler({ storage, store, now, onChange, fetchFn, signal }) {
  const identity = store.workspace;
  const owns = schedule => Boolean(schedule.background);
  async function scopeFor(schedule) {
    const profile = schedule.approval.backgroundProfile;
    if (profile?.format !== 1 || profile.runtime !== version) throw new Error('Review the background approval with the current extension version.');
    if (await fs.realpath(identity) !== identity) throw new Error('The approved workspace moved or is unavailable.');
    const policy = new PolicyEngine({ admin: await loadManagedPolicy(identity, { signal }), user: profile.userRules, workspace: profile.workspaceRules });
    if (digest([policy.digest, policy.admin.digest]) !== profile.policy) throw new Error('Permission policy changed.');
    const connectors = profile.connectors.map(validateConnector);
    const credentials = new BackgroundCredentials(store, schedule);
    const { secrets, accounts } = await credentials.secrets(connectors, () => currentApproval(schedule));
    const scope = await resolveScheduleScope({ identity, schedule, connectors, settings: profile.settings, secrets, accounts, backgroundProfile: profile,
      contextCatalog: (workspace, connectorIds, fields) => scheduleContextCatalog({
        identity: workspace, connectorIds, fields, policy, connectors, storage, profile: profile.context,
      }) });
    return { ...scope, policy, secrets, accounts, credentials, notes: profile.notes };
  }
  async function currentApproval(schedule) {
    const current = (await store.list()).find(item => item.id === schedule.id);
    if (!current?.enabled || !owns(current) || current.approval.at !== schedule.approval.at
        || current.approval.digest !== schedule.approval.digest || current.approval.oauthEpoch !== schedule.approval.oauthEpoch) {
      throw new Error('The background approval is no longer active.');
    }
    return current;
  }
  async function verify(schedule) {
    const current = await currentApproval(schedule);
    const scope = await scopeFor(current);
    if (scope.approval.digest !== schedule.approval.digest) throw new Error('The approved context or runner credential changed.');
    return scope;
  }
  return new Scheduler({ store, owns, now, onChange, pinFor: async schedule => (await scopeFor(schedule)).approval.digest,
    execute: async (schedule, occurrence, trigger, onCancel) => {
      let scope;
      try { scope = await verify(schedule); }
      catch (error) { return { status: 'blocked', reason: error.message }; }
      if (signal?.aborted) return { status: 'cancelled', reason: 'Background runner stopped.' };
      const workspace = new Workspace(identity, () => undefined, signal => diskPaths(identity, signal));
      workspace.identity = identity;
      const release = scope.oauthAccounts.size ? await scope.credentials.lockOAuthRun() : undefined;
      let accessFailure;
      const accounts = {
        identity: raw => scope.accounts.identity(raw),
        async access(config, raw, accessSignal, rejectedToken) {
          try { return await scope.accounts.access(config, raw, accessSignal, rejectedToken); }
          catch (error) {
            if (!accessSignal.aborted) {
              accessFailure = error;
              await store.pauseForReview(schedule);
            }
            throw error;
          }
        },
      };
      try {
        return await runScheduledReport({ schedule, occurrence, trigger, workspace, storage, settings: scope.settings, policy: scope.policy,
          connectorConfigs: scope.selected, secrets: scope.secrets, accounts, inputs: scope.inputs, notes: scope.notes, onCancel,
          verify: async () => { if (accessFailure) throw accessFailure; return verify(schedule); }, now });
      } finally { await release?.(); }
    },
    onRecorded: async (record, schedule) => {
      if (signal?.aborted || !schedule.background.webhook || !record.report || record.status === 'blocked' || record.status === 'cancelled') return;
      try { await verify(schedule); } catch { return; }
      await store.notification(record.id, { status: 'pending' });
      const delivery = await deliverNotification(schedule.background.webhook, notificationPayload(storage, record), fetchFn);
      await store.notification(record.id, delivery);
    },
  });
}

async function runBackground({ storage, signal, once, onChange, onError = () => {}, intervalMs = 30_000 }) {
  do {
    for (const store of await workspaceStores(storage)) {
      if (signal.aborted) return;
      const scheduler = backgroundScheduler({ storage, store, onChange, signal });
      const cancel = () => scheduler.stop();
      signal.addEventListener('abort', cancel, { once: true });
      try { await scheduler.tick(); }
      catch (error) { if (once) throw error; onError(error); }
      finally { signal.removeEventListener('abort', cancel); }
    }
    if (!once && !signal.aborted) await delay(intervalMs, undefined, { signal }).catch(error => { if (!signal.aborted) throw error; });
  } while (!once && !signal.aborted);
}

async function controlBackground(storage, action, id, connectorId, token) {
  if (!UUID.test(id ?? '')) throw new Error('Use the schedule ID shown by the runner status command.');
  for (const store of await workspaceStores(storage)) {
    const schedule = (await store.list()).find(item => item.id === id && item.background);
    if (!schedule) continue;
    const credentials = new BackgroundCredentials(store, schedule);
    if (action === 'token') {
      const config = schedule.approval.backgroundProfile?.connectors.find(item => item.id === connectorId);
      if (!schedule.enabled || !config || config.oauth || !token || Buffer.byteLength(token) > 8_000 || /\s|\0/.test(token)
          || !schedule.approval.credentialDigests?.includes(`${connectorId}:${digest(token)}`)) {
        throw new Error('The bearer token does not match an active background approval for this connector.');
      }
      await credentials.set(config, token);
    } else {
      await store.suspend(schedule, action === 'revoke');
      if (action === 'revoke') await credentials.clear();
    }
    return;
  }
  throw new Error('No background schedule with that ID was found.');
}

module.exports = { runBackground, backgroundScheduler, workspaceStores, controlBackground, BackgroundCredentials, revokeBackgroundOAuth };

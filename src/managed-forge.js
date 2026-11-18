const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { existsSync } = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

const MODEL_SECRET = 'model.managed.v1';
const MANAGED_MODEL = 'agentextension/default';

function providerUrl(value) {
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('Enter a full model API URL.'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
      || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTPS model API URL or a local HTTP URL. Omit credentials, query text, and fragments.');
  }
  return url.href.replace(/\/+$/, '');
}

function readProfile(raw) {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw);
    if (!/^[a-f0-9]{32}$/.test(value.id) || typeof value.modelId !== 'string' || !value.modelId.trim()
        || typeof value.apiKey !== 'string') return undefined;
    return { id: value.id, baseUrl: providerUrl(value.baseUrl), modelId: value.modelId, apiKey: value.apiKey };
  } catch { return undefined; }
}

async function startServer(runtime, signal) {
  const executable = path.join(runtime, process.platform === 'win32' ? 'node.exe' : 'node');
  const entry = path.join(runtime, 'launch.cjs');
  if (!existsSync(executable) || !existsSync(entry)) {
    throw new Error('Install the VSIX for your platform to use bundled TrueForge.');
  }
  const directory = await fs.mkdtemp(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'agentextension-'));
  const serverToken = randomBytes(32).toString('hex');
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, {
    HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory, XDG_DATA_HOME: directory,
    TMPDIR: directory, TEMP: directory, TMP: directory, SQLITE_PATH: path.join(directory, 'db.sqlite'),
    STANDALONE: 'true', HOST: '127.0.0.1', OUTBOUND_URL_ALLOWED_HOSTS: '["127.0.0.1","localhost","[::1]"]',
    SENTRY_ENABLED: 'false', ACCESS_LOGS: 'false', AGENTEXTENSION_SERVER_TOKEN: serverToken,
  });
  const child = spawn(executable, [entry], { cwd: directory, env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  const closed = once(child, 'close').catch(() => {});
  void closed.then(() => fs.rm(directory, { recursive: true, force: true })).catch(() => {});
  function stop() {
    if (child.connected) child.disconnect();
    const force = setTimeout(() => child.kill('SIGKILL'), 3_000);
    force.unref();
    void closed.then(() => clearTimeout(force));
  }
  try {
    const port = await Promise.race([
      once(child, 'message', { signal }).then(([message]) => message.port),
      closed.then(() => { throw new Error('Bundled TrueForge exited during startup.'); }),
    ]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Bundled TrueForge returned an invalid port.');
    return { serverUrl: `http://127.0.0.1:${port}`, serverToken, closed, stop };
  } catch (error) {
    stop();
    throw error;
  }
}

class ManagedForge {
  constructor(extensionPath) {
    this.runtime = path.join(extensionPath, 'trueforge', 'runtime');
  }

  async connection(profile, signal) {
    signal.throwIfAborted();
    if (this.current?.id !== profile.id) {
      this.dispose();
      const controller = new AbortController();
      const current = { id: profile.id, controller, ready: this.start(profile, controller.signal) };
      this.current = current;
      const reset = () => { if (this.current === current) this.current = undefined; };
      void current.ready.then(server => server.closed).then(reset, reset);
    }
    // Cancelling a single caller leaves the shared startup available for the next run.
    let cancel;
    const cancelled = new Promise((_, reject) => {
      cancel = () => reject(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
    });
    try {
      const { serverUrl, serverToken } = await Promise.race([this.current.ready, cancelled]);
      return { serverUrl, serverToken };
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }

  async start(profile, lifetime) {
    const signal = AbortSignal.any([lifetime, AbortSignal.timeout(30_000)]);
    const server = await startServer(this.runtime, signal).catch(() => {
      if (!existsSync(path.join(this.runtime, 'launch.cjs'))) throw new Error('Install the VSIX for your platform to use bundled TrueForge.');
      throw new Error('Bundled TrueForge could not start. Reinstall the VSIX for your platform or connect to an existing server.');
    });
    lifetime.addEventListener('abort', server.stop, { once: true });
    try {
      signal.throwIfAborted();
      const { TrueForge } = await import('@truefoundry/trueforge-sdk');
      const forge = new TrueForge({ baseUrl: server.serverUrl, token: server.serverToken, timeoutInSeconds: 15, maxRetries: 0 });
      await forge.settings.modelProviders.create({
        manifest: {
          type: 'custom', name: 'agentextension', baseUrl: profile.baseUrl,
          ...(profile.apiKey ? { auth: { apiKey: profile.apiKey } } : {}),
          models: [{ name: 'default', modelId: profile.modelId,
            properties: { contextLength: 32_768 } }],
        },
      }, { abortSignal: signal });
      return server;
    } catch {
      server.stop();
      throw new Error('Could not register the model. Check the model API URL and credentials.');
    }
  }

  dispose() {
    this.current?.controller.abort();
    this.current = undefined;
  }
}

module.exports = { ManagedForge, MODEL_SECRET, MANAGED_MODEL, providerUrl, readProfile };

const http = require('node:http');
const { randomBytes, randomUUID } = require('node:crypto');
const { auth, discoverAuthorizationServerMetadata, discoverOAuthProtectedResourceMetadata, refreshAuthorization } = require('@modelcontextprotocol/sdk/client/auth.js');
const { digest } = require('./permissions');

function connectorUrl(raw) {
  const url = new URL(raw);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.hash) {
    throw new Error('Use an HTTPS URL or a loopback HTTP URL without credentials or fragments.');
  }
  return url;
}

function secretKey(config) {
  const identity = [config.id, config.url, config.account];
  if (config.oauth) identity.push(config.oauth);
  return `connector.v1.${digest(identity)}`;
}

// Separate the stable approval identity from rotating tokens. Only identity changes revoke approvals.
const tokenKey = identity => `connector.oauth-tokens.v1.${identity.binding}`;
const scopesOf = (value, fallback) => value === undefined ? fallback : [...new Set(value.split(/\s+/).filter(Boolean))].sort();

function oauthFetch(config, signal) {
  const resource = connectorUrl(config.url);
  const issuer = connectorUrl(config.oauth.issuer);
  return async (input, init = {}) => {
    const url = connectorUrl(String(input));
    if (url.origin !== issuer.origin && (url.origin !== resource.origin || (init.method ?? 'GET').toUpperCase() !== 'GET'
        || !url.pathname.startsWith('/.well-known/oauth-protected-resource'))) {
      throw new Error('OAuth discovery changed the configured server.');
    }
    const response = await fetch(url, { ...init, signal, redirect: 'error' });
    if (!response.body) return response;
    let received = 0;
    const body = response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > 128_000) throw new Error('OAuth response exceeded its size limit.');
      controller.enqueue(chunk);
    } }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

async function discovery(config, fetchFn) {
  const { issuer } = config.oauth;
  const resourceMetadata = await discoverOAuthProtectedResourceMetadata(config.url, {}, fetchFn);
  if (new URL(resourceMetadata?.resource ?? 'about:blank').href !== config.url
      || !resourceMetadata?.authorization_servers?.includes(issuer)) {
    throw new Error('OAuth metadata does not match the configured connector and issuer.');
  }
  const metadata = await discoverAuthorizationServerMetadata(issuer, { fetchFn });
  const origin = connectorUrl(issuer).origin;
  if (!metadata || metadata.issuer !== issuer || !metadata.code_challenge_methods_supported?.includes('S256')
      || ![metadata.authorization_endpoint, metadata.token_endpoint, metadata.jwks_uri]
        .every(endpoint => endpoint && connectorUrl(endpoint).origin === origin)) {
    throw new Error('The configured issuer must support PKCE and signed OpenID Connect ID tokens on its own origin.');
  }
  return { authorizationServerUrl: issuer, resourceMetadata, authorizationServerMetadata: metadata };
}

async function verifyAccount(config, token, metadata, fetchFn, nonce) {
  if (!token) throw new Error('The issuer did not supply a verifiable account.');
  const response = await fetchFn(metadata.jwks_uri);
  if (!response.ok) throw new Error('Could not verify the OAuth account.');
  const { jwtVerify, createLocalJWKSet } = await import('jose');
  const { payload } = await jwtVerify(token, createLocalJWKSet(await response.json()), {
    issuer: config.oauth.issuer, audience: config.oauth.clientId, requiredClaims: ['sub', 'iat', 'exp'],
    algorithms: ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'],
  });
  if ((nonce !== undefined && payload.nonce !== nonce) || typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255 || /[\x00-\x1f\x7f]/.test(payload.sub)
      || ((Array.isArray(payload.aud) && payload.aud.length > 1 || payload.azp !== undefined) && payload.azp !== config.oauth.clientId)) {
    throw new Error('The OAuth account proof did not match this sign-in.');
  }
  return { subject: payload.sub, label: payload.email_verified === true && typeof payload.email === 'string'
    ? payload.email.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) || payload.sub : payload.sub };
}

function tokenRecord(tokens) {
  if (tokens.token_type.toLowerCase() !== 'bearer' || !tokens.access_token || tokens.access_token.length > 32_000
      || !/^[A-Za-z0-9._~+/=-]+$/.test(tokens.access_token)) throw new Error('The issuer did not return a usable bearer token.');
  return { tokens, expiresAt: Number.isFinite(tokens.expires_in) ? Date.now() + tokens.expires_in * 1000 : null };
}

async function authorize(config, signal, fetchFn, state, openBrowser, background = false) {
  const csrf = randomBytes(32).toString('hex');
  const nonce = randomBytes(32).toString('hex');
  let resolveCallback;
  const callback = new Promise(resolve => { resolveCallback = resolve; });
  const abort = () => resolveCallback();
  let redirectUrl;
  const server = http.createServer((request, response) => {
    try {
      if (!redirectUrl || request.headers.host !== redirectUrl.host || request.method !== 'GET' || !request.url.startsWith('/')) throw new Error();
      const url = new URL(request.url, redirectUrl);
      if (url.origin !== redirectUrl.origin || url.pathname !== redirectUrl.pathname
          || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== csrf) throw new Error();
      const codes = url.searchParams.getAll('code');
      const code = codes.length === 1 && codes[0].length <= 4096 && !url.searchParams.has('error') ? codes[0] : undefined;
      response.writeHead(code ? 200 : 400, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      response.end(code ? 'Return to VS Code to confirm the account.' : 'OAuth sign-in was declined or failed.');
      resolveCallback(code);
    } catch {
      response.writeHead(400).end('This callback did not match the pending sign-in.');
    }
  });
  signal.addEventListener('abort', abort, { once: true });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    signal.throwIfAborted();
    redirectUrl = new URL(`http://127.0.0.1:${server.address().port}/oauth/callback`);
    const { issuer, clientId, scopes } = config.oauth;
    let codeVerifier;
    let tokens;
    const provider = {
      redirectUrl, clientMetadata: { redirect_uris: [redirectUrl.href], token_endpoint_auth_method: 'none' },
      clientInformation: () => ({ client_id: clientId, issuer }), discoveryState: () => state,
      state: () => csrf, tokens: () => undefined, saveTokens: value => { tokens = value; },
      saveCodeVerifier: value => { codeVerifier = value; }, codeVerifier: () => codeVerifier,
      async redirectToAuthorization(url) {
        url.searchParams.set('nonce', nonce);
        url.searchParams.set('prompt', background || scopes.includes('offline_access') ? 'consent select_account' : 'select_account');
        if (await openBrowser(url) === false) throw new Error('Could not open the browser for OAuth sign-in.');
      },
    };
    const options = { serverUrl: config.url, scope: scopes.join(' '), fetchFn };
    if (await auth(provider, options) !== 'REDIRECT') throw new Error('OAuth sign-in did not request authorization.');
    const authorizationCode = await callback;
    signal.throwIfAborted();
    if (!authorizationCode) throw new Error('OAuth sign-in was declined or failed.');
    if (await auth(provider, { ...options, authorizationCode }) !== 'AUTHORIZED' || tokens?.issuer !== issuer) {
      throw new Error('OAuth sign-in did not return tokens from the configured issuer.');
    }
    const account = await verifyAccount(config, tokens.id_token, state.authorizationServerMetadata, fetchFn, nonce);
    const granted = scopesOf(tokens.scope, scopes);
    if (!granted.includes('openid') || granted.some(scope => !scopes.includes(scope))) {
      throw new Error('The OAuth issuer returned a scope outside the configured account access.');
    }
    return { identity: { ...account, scopes: granted, binding: randomUUID() }, record: tokenRecord(tokens) };
  } finally {
    signal.removeEventListener('abort', abort);
    server.close();
    server.closeAllConnections();
  }
}

class ConnectorAccounts {
  constructor(secrets, { beforeAccountChange } = {}) {
    this.secrets = secrets;
    this.beforeAccountChange = beforeAccountChange;
    this.refreshing = new Map();
    this.accountChanges = new Map();
  }

  async changeAccount(key, expected, change) {
    const previous = this.accountChanges.get(key) ?? Promise.resolve();
    const update = previous.catch(() => {}).then(async () => {
      if (await this.secrets.get(key) !== expected) throw new Error('The connector account changed. Review the current account first.');
      await change();
    });
    this.accountChanges.set(key, update);
    try { await update; }
    finally { if (this.accountChanges.get(key) === update) this.accountChanges.delete(key); }
  }

  identity(raw) {
    if (!raw) return undefined;
    try {
      const identity = JSON.parse(raw);
      if (typeof identity.subject === 'string' && typeof identity.label === 'string' && Array.isArray(identity.scopes)
          && identity.scopes.every(scope => typeof scope === 'string')
          && /^[a-f0-9-]{36}$/.test(identity.binding)) return identity;
    } catch { /* Treat invalid storage as signed out. */ }
  }

  async signIn(config, { openBrowser, confirm, signal }) {
    const key = secretKey(config);
    const previous = await this.secrets.get(key);
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(300_000)]);
    const fetchFn = oauthFetch(config, deadline);
    let next;
    try { next = await authorize(config, deadline, fetchFn, await discovery(config, fetchFn), openBrowser); }
    catch {
      deadline.throwIfAborted();
      throw new Error('OAuth sign-in failed. Check the issuer, client registration, and granted scopes.');
    }
    if (!await confirm(next.identity)) return undefined;
    deadline.throwIfAborted();
    const target = tokenKey(next.identity);
    await this.secrets.store(target, JSON.stringify(next.record));
    try {
      await this.changeAccount(key, previous, async () => {
        deadline.throwIfAborted();
        if (previous) await this.beforeAccountChange?.(config, previous);
        await this.secrets.store(key, JSON.stringify(next.identity));
      });
    } catch (error) {
      await this.secrets.delete(target).catch(() => {});
      throw error;
    }
    const old = this.identity(previous);
    if (old) await this.secrets.delete(tokenKey(old)).catch(() => {});
    return next.identity;
  }

  async signOut(config, expected) {
    const key = secretKey(config);
    const current = expected ?? await this.secrets.get(key);
    const old = this.identity(current);
    await this.changeAccount(key, current, async () => {
      if (current) await this.beforeAccountChange?.(config, current);
      await this.secrets.delete(key);
    });
    if (old) await this.secrets.delete(tokenKey(old));
  }

  async authorizeBackground(config, raw, { openBrowser, signal }) {
    const key = secretKey(config);
    const identity = this.identity(raw);
    if (!identity || await this.secrets.get(key) !== raw) throw new Error('The connector account changed. Review the schedule again.');
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(300_000)]);
    const fetchFn = oauthFetch(config, deadline);
    let grant;
    try { grant = await authorize(config, deadline, fetchFn, await discovery(config, fetchFn), openBrowser, true); }
    catch {
      deadline.throwIfAborted();
      throw new Error('Background OAuth authorization failed. Check that the issuer supports offline access.');
    }
    if (grant.identity.subject !== identity.subject || digest(grant.identity.scopes) !== digest(identity.scopes)) {
      throw new Error('Background OAuth must use the signed-in connector account and the same scopes.');
    }
    const foreground = JSON.parse(await this.secrets.get(tokenKey(identity)) ?? 'null');
    const { refresh_token: refreshToken } = grant.record.tokens;
    if (!refreshToken || refreshToken === foreground?.tokens?.refresh_token) {
      throw new Error('The issuer must supply a separate refresh token for this background approval.');
    }
    deadline.throwIfAborted();
    if (await this.secrets.get(key) !== raw) throw new Error('The connector account changed. Review the schedule again.');
    return grant.record;
  }

  async access(config, raw, signal, rejectedToken) {
    const identity = this.identity(raw);
    if (!identity) throw new Error('Sign in to this connector account first.');
    let record;
    try { record = JSON.parse(await this.secrets.get(tokenKey(identity))); } catch { /* A missing token needs sign-in. */ }
    if (record?.tokens?.issuer !== config.oauth.issuer) throw new Error('Sign in to this connector account again.');
    if (record.tokens.access_token === rejectedToken || (record.expiresAt !== null && record.expiresAt <= Date.now() + 5_000)) {
      if (!this.refreshing.has(raw)) {
        const pending = this.refresh(config, identity, raw, record, signal).finally(() => this.refreshing.delete(raw));
        this.refreshing.set(raw, pending);
      }
      record = await this.refreshing.get(raw);
    }
    signal.throwIfAborted();
    if (await this.secrets.get(secretKey(config)) !== raw) throw new Error('The connector account changed.');
    return record.tokens.access_token;
  }

  async refresh(config, identity, raw, record, signal) {
    if (!record.tokens.refresh_token) throw new Error('The connector session expired. Sign in again.');
    const fetchFn = oauthFetch(config, signal);
    try {
      const state = await discovery(config, fetchFn);
      const { issuer, clientId } = config.oauth;
      const metadata = state.authorizationServerMetadata;
      const tokens = await refreshAuthorization(issuer, { metadata, clientInformation: { client_id: clientId, issuer },
        refreshToken: record.tokens.refresh_token, resource: state.resourceMetadata.resource, fetchFn });
      const scopes = scopesOf(tokens.scope, identity.scopes);
      if (JSON.stringify(scopes) !== JSON.stringify(identity.scopes)) throw new Error('OAuth scope changed.');
      if (tokens.id_token && (await verifyAccount(config, tokens.id_token, metadata, fetchFn)).subject !== identity.subject) {
        throw new Error('OAuth account changed.');
      }
      const updated = tokenRecord({ ...tokens, issuer });
      if (await this.secrets.get(secretKey(config)) !== raw) throw new Error('OAuth account changed.');
      await this.secrets.store(tokenKey(identity), JSON.stringify(updated));
      // Sign-out may have removed the token key while this refresh was in flight.
      if (await this.secrets.get(secretKey(config)) !== raw) {
        await this.secrets.delete(tokenKey(identity));
        throw new Error('OAuth account changed.');
      }
      return updated;
    } catch {
      signal.throwIfAborted();
      throw new Error('The connector could not refresh the same account and scope. Sign in again.');
    }
  }
}

module.exports = { ConnectorAccounts, connectorUrl, secretKey, tokenKey };

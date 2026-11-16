const assert = require('node:assert/strict');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const { ConnectorAccounts } = require('../../src/connector-oauth');
const { validateConnector } = require('../../src/connectors');

async function startOAuthFixture(t) {
  const { exportJWK, generateKeyPair, SignJWT } = await import('jose');
  const keys = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...await exportJWK(keys.publicKey), kid: 'fixture-key', alg: 'ES256', use: 'sig' };
  const values = new Map();
  const secrets = { get: async key => values.get(key), store: async (key, value) => values.set(key, value), delete: async key => values.delete(key) };
  const accounts = new ConnectorAccounts(secrets);
  const state = { subject: 'account-one', refreshes: 0, calls: 0, accessToken: '', error: undefined, backgroundGrants: 0 };
  const backgroundTokens = new Map();
  let origin;
  let authorization;
  const server = http.createServer(async (request, response) => {
    const json = data => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(data)); };
    try {
      const path = new URL(request.url, origin).pathname;
      if (path.startsWith('/.well-known/oauth-protected-resource')) return json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
      if (['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration'].includes(path)) {
        return json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, jwks_uri: `${origin}/keys`,
          response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
          subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['ES256'] });
      }
      if (path === '/keys') return json({ keys: [jwk] });
      if (path === '/token') {
        let body = '';
        for await (const chunk of request) body += chunk;
        const form = new URLSearchParams(body);
        assert.equal(form.get('client_id'), 'fixture-client');
        assert.equal(form.get('resource'), `${origin}/mcp`);
        const refresh = form.get('grant_type') === 'refresh_token';
        let subject;
        let refreshToken;
        if (refresh) {
          state.refreshes++;
          const supplied = form.get('refresh_token');
          const background = backgroundTokens.get(supplied);
          if (supplied.startsWith('refresh-background-')) {
            if (!background || state.rejectRefresh) return response.writeHead(400, { 'content-type': 'application/json' })
              .end(JSON.stringify({ error: 'invalid_grant' }));
            await state.beforeBackgroundRefresh?.();
            backgroundTokens.delete(supplied);
            refreshToken = `refresh-background-${background.grant}-${state.refreshes}`;
            backgroundTokens.set(refreshToken, background);
            subject = background.subject;
          } else {
            assert.equal(supplied, `refresh-${state.subject}`);
            refreshToken = supplied;
            subject = state.subject;
          }
          subject = state.refreshSubject ?? subject;
        } else {
          assert.equal(form.get('grant_type'), 'authorization_code');
          assert.equal(form.get('code'), 'fixture-code');
          assert.equal(form.get('redirect_uri'), authorization.get('redirect_uri'));
          assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), authorization.get('code_challenge'));
          const background = authorization.get('prompt') === 'consent select_account';
          subject = background ? state.backgroundSubject ?? state.subject : state.subject;
          if (background && !state.reuseEditorGrant) {
            const grant = ++state.backgroundGrants;
            refreshToken = `refresh-background-${grant}-0`;
            backgroundTokens.set(refreshToken, { grant, subject });
          } else refreshToken = `refresh-${subject}`;
        }
        const idToken = await new SignJWT(refresh ? {} : { nonce: authorization.get('nonce') })
          .setProtectedHeader({ alg: 'ES256', kid: jwk.kid }).setIssuer(origin).setAudience('fixture-client')
          .setSubject(subject).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
        state.accessToken = `access-${state.subject}-${state.refreshes}`;
        return json({ access_token: state.accessToken, token_type: 'Bearer', refresh_token: refreshToken,
          id_token: refresh && state.omitRefreshIdentity ? undefined : idToken,
          expires_in: refresh ? 120 : state.omitExpiry ? undefined : 0, scope: refresh ? state.refreshScope ?? 'openid docs.read' : 'openid docs.read' });
      }
      if (path !== '/mcp') return response.writeHead(404).end();
      if (request.headers.authorization !== `Bearer ${state.accessToken}`) return response.writeHead(401).end();
      if (request.method !== 'POST') return response.writeHead(405).end();
      const mcp = new McpServer({ name: 'oauth-fixture', version: '1.0.0' });
      mcp.registerTool('read_doc', { inputSchema: { document: z.string() } }, async ({ document }) => {
        state.calls++;
        return { content: [{ type: 'text', text: `Read ${document}; echoed ${state.accessToken}` }] };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      response.once('close', () => { void mcp.close().catch(() => {}); });
      await mcp.connect(transport);
      await transport.handleRequest(request, response);
    } catch (error) { state.error ??= error; response.writeHead(500).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const config = validateConnector({ id: 'docs', account: 'example profile', url: `${origin}/mcp`,
    oauth: { issuer: origin, clientId: 'fixture-client', scopes: ['openid', 'docs.read'] },
    tools: [{ name: 'read_doc', targetArgument: 'document', targets: ['manual'] }] });
  const openBrowser = async url => {
    assert.equal(url.origin, origin);
    authorization = url.searchParams;
    assert.match(authorization.get('prompt'), /^(?:consent )?select_account$/);
    assert.equal(authorization.get('code_challenge_method'), 'S256');
    assert.equal(authorization.get('scope'), 'docs.read openid');
    assert.ok(authorization.get('nonce'));
    const callback = new URL(authorization.get('redirect_uri'));
    assert.equal(callback.hostname, '127.0.0.1');
    callback.searchParams.set('code', 'fixture-code');
    callback.searchParams.set('state', 'other-sign-in');
    assert.equal((await fetch(callback)).status, 400);
    callback.searchParams.set('state', authorization.get('state'));
    assert.equal((await fetch(callback)).status, 200);
    return true;
  };
  return { config, state, secrets, accounts, values, openBrowser };
}

module.exports = { startOAuthFixture };

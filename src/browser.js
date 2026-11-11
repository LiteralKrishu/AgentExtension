const path = require('node:path');
const { z } = require('zod');
const { digest } = require('./permissions');
const { SurfaceAccess } = require('./surface-access');

const browserOpen = z.strictObject({ url: z.string().min(1).max(2_000) });
const browserObserve = z.strictObject({ screenshot: z.boolean().default(false) });
const browserVisit = z.strictObject({ url: z.string().min(1).max(2_000), reason: z.string().trim().min(1).max(300) });
const VISIT = { limit: 3, ttl: 5 * 60_000 };
const browserAction = z.strictObject({ snapshot: z.string().length(64), element: z.string().regex(/^e\d{1,2}$/),
  action: z.enum(['click', 'fill', 'upload']), text: z.string().max(2_000).optional(), file: z.string().max(500).optional() });

function webUrl(raw) {
  const url = new URL(raw);
  if (url.username || url.password || url.hostname.includes('*') || !['https:', 'http:'].includes(url.protocol)
      || (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Use HTTPS or loopback HTTP without URL credentials.');
  }
  return url;
}
function browserOrigins(input) {
  if (!Array.isArray(input) || input.length > 8) throw new Error('Configure at most eight exact browser origins.');
  return [...new Set(input.map(raw => {
    const url = webUrl(raw);
    if (url.pathname !== '/' || url.search || url.hash) throw new Error('Browser scope must be an exact origin without a path or query.');
    return url.origin;
  }))];
}

class ScopedBrowser extends SurfaceAccess {
  constructor(options) {
    super(options);
    this.origins = browserOrigins(options.origins); this.interactive = options.interactive === true;
    this.executablePath = options.executablePath || undefined;
    this.workspace = options.workspace; this.onImage = options.onImage ?? (async () => undefined);
    this.requests = new Set(); this.requestCount = 0; this.responseBytes = 0; this.visits = 0; this.now = options.now ?? Date.now;
    this.signal.addEventListener('abort', () => { void this.browser?.close().catch(() => {}); }, { once: true });
  }
  // A visit approved with browser_visit adds one origin for GET and HEAD only, until it expires or the agent opens another page.
  allowed(raw, { write = false } = {}) {
    const url = webUrl(raw);
    if (this.origins.includes(url.origin)) return url;
    if (!write && this.visit?.origin === url.origin && this.now() < this.visit.expires) return url;
    throw new Error('Browser origin is outside the approved scope.');
  }
  onVisit() { return Boolean(this.page && this.visit && !this.origins.includes(new URL(this.page.url()).origin)); }
  async start() {
    this.check();
    if (this.page) return;
    const { chromium } = require('playwright-core');
    try {
      this.browser = await chromium.launch({ headless: false, chromiumSandbox: true,
        ...(this.executablePath ? { executablePath: this.executablePath } : { channel: 'chrome' }),
        args: ['--disable-background-networking', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
    } catch { throw new Error('Could not start the dedicated browser. Install Chrome or set AgentExtension: Browser Executable.'); }
    if (this.signal.aborted) { await this.browser.close(); this.check(); }
    this.context = await this.browser.newContext({ acceptDownloads: false, serviceWorkers: 'block',
      permissions: [], viewport: { width: 1100, height: 740 } });
    await this.context.routeWebSocket('**/*', socket => socket.close());
    await this.context.route('**/*', route => {
      const pending = this.route(route); this.requests.add(pending);
      pending.finally(() => this.requests.delete(pending)).catch(() => {}); return pending;
    });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(8_000);
    this.page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
    this.context.on('page', page => { if (page !== this.page) void page.close().catch(() => {}); });
    this.page.on('framenavigated', frame => {
      if (frame === this.page.mainFrame() && frame.url() !== 'about:blank') {
        try { this.allowed(frame.url()); } catch { this.close(); }
      }
    });
  }
  async route(route) {
    const request = route.request();
    try {
      this.check(); this.allowed(request.url());
      if (++this.requestCount > 100) throw new Error('Browser request limit reached.');
      if (request.frame() !== this.page?.mainFrame() || request.isNavigationRequest() && request.frame().page() !== this.page) throw new Error('Extra windows and frames are blocked.');
      const method = request.method();
      const body = request.postDataBuffer();
      if ((body?.length ?? 0) > 128_000) throw new Error('Browser request exceeds 128,000 bytes.');
      const input = { method, url: request.url(), body: digest(body?.toString('base64') ?? '') };
      let action;
      if (!['GET', 'HEAD'].includes(method)) {
        this.allowed(request.url(), { write: true });
        if (!this.interactive || !this.gesture) throw new Error('Unrequested browser writes are blocked.');
        const gesture = this.gesture;
        action = await this.approve('browser_request', 'browser.write', request.url(), input, { gesture, page: this.page.url() },
          { title: 'Allow this browser request?', detail: `${method} ${request.url()}\nBody: ${body?.length ?? 0} bytes\nDigest: ${input.body}\nThis request can change remote data.` });
        if (gesture !== this.gesture) throw new Error('Browser action ended.');
        this.permissions.require(action);
      } else {
        action = this.permissions.action('browser_request', 'browser.observe', request.url(), input);
        this.permissions.require(action);
      }
      this.check(action);
      // Fulfill bounded host fetches. Never continue a browser request or follow redirects.
      const headers = { ...request.headers() };
      delete headers.host; delete headers['content-length'];
      const response = await fetch(request.url(), { method, headers, body: body ?? undefined, redirect: 'manual',
        signal: AbortSignal.any([this.signal, AbortSignal.timeout(15_000)]) });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel(); throw new Error('Redirect blocked. Open the destination explicitly within the approved scope.');
      }
      const chunks = []; let size = 0;
      if (response.body) for await (const chunk of response.body) {
        size += chunk.length; this.responseBytes += chunk.length;
        if (size > 2_000_000 || this.responseBytes > 16_000_000) throw new Error('Browser response budget exceeded.');
        chunks.push(chunk);
      }
      this.check(action); this.allowed(request.url());
      const outputHeaders = Object.fromEntries(response.headers);
      delete outputHeaders['content-encoding']; delete outputHeaders['content-length'];
      // Prevent navigation to external protocols and unsolicited resource channels.
      outputHeaders['content-security-policy'] = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'";
      await route.fulfill({ status: response.status, headers: outputHeaders, body: Buffer.concat(chunks) });
    } catch {
      this.onEvent({ kind: 'browser request', target: digest(request.url()), status: 'blocked' });
      await route.abort('blockedbyclient').catch(() => {});
    }
  }
  async readState(remember = false) {
    this.check(); const url = this.allowed(this.page.url()).href;
    const handles = (await this.page.locator('button,a,input,textarea,select,[role="button"]').elementHandles()).slice(0, 60);
    const elements = [];
    for (let i = 0; i < handles.length; i++) {
      const info = await handles[i].evaluate(node => ({ tag: node.tagName.toLowerCase(), type: node.getAttribute('type') ?? '',
        label: (node.getAttribute('aria-label') ?? node.innerText ?? node.getAttribute('placeholder') ?? '').slice(0, 160),
        href: node.getAttribute('href') ?? '', disabled: Boolean(node.disabled),
        value: node.type === 'password' ? '[protected]' : String(node.value ?? '').slice(0, 200) }));
      elements.push({ id: `e${i}`, ...info });
    }
    const state = { url, title: (await this.page.title()).slice(0, 200),
      text: (await this.page.locator('body').innerText()).slice(0, 8_000), elements, trust: 'untrusted page data' };
    const snapshot = digest(state);
    if (remember) { await Promise.allSettled((this.receipt?.handles ?? []).map(handle => handle.dispose())); this.receipt = { snapshot, handles, state }; }
    else await Promise.allSettled(handles.map(handle => handle.dispose()));
    this.check(); this.allowed(this.page.url());
    return { ...state, snapshot };
  }
  open(raw) {
    const input = browserOpen.parse(raw); this.allowed(input.url);
    return this.operation('browser open', input.url, async () => {
      this.permissions.require(this.permissions.action('browser_open', 'browser.observe', input.url, input));
      this.visit = undefined;
      await this.start();
      await this.page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      return this.readState(true);
    });
  }
  observe(raw = {}) {
    const input = browserObserve.parse(raw);
    return this.operation('browser observe', this.page?.url(), async () => {
      if (!this.page) throw new Error('Open an approved page first.');
      this.permissions.require(this.permissions.action('browser_observe', 'browser.observe', this.page.url(), input));
      const state = await this.readState(true);
      if (input.screenshot) {
        const image = await this.page.screenshot({ type: 'jpeg', quality: 45, timeout: 5_000 });
        this.check(); this.allowed(this.page.url());
        if (image.length > 250_000) throw new Error('Screenshot exceeds 250,000 bytes.');
        state.evidence = await this.onImage(image, state);
        state.image = { mimeType: 'image/jpeg', data: image.toString('base64') };
      }
      return state;
    });
  }
  // Asks for one visit to a page outside the selected origins. The page is read-only and leaves scope on the next open.
  visitOnce(raw) {
    const input = browserVisit.parse(raw);
    const url = webUrl(input.url);
    if (this.origins.includes(url.origin)) return this.open({ url: url.href });
    if (this.visits >= VISIT.limit) return Promise.reject(new Error(`Visit limit reached: ${VISIT.limit} pages outside the browser scope per run.`));
    return this.operation('browser visit', url.href, async () => {
      const action = await this.approve('browser_visit', 'browser.navigate', url.href, input, {},
        { title: 'Allow one visit outside the browser scope?', detail: `${url.href}\nReason given by the agent: ${input.reason}\nThe page can load resources from ${url.origin} with GET and HEAD for up to five minutes, or until the agent opens another page. Clicks, typing, uploads and form submissions on this page are blocked. Redirects stay blocked. Page content is untrusted and can be sent to your model.` });
      this.permissions.require(action);
      this.visits++;
      this.visit = { origin: url.origin, url: url.href, expires: this.now() + VISIT.ttl };
      await this.start();
      await this.page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      return { ...await this.readState(true), visit: { origin: url.origin, readOnly: true, expiresInSeconds: VISIT.ttl / 1000 } };
    });
  }
  act(raw) {
    const input = browserAction.parse(raw);
    return this.operation(`browser ${input.action}`, input.element, async () => {
      if (!this.interactive || !this.receipt) throw new Error('Browser interaction is not enabled.');
      if (this.onVisit()) throw new Error('Actions are blocked on a page outside the browser scope. Open an in-scope page first.');
      const receipt = this.receipt;
      const index = Number(input.element.slice(1)); const node = receipt.state.elements[index];
      if (input.snapshot !== receipt.snapshot || !node || node.type === 'password') throw new Error('Observe a current non-protected browser target.');
      if (input.action === 'fill' && (typeof input.text !== 'string' || input.file !== undefined)
          || input.action === 'click' && (input.text !== undefined || input.file !== undefined)
          || input.action === 'upload' && (!input.file || input.text !== undefined || node.type !== 'file')) throw new Error('Action arguments do not match the target.');
      let upload;
      if (input.action === 'upload') {
        const text = await this.workspace.read(input.file);
        upload = Buffer.from(text); if (upload.length > 64_000) throw new Error('Upload limit is 64,000 bytes of workspace text.');
      }
      const check = async () => {
        this.check(); if ((await this.readState()).snapshot !== receipt.snapshot) throw new Error('Browser target changed. Observe again.');
        if (upload && !upload.equals(Buffer.from(await this.workspace.read(input.file)))) throw new Error('Upload content changed. Approve it again.');
      };
      await check();
      const action = await this.approve('browser_act', 'browser.write', receipt.state.url, input,
        { snapshot: receipt.snapshot, upload: upload ? digest(upload.toString('base64')) : undefined },
        { title: 'Allow this browser action?', detail: `${receipt.state.url}\n${input.action} · ${node.tag} · ${node.label}\n${input.action === 'fill' ? `Text: ${input.text}` : ''}${upload ? `File: ${input.file}\n${upload.length} bytes · ${digest(upload.toString('base64'))}` : ''}\nChanges outside the editor cannot be undone by Undo last apply.` });
      await check(); this.check(action); this.permissions.require(action);
      this.gesture = digest(action);
      try {
        const handle = receipt.handles[index];
        if (input.action === 'click') await handle.click({ timeout: 75_000, noWaitAfter: false });
        else if (input.action === 'fill') await handle.fill(input.text, { timeout: 8_000 });
        else await handle.setInputFiles({ name: path.basename(input.file), mimeType: 'text/plain', buffer: upload });
        await Promise.allSettled([...this.requests]);
        await this.page.waitForLoadState('domcontentloaded', { timeout: 8_000 });
        return await this.readState(true);
      } finally { this.gesture = undefined; }
    });
  }
  async reset() { await this.browser?.close().catch(() => {}); this.browser = this.page = this.context = this.receipt = undefined; }
  close() { super.close(); return this.reset(); }
}

module.exports = { ScopedBrowser, browserOrigins, browserOpen, browserObserve, browserAction, browserVisit, VISIT };

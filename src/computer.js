const path = require('node:path');
const { spawn } = require('node:child_process');
const { z } = require('zod');
const { SurfaceAccess } = require('./surface-access');
const { digest } = require('./permissions');

const computerAction = z.strictObject({ snapshot: z.string().length(64), element: z.string().regex(/^w0(?:\.\d{1,2}){0,10}$/),
  action: z.enum(['press', 'fill', 'increment']), text: z.string().max(2_000).optional() });
const desktopHelper = path.join(__dirname, '../native/agentextension-desktop');
function desktopRequest(input, signal, helper = desktopHelper) {
  if (process.platform !== 'darwin') return Promise.reject(new Error('Native computer access is supported on macOS only.'));
  return new Promise((resolve, reject) => {
    const stop = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(15_000)]);
    const child = spawn(helper, [], { stdio: ['pipe', 'pipe', 'pipe'], signal: stop });
    let output = ''; let error = ''; let finished = false;
    const done = (err, value) => { if (finished) return; finished = true; err ? reject(err) : resolve(value); };
    child.on('error', () => done(new Error(stop.aborted ? 'Computer access stopped or timed out.' : 'Native desktop helper is unavailable.')));
    child.stdout.on('data', data => { output += data; if (output.length > 80_000) { child.kill(); done(new Error('Desktop result exceeded its limit.')); } });
    child.stderr.on('data', data => { error = (error + data).slice(0, 1_000); });
    child.stdin.on('error', () => {});
    child.on('exit', code => {
      if (stop.aborted || code !== 0) return done(new Error(stop.aborted ? 'Computer access stopped or timed out.' : error || 'Desktop action failed.'));
      try { done(null, JSON.parse(output)); } catch { done(new Error('Invalid desktop helper response.')); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

// Keep the observed Accessibility objects in the helper for the lifetime of this app scope.
function desktopSession(scopeSignal) {
  let child;
  let pending;
  let output = '';
  function stop(error) {
    const process = child;
    child = undefined;
    output = '';
    process?.kill();
    pending?.finish(error);
  }
  scopeSignal.addEventListener('abort', () => stop(new Error('Computer access stopped.')), { once: true });
  return async (input, requestSignal) => {
    if (process.platform !== 'darwin') throw new Error('Native computer access is supported on macOS only.');
    const signal = AbortSignal.any([scopeSignal, requestSignal, AbortSignal.timeout(15_000)]);
    signal.throwIfAborted();
    if (pending) throw new Error('Wait for the current desktop request.');
    if (!child) {
      const process = spawn(desktopHelper, ['--session'], { stdio: ['pipe', 'pipe', 'ignore'] });
      child = process;
      const failed = () => {
        if (child === process) stop(new Error('Native desktop helper is unavailable.'));
      };
      process.on('error', failed);
      process.on('exit', failed);
      process.stdin.on('error', failed);
      process.stdout.setEncoding('utf8').on('data', chunk => {
        if (child !== process) return;
        output += chunk;
        if (Buffer.byteLength(output) > 80_000) return stop(new Error('Desktop result exceeded its limit.'));
        if (!output.includes('\n')) return;
        let reply;
        try { reply = JSON.parse(output); } catch { return stop(new Error('Invalid desktop helper response.')); }
        output = '';
        pending?.finish(reply.error ? new Error(reply.error) : null, reply.value);
      });
    }
    return new Promise((resolve, reject) => {
      const cancelled = () => stop(new Error('Computer access stopped or timed out.'));
      pending = { finish(error, value) {
        pending = undefined;
        signal.removeEventListener('abort', cancelled);
        if (error) reject(error);
        else resolve(value);
      } };
      signal.addEventListener('abort', cancelled, { once: true });
      child.stdin.write(`${JSON.stringify(input)}\n`);
    });
  };
}

// Allow rules for computer.write match this subject, for example `com.example.app press AXButton Save`.
// A rule for the bundle ID alone no longer allows every press and fill in that app.
const computerSubject = (app, action, node) => [app.bundleId, action, node.role, String(node.title || node.description || '').replace(/\s+/g, ' ').trim()].join(' ');

class ScopedComputer extends SurfaceAccess {
  constructor(options) {
    super(options); this.app = options.app; this.interactive = options.interactive === true;
    this.request = options.request ?? desktopSession(this.signal);
    this.onDispatch = options.onDispatch ?? (() => {});
  }
  observe() {
    return this.operation('computer observe', this.app, async () => {
      this.permissions.require(this.permissions.action('computer_observe', 'computer.observe', this.app));
      const state = await this.request({ command: 'observe', app: this.app }, this.signal);
      this.check(); if (digest(state.app) !== digest(this.app)) throw new Error('Desktop app identity changed.');
      this.receipt = state; return state;
    });
  }
  act(raw, requestSignal = this.signal) {
    const input = computerAction.parse(raw);
    return this.operation(`computer ${input.action}`, this.app, async () => {
      if (!this.interactive) throw new Error('Computer interaction is not enabled.');
      const receipt = this.receipt;
      const node = receipt?.nodes.find(node => node.id === input.element);
      if (!receipt || receipt.snapshot !== input.snapshot || !node || !node.enabled
          || input.action === 'press' && (!node.press || input.text !== undefined)
          || input.action === 'fill' && (!node.editable || typeof input.text !== 'string')
          || input.action === 'increment' && (!node.increment || input.text !== undefined)) throw new Error('Observe a current permitted desktop target.');
      const check = async signal => {
        this.check(); signal.throwIfAborted();
        const state = await this.request({ command: 'check', app: this.app, snapshot: receipt.snapshot, element: input.element }, signal);
        if (state.snapshot !== receipt.snapshot || digest(state.app) !== digest(this.app)) throw new Error('Desktop target changed. Observe again.');
      };
      await check(requestSignal);
      const value = input.action === 'fill' ? `Text: ${input.text}\n`
        : input.action === 'increment' ? `Current value: ${node.value}\nRange: ${node.minimum} to ${node.maximum}\n` : '';
      const action = await this.approve('computer_act', 'computer.write', this.app, input, { snapshot: receipt.snapshot },
        { title: 'Allow this computer action?', detail: `${this.app.name} · ${this.app.bundleId}\n${this.app.path}\nWindow: ${receipt.window}\n${input.action} · ${node.role} · ${node.title || node.description}\n${value}This affects the selected app. Editor Undo cannot reverse it.` },
        computerSubject(this.app, input.action, node), requestSignal);
      const signal = AbortSignal.any([this.signal, requestSignal, this.permissions.revocation.signal]);
      await check(signal); this.check(action); this.permissions.require(action);
      signal.throwIfAborted();
      this.receipt = undefined;
      this.onDispatch();
      const result = await this.request({ command: 'act', app: this.app, ...input }, signal);
      this.check(action); return result;
    });
  }
  reset() { this.receipt = undefined; }
}

module.exports = { ScopedComputer, desktopRequest, computerAction, computerSubject };

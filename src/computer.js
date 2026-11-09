const path = require('node:path');
const { spawn } = require('node:child_process');
const { z } = require('zod');
const { SurfaceAccess } = require('./surface-access');
const { digest } = require('./permissions');

const computerAction = z.strictObject({ snapshot: z.string().length(64), element: z.string().regex(/^w0(?:\.\d{1,2}){0,10}$/),
  action: z.enum(['press', 'fill']), text: z.string().max(2_000).optional() });
function desktopRequest(input, signal, helper = path.join(__dirname, '../native/agentextension-desktop')) {
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

class ScopedComputer extends SurfaceAccess {
  constructor(options) {
    super(options); this.app = options.app; this.interactive = options.interactive === true;
    this.request = options.request ?? desktopRequest;
  }
  observe() {
    return this.operation('computer observe', this.app, async () => {
      this.permissions.require(this.permissions.action('computer_observe', 'computer.observe', this.app));
      const state = await this.request({ command: 'observe', app: this.app }, this.signal);
      this.check(); if (digest(state.app) !== digest(this.app)) throw new Error('Desktop app identity changed.');
      this.receipt = state; return state;
    });
  }
  act(raw) {
    const input = computerAction.parse(raw);
    return this.operation(`computer ${input.action}`, this.app, async () => {
      if (!this.interactive) throw new Error('Computer interaction is not enabled.');
      const receipt = this.receipt;
      const node = receipt?.nodes.find(node => node.id === input.element);
      if (!receipt || receipt.snapshot !== input.snapshot || !node || !node.enabled
          || input.action === 'press' && (!node.press || input.text !== undefined)
          || input.action === 'fill' && (!node.editable || typeof input.text !== 'string')) throw new Error('Observe a current permitted desktop target.');
      const check = async () => {
        this.check(); const state = await this.request({ command: 'observe', app: this.app }, this.signal);
        if (state.snapshot !== receipt.snapshot || digest(state.app) !== digest(this.app)) throw new Error('Desktop target changed. Observe again.');
      };
      await check();
      const action = await this.approve('computer_act', 'computer.write', this.app, input, { snapshot: receipt.snapshot },
        { title: 'Allow this computer action?', detail: `${this.app.name} · ${this.app.bundleId}\n${this.app.path}\nWindow: ${receipt.window}\n${input.action} · ${node.role} · ${node.title || node.description}\n${input.action === 'fill' ? `Text: ${input.text}\n` : ''}This affects the selected app. Editor Undo cannot reverse it.` });
      await check(); this.check(action); this.permissions.require(action);
      this.receipt = undefined;
      const result = await this.request({ command: 'act', app: this.app, ...input }, this.signal);
      this.check(action); return result;
    });
  }
  reset() { this.receipt = undefined; }
}

module.exports = { ScopedComputer, desktopRequest, computerAction };

const { digest } = require('./permissions');

class SurfaceAccess {
  constructor({ permissions, signal, ask, onEvent = () => {}, limit = 30 }) {
    this.permissions = permissions; this.ask = ask; this.onEvent = onEvent;
    this.controller = new AbortController();
    this.signal = AbortSignal.any([signal, this.controller.signal]);
    this.limit = limit; this.count = 0; this.busy = false;
  }
  check(action) {
    this.signal.throwIfAborted();
    if (action && !this.permissions.valid(action)) throw new Error('Surface permission changed. Observe again.');
  }
  async approve(tool, effect, target, args, scope, detail) {
    this.check();
    const action = this.permissions.action(tool, effect, target, args, scope);
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(60_000)]);
    let stop;
    const answer = await Promise.race([this.ask(detail, signal), new Promise(resolve => {
      stop = () => resolve(false); signal.addEventListener('abort', stop, { once: true });
    })]).finally(() => signal.removeEventListener('abort', stop));
    this.check(action);
    if (!answer || signal.aborted) {
      this.permissions.record(action, 'deny', 'Surface action declined or expired');
      throw new Error('Surface action was not approved.');
    }
    if (!this.permissions.grant(action)) throw new Error('Surface approval no longer matches.');
    return action;
  }
  async operation(kind, target, work) {
    this.check();
    if (this.busy) throw new Error('Wait for the current surface operation.');
    if (++this.count > this.limit) throw new Error('Surface limit reached: 30 operations per run.');
    this.busy = true;
    const timer = setTimeout(() => this.close(), 90_000);
    try {
      const value = await work(); this.check();
      this.onEvent({ kind, target: digest(target), status: 'passed' });
      return value;
    } catch (error) {
      this.onEvent({ kind, target: digest(target), status: this.signal.aborted ? 'cancelled' : 'failed' });
      throw error;
    } finally { clearTimeout(timer); this.busy = false; }
  }
  close() { this.controller.abort(new Error('Browser and computer access stopped.')); }
}

module.exports = { SurfaceAccess };

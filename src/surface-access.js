const { digest } = require('./permissions');
const { reason } = require('./policy');

// Deny wins, then a rule that requires a prompt. Allow comes only from the detailed subject when there is one.
function combine(broad, detailed) {
  if (!detailed) return broad;
  for (const decision of ['deny', 'ask']) {
    const match = [broad, detailed].find(verdict => verdict.decision === decision && verdict.source !== 'default');
    if (match) return match;
  }
  return detailed;
}

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
  // `subject` is the rule subject for an allow. Deny and ask rules also match the broad target, so a deny rule for
  // an app still applies when a detailed subject is used, while an allow rule must name the detailed subject.
  async approve(tool, effect, target, args, scope, detail, subject, requestSignal = this.signal) {
    await this.permissions.refreshPolicy?.();
    requestSignal.throwIfAborted();
    this.check();
    const action = this.permissions.action(tool, effect, target, args, scope);
    const broad = typeof target === 'string' ? target : target?.bundleId ?? JSON.stringify(target);
    const verdict = combine(this.permissions.decide(effect, broad), subject === undefined ? undefined : this.permissions.decide(effect, subject));
    if (verdict.decision === 'deny') {
      this.permissions.record(action, 'deny', reason(verdict));
      throw new Error('A permission rule denies this action.');
    }
    if (verdict.decision === 'allow') {
      if (!this.permissions.grant(action, undefined, reason(verdict))) throw new Error('Surface approval no longer matches.');
      return action;
    }
    const signal = AbortSignal.any([this.signal, requestSignal, this.permissions.revocation.signal, AbortSignal.timeout(60_000)]);
    let stop;
    const cancelled = new Promise(resolve => {
      stop = () => resolve(false); signal.addEventListener('abort', stop, { once: true });
    });
    const answer = await Promise.race([Promise.resolve().then(() => signal.aborted ? false : this.ask(detail, signal)), cancelled])
      .finally(() => signal.removeEventListener('abort', stop));
    if (answer && !signal.aborted) await this.permissions.refreshPolicy?.();
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

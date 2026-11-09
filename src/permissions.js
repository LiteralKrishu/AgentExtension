const { createHash, randomUUID } = require('node:crypto');

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
const digest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

// Host-owned grants never enter model messages or restored conversation history.
class PermissionBroker {
  constructor({ workspace, signal, onChange = () => {}, audit = () => {}, now = Date.now }) {
    if (!workspace) throw new Error('A canonical workspace identity is required.');
    this.workspace = workspace;
    this.runId = randomUUID();
    this.signal = signal;
    this.onChange = onChange;
    this.audit = audit;
    this.now = now;
    this.epoch = 0;
    this.grants = new Map();
    this.denied = new Set();
    this.events = [];
    this.closed = false;
    signal?.addEventListener('abort', () => this.revokeAll('cancelled'), { once: true });
  }

  action(tool, effect, target, args = {}, scope = {}) {
    return Object.freeze({ workspace: this.workspace, runId: this.runId, policy: 1, epoch: this.epoch,
      tool, effect, target, arguments: digest(args), scope: digest(scope) });
  }

  record(action, decision, reason) {
    // Hash targets. Do not log text, command arguments, tokens, or service payloads.
    const event = { time: new Date(this.now()).toISOString(), tool: action.tool, effect: action.effect,
      target: digest(action.target), decision, reason, runId: this.runId };
    this.events.push(event);
    this.events = this.events.slice(-80);
    this.audit(event);
    this.onChange(this.snapshot());
  }

  valid(action) {
    return !this.closed && !this.signal?.aborted && action.workspace === this.workspace
      && action.runId === this.runId && action.policy === 1 && action.epoch === this.epoch
      && !this.denied.has(action.effect) && !this.denied.has(action.tool);
  }

  allowScope(effect) {
    if (this.closed || this.signal?.aborted || this.denied.has(effect)) throw new Error('Permission scope is closed.');
    this.grants.set(`scope:${effect}`, { effect, expires: this.now() + 24 * 60 * 60 * 1000 });
    this.onChange(this.snapshot());
  }

  grant(action, ttl = 5 * 60 * 1000) {
    if (!this.valid(action)) {
      this.record(action, 'deny', 'Approval scope changed or was revoked');
      return false;
    }
    const key = digest(action);
    const prior = this.grants.get(key);
    this.grants.set(key, { effect: action.effect, count: (prior?.count ?? 0) + 1, expires: this.now() + ttl });
    this.record(action, 'approve', 'One exact action');
    return true;
  }

  require(action) {
    const key = digest(action);
    const exact = this.grants.get(key);
    const scope = this.grants.get(`scope:${action.effect}`);
    const grant = exact?.expires > this.now() ? exact : scope?.expires > this.now() ? scope : undefined;
    if (!this.valid(action) || !grant) {
      this.record(action, 'deny', 'No current matching permission');
      throw new Error('Permission denied. Start a new run or approve this exact action in the editor.');
    }
    if (grant === exact && --exact.count === 0) this.grants.delete(key);
    this.record(action, 'allow', grant === exact ? 'Consumed exact approval' : 'Workspace run scope');
  }

  reset() {
    this.epoch++;
    for (const key of this.grants.keys()) if (!key.startsWith('scope:')) this.grants.delete(key);
    this.onChange(this.snapshot());
  }

  deny(effect) {
    this.denied.add(effect);
    this.reset();
  }

  revokeAll(reason = 'revoked') {
    this.closed = true;
    this.grants.clear();
    this.epoch++;
    this.record({ tool: 'host', effect: 'all', target: this.workspace }, 'revoke', reason);
  }

  snapshot() {
    return { runId: this.runId, workspace: this.workspace, closed: this.closed,
      scopes: [...this.grants.entries()].filter(([key, value]) => key.startsWith('scope:') && value.expires > this.now())
        .map(([, value]) => value.effect), pending: [...this.grants.keys()].filter(key => !key.startsWith('scope:')).length,
      events: this.events };
  }
}

module.exports = { PermissionBroker, digest };

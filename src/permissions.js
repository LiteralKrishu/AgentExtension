// @ts-check
const { createHash, randomUUID } = require('node:crypto');

/** @typedef {{ tool: string, effect: string, target: string }} ActionTarget */
/** @typedef {Readonly<ActionTarget & { workspace: string, runId: string, policy: 1, epoch: number, arguments: string, scope: string }>} Action */
/** @typedef {{ effect: string, expires: number }} Grant */
/** @typedef {'allow' | 'approve' | 'deny' | 'revoke' | 'skip' | 'answer'} AuditDecision */
/** @typedef {ActionTarget & { time: string, decision: AuditDecision, reason: string, runId: string }} PermissionEvent */
/** @typedef {{ runId: string, workspace: string, closed: boolean, scopes: string[], pending: number, events: PermissionEvent[] }} PermissionSnapshot */

/** @param {unknown} value @returns {unknown} */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const record = /** @type {Record<string, unknown>} */ (value);
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, stable(record[key])]));
  }
  return value;
}
/** @param {unknown} value */
const digest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

// Host-owned grants never enter model messages or restored conversation history.
class PermissionBroker {
  /** @param {{ workspace: string, signal?: AbortSignal, onChange?: (snapshot: PermissionSnapshot) => void,
   * audit?: (event: PermissionEvent) => void, now?: () => number, policy?: import('./policy').PolicyEngine }} options */
  constructor({ workspace, signal, onChange = () => {}, audit = () => {}, now = Date.now, policy }) {
    if (!workspace) throw new Error('A canonical workspace identity is required.');
    this.workspace = workspace;
    this.runId = randomUUID();
    this.signal = signal;
    this.onChange = onChange;
    this.audit = audit;
    this.now = now;
    this.policy = policy;
    this.epoch = 0;
    /** @type {Map<string, Grant & { count?: number }>} */
    this.grants = new Map();
    /** @type {Set<string>} */
    this.denied = new Set();
    /** @type {PermissionEvent[]} */
    this.events = [];
    this.closed = false;
    signal?.addEventListener('abort', () => this.revokeAll('cancelled'), { once: true });
  }

  /** @param {string} tool @param {string} effect @param {string} target
   * @param {unknown} [args] @param {unknown} [scope] @returns {Action} */
  action(tool, effect, target, args = {}, scope = {}) {
    return Object.freeze({ workspace: this.workspace, runId: this.runId, policy: 1, epoch: this.epoch,
      tool, effect, target, arguments: digest(args), scope: digest(scope) });
  }

  /** @param {ActionTarget} action @param {AuditDecision} decision @param {string} reason */
  record(action, decision, reason) {
    // Hash targets. Do not log text, command arguments, tokens, or service payloads.
    const event = { time: new Date(this.now()).toISOString(), tool: action.tool, effect: action.effect,
      target: digest(action.target), decision, reason, runId: this.runId };
    this.events.push(event);
    this.events = this.events.slice(-80);
    this.audit(event);
    this.onChange(this.snapshot());
  }

  /** @param {Action} action */
  valid(action) {
    return !this.closed && !this.signal?.aborted && action.workspace === this.workspace
      && action.runId === this.runId && action.policy === 1 && action.epoch === this.epoch
      && !this.denied.has(action.effect) && !this.denied.has(action.tool);
  }

  // Returns false when a permission rule turns the capability off for every target.
  /** @param {string} effect */
  allowScope(effect) {
    if (this.closed || this.signal?.aborted || this.denied.has(effect)) throw new Error('Permission scope is closed.');
    const blocked = this.policy?.blocks(effect);
    if (blocked) {
      this.denied.add(effect);
      this.record({ tool: 'host', effect, target: this.workspace }, 'deny', `Denied by ${blocked.source} rule ${blocked.effect} ${blocked.target}`);
      return false;
    }
    this.grants.set(`scope:${effect}`, { effect, expires: this.now() + 24 * 60 * 60 * 1000 });
    this.onChange(this.snapshot());
    return true;
  }

  /** @param {string} effect @param {unknown} [subject] @returns {import('./policy').Verdict} */
  decide(effect, subject) {
    return this.policy?.decide(effect, subject) ?? { decision: 'ask', source: 'default' };
  }

  /** @param {Action} action */
  grant(action, ttl = 5 * 60 * 1000, reason = 'One exact action') {
    if (!this.valid(action)) {
      this.record(action, 'deny', 'Approval scope changed or was revoked');
      return false;
    }
    const key = digest(action);
    const prior = this.grants.get(key);
    this.grants.set(key, { effect: action.effect, count: (prior?.count ?? 0) + 1, expires: this.now() + ttl });
    this.record(action, 'approve', reason);
    return true;
  }

  /** @param {Action} action */
  require(action) {
    const key = digest(action);
    const exact = this.grants.get(key);
    const scope = this.grants.get(`scope:${action.effect}`);
    const grant = exact && exact.expires > this.now() ? exact : scope && scope.expires > this.now() ? scope : undefined;
    if (!this.valid(action) || !grant) {
      this.record(action, 'deny', 'No current matching permission');
      throw new Error('Permission denied. Start a new run or approve this exact action in the editor.');
    }
    if (grant === exact && exact.count !== undefined && --exact.count === 0) this.grants.delete(key);
    this.record(action, 'allow', grant === exact ? 'Consumed exact approval' : 'Workspace run scope');
  }

  reset() {
    this.epoch++;
    for (const key of this.grants.keys()) if (!key.startsWith('scope:')) this.grants.delete(key);
    this.onChange(this.snapshot());
  }

  /** @param {string} effect */
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

  /** @returns {PermissionSnapshot} */
  snapshot() {
    return { runId: this.runId, workspace: this.workspace, closed: this.closed,
      scopes: [...this.grants.entries()].filter(([key, value]) => key.startsWith('scope:') && value.expires > this.now())
        .map(([, value]) => value.effect), pending: [...this.grants.keys()].filter(key => !key.startsWith('scope:')).length,
      events: this.events };
  }
}

module.exports = { PermissionBroker, digest };

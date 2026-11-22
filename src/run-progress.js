const { digest } = require('./permissions');
const { performance } = require('node:perf_hooks');

function failureCategory(error) {
  const text = String(error?.message ?? error);
  if (/changed (?:since|while)|stale|current receipt|anchor|exactly once|read excerpt/i.test(text)) return 'edit-conflict';
  if (/schema|invalid (?:input|argument)|expected .*received|JSON.*pars/i.test(text)) return 'model-tool-format';
  if (/not been approved|needs?.*review|not.*reviewed/i.test(text)) return 'missing-review';
  if (/ECONN|socket|fetch failed|endpoint|transport|stream without/i.test(text)) return 'runtime-transport';
  if (/ENOENT|not found|snapshot|too large|bubblewrap|sandbox-exec|not permitted/i.test(text)) return 'environment-failure';
  return 'unknown';
}

// Only host-observed metadata enters this trace. Arguments and source text do not.
class RunProgress {
  constructor({ now = () => performance.now(), limit = 160 } = {}) {
    this.now = now; this.limit = limit; this.started = now(); this.lastProgress = this.started;
    this.startedAt = Date.now();
    this.events = []; this.active = new Map(); this.waiting = new Set();
    this.waitMs = 0; this.waitStarted = undefined; this.next = 0; this.revision = 0;
    this.state = 'working'; this.repeated = 0; this.rejected = 0; this.retries = 0;
    this.modelToolCalls = 0; this.lastCheck = undefined;
    this.reads = new Map();
  }
  record(type, fields = {}) {
    const event = { atMs: Math.max(0, this.now() - this.started), type };
    for (const key of ['tool', 'requestKey', 'ok', 'revision', 'durationMs', 'category']) {
      if (fields[key] !== undefined) event[key] = fields[key];
    }
    this.events.push(event);
    this.events = this.events.slice(-this.limit);
  }
  tool(name, args = {}) {
    const started = this.now();
    const requestKey = digest([name, args, this.revision]);
    const id = ++this.next;
    this.active.set(id, name);
    this.state = name === 'run_command' ? 'checking' : /propose|create_file|merge_worker/.test(name) ? 'editing' : 'searching';
    this.record('tool-start', { tool: name, requestKey });
    return (ok, revision = this.revision) => {
      if (!this.active.delete(id)) return;
      this.record('tool-end', { tool: name, requestKey, ok, revision, durationMs: Math.max(0, this.now() - started) });
      if (!ok) this.rejected++;
      if (revision !== this.revision) { this.revision = revision; this.reads.clear(); this.lastProgress = this.now(); }
      if (ok && ['read_file', 'read_files', 'search_workspace'].includes(name)) {
        const count = (this.reads.get(requestKey) ?? 0) + 1;
        this.reads.set(requestKey, count);
        if (this.reads.size > this.limit) this.reads.delete(this.reads.keys().next().value);
        if (count >= 3) this.repeated++;
        if (count === 1) this.lastProgress = this.now();
      } else if (ok) this.lastProgress = this.now();
      if (!this.active.size) this.state = 'working';
    };
  }
  async waitFor(category, action) {
    const id = ++this.next;
    if (!this.waiting.size) this.waitStarted = this.now();
    this.waiting.add(id);
    this.record('wait-start', { category });
    try { return await action(); }
    finally {
      this.waiting.delete(id);
      if (!this.waiting.size) { this.waitMs += this.now() - this.waitStarted; this.waitStarted = undefined; }
      this.record('wait-end', { category });
    }
  }
  modelTool(argumentsText) {
    this.modelToolCalls++;
    this.record('model-tool-request', { requestKey: digest(argumentsText) });
  }
  check(ok, revision, executionError = false, diagnostic = false) {
    this.lastCheck = diagnostic ? 'check-diagnostic-only' : executionError ? 'check-could-not-run' : ok ? 'check-passed' : 'check-failed';
    this.record('check', { ok, revision, category: this.lastCheck });
    if (ok && !diagnostic) this.lastProgress = this.now();
  }
  retry() { this.retries++; this.record('retry'); }
  draft(revision, hasChanges) {
    if (!hasChanges) return;
    this.firstDraftMs ??= Math.max(0,this.now()-this.started);
    this.record('draft-staged',{revision});
  }
  failure(error) { this.record('failure', { category: failureCategory(error) }); }
  finish(outcome) {
    this.finished ??= this.now();
    this.outcome = outcome;
  }
  snapshot() {
    const end = this.finished ?? this.now();
    const waitingMs = this.waitMs + (this.waiting.size ? end - this.waitStarted : 0);
    return { state: this.waiting.size ? 'waiting-for-user' : this.state, outcome: this.outcome,
      startedAt: this.startedAt, firstDraftMs: this.firstDraftMs,
      elapsedMs: Math.max(0, end - this.started), waitingMs: Math.max(0, waitingMs),
      activeMs: Math.max(0, end - this.started - waitingMs), sinceProgressMs: Math.max(0, end - this.lastProgress),
      activeTools: this.active.size, repeatedReads: this.repeated, rejectedTools: this.rejected, retries: this.retries,
      modelToolCalls: this.modelToolCalls, lastCheck: this.lastCheck,
      diagnosis: this.waiting.size ? 'waiting-for-user' : this.repeated ? 'repeated-read-inputs'
        : this.rejected ? 'tool-rejections' : this.lastCheck ?? 'unknown',
      events: this.events.map(event => ({ ...event })) };
  }
}
module.exports = { RunProgress, failureCategory };

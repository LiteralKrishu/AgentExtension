// Tracks model tokens, tool calls and time for one run, across the parent agent and its workers.
// A limit of 0 means no limit. Reaching a limit stops new tool calls except review_changes, so the user can still
// review staged work. At 125% of the token or time limit the run is cancelled.
const FINISH_TOOLS = new Set(['review_changes']);

class RunUsage {
  constructor({ maxTokens = 0, maxMinutes = 0, maxToolCalls = 0 } = {}, now = Date.now) {
    this.limits = { maxTokens, maxMinutes, maxToolCalls };
    this.now = now;
    this.started = now();
    this.tokens = { input: 0, output: 0, cacheRead: 0 };
    this.actors = {};
    this.toolCalls = 0;
    this.modelCalls = 0;
    this.breakdown = undefined;
    this.compactions = [];
    this.cost = { usd: null, unreportedTurns: 0 };
  }
  get total() { return this.tokens.input + this.tokens.output; }
  elapsedMs() { return this.now() - this.started; }
  model(usage, actor = 'parent', continuation = false) {
    if (!usage) return;
    const input = Number(usage.inputTokens) || 0;
    const output = Number(usage.outputTokens) || 0;
    this.tokens.input += input;
    this.tokens.output += output;
    this.tokens.cacheRead += Number(usage.cacheReadTokens) || 0;
    if (!continuation) this.modelCalls++;
    const row = this.actors[actor] ??= { input: 0, output: 0, calls: 0 };
    row.input += input; row.output += output; if (!continuation) row.calls++;
    // TrueForge attributes each parent input to harness, instructions, messages, skills and tool definitions.
    if (actor === 'parent' && usage.inputTokensBreakdown) this.breakdown = { ...usage.inputTokensBreakdown };
  }
  compaction(event) {
    this.compactions.push({ at: event.createdAt, threadId: event.threadId, trigger: event.trigger?.type ?? 'unknown', durationMs: event.durationMs,
      contextTokens: event.trigger?.contextTokens, thresholdTokens: event.trigger?.thresholdTokens,
      inputTokens: event.usage?.inputTokens ?? 0, outputTokens: event.usage?.outputTokens ?? 0 });
    this.model(event.usage, 'compaction');
  }
  turnCost(metrics) {
    // TrueForge turn totals include the cost of compaction. Extension workers run separate turns.
    const usd = metrics?.totalCostInUsd;
    if (!Number.isFinite(usd) || usd < 0) this.cost.unreportedTurns++;
    else this.cost.usd = (this.cost.usd ?? 0) + usd;
  }
  exceeded() {
    const { maxTokens, maxMinutes, maxToolCalls } = this.limits;
    if (maxTokens && this.total >= maxTokens) return `token limit of ${maxTokens.toLocaleString('en-US')}`;
    if (maxToolCalls && this.toolCalls >= maxToolCalls) return `tool-call limit of ${maxToolCalls}`;
    if (maxMinutes && this.elapsedMs() >= maxMinutes * 60_000) return `time limit of ${maxMinutes} minutes`;
    return '';
  }
  hardStop() {
    const { maxTokens, maxMinutes } = this.limits;
    if (maxTokens && this.total >= maxTokens * 1.25) return `Run budget exceeded: ${this.total.toLocaleString('en-US')} tokens.`;
    if (maxMinutes && this.elapsedMs() >= maxMinutes * 75_000) return `Run budget exceeded: ${Math.round(this.elapsedMs() / 60_000)} minutes.`;
    return '';
  }
  notice() {
    const { maxTokens, maxMinutes, maxToolCalls } = this.limits;
    const fraction = Math.max(maxTokens ? this.total / maxTokens : 0,
      maxMinutes ? this.elapsedMs() / (maxMinutes * 60_000) : 0,
      maxToolCalls ? this.toolCalls / maxToolCalls : 0);
    const stage = fraction >= 1 ? 4 : fraction >= .9 ? 3 : fraction >= .75 ? 2 : fraction >= .5 ? 1 : 0;
    if (!stage || stage <= (this.lastNotice ?? 0)) return undefined;
    this.lastNotice = stage;
    return { stage: stage === 4 ? 'review-only' : stage >= 2 ? 'finish-soon' : 'half-used',
      remainingTokens: maxTokens ? Math.max(0, maxTokens - this.total) : null,
      remainingToolCalls: maxToolCalls ? Math.max(0, maxToolCalls - this.toolCalls) : null,
      remainingSeconds: maxMinutes ? Math.max(0, Math.floor(maxMinutes * 60 - this.elapsedMs() / 1000)) : null,
      note: stage === 4 ? 'The host budget is reached. Only review_changes can proceed. Finish with an accurate account of missing work.'
        : 'Use the remaining budget to finish the requested changes, run required checks, and request review. Keep edits small. Do not claim an omitted check passed.' };
  }
  // Called before each editor tool. Throws once a limit is reached, except for the tool that hands work to review.
  tool(name) {
    const reached = this.exceeded();
    if (reached && !FINISH_TOOLS.has(name)) throw new Error(`Run budget reached: ${reached}. Call review_changes for staged work, or finish with a summary.`);
    this.toolCalls++;
  }
  snapshot() {
    return { limits: this.limits, tokens: { ...this.tokens, total: this.total }, actors: structuredClone(this.actors), toolCalls: this.toolCalls,
      modelCalls: this.modelCalls, elapsedSeconds: Math.round(this.elapsedMs() / 1000), breakdown: this.breakdown, compactions: [...this.compactions],
      cost: { ...this.cost }, reached: this.exceeded() };
  }
}

function usageSummary(snapshot) {
  if (!snapshot) return '';
  const { tokens, limits, toolCalls, elapsedSeconds, compactions } = snapshot;
  const of = (value, limit) => limit ? `${value.toLocaleString('en-US')} / ${limit.toLocaleString('en-US')}` : value.toLocaleString('en-US');
  const time = seconds => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return `${of(tokens.total, limits.maxTokens)} tokens · ${of(toolCalls, limits.maxToolCalls)} tool calls · ${time(elapsedSeconds)}${limits.maxMinutes ? ` / ${time(limits.maxMinutes * 60)}` : ''}`
    + (compactions.length ? ` · ${compactions.length} compaction${compactions.length === 1 ? '' : 's'}` : '')
    + (snapshot.reached ? ` · limit reached: ${snapshot.reached}` : '');
}

function costSummary(cost) {
  if (!Number.isFinite(cost?.usd)) return 'Unreported';
  const amount = cost.usd > 0 && cost.usd < 0.00000001 ? '<0.00000001'
    : cost.usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 });
  return `USD ${amount}${cost.unreportedTurns ? ' (some turns unreported)' : ''}`;
}

module.exports = { RunUsage, usageSummary, costSummary };

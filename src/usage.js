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
  }
  get total() { return this.tokens.input + this.tokens.output; }
  elapsedMs() { return this.now() - this.started; }
  model(usage, actor = 'parent') {
    if (!usage) return;
    const input = Number(usage.inputTokens) || 0;
    const output = Number(usage.outputTokens) || 0;
    this.tokens.input += input;
    this.tokens.output += output;
    this.tokens.cacheRead += Number(usage.cacheReadTokens) || 0;
    this.modelCalls++;
    const row = this.actors[actor] ??= { input: 0, output: 0, calls: 0 };
    row.input += input; row.output += output; row.calls++;
    // TrueForge attributes each parent input to harness, instructions, messages, skills and tool definitions.
    if (actor === 'parent' && usage.inputTokensBreakdown) this.breakdown = { ...usage.inputTokensBreakdown };
  }
  compaction(event) {
    this.compactions.push({ at: event.createdAt, trigger: event.trigger?.type ?? 'unknown', durationMs: event.durationMs,
      inputTokens: event.usage?.inputTokens ?? 0, outputTokens: event.usage?.outputTokens ?? 0 });
    this.model(event.usage, 'compaction');
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
  // Called before each editor tool. Throws once a limit is reached, except for the tool that hands work to review.
  tool(name) {
    const reached = this.exceeded();
    if (reached && !FINISH_TOOLS.has(name)) throw new Error(`Run budget reached: ${reached}. Call review_changes for staged work, or finish with a summary.`);
    this.toolCalls++;
  }
  snapshot() {
    return { limits: this.limits, tokens: { ...this.tokens, total: this.total }, actors: structuredClone(this.actors), toolCalls: this.toolCalls,
      modelCalls: this.modelCalls, elapsedSeconds: Math.round(this.elapsedMs() / 1000), breakdown: this.breakdown, compactions: [...this.compactions],
      reached: this.exceeded() };
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

module.exports = { RunUsage, usageSummary };

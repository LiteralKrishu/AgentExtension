const { safePath } = require('./workspace');

const PREFIX = 4_000;
const SUFFIX = 1_500;
const MAX_INSERT = 1_000;
const LATENCY_SAMPLES = 1_000;

const clean = reply => String(reply ?? '').replace(/^```[\w+-]*\n?/, '').replace(/\n?```\s*$/, '').slice(0, MAX_INSERT);

// Opt-in inline suggestions: one tool-free model turn per request, built only from the current document.
// A result is shown only if the document is unchanged, and VS Code inserts it only when the user accepts it.
function createInlineCompletions({ vscode, options, settings, run, debounceMs = 350, now = Date.now }) {
  const stats = { requests: 0, shown: 0, accepted: 0, cancelled: 0, stale: 0, failed: 0, latencies: [] };
  const recent = [];
  const provider = {
    async provideInlineCompletionItems(document, position, context, token) {
      const enabled = options(document);
      if (!enabled) return;
      if (enabled.mode !== 'automatic' && context.triggerKind !== vscode.InlineCompletionTriggerKind.Invoke) return;
      // Never send private workspace files such as dotenv files or keys.
      try { safePath(vscode.workspace.asRelativePath(document.uri, false)); } catch { return; }
      await new Promise(resolve => setTimeout(resolve, debounceMs));
      if (token.isCancellationRequested) { stats.cancelled++; return; }
      while (recent.length && recent[0] <= now() - 3_600_000) recent.shift();
      if (recent.length >= enabled.maxRequestsPerHour) return;
      recent.push(now());
      stats.requests++;
      const version = document.version;
      const text = document.getText();
      const offset = document.offsetAt(position);
      const task = { language: document.languageId, prefix: text.slice(Math.max(0, offset - PREFIX), offset), suffix: text.slice(offset, offset + SUFFIX) };
      const controller = new AbortController();
      const listener = token.onCancellationRequested(() => controller.abort());
      const started = now();
      try {
        const insert = clean(await run(await settings(controller.signal), task, controller.signal));
        if (token.isCancellationRequested) { stats.cancelled++; return; }
        if (document.version !== version) { stats.stale++; return; }
        if (!insert.trim()) return;
        stats.shown++;
        stats.latencies.push(now() - started);
        if (stats.latencies.length > LATENCY_SAMPLES) stats.latencies.shift();
        return [new vscode.InlineCompletionItem(insert, new vscode.Range(position, position),
          { command: 'agentextension.inlineSuggestionAccepted', title: 'Inline suggestion accepted' })];
      } catch {
        if (controller.signal.aborted) stats.cancelled++; else stats.failed++;
      } finally {
        listener.dispose();
      }
    },
  };
  return { provider, stats, accepted: () => { stats.accepted++; } };
}

function summarize(stats) {
  const sorted = [...stats.latencies].sort((a, b) => a - b);
  const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] : null;
  return `Inline suggestions this window: ${stats.requests} requests, ${stats.shown} shown, ${stats.accepted} accepted, ` +
    `${stats.cancelled} cancelled, ${stats.stale} stale, ${stats.failed} failed. ` +
    (p95 === null ? 'No latency samples yet.' : `p95 latency ${Math.round(p95)} ms over ${sorted.length} samples.`);
}

module.exports = { createInlineCompletions, summarize, clean };

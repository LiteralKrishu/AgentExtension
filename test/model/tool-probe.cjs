// Synthetic diagnostics only. Returned tool calls are never executed.
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { requireLocalEndpoint } = require('./local-only.cjs');

const cases = [
  { name: 'single-line', text: 'return left + right;' },
  { name: 'multiline', text: 'def example():\n    value = "quoted"\n    return value\n' },
  { name: 'literal-escapes', text: 'const pattern = "\\\\n";\n\t// café: preserve tabs, quotes, and literal backslashes\n' },
];

async function completion(response, stream, { maxBytes = 2_000_000 } = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0, pending = '', raw = '', done = false, usage;
  const calls = new Map();
  function event(line) {
    if (!line.startsWith('data:')) return;
    const text = line.slice(5).trim();
    if (text === '[DONE]') { done = true; return; }
    const value = JSON.parse(text);
    if (value.error) throw new Error('The local endpoint returned a stream error.');
    usage = value.usage ?? usage;
    for (const item of value.choices?.[0]?.delta?.tool_calls ?? []) {
      if (!Number.isInteger(item.index) || item.index < 0 || item.index > 7) throw new Error('Invalid tool-call index.');
      const call = calls.get(item.index) ?? { function: { name: '', arguments: '' } };
      call.function.name += item.function?.name ?? '';
      call.function.arguments += item.function?.arguments ?? '';
      calls.set(item.index, call);
    }
  }
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new Error('Local probe response exceeded its byte limit.');
      const text = decoder.decode(next.value, { stream: true });
      if (!stream) { raw += text; continue; }
      pending += text;
      const lines = pending.split(/\r?\n/); pending = lines.pop();
      for (const line of lines) event(line);
    }
    if (!stream) {
      const result = JSON.parse(raw + decoder.decode());
      return { calls: result.choices?.[0]?.message?.tool_calls ?? [], usage: result.usage };
    }
    pending += decoder.decode(); if (pending.trim()) event(pending);
    if (!done) throw new Error('The local probe stream ended without DONE.');
    return { calls: [...calls.values()], usage };
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function evaluateCalls(calls, expected) {
  if (calls.length !== 1 || calls[0].function?.name !== 'capture_code') return { ok: false, category: 'missing-or-unexpected-tool' };
  let args;
  try { args = JSON.parse(calls[0].function.arguments); }
  catch { return { ok: false, category: 'invalid-argument-json' }; }
  if (args?.text === expected) return { ok: true, category: 'exact-round-trip' };
  // Diagnose one additional escaping layer. Never repair or execute the output.
  if (typeof args?.text === 'string') {
    try { if (JSON.parse('"' + args.text + '"') === expected) return { ok: false, category: 'extra-string-escaping' }; } catch {}
  }
  return { ok: false, category: 'changed-text' };
}

async function runProbe({ endpoint, model, directory }) {
  const url = requireLocalEndpoint(endpoint);
  if (url.search || url.hash || !model) throw new Error('Supply a local chat-completions endpoint and model ID.');
  const results = [];
  for (const item of cases) for (const stream of [false, true]) {
    const started = performance.now();
    let result;
    try {
      const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(90_000),
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, stream, max_tokens: 512,
          messages: [{ role: 'user', content: 'Call capture_code exactly once. Copy the code between the markers byte for byte. Keep actual line endings, indentation, quotes, and literal backslashes. Do not add markers.\nBEGIN_CODE\n' + item.text + '\nEND_CODE' }],
          tools: [{ type: 'function', function: { name: 'capture_code', description: 'Capture synthetic source text without executing it.',
            parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } } }],
          tool_choice: 'required',
        }) });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Local endpoint returned HTTP ${response.status}.`); }
      const received = await completion(response, stream);
      result = { ...evaluateCalls(received.calls, item.text), usage: received.usage, calls: received.calls };
    } catch (error) { result = { ok: false, category: 'endpoint-or-protocol-error', error: error.message }; }
    results.push({ name: item.name, stream, ms: performance.now() - started, ...result });
    console.log(`${item.name} ${stream ? 'streamed' : 'buffered'}: ${result.category}`);
  }
  const report = { version: 1, recordedAt: new Date().toISOString(), endpoint: url.href, model, apiSpend: 0,
    settings: { toolChoice: 'required', maxOutputTokens: 512, temperature: 'provider default', timeoutMs: 90000 },
    scope: 'Synthetic tool-text diagnostics. No returned function is executed. Not task qualification.', results };
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'tool-probe.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  return report;
}

if (require.main === module) runProbe({ endpoint: process.env.AGENTEXTENSION_TEST_CHAT_ENDPOINT,
  model: process.env.AGENTEXTENSION_TEST_MODEL_ID,
  directory: process.env.AGENTEXTENSION_TEST_RESULTS_DIR ?? path.join(__dirname, '../../test-results/tool-probe'),
}).then(report => { if (report.results.some(result => !result.ok)) process.exitCode = 1; }).catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { cases, completion, evaluateCalls, runProbe };

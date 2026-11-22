const test = require('node:test');
const assert = require('node:assert/strict');
const { createInlineCompletions, summarize, clean } = require('../src/inline-completion');

const vscode = {
  InlineCompletionTriggerKind: { Invoke: 0, Automatic: 1 },
  InlineCompletionItem: class { constructor(insertText, range, command) { Object.assign(this, { insertText, range, command }); } },
  Range: class { constructor(start, end) { Object.assign(this, { start, end }); } },
  workspace: { asRelativePath: uri => uri.path },
};
function documentAt(text, file = 'src/app.js') {
  return { uri: { path: file }, version: 1, languageId: 'javascript', getText: () => text, offsetAt: position => position.offset };
}
const token = (cancelled = false) => { const listeners = []; return { isCancellationRequested: cancelled, listeners,
  onCancellationRequested: fn => { listeners.push(fn); return { dispose() {} }; } }; };
const invoke = { triggerKind: 0 };
function setup({ reply = 'b + 1;', options = { mode: 'manual', maxRequestsPerHour: 120 }, run } = {}) {
  const calls = [];
  const inline = createInlineCompletions({ vscode, debounceMs: 0, options: () => options, settings: async () => ({ model: 'm' }),
    run: run ?? (async (settings, task) => { calls.push(task); return reply; }) });
  return { inline, calls };
}

test('a suggestion uses only the bounded current document and is offered for explicit acceptance', async () => {
  const { inline, calls } = setup();
  const text = 'x'.repeat(5_000) + 'const a = ' + 'y'.repeat(2_000);
  const items = await inline.provider.provideInlineCompletionItems(documentAt(text), { offset: 5_010 }, invoke, token());
  assert.equal(items.length, 1);
  assert.equal(items[0].insertText, 'b + 1;');
  assert.deepEqual([items[0].range.start, items[0].range.end], [{ offset: 5_010 }, { offset: 5_010 }]);
  assert.equal(items[0].command.command, 'agentextension.inlineSuggestionAccepted');
  assert.equal(calls[0].prefix.length, 4_000);
  assert.equal(calls[0].suffix.length, 1_500);
  assert.ok(calls[0].prefix.endsWith('const a = '));
});

test('a result for a changed document is dropped as stale', async () => {
  const document = documentAt('const a = ');
  const { inline } = setup({ run: async () => { document.version = 2; return 'b;'; } });
  assert.equal(await inline.provider.provideInlineCompletionItems(document, { offset: 10 }, invoke, token()), undefined);
  assert.equal(inline.stats.stale, 1);
});

test('cancellation stops the request and aborts the model turn', async () => {
  let signal;
  const cancel = token();
  const { inline } = setup({ run: async (_settings, _task, s) => { signal = s; cancel.listeners.forEach(fn => fn()); cancel.isCancellationRequested = true; return 'late'; } });
  assert.equal(await inline.provider.provideInlineCompletionItems(documentAt('a'), { offset: 1 }, invoke, cancel), undefined);
  assert.equal(signal.aborted, true);
  assert.equal(inline.stats.cancelled, 1);
  const before = setup();
  assert.equal(await before.inline.provider.provideInlineCompletionItems(documentAt('a'), { offset: 1 }, invoke, token(true)), undefined);
  assert.equal(before.calls.length, 0, 'a request cancelled during debounce never reaches the model');
});

test('disabled, manual-mode typing, private files, and an exhausted budget send nothing', async () => {
  const off = setup({ options: null });
  assert.equal(await off.inline.provider.provideInlineCompletionItems(documentAt('a'), { offset: 1 }, invoke, token()), undefined);
  const manual = setup();
  assert.equal(await manual.inline.provider.provideInlineCompletionItems(documentAt('a'), { offset: 1 }, { triggerKind: 1 }, token()), undefined);
  for (const file of ['.env', 'config/secrets.json', 'keys/server.pem']) {
    assert.equal(await manual.inline.provider.provideInlineCompletionItems(documentAt('a', file), { offset: 1 }, invoke, token()), undefined, file);
  }
  assert.equal(off.calls.length + manual.calls.length, 0);
  const capped = setup({ options: { mode: 'automatic', maxRequestsPerHour: 2 } });
  for (let i = 0; i < 3; i++) await capped.inline.provider.provideInlineCompletionItems(documentAt('a'), { offset: 1 }, { triggerKind: 1 }, token());
  assert.equal(capped.calls.length, 2);
});

test('model failures show nothing, replies are cleaned and bounded, and statistics summarize latency', async () => {
  const failing = setup({ run: async () => { throw new Error('down'); } });
  assert.equal(await failing.inline.provider.provideInlineCompletionItems(documentAt('a'), { offset: 1 }, invoke, token()), undefined);
  assert.equal(failing.inline.stats.failed, 1);
  assert.equal(clean('```js\nreturn 1;\n```'), 'return 1;');
  assert.equal(clean('x'.repeat(5_000)).length, 1_000);
  const { inline } = setup();
  await inline.provider.provideInlineCompletionItems(documentAt('a'), { offset: 1 }, invoke, token());
  inline.accepted();
  assert.match(summarize(inline.stats), /1 requests, 1 shown, 1 accepted.*p95 latency \d+ ms over 1 samples/);
});

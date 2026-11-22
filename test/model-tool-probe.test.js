const assert = require('node:assert/strict');
const { test } = require('node:test');
const { cases, completion, evaluateCalls, runProbe } = require('./model/tool-probe.cjs');

test('tool-text diagnostics reject extra escaping without silently decoding source', () => {
  for (const { text } of cases) {
    const call = value => [{ function: { name: 'capture_code', arguments: JSON.stringify({ text: value }) } }];
    assert.equal(evaluateCalls(call(text), text).ok, true);
    assert.equal(evaluateCalls([], text).ok, false);
    assert.equal(evaluateCalls(call('changed'), text).category, 'changed-text');
    const encoded = JSON.stringify(text).slice(1, -1);
    if (encoded !== text) assert.equal(evaluateCalls(call(encoded), text).category, 'extra-string-escaping');
  }
  assert.equal(evaluateCalls([{ function: { name: 'capture_code', arguments: '{' } }], '').category, 'invalid-argument-json');
});

test('streamed tool diagnostics preserve split argument text and require a terminal marker', async () => {
  const text = cases[2].text;
  const argumentsText = JSON.stringify({ text });
  const chunks = [argumentsText.slice(0, 8), argumentsText.slice(8)];
  const frames = chunks.map((argumentsPart, i) => 'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0,
    function: { ...(i === 0 ? { name: 'capture_code' } : {}), arguments: argumentsPart } }] } }] }) + '\r\n\r\n').join('');
  const bytes = new TextEncoder().encode(frames + 'data: [DONE]\r\n');
  const body = new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close(); } });
  const received = await completion(new Response(body), true);
  assert.equal(evaluateCalls(received.calls, text).ok, true);
  await assert.rejects(completion(new Response(frames), true), /without DONE/);
  await assert.rejects(completion(new Response(frames), true, { maxBytes: 2 }), /byte limit/);
});

test('a diagnostic probe rejects nonlocal destinations before sending a request', async () => {
  for (const endpoint of ['https://example.com/v1/chat/completions', 'http://127.0.0.1.example.com', 'http://user:pass@localhost']) {
    await assert.rejects(runProbe({ endpoint, model: 'fixture', directory: '/unused' }), /loopback/);
  }
});

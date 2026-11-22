const assert = require('node:assert/strict');
const { test } = require('node:test');
const { tokens, LexicalIndex } = require('../../src/lexical-index');
const { rank, assemble } = require('../../src/context');
const { budgetForContext } = require('../../src/retrieval');

test('identifier tokens retain full camel, acronym and snake names plus their components', () => {
  const words = tokens('HTTPServer_readFile $value runCheck');
  for (const word of ['httpserver_readfile', 'http', 'server', 'read', 'file', '$value', 'value', 'runcheck', 'run', 'check']) assert.ok(words.includes(word), word);
});

test('exact symbols and paths outrank repeated approximate mentions', () => {
  const files = Array.from({ length: 300 }, (_, i) => ({ path: `docs/filler-${i}.md`, text: 'alpha beta '.repeat(100) }));
  files.push({ path: 'src/feature.js', text: 'function alphaBeta() { return true; }\n' });
  assert.equal(rank(files, 'Find alphaBeta').at(0).file, 'src/feature.js');
  assert.equal(rank(files, 'Inspect docs/filler-299.md').at(0).file, 'docs/filler-299.md');
  files.at(-1).text = 'function replacement() { return true; }\n';
  assert.ok(!rank(files, 'alphaBeta').some(hit => hit.file === 'src/feature.js'), 'Changed source invalidates the cached lexical index.');
});

test('packed excerpts have valid offsets, content versions and no overlapping windows', () => {
  const text = Array.from({ length: 120 }, (_, i) => i === 4 ? 'function locateTarget() {' : `  // locate target ${i}`).join('\n');
  const result = assemble([{ path: 'src/target.js', text }, { path: 'test/target.test.js', text: 'test locateTarget behavior' },
    { path: 'docs/target.md', text: '# locateTarget\nThe target lookup.' }], 'Inspect locateTarget and its tests and docs.', 1000);
  assert.ok(result.used <= 1000);
  assert.ok(result.selected.every(item => /^[a-f0-9]{64}$/.test(item.contentHash)));
  const ranges = result.selected.filter(item => item.file === 'src/target.js');
  for (let i = 0; i < ranges.length; i++) for (let j = i + 1; j < ranges.length; j++) assert.ok(ranges[i].end < ranges[j].start || ranges[j].end < ranges[i].start);
  for (const item of result.text.trim().split('\n').map(JSON.parse)) assert.ok(item.text.startsWith(text.split('\n')[item.start - 1]) || item.file !== 'src/target.js');
});

test('an exact registered tool outranks repeated call sites and resolves as an explicit symbol', () => {
  const files = [{ path: 'test/calls.test.js', text: "call('repair_lines', {});\n".repeat(100) },
    { path: 'src/editor.js', text: "tool('repair_lines', 'Stage a bounded edit', {}, false, handler);\n" }];
  assert.equal(rank(files,'repair_lines')[0].file,'src/editor.js');
  const packed=assemble(files,'@symbol:repair_lines',1000);
  assert.deepEqual(packed.unresolved,[]);
  assert.equal(packed.selected[0].file,'src/editor.js');
  files[1].text="server.registerTool('different_tool', {}, handler);\n";
  assert.equal(rank(files,'different_tool')[0].file,'src/editor.js');
  assert.ok(!rank(files,'@symbol:repair_lines').some(hit=>hit.file==='src/editor.js'));
});

test('posting quota and rank-fusion variants are deterministic and explicit', () => {
  const files = [{ path: 'src/a.js', text: 'function alphaBeta() {}' }, { path: 'docs/a.md', text: 'alpha beta usage' }];
  const limited = new LexicalIndex(files, { maxPostings: 2 });
  assert.equal(limited.coverage.complete, false);
  assert.ok(limited.coverage.unindexed > 0);
  assert.deepEqual(rank(files, 'alpha beta', { fusion: 'rrf' }), rank(files, 'alpha beta', { fusion: 'rrf' }));
  assert.equal(rank(files, '@file:docs/a.md', { fusion: 'rrf' })[0].file, 'docs/a.md');
});

test('repository context uses the declared model budget with a bounded fallback estimate', () => {
  assert.equal(budgetForContext(4096).characters, 4096);
  assert.equal(budgetForContext(32768).characters, 12000);
  assert.equal(budgetForContext(32768, 4000).characters, 4000);
  assert.equal(budgetForContext(undefined).contextTokens, null);
  assert.equal(budgetForContext(undefined).characters, 12000);
});

test('ranking leads with a balanced file mix and puts user-facing docs before planning docs', () => {
  const { rank: rankFiles } = require('../../src/context');
  const files = [
    ...Array.from({ length: 12 }, (_, i) => ({ path: `src/widget${i}.js`, text: 'const gauge = widgetGauge + widgetGauge;\n'.repeat(3) })),
    { path: 'test/widget.test.js', text: 'test("widgetGauge", () => {});\n' },
    { path: 'docs/plan.md', text: '# Plan\nwidgetGauge widgetGauge widgetGauge widgetGauge\n' },
    { path: 'README.md', text: '# Usage\nThe widgetGauge shows progress.\n' },
  ];
  const top = [...new Set(rankFiles(files, 'widgetGauge').map(hit => hit.file))].slice(0, 10);
  assert.ok(top.includes('test/widget.test.js'), 'a test file keeps a top-ten slot');
  assert.ok(top.indexOf('README.md') >= 0 && top.indexOf('README.md') < top.indexOf('docs/plan.md'), 'README ranks before the plan');
});

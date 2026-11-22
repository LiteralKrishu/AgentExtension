const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { digest } = require('../../src/permissions');
const { validateJudgments, sha256, excerpt } = require('./judgments.cjs');

function fixture() {
  const files = [{ path: 'src/a.js', text: 'function work() {\n  return 1;\n}\n' },
    { path: 'test/a.test.js', text: "assert.equal(work(), 1);\n" }];
  const labels = { version: 'fixture/1', sourceRevision: 'abc123', queries: [
    { id: 'q1', expected: { implementation: ['src/a.js'], test: ['test/a.test.js'] } },
  ] };
  const revision = 'abc123000';
  const review = { version: 'retrieval-judgment-audit/1', corpusVersion: labels.version, labelsDigest: digest(labels),
    sourceRevision: revision, inputDigest: digest(files), sources: Object.fromEntries(files.map(file => [file.path, sha256(file.text)])),
    judgments: ['implementation', 'test'].map((category, i) => ({ query: 'q1', category,
      originalFiles: labels.queries[0].expected[category], decision: 'retain', reason: 'Cites the implementation or its direct assertion.',
      citations: [{ file: files[i].path, start: 1, end: 1, sha256: sha256(excerpt(files[i].text, 1, 1)) }] })) };
  return { review, labels, files, revision };
}

test('a citation audit rejects changed source, labels, missing judgments, and invalid witnesses', () => {
  assert.equal(validateJudgments(fixture()).readyForRevisedCorpus, true);
  const cases = [
    [f => { f.files[0].text += '// changed\n'; }, 'source-provenance-mismatch'],
    [f => { f.review.sourceRevision = 'different'; }, 'source-provenance-mismatch'],
    [f => { f.labels.queries[0].expected.test = ['other.test.js']; }, 'labels-provenance-mismatch'],
    [f => { f.review.judgments.pop(); }, 'full-judgment-set-required'],
    [f => { f.review.judgments.push(f.review.judgments[0]); }, 'duplicate-judgment:q1:implementation'],
    [f => { f.review.judgments[0].category = 'unknown'; }, 'unknown-judgment:q1:unknown'],
    [f => { f.review.judgments[0].citations[0].start = 0; }, 'invalid-citation-range:q1:implementation:src/a.js'],
    [f => { f.review.judgments[0].citations[0].end = 999; }, 'invalid-citation-range:q1:implementation:src/a.js'],
    [f => { f.review.judgments[0].citations[0].sha256 = '0'.repeat(64); }, 'citation-hash-mismatch:q1:implementation:src/a.js'],
    [f => { delete f.review.sources['src/a.js']; }, 'missing-source-hash:q1:implementation:src/a.js'],
    [f => { f.review.sources['src/a.js'] = '0'.repeat(64); }, 'source-hash-mismatch:src/a.js'],
    [f => { f.review.judgments[0].citations = [f.review.judgments[1].citations[0]]; }, 'uncited-target:q1:implementation:src/a.js'],
    [f => { f.review.judgments[0] = null; }, 'invalid-judgment-record'],
    [f => { f.review.judgments[0].citations = [null]; }, 'invalid-citation:q1:implementation'],
    [f => { f.review.judgments[0].decision = '__proto__'; }, 'invalid-decision:q1:implementation'],
    [f => { f.review.judgments[0].decision = 'replace-proposed'; f.review.judgments[0].proposedFiles = {}; }, 'missing-targets:q1:implementation'],
  ];
  for (const [change, issue] of cases) {
    const f = fixture(); change(f);
    const result = validateJudgments(f);
    assert.equal(result.valid, false, issue);
    assert.ok(result.issues.includes(issue), JSON.stringify(result.issues));
  }
});

test('source-correct proposed replacements and coverage gaps do not become approved labels', () => {
  const f = fixture();
  f.review.judgments[0].decision = 'coverage-gap';
  let result = validateJudgments(f);
  assert.equal(result.valid, true);
  assert.equal(result.readyForRevisedCorpus, false);
  assert.equal(result.pending[0].decision, 'coverage-gap');
  const row = f.review.judgments[0];
  row.decision = 'replace-proposed'; row.proposedFiles = ['test/a.test.js'];
  row.citations = [f.review.judgments[1].citations[0]];
  result = validateJudgments(f);
  assert.equal(result.valid, true);
  assert.equal(result.readyForRevisedCorpus, false);
  assert.deepEqual(f.labels.queries[0].expected.implementation, ['src/a.js']);
});

test('the checked-in audit covers all frozen judgments and retains every known correction', async () => {
  const labels = require('./queries.json');
  const review = require('./judgments.json');
  const source = await require('./run.cjs').snapshot();
  const result = validateJudgments({ review, labels, ...source });
  assert.equal(result.valid, true, JSON.stringify(result.issues));
  assert.equal(result.judgments, 120);
  assert.deepEqual(result.decisions, { retain: 114, 'replace-proposed': 5, 'coverage-gap': 1 });
  assert.equal(result.readyForRevisedCorpus, false);
  assert.ok(result.pending.some(row => row.query === 'query-20' && row.decision === 'coverage-gap'));
});

test('the audit command fails its readiness gate while frozen-label corrections remain pending', () => {
  const run = spawnSync(process.execPath, [path.join(__dirname, 'judgments.cjs'), '--corpus', '1', '--require-ready'], { encoding: 'utf8' });
  assert.equal(run.status, 1, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.valid, true);
  assert.equal(result.readyForRevisedCorpus, false);
  assert.equal(result.pending.length, 6);
});

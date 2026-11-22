const { createHash } = require('node:crypto');
const { digest } = require('../../src/permissions');
const { safePath } = require('../../src/workspace');

const sha256 = text => createHash('sha256').update(text).digest('hex');
const excerpt = (text, start, end) => text.split('\n').slice(start - 1, end).join('\n');

// Checks source identity and coverage. It cannot prove a relevance judgment is true.
function validateJudgments({ review, labels, files, revision, sourceVersion }) {
  const issues = [];
  const add = (condition, issue) => { if (!condition) issues.push(issue); };
  const source = new Map(files.map(file => [file.path, file.text]));
  const expected = new Map(labels.queries.flatMap(query => Object.entries(query.expected)
    .map(([category, paths]) => [`${query.id}:${category}`, paths])));
  add(review?.version === 'retrieval-judgment-audit/1', 'unsupported-review-version');
  add(review?.corpusVersion === labels.version && review?.labelsDigest === digest(labels), 'labels-provenance-mismatch');
  add(typeof revision === 'string' && revision.startsWith(labels.sourceRevision) && review?.sourceRevision === revision &&
    review?.inputDigest === digest(files), 'source-provenance-mismatch');
  if (labels.sourceVersion) add(sourceVersion === labels.sourceVersion && review?.sourceVersion === sourceVersion, 'source-version-mismatch');
  const sources = review?.sources ?? {};
  for (const [file, hash] of Object.entries(sources)) {
    try { safePath(file); } catch { issues.push(`invalid-source-path:${file}`); }
    add(source.has(file) && hash === sha256(source.get(file)), `source-hash-mismatch:${file}`);
  }
  const rows = Array.isArray(review?.judgments) ? review.judgments : [];
  const seen = new Set();
  const decisions = { retain: 0, 'replace-proposed': 0, 'coverage-gap': 0 };
  const pending = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) { issues.push('invalid-judgment-record'); continue; }
    const key = `${row.query}:${row.category}`;
    add(expected.has(key), `unknown-judgment:${key}`);
    add(!seen.has(key), `duplicate-judgment:${key}`);
    seen.add(key);
    add(digest(row.originalFiles ?? null) === digest(expected.get(key) ?? null), `original-label-mismatch:${key}`);
    const knownDecision = Object.hasOwn(decisions, row.decision);
    add(knownDecision, `invalid-decision:${key}`);
    if (knownDecision) decisions[row.decision]++;
    add(typeof row.reason === 'string' && row.reason.trim().length >= 8 && row.reason.length <= 1200, `missing-reason:${key}`);
    const original = Array.isArray(row.originalFiles) && row.originalFiles.every(file => typeof file === 'string') ? row.originalFiles : [];
    const targets = row.decision === 'replace-proposed' ? row.proposedFiles : row.originalFiles;
    const proposed = Array.isArray(targets) && targets.every(file => typeof file === 'string') ? targets : [];
    add(proposed.length > 0 && new Set(proposed).size === proposed.length, `missing-targets:${key}`);
    if (row.decision !== 'replace-proposed') add(row.proposedFiles === undefined, `unexpected-proposed-files:${key}`);
    if (row.decision === 'replace-proposed') add(digest(row.proposedFiles ?? null) !== digest(row.originalFiles ?? null), `unchanged-replacement:${key}`);
    for (const file of [...original, ...proposed]) add(Object.hasOwn(sources, file), `missing-source-hash:${key}:${file}`);
    const citations = Array.isArray(row.citations) ? row.citations : [];
    add(citations.length > 0 && citations.length <= 8, `missing-or-excessive-citations:${key}`);
    for (const file of proposed) add(citations.some(citation => citation?.file === file), `uncited-target:${key}:${file}`);
    for (const citation of citations) {
      if (!citation || typeof citation !== 'object' || Array.isArray(citation)) { issues.push(`invalid-citation:${key}`); continue; }
      const text = source.get(citation.file);
      const validRange = typeof text === 'string' && Number.isInteger(citation.start) && Number.isInteger(citation.end) &&
        citation.start >= 1 && citation.end >= citation.start && citation.end <= text.split('\n').length && citation.end - citation.start < 80;
      add(validRange, `invalid-citation-range:${key}:${citation.file}`);
      add(Object.hasOwn(sources, citation.file), `missing-source-hash:${key}:${citation.file}`);
      if (validRange) {
        const cited = excerpt(text, citation.start, citation.end);
        add(Boolean(cited.trim()) && citation.sha256 === sha256(cited), `citation-hash-mismatch:${key}:${citation.file}`);
      }
    }
    if (row.decision !== 'retain') pending.push({ query: row.query, category: row.category, decision: row.decision,
      originalFiles: row.originalFiles, ...(row.proposedFiles ? { proposedFiles: row.proposedFiles } : {}), reason: row.reason });
  }
  add(rows.length === expected.size && [...expected.keys()].every(key => seen.has(key)), 'full-judgment-set-required');
  return { valid: issues.length === 0, readyForRevisedCorpus: issues.length === 0 && pending.length === 0,
    judgments: rows.length, expectedJudgments: expected.size, citedSources: Object.keys(sources).length, decisions,
    issues: [...new Set(issues)], pending,
    limitation: 'Hash validation checks pinned text and citation coverage. It does not prove semantic relevance, feature correctness, or independent held-out quality. Frozen labels and scores stay unchanged.' };
}

async function main() {
  const args = process.argv.slice(2);
  const version = args.includes('--corpus') ? args[args.indexOf('--corpus') + 1] : '2';
  const corpus = await require('./corpus.cjs').loadRetrievalCorpus(version);
  const result = validateJudgments({ ...corpus, labels: corpus.labels });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.valid && (!process.argv.includes('--require-ready') || result.readyForRevisedCorpus) ? 0 : 1;
}

module.exports = { validateJudgments, sha256, excerpt };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 2; });

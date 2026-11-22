const { digest } = require('./permissions');

const STOP = new Set('about across add alongside also any appear application as be built by change code containing every find for from has have in into is it its list loaded must new of on only or print prints should that the their these this to use values was were when where which will with would'.split(' '));
const declaration = /^\s*(?:(?:export|default|public|private|static|async)\s+)*(?:def|class|function|type|interface|const|let|struct|fn|func)\s+([\w$]+)/;

const tokenParts = new Map();
function partsFor(raw) {
    if (tokenParts.has(raw)) return tokenParts.get(raw);
    const parts = raw.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').toLowerCase().match(/[a-z\d]{2,}/g) ?? [];
    const full = raw.toLowerCase();
    const output = parts.length > 1 || full.includes('_') || full.includes('$') ? [full, ...parts] : parts;
    if (raw.length <= 200) {
      if (tokenParts.size >= 20000) tokenParts.delete(tokenParts.keys().next().value);
      tokenParts.set(raw, output);
    }
    return output;
}
function tokens(text) {
  const output = [];
  for (const raw of text.match(/[A-Za-z_$][\w$]*/g) ?? []) output.push(...partsFor(raw));
  return output;
}
function countsFor(text) {
  const counts = new Map(); let length = 0;
  for (const raw of text.match(/[A-Za-z_$][\w$]*/g) ?? []) for (const token of partsFor(raw)) {
    counts.set(token, (counts.get(token) ?? 0) + 1); length++;
  }
  return { counts, length };
}
const queryTerms = text => [...new Set(tokens(text))].filter(term => !STOP.has(term)).slice(0, 32);
const category = file => /(^|\/)(tests?|spec)(\/|\.)|(^|\/)(test_|.*\.test\.)/.test(file) ? 'test'
  : /(^|\/)docs?(\/|\.)|\.(md|rst)$/.test(file) ? 'documentation' : 'implementation';

class LexicalIndex {
  constructor(files, { maxPostings = 1000000 } = {}) {
    this.files = files; this.documents = []; this.postings = new Map(); this.length = 0;
    this.coverage = { complete: true, indexed: 0, unindexed: 0, postings: 0 };
    for (const file of files) {
      const body = countsFor(file.text);
      const pathTerms = new Set(tokens(file.path));
      const counts = body.counts;
      const words = new Set([...counts.keys(), ...pathTerms]);
      if (this.coverage.postings + words.size > maxPostings) { this.coverage.complete = false; this.coverage.unindexed++; continue; }
      const id = this.documents.length;
      this.documents.push({ file, counts, pathTerms, length: body.length, category: category(file.path),
        stem: file.path.split('/').at(-1).replace(/^test[_-]/, '').split('.')[0].toLowerCase() });
      this.length += body.length;
      for (const term of words) {
        if (!this.postings.has(term)) this.postings.set(term, []);
        this.postings.get(term).push(id);
      }
      this.coverage.postings += words.size; this.coverage.indexed++;
    }
    this.average = this.length / Math.max(1, this.documents.length);
  }
  rank(prompt, explicit = [], { fusion = 'score' } = {}) {
    const words = queryTerms(prompt);
    const ids = new Set(words.flatMap(word => this.postings.get(word) ?? []));
    const raw = [...prompt.matchAll(/[A-Za-z_$][\w$]*/g)].map(match => match[0]);
    const symbols = new Set(raw.filter(word => /[a-z\d][A-Z]|[_$]/.test(word) || raw.length === 1));
    const paths = [...prompt.matchAll(/[\w.-]+(?:\/[\w.-]+)+|[\w-]+\.(?:js|cjs|mjs|ts|tsx|jsx|py|md|rst|json|go|rs)/g)].map(match => match[0]);
    for (const [id, doc] of this.documents.entries()) if (explicit.some(item => item.type === 'file' && item.value === doc.file.path) || paths.some(file => doc.file.path === file || doc.file.path.endsWith('/' + file))) ids.add(id);
    const idf = word => Math.log(1 + (this.documents.length - (this.postings.get(word)?.length ?? 0) + 0.5) / ((this.postings.get(word)?.length ?? 0) + 0.5));
    const scores = [...ids].map(id => {
      const doc = this.documents[id];
      const hits = words.filter(word => doc.counts.has(word) || doc.pathTerms.has(word));
      const score = hits.reduce((sum, word) => {
        const tf = doc.counts.get(word) ?? 0;
        return sum + idf(word) * (tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * doc.length / Math.max(1, this.average))) + (doc.pathTerms.has(word) ? 3 : 0));
      }, 0);
      const exactFile = explicit.find(item => item.type === 'file' && item.value === doc.file.path);
      const exactPath = paths.some(file => doc.file.path === file || doc.file.path.endsWith('/' + file));
      return { ...doc, score, hits, exactFile, exactPath };
    }).sort((a, b) => Number(Boolean(b.exactFile)) - Number(Boolean(a.exactFile)) || Number(b.exactPath) - Number(a.exactPath) || b.score - a.score || a.file.path.localeCompare(b.file.path));
    // Bound excerpt work after the inverted lookup. File candidates remain exact and distinct.
    const selected = scores.slice(0, 160);
    const output = [];
    for (const doc of selected) {
      const contentHash = doc.file.contentHash ?? digest(doc.file.text);
      const lines = doc.file.text.split(/\r?\n/);
      const starts = new Set();
      for (let line = 0; line < lines.length; line += 40) starts.add(line);
      for (let line = 0; line < lines.length; line++) if (declaration.test(lines[line])) starts.add(line);
      for (const start of [...starts].sort((a, b) => a - b)) {
        let end = Math.min(start + 48, lines.length);
        if (declaration.test(lines[start])) {
          for (let line = start + 1; line < end; line++) if (declaration.test(lines[line]) && (lines[line].match(/^\s*/)[0].length <= lines[start].match(/^\s*/)[0].length)) { end = line; break; }
        }
        const sample = lines.slice(start, end).join('\n');
        const windowTerms = new Set(tokens(sample));
        const hits = doc.hits.filter(word => windowTerms.has(word) || doc.pathTerms.has(word));
        const declarations = lines.slice(start, end).flatMap(line => [line.match(declaration)?.[1],
          line.match(/\b(?:tool|registerTool)\(\s*['"]([\w$]+)['"]/)?.[1]]).filter(Boolean);
        const symbol = explicit.find(item => item.type === 'symbol' && declarations.includes(item.value));
        const exactSymbol = declarations.some(name => symbols.has(name));
        if (!hits.length && !doc.exactFile && !symbol && !doc.exactPath) continue;
        const lexicalScore = hits.reduce((sum, word) => sum + idf(word) * (windowTerms.has(word) ? 2 : 0.25), 0) + doc.score * 0.3;
        const pathScore = hits.reduce((sum, word) => sum + (doc.stem === word ? 5 : doc.pathTerms.has(word) ? 2 : 0), 0);
        const priority = symbol ? 1000 : doc.exactFile ? 900 : doc.exactPath ? 800 : exactSymbol ? 400 : 0;
        output.push({ file: doc.file.path, start: start + 1, end, sample, hits, stem: doc.stem, category: doc.category,
          exactFile: doc.exactFile, symbol, lexicalScore, pathScore, priority,
          contentHash,
          score: priority + lexicalScore + pathScore,
          reason: symbol ? `Explicit symbol ${symbol.value}` : doc.exactFile ? 'Explicit file mention'
            : `${exactSymbol ? 'Exact declaration; ' : ''}BM25 ${doc.category} match for ${hits.slice(0, 5).join(', ')}` });
      }
    }
    if (fusion === 'rrf') {
      const lexical = [...output].sort((a, b) => b.lexicalScore - a.lexicalScore);
      const paths = [...output].filter(item => item.pathScore).sort((a, b) => b.pathScore - a.pathScore);
      const positions = new Map(lexical.map((item, i) => [item, 60 / (61 + i)]));
      paths.forEach((item, i) => positions.set(item, positions.get(item) + 60 / (61 + i)));
      for (const item of output) item.score = item.priority + positions.get(item);
    }
    return output.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.start - b.start);
  }
}

module.exports = { LexicalIndex, tokens, queryTerms };

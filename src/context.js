const CONTEXT_BUDGET = 12_000;
const { LexicalIndex } = require('./lexical-index');
const { Relationships } = require('./relationships');
const { digest } = require('./permissions');
const indexes = new WeakMap();
const STOP_WORDS = new Set('about across add alongside also any appear application as be built by change code covered containing every find for from has have in into is it its list loaded must new of on only or print prints should that the their these this to use values was were when where which will with would'.split(' '));

function lexemes(text) {
  return new Set(text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z][a-z0-9]{1,}/g) ?? []);
}

function terms(text) {
  return [...lexemes(text)]
    .filter(word => !STOP_WORDS.has(word)).slice(0, 24);
}

function mentions(prompt) {
  return [...prompt.matchAll(/(?:^|\s)@(file|symbol)(?::(?:"([^"]+)"|([^\s,;]+))|\s+(?:"([^"]+)"|([^\s,;]+)))/g)]
    .map(([, type, ...values]) => ({ type, value: values.find(value => value !== undefined) }));
}

function legacyRank(files, prompt) {
  const words = terms(prompt);
  const explicit = mentions(prompt);
  const candidates = [];
  const frequency = new Map(words.map(word => [word, 0]));
  for (const file of files) {
    const filename = file.path.toLowerCase();
    const fileTerms = lexemes(file.path);
    const stem = file.path.split('/').at(-1).replace(/^test[_-]/, '').split('.')[0].toLowerCase();
    const lines = file.text.split(/\r?\n/);
    const category = /(^|\/)(tests?|spec)(\/|\.)|(^|\/)(test_|.*\.test\.)/.test(filename) ? 'test'
      : /(^|\/)docs?(\/|\.)|\.(md|rst)$/.test(filename) ? 'documentation' : 'implementation';
    const exactFile = explicit.find(item => item.type === 'file' && item.value === file.path);
    const body = lexemes(file.text);
    const matched = words.filter(word => body.has(word) || fileTerms.has(word));
    for (const word of matched) frequency.set(word, frequency.get(word) + 1);

    // Rank small windows independently so a large file cannot consume the budget.
    for (let start = 0; start < lines.length; start += 40) {
      const end = Math.min(start + 48, lines.length);
      const sample = lines.slice(start, end).join('\n');
      const windowTerms = lexemes(sample);
      const symbol = explicit.find(item => item.type === 'symbol' &&
        sample.split('\n').some(line => {
          const declaration = line.match(/^\s*(?:(?:export|default|public|private|static|async)\s+)*(?:def|class|function|type|interface|const|let|struct|fn|func)\s+([\w$]+)/);
          return declaration?.[1] === item.value;
        }));
      const hits = matched.filter(word => windowTerms.has(word) || fileTerms.has(word));
      if (!hits.length && !exactFile && !symbol) continue;
      candidates.push({ file: file.path, start: start + 1, end, sample, hits, fileTerms, windowTerms, stem, category, exactFile, symbol });
    }
  }

  for (const item of candidates) {
    item.score = item.hits.reduce((score, word) => {
      const weight = Math.log(1 + files.length / (frequency.get(word) + 1));
      const pathMatch = item.stem === word ? 5 : item.fileTerms.has(word) ? 2 : 0;
      return score + weight * (pathMatch + Number(item.windowTerms.has(word)));
    }, 0) + (item.symbol ? 90 : 0) + (item.exactFile ? 60 : 0);
    item.reason = item.symbol ? `Explicit symbol ${item.symbol.value}` : item.exactFile ? 'Explicit file mention'
      : `${item.category[0].toUpperCase() + item.category.slice(1)} match for ${item.hits.slice(0, 5).join(', ')}`;
  }
  return candidates.sort((left, right) => right.score - left.score || left.file.localeCompare(right.file) || left.start - right.start);
}

// Planning and history documents describe intent, not current behavior, so they rank below other documentation.
const PROCESS_DOCUMENT = /(^|[/._-])(milestones?|roadmap|research|backlog|plans?|implementation|progress|changelog|releases?|remaining[-_]work|evidence|notes|todo|history)(?=[/._-]|$)/i;
const SLOTS = { implementation: 3, test: 3, documentation: 3 };

// Leads with the best window of a balanced top ten: explicit matches first, then up to three files of each category,
// then the strongest remaining files. Scores are unchanged; later windows keep their order.
function balance(ranked) {
  const best = new Map();
  for (const item of ranked) if (!best.has(item.file)) best.set(item.file, { item, position: best.size,
    weight: item.category === 'documentation' && PROCESS_DOCUMENT.test(item.file.replace(/\.[^./]+$/, '')) ? item.score * .5 : item.score });
  const files = [...best.values()].sort((a, b) => (b.item.priority ?? 0) - (a.item.priority ?? 0) || b.weight - a.weight || a.position - b.position);
  const lead = new Set(files.filter(entry => (entry.item.priority ?? 0) > 0));
  for (const [category, slots] of Object.entries(SLOTS)) for (const entry of files.filter(entry => entry.item.category === category).slice(0, slots)) lead.add(entry);
  for (const entry of files) lead.add(entry);
  const first = [...lead].slice(0, 10).map(entry => entry.item);
  const chosen = new Set(first);
  return [...first, ...ranked.filter(item => !chosen.has(item))];
}

function rank(files, prompt, options = {}) {
  return balance(rankWindows(files, prompt, options));
}

function rankWindows(files, prompt, options = {}) {
  let cached = indexes.get(files);
  if (!cached || cached.sources.length !== files.length || cached.sources.some((source, i) => source.path !== files[i].path || source.text !== files[i].text)) {
    cached = { sources: files.map(({ path, text }) => ({ path, text })), index: new LexicalIndex(files) };
    indexes.set(files, cached);
  }
  const ranked = cached.index.rank(prompt, mentions(prompt), options);
  if (options.relationships !== true || !ranked.length) return ranked;
  cached.relationships ??= new Relationships(files);
  const ordered = [...new Set(ranked.map(hit => hit.file))];
  const seeds = [...new Set(ranked.filter(item => item.category === 'implementation').map(item => item.file))].slice(0, 3);
  const related = cached.relationships.related(seeds);
  const lexicalPosition = new Map(ordered.map((file, index) => [file, index]));
  const relationshipPosition = new Map(related.map((edge, index) => [edge.file, index]));
  for (const edge of related) if (!lexicalPosition.has(edge.file)) {
    const source = cached.relationships.files.get(edge.file);
    const lines = source.text.split(/\r?\n/);
    const start = Math.max(1, edge.line - 3); const end = Math.min(lines.length, start + 17);
    ranked.push({ file: edge.file, start, end, sample: lines.slice(start - 1, end).join('\n'), hits: [], category: /test/.test(edge.file) ? 'test' : /\.(md|rst)$/.test(edge.file) ? 'documentation' : 'implementation',
      stem: edge.file.split('/').at(-1).split('.')[0], reason: edge.reason, provenance: edge.provenance, priority: 0,
      contentHash: source.contentHash ?? digest(source.text) });
  }
  for (const item of ranked) {
    const lexical = lexicalPosition.get(item.file); const relation = relationshipPosition.get(item.file);
    item.score = (item.priority ?? 0) + (lexical === undefined ? 0 : 60 / (61 + lexical)) + (relation === undefined ? 0 : 60 / (61 + relation)) + (item.lexicalScore ?? 0) * .000001;
  }
  return ranked.sort((a,b) => b.score - a.score || a.file.localeCompare(b.file) || a.start - b.start);
}

function outline(file, category, words) {
  const lines = file.text.split(/\r?\n/);
  const anchors = [];
  for (const [index, raw] of lines.entries()) {
    const text = raw.trim();
    if (!text || text.length > 140) continue;
    const heading = category === 'documentation'
      && (/^#{1,6}\s+\S/.test(raw) || /^([=~^-])\1{2,}$/.test(lines[index + 1]?.trim() ?? ''));
    const declaration = /^\s{0,8}(?:(?:export|default|async|public)\s+)*(?:class|def|function|fn|func|interface)\s+[\w$]+/.test(raw);
    const registration = /^\s{0,12}[\w$.]+\.(?:add|register|mount)(?:_[\w]+|[A-Z][\w]+)?\(/.test(raw);
    const constructor = /^[\w$]+\s*=\s*[A-Z][\w$]+\(/.test(raw);
    const relevant = category === 'documentation' ? heading
      : declaration || (category === 'implementation' && (registration || constructor));
    if (!relevant) continue;
    const tokens = lexemes(text);
    const score = words.filter(word => tokens.has(word)).length + (registration ? 3 : 0);
    anchors.push({ line: index + 1, text, score });
  }
  return anchors.sort((left, right) => right.score - left.score || left.line - right.line)
    .slice(0, 12).sort((left, right) => left.line - right.line).map(item => `${item.line}: ${item.text}`);
}

function assemble(files, prompt, budget = CONTEXT_BUDGET, anchors = [], options) {
  const ranked = rank(files, prompt, options);
  const categories = ['implementation', 'test', 'documentation'];
  const pinned = ranked.filter(item => item.exactFile || item.symbol);
  const implementation = ranked.find(item => item.category === 'implementation');
  const relatedStem = implementation?.hits.includes(implementation.stem) ? implementation.stem : undefined;
  const representative = categories.map(category =>
    ranked.find(item => item.category === category && item.stem === relatedStem)
    ?? ranked.find(item => item.category === category));
  const outlines = new Map();
  if (relatedStem && budget >= CONTEXT_BUDGET) {
    const query = terms(prompt);
    for (const item of representative.filter(Boolean)) {
      const file = files.find(candidate => candidate.path === item.file);
      outlines.set(item.file, outline(file, item.category, query));
    }
  }
  const locations = anchors.flatMap(anchor => {
    const file = files.find(item => item.path === anchor.file);
    if (!file) return [];
    const lines = file.text.split(/\r?\n/);
    const start = Math.max(1, anchor.line - 5);
    const end = Math.min(lines.length, anchor.line + 12);
    return [{ ...anchor, start, end, sample: lines.slice(start - 1, end).join('\n') }];
  });
  const queue = [...pinned, ...locations, ...representative.filter(Boolean), ...ranked];
  const selected = [];
  const perFile = new Map();
  const seen = new Set();
  const ranges = new Map();
  let omitted = 0;
  let text = '';
  for (const item of queue) {
    const key = `${item.file}:${item.start}`;
    if (seen.has(key) || (perFile.get(item.file) ?? 0) >= 2) continue;
    if (ranges.get(item.file)?.some(range => Math.max(range.start, item.start) <= Math.min(range.end, item.end))) continue;
    seen.add(key);
    const anchors = !perFile.has(item.file) ? outlines.get(item.file) : undefined;
    const sample = item.sample.slice(0, 2300);
    const end = Math.min(item.end, item.start + sample.split('\n').length - 1);
    const excerpt = JSON.stringify({
      file: item.file, start: item.start, end, text: sample,
      ...(sample.length < item.sample.length ? { truncated: true } : {}),
      ...(anchors?.length ? { anchors } : {}),
    });
    if (text.length + excerpt.length + 1 > budget) { omitted++; continue; }
    text += excerpt + '\n';
    perFile.set(item.file, (perFile.get(item.file) ?? 0) + 1);
    if (!ranges.has(item.file)) ranges.set(item.file, []);
    ranges.get(item.file).push({ start: item.start, end });
    selected.push({ file: item.file, start: item.start, end, reason: item.reason,
      ...(item.contentHash ? { contentHash: item.contentHash } : {}),
      ...(item.provenance ? { provenance: item.provenance } : {}),
      ...(typeof item.symbol === 'string' ? { symbol: item.symbol } : {}) });
  }
  const unresolved = mentions(prompt).filter(item => !selected.some(hit => item.type === 'file'
    ? hit.file === item.value : hit.reason === `Explicit symbol ${item.value}` || hit.symbol === item.value));
  return { text, selected, unresolved, budget, used: text.length, omitted,
    ranking: { algorithm: 'bm25-fields', coverage: indexes.get(files)?.index.coverage } };
}

function search(files, query, limit, { includeScores = false } = {}) {
  const words = terms(query);
  const needle = query.toLowerCase();
  const results = [];
  for (const file of files) {
    const lines = file.text.split(/\r?\n/);
    if (/[/.]/.test(query)) {
      const pathWords = lexemes(file.path);
      const exactPath = file.path.toLowerCase().includes(needle);
      if (exactPath || (words.length > 1 && words.every(word => pathWords.has(word)))) {
        results.push({ file: file.path, line: 1, text: lines[0].slice(0, 300), score: exactPath ? 200 : 50 });
      }
    }
    for (let index = 0; index < lines.length; index++) {
      const lower = lines[index].toLowerCase();
      const literal = lower.includes(needle);
      const hits = words.filter(word => lower.includes(word));
      if (!literal && (words.length < 2 || hits.length < Math.min(2, words.length))) continue;
      results.push({
        file: file.path, line: index + 1, text: lines[index].slice(0, 300),
        score: (literal ? 100 : 0) + hits.length,
      });
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit).map(({ score, ...item }) =>
    includeScores ? { ...item, score } : item);
}

module.exports = { assemble, search, mentions, rank, legacyRank, CONTEXT_BUDGET };

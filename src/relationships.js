const path = require('node:path').posix;
const { safePath } = require('./workspace');
const { digest } = require('./permissions');

// Syntax-derived edges are hints. They are not language-service definitions or edit receipts.
class Relationships {
  constructor(files, { maxEdges = 50000, maxNeighbors = 8 } = {}) {
    this.files = new Map(files.map(file => [file.path, file])); this.edges = new Map();
    this.maxNeighbors = maxNeighbors; this.coverage = { complete: true, edges: 0 };
    const add = (from, to, line, kind) => {
      if (from === to || !this.files.has(to)) return;
      try { safePath(to); } catch { return; }
      if (this.coverage.edges >= maxEdges) { this.coverage.complete = false; return; }
      for (const [file, other, direction] of [[from, to, 'outgoing'], [to, from, 'incoming']]) {
        if (!this.edges.has(file)) this.edges.set(file, []);
        this.edges.get(file).push({ from: file, file: other, line: direction === 'outgoing' ? 1 : line, kind, direction, provenance: 'inferred-syntax' });
      }
      this.coverage.edges++;
    };
    const resolve = base => [base, ...['.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '.py', '/index.js', '/index.ts', '/__init__.py'].map(suffix => base + suffix)].find(file => this.files.has(file));
    const stems = new Map();
    for (const file of files) {
      const stem = path.basename(file.path).replace(/^test[_-]/, '').replace(/\.(?:test|spec)(?=\.)/, '').replace(/\.[^.]+$/, '');
      if (!stems.has(stem)) stems.set(stem, []);
      stems.get(stem).push(file.path);
      if (/\.[cm]?[jt]sx?$/.test(file.path) && !/\b(?:from|require|import)\b/.test(file.text)) continue;
      if (file.path.endsWith('.py') && !/^\s*(?:from|import)\s/m.test(file.text)) continue;
      if (/\.(?:md|rst)$/.test(file.path) && !file.text.includes('](')) continue;
      for (const [index, line] of file.text.split(/\r?\n/).entries()) {
        if (/\.[cm]?[jt]sx?$/.test(file.path)) {
          for (const match of line.matchAll(/(?:\bfrom\s*|\b(?:require|import)\s*\(\s*|\bimport\s*)['"]([^'"\n]+)['"]/g)) {
            if (!match[1].startsWith('.')) continue;
            const target = resolve(path.normalize(path.join(path.dirname(file.path), match[1])));
            if (target) add(file.path, target, index + 1, 'import');
          }
        } else if (file.path.endsWith('.py')) {
          const match = line.match(/^\s*(?:from\s+([.\w]+)\s+import|import\s+([\w.]+))/);
          if (match) {
            const name = match[1] ?? match[2];
            const dots = name.match(/^\.+/)?.[0].length ?? 0;
            const module = name.slice(dots).replaceAll('.', '/');
            const base = dots ? path.join(path.dirname(file.path), ...Array(Math.max(0, dots - 1)).fill('..'), module) : module;
            const target = resolve(path.normalize(base)) ?? (!dots && resolve('src/' + base));
            if (target) add(file.path, target, index + 1, 'import');
          }
        } else if (/\.(?:md|rst)$/.test(file.path)) {
          for (const match of line.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
            const target = resolve(path.normalize(path.join(path.dirname(file.path), match[1])));
            if (target) add(file.path, target, index + 1, 'documentation-link');
          }
        }
      }
    }
    for (const group of stems.values()) {
      const implementation = group.filter(file => !/(?:^|\/)(?:tests?|docs?)(?:\/|\.)|(?:^|\/)test_|\.(?:test|spec)\.|\.(?:md|rst)$/.test(file));
      const tests = group.filter(file => /(?:^|\/)tests?\/|(?:^|\/)test_|\.(?:test|spec)\./.test(file));
      for (const source of implementation.slice(0, 3)) for (const test of tests.slice(0, 3)) add(test, source, 1, 'test-name');
    }
  }
  related(seeds, limit = this.maxNeighbors) {
    const excluded = new Set(seeds); const result = new Map();
    for (const source of seeds.slice(0, 4)) for (const edge of (this.edges.get(source) ?? []).slice(0, 128)) {
      if (excluded.has(edge.file) || result.has(edge.file)) continue;
      result.set(edge.file, { ...edge, reason: `Inferred ${edge.kind} relationship from ${source}` });
    }
    const priority = edge => edge.kind === 'documentation-link' ? 4 : edge.kind === 'test-name' ? 3 : edge.direction === 'incoming' ? 2 : 1;
    return [...result.values()].sort((a, b) => priority(b) - priority(a) || a.file.localeCompare(b.file)).slice(0, Math.min(limit, this.maxNeighbors));
  }
  anchors(seeds) { return this.related(seeds).map(({ file, line, reason, provenance }) => ({ file, line, reason, provenance })); }
  async currentHints(workspace, seeds, signal, { limit = 4, glob } = {}) {
    const hints = [];
    const current = [];
    for (const file of seeds.slice(0, 4)) {
      try { if (this.files.get(file)?.text === await workspace.read(file)) current.push(file); } catch { /* Stale or excluded seed. */ }
    }
    const edges = this.related(current, 8).filter(edge => !glob || path.matchesGlob(edge.file, glob)).slice(0, limit);
    for (const edge of edges) {
      signal.throwIfAborted();
      try {
        const text = await workspace.read(edge.file);
        const lines = text.split(/\r?\n/);
        if (edge.line > lines.length) continue;
        hints.push({ file: edge.file, line: edge.line, text: lines[edge.line - 1].slice(0, 300), contentDigest: digest(text),
          provenance: edge.provenance, relationship: edge.kind, reason: edge.reason });
      } catch { /* A source that moved out of scope supplies no content. */ }
    }
    return hints;
  }
}

module.exports = { Relationships };

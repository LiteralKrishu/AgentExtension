const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { digest } = require('./permissions');
const { safePath, runIsolated } = require('./workspace');
const { search } = require('./context');

const slash = String.fromCharCode(92);
const escape = value => [...value].map(char => '.*+?^$()[]{}|'.includes(char) || char === slash ? slash + char : char).join('');

function draftOverlay(draft) {
  return new Map([...(draft?.files ?? [])].map(([file, entry]) => [file, draft.current(file, entry.base)]));
}

async function searchExecutable(appRoot) {
  if (!['darwin', 'linux'].includes(process.platform)) return undefined;
  if (process.platform === 'linux' && !await fs.access('/usr/bin/bwrap', fs.constants.X_OK).then(() => true, () => false)) return undefined;
  const binary = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const candidates = [...(appRoot ? ['node_modules', 'node_modules.asar.unpacked'].flatMap(directory => [
    path.join(appRoot, directory, '@vscode/ripgrep-universal/bin', `${process.platform}-${process.arch}`, binary),
    path.join(appRoot, directory, '@vscode/ripgrep/bin', binary),
  ]) : []),
  '/opt/homebrew/bin/rg', '/usr/local/bin/rg', '/usr/bin/rg'];
  for (const candidate of candidates) {
    try { await fs.access(candidate, fs.constants.X_OK); return await fs.realpath(candidate); } catch { /* Try another known host executable. */ }
  }
}

class FreshSearch {
  constructor(workspace, { executable, overlay = () => new Map(), allow = () => true, maxFiles = 20_000,
    maxBytes = 256_000_000, timeoutMs = 2_000, maxMatches = 1024 } = {}) {
    Object.assign(this, { workspace, executable, overlay, allow, maxFiles, maxBytes, timeoutMs, maxMatches });
  }
  async query({ query, mode = 'keywords', glob, cursor, limit = 16 }, signal = new AbortController().signal) {
    if (typeof query !== 'string' || !query.length || query.length > 240 ||
        !['keywords', 'literal', 'word', 'path', 'regex'].includes(mode) ||
        !Number.isInteger(limit) || limit < 1 || limit > 32 || glob !== undefined && (typeof glob !== 'string' || glob.length > 200) ||
        cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 512)) throw new Error('Invalid search request.');
    if (mode === 'regex' && !this.executable) throw new Error('Regex search requires a supported ripgrep executable.');
    signal.throwIfAborted();
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const operation = AbortSignal.any([signal, deadline]);
    const expires = Date.now() + this.timeoutMs;
    const checkTime = () => {
      signal.throwIfAborted();
      if (deadline.aborted || Date.now() >= expires) throw new DOMException('Search deadline reached.', 'TimeoutError');
    };
    const coverage = { complete: true, reason: null, files: 0, bytes: 0, omitted: 0, backend: this.executable && mode !== 'keywords' && mode !== 'path' ? 'ripgrep' : 'javascript' };
    const overlay = new Map();
    for (const [file, text] of this.overlay()) {
      try { safePath(file); if (typeof text === 'string') overlay.set(file, text); } catch { /* Excluded even in host overlays. */ }
    }
    let paths;
    try { paths = await this.workspace.paths(operation, { limit: this.maxFiles + 1 }); }
    catch (error) {
      signal.throwIfAborted();
      if (!deadline.aborted) throw error;
      return { matches: [], coverage: { ...coverage, complete: false, reason: 'deadline' }, nextCursor: null };
    }
    if (paths.length > this.maxFiles) { coverage.complete = false; coverage.reason = 'file-limit'; }
    const allowedPaths = [...new Set([...overlay.keys(), ...paths])].filter(file => {
      try {
        safePath(file);
        if (!this.allow(file)) { coverage.omitted++; coverage.complete = false; return false; }
        return !glob || path.matchesGlob(file, glob);
      } catch { return false; }
    }).slice(0, this.maxFiles);
    const visible = new Set(allowedPaths);
    const matches = [];
    const keywordScores = new Map();
    const fingerprints = new Map();
    const add = (file, line, text, source) => {
      if (!this.allow(file)) { coverage.omitted++; coverage.complete = false; return; }
      if (source === undefined) { matches.push({ file, line, text: '' }); return; }
      const previous = fingerprints.get(file);
      const contentDigest = previous?.text === source ? previous.digest : digest(source);
      fingerprints.set(file, { text: source, digest: contentDigest });
      matches.push({ file, line, text: text.slice(0, 300), contentDigest });
    };
    const scan = (file, text) => {
      checkTime();
      if (text.length > 256_000 || text.includes('\0')) { coverage.omitted++; coverage.complete = false; return; }
      coverage.bytes += Buffer.byteLength(text);
      if (mode === 'keywords') {
        for (const hit of search([{ path: file, text }], query, this.maxMatches, { includeScores: true })) {
          add(file, hit.line, hit.text, text);
          const key = file + ':' + hit.line;
          keywordScores.set(key, Math.max(keywordScores.get(key) ?? 0, hit.score));
        }
      } else {
        const matcher = mode === 'word' ? new RegExp('(^|[^' + slash + 'p{L}' + slash + 'p{N}_])' + escape(query) + '(?=$|[^' + slash + 'p{L}' + slash + 'p{N}_])', 'iu') : null;
        for (const [index, line] of text.split(/\r?\n/).entries()) {
          if (index % 256 === 0) checkTime();
          if (matcher ? matcher.test(line) : line.toLowerCase().includes(query.toLowerCase())) add(file, index + 1, line, text);
          if (matches.length >= this.maxMatches) break;
        }
      }
    };
    const native = async (files, cwd, remap) => {
      if (!files.length) return;
      checkTime();
      const flags = ['--no-config', '--no-follow', '--json', '--max-filesize', '256000', '--ignore-case', ...(mode === 'literal' ? ['--fixed-strings'] : mode === 'word' ? ['--word-regexp', '--fixed-strings'] : []),
        '--', query, ...files];
      const result = await runIsolated(this.executable, flags, cwd, operation, { readOnly: true, maxOutputBytes: 256_000 });
      signal.throwIfAborted();
      if (result.exitCode !== 0 && result.exitCode !== 1) { coverage.complete = false; coverage.reason = 'invalid-pattern-or-unreadable-input'; }
      if (result.exitCode == null || result.output.length >= 256_000) { coverage.complete = false; coverage.reason = deadline.aborted ? 'deadline' : 'output-limit'; }
      const texts = new Map();
      const lines = new Map();
      for (const row of result.output.split('\n')) {
        signal.throwIfAborted();
        if (deadline.aborted) { coverage.complete = false; coverage.reason = 'deadline'; break; }
        if (!row) continue;
        let event;
        try { event = JSON.parse(row); } catch { coverage.complete = false; continue; }
        if (event.type === 'summary') coverage.bytes += event.data.stats.bytes_searched;
        if (event.type !== 'match' || !event.data.path.text) continue;
        const file = remap ?? event.data.path.text.replaceAll(slash, '/').replace(/^\.\//, '');
        if (!visible.has(file) || !remap && overlay.has(file)) continue;
        try {
          const text = remap ? overlay.get(file) : texts.get(file) ?? await this.workspace.read(file);
          texts.set(file, text);
          if (!lines.has(file)) lines.set(file, text.split(/\r?\n/));
          const line = event.data.line_number;
          const content = lines.get(file)[line - 1];
          // Native matches are hints. Only current, scope-checked text reaches the agent.
          if (content !== undefined && event.data.lines.text.replace(/\r?\n$/, '') === content) add(file, line, content, text);
          else { coverage.omitted++; coverage.complete = false; }
        } catch { coverage.omitted++; coverage.complete = false; }
        if (matches.length >= this.maxMatches) { coverage.complete = false; coverage.reason = 'match-limit'; break; }
      }
    };
    try {
      // Scope-check overlays too. Open documents and staged new files cannot bypass symlink rules.
      for (const file of allowedPaths) {
        checkTime();
        const open = this.workspace.openText(path.join(this.workspace.root, file));
        if (!overlay.has(file) && typeof open !== 'string') continue;
        try {
          let full;
          try { full = await this.workspace.resolve(file); }
          catch (error) { if (error.code !== 'ENOENT' || !overlay.has(file)) throw error; full = await this.workspace.resolve(file, true); }
          const text = this.workspace.openText(full);
          if (typeof text === 'string' && !overlay.has(file)) overlay.set(file, text);
        } catch { visible.delete(file); overlay.delete(file); coverage.omitted++; coverage.complete = false; }
      }
      if (mode === 'path') {
        for (const file of visible) {
          checkTime();
          if (file.toLowerCase().includes(query.toLowerCase())) {
            try { await this.workspace.resolve(file, overlay.has(file) && !paths.includes(file)); add(file, 1, ''); }
            catch { coverage.omitted++; coverage.complete = false; }
          }
          if (matches.length >= this.maxMatches) break;
        }
        coverage.files = visible.size;
      } else if (coverage.backend === 'ripgrep') {
        let batch = []; let size = 0;
        let plannedBytes = 0;
        const directories = new Map();
        const candidates = [...visible].filter(file => !overlay.has(file));
        for (let index = 0; index < candidates.length; index += 24) {
          checkTime();
          const inspected = await Promise.all(candidates.slice(index, index + 24).map(async file => {
            try { return { file, stat: (await this.workspace.inspect(file, directories)).stat }; } catch { return { file }; }
          }));
          for (const { file, stat } of inspected) {
            if (!stat || stat.size > 256_000n) { coverage.omitted++; coverage.complete = false; continue; }
            if (plannedBytes + Number(stat.size) > this.maxBytes) { coverage.complete = false; coverage.reason = 'byte-limit'; continue; }
            plannedBytes += Number(stat.size);
            if (size + Buffer.byteLength(file) > 60_000) { await native(batch, this.workspace.root); coverage.files += batch.length; batch = []; size = 0; }
            batch.push(file); size += Buffer.byteLength(file) + 1;
          }
          if (matches.length >= this.maxMatches || coverage.bytes >= this.maxBytes) break;
        }
        await native(batch, this.workspace.root); coverage.files += batch.length;
        for (const [file, text] of overlay) {
          if (!visible.has(file)) continue;
          if (text.length > 256_000 || text.includes('\0')) { coverage.omitted++; coverage.complete = false; continue; }
          if (matches.length >= this.maxMatches || coverage.bytes >= this.maxBytes) break;
          if (mode !== 'regex') { scan(file, text); coverage.files++; continue; }
          const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-search-')));
          try { await fs.writeFile(path.join(directory, 'buffer.txt'), text); await native(['buffer.txt'], directory, file); coverage.files++; }
          finally { await fs.rm(directory, { recursive: true, force: true }); }
        }
      } else {
        const files = [...visible];
        for (let index = 0; index < files.length; index += 24) {
          checkTime();
          const batch = await Promise.all(files.slice(index, index + 24).map(async file => {
            try { return [file, overlay.get(file) ?? await this.workspace.read(file)]; }
            catch { coverage.omitted++; coverage.complete = false; return null; }
          }));
          for (const item of batch.filter(Boolean)) {
            scan(item[0], item[1]); coverage.files++;
            if (matches.length >= this.maxMatches || coverage.bytes >= this.maxBytes) break;
          }
          if (matches.length >= this.maxMatches || coverage.bytes >= this.maxBytes) break;
        }
      }
    } catch (error) {
      signal.throwIfAborted();
      if (!deadline.aborted && error.name !== 'TimeoutError') throw error;
      coverage.complete = false; coverage.reason = 'deadline';
    }
    if (coverage.bytes >= this.maxBytes || matches.length >= this.maxMatches) {
      coverage.complete = false; coverage.reason ??= coverage.bytes >= this.maxBytes ? 'byte-limit' : 'match-limit';
    }
    if (coverage.omitted) coverage.reason ??= 'unreadable-or-excluded-input';
    matches.sort((left, right) => (mode === 'keywords'
      ? (keywordScores.get(right.file + ':' + right.line) ?? 0) - (keywordScores.get(left.file + ':' + left.line) ?? 0) : 0)
      || left.file.localeCompare(right.file) || left.line - right.line);
    const unique = [...new Map(matches.map(hit => [hit.file + ':' + hit.line, hit])).values()].slice(0, this.maxMatches);
    const key = digest([query, mode, glob ?? null, unique, coverage.complete]);
    let offset = 0;
    if (cursor) {
      let saved;
      try { saved = JSON.parse(Buffer.from(cursor, 'base64url').toString()); } catch { throw new Error('Invalid search cursor.'); }
      if (saved.key !== key || !Number.isInteger(saved.offset) || saved.offset < 0 || saved.offset > unique.length) throw new Error('Search results changed. Start a new search.');
      offset = saved.offset;
    }
    return { matches: unique.slice(offset, offset + limit), coverage,
      nextCursor: offset + limit < unique.length ? Buffer.from(JSON.stringify({ key, offset: offset + limit })).toString('base64url') : null };
  }
}

module.exports = { FreshSearch, searchExecutable, draftOverlay };

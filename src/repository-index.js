const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { digest } = require('./permissions');
const { safePath } = require('./workspace');

const VERSION = 1;
const HASH = /^[a-f0-9]{64}$/;

// Rebuildable source cache. It stores no permissions and never supplies edit receipts.
class RepositoryIndex {
  constructor(workspace, storage, { maxFiles = 20000, maxBytes = 256000000, timeoutMs = 4500, onStatus = () => {} } = {}) {
    Object.assign(this, { workspace, maxFiles, maxBytes, timeoutMs, onStatus });
    this.directory = path.join(storage, 'repository-index', digest([workspace.root, VERSION]).slice(0, 24));
    this.entries = new Map(); this.bodies = new Map(); this.invalid = new Set();
    this.dirty = new Set(); this.pending = new Set(); this.generation = 0; this.loaded = false; this.queue = Promise.resolve();
  }
  invalidate(file) {
    try {
      safePath(file); this.pending.add(file);
      this.debounce ??= setTimeout(() => this.flushEvents(), 40);
      this.debounce.unref?.();
    } catch { /* Always excluded. */ }
  }
  flushEvents() {
    clearTimeout(this.debounce); this.debounce = undefined;
    for (const file of this.pending) this.invalid.add(file);
    this.pending.clear();
  }
  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const stat = await fs.stat(path.join(this.directory, 'inventory.json'));
      if (stat.size > 8000000) throw new Error('Index inventory exceeds its quota.');
      const value = JSON.parse(await fs.readFile(path.join(this.directory, 'inventory.json'), 'utf8'));
      if (value.version !== VERSION || value.root !== this.workspace.root || !Array.isArray(value.entries) || value.entries.length > this.maxFiles) throw new Error('Invalid index inventory.');
      const entries = new Map();
      for (const entry of value.entries) {
        safePath(entry.file);
        if (!HASH.test(entry.hash) || typeof entry.stamp !== 'string' || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > 256000) throw new Error('Invalid index entry.');
        entries.set(entry.file, entry);
      }
      let bytes = 0;
      for (const shard of new Set([...entries.values()].map(entry => entry.hash.slice(0, 2)))) {
        const file = path.join(this.directory, shard + '.json');
        if ((await fs.stat(file)).size > 16000000) throw new Error('Index shard exceeds its quota.');
        const values = JSON.parse(await fs.readFile(file, 'utf8'));
        if (!values || Array.isArray(values) || typeof values !== 'object') throw new Error('Invalid index shard.');
        for (const [hash, text] of Object.entries(values)) {
          if (!HASH.test(hash) || !hash.startsWith(shard) || typeof text !== 'string' || text.length > 256000 || text.includes('\0') || digest(text) !== hash) throw new Error('Corrupt index content.');
          bytes += Buffer.byteLength(text);
          if (bytes > this.maxBytes) throw new Error('Index exceeds its byte quota.');
          this.bodies.set(hash, text);
        }
      }
      this.entries = entries; this.branch = value.branch; this.generation = value.generation ?? 0;
    } catch {
      this.entries.clear(); this.bodies.clear(); this.rebuilt = true;
    }
  }
  async save(signal) {
    signal.throwIfAborted();
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const write = async (file, value) => {
      const temporary = `${file}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, file); }
      finally { await fs.rm(temporary, { force: true }); }
    };
    for (const shard of this.dirty) {
      signal.throwIfAborted();
      const values = Object.fromEntries([...this.bodies].filter(([hash]) => hash.startsWith(shard)));
      const file = path.join(this.directory, shard + '.json');
      await write(file, values);
    }
    const file = path.join(this.directory, 'inventory.json');
    await write(file, { version: VERSION, root: this.workspace.root, branch: this.branch,
      generation: this.generation, entries: [...this.entries.values()] });
    this.dirty.clear();
  }
  snapshot(signal) {
    const next = this.queue.then(() => this.refresh(signal));
    this.queue = next.catch(() => {});
    return next;
  }
  async refresh(signal) {
    signal.throwIfAborted();
    await this.load();
    this.flushEvents();
    const started = Date.now();
    const branch = await this.workspace.gitRevision(signal).catch(() => null);
    signal.throwIfAborted();
    if (this.branch !== branch) { this.entries.clear(); this.invalid.clear(); }
    this.branch = branch;
    const paths = await this.workspace.paths(signal, { limit: this.maxFiles + 1 });
    const files = paths.slice(0, this.maxFiles);
    const inventory = new Set(files);
    for (const file of this.entries.keys()) if (!inventory.has(file)) this.entries.delete(file);
    const coverage = { complete: paths.length <= this.maxFiles, files: files.length, indexed: 0, bytes: 0,
      excludedOrUnreadable: 0, oversized: 0, unindexed: Math.max(0, paths.length - this.maxFiles),
      sourceReads: 0, cacheHits: 0, bufferOverlays: 0, rebuilt: Boolean(this.rebuilt), generation: ++this.generation };
    const output = [];
    let processed = 0;
    for (let index = 0; index < files.length; index += 48) {
      signal.throwIfAborted();
      if (Date.now() - started >= this.timeoutMs) { coverage.complete = false; coverage.reason = 'deadline'; break; }
      const batch = await Promise.all(files.slice(index, index + 48).map(async file => {
        try {
          const full = await this.workspace.resolve(file);
          const stat = await fs.stat(full, { bigint: true });
          if (stat.size > 256000n) { coverage.oversized++; return; }
          const stamp = [stat.size, stat.mtimeNs, stat.ctimeNs, stat.ino, stat.dev].join(':');
          let entry = this.entries.get(file);
          let text = entry && entry.stamp === stamp && !this.invalid.has(file) ? this.bodies.get(entry.hash) : undefined;
          if (text === undefined) {
            // Do not persist dirty buffers. Read the disk through a separate Workspace view.
            const { Workspace } = require('./workspace');
            const disk = new Workspace(this.workspace.root, () => undefined, this.workspace.findPaths);
            disk.identity = this.workspace.identity;
            text = await disk.read(file);
            coverage.sourceReads++;
            const after = await fs.stat(full, { bigint: true });
            if ([after.size, after.mtimeNs, after.ctimeNs, after.ino, after.dev].join(':') !== stamp) { this.invalid.add(file); return; }
            entry = { file, stamp, hash: digest(text), bytes: Buffer.byteLength(text) };
          } else coverage.cacheHits++;
          const open = this.workspace.openText(full);
          if (typeof open === 'string') { if (open.length > 256000 || open.includes('\0')) throw new Error('Invalid open buffer.'); coverage.bufferOverlays++; }
          return { entry, text, visible: typeof open === 'string' ? open : text };
        } catch { coverage.excludedOrUnreadable++; this.entries.delete(file); }
      }));
      processed += batch.length;
      for (const item of batch.filter(Boolean)) {
        const { entry, text, visible } = item;
        const bytes = Buffer.byteLength(visible);
        if (coverage.bytes + bytes > this.maxBytes) { coverage.complete = false; coverage.reason = 'byte-limit'; continue; }
        if (!this.bodies.has(entry.hash)) { this.bodies.set(entry.hash, text); this.dirty.add(entry.hash.slice(0, 2)); }
        this.entries.set(entry.file, entry); this.invalid.delete(entry.file);
        output.push({ path: entry.file, text: visible, contentHash: digest(visible) });
        coverage.bytes += bytes; coverage.indexed++;
      }
      this.onStatus({ ...coverage, elapsedMs: Date.now() - started });
    }
    coverage.unindexed += files.length - coverage.indexed;
    coverage.complete &&= !coverage.unindexed;
    let cachedBytes = 0;
    const keptHashes = new Set();
    for (const [file, entry] of this.entries) {
      if (keptHashes.has(entry.hash)) continue;
      if (cachedBytes + entry.bytes > this.maxBytes) { this.entries.delete(file); continue; }
      cachedBytes += entry.bytes; keptHashes.add(entry.hash);
    }
    const retained = new Set([...this.entries.values()].map(entry => entry.hash));
    for (const hash of this.bodies.keys()) if (!retained.has(hash)) { this.bodies.delete(hash); this.dirty.add(hash.slice(0, 2)); }
    // A partial pass retains only entries checked in this generation for returned results.
    coverage.processed = processed;
    this.status = { ...coverage, elapsedMs: Date.now() - started };
    this.onStatus(this.status);
    try { await this.save(signal); } catch (error) { signal.throwIfAborted(); this.status.cacheError = true; }
    this.rebuilt = false;
    return { files: output, coverage: this.status };
  }
  async clear() {
    await this.queue;
    this.flushEvents();
    this.entries.clear(); this.bodies.clear(); this.invalid.clear(); this.dirty.clear();
    this.loaded = true; this.rebuilt = true;
    await fs.rm(this.directory, { recursive: true, force: true });
  }
  dispose() { clearTimeout(this.debounce); }
}

module.exports = { RepositoryIndex };

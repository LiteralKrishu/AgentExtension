const { digest } = require('./permissions');
const fs = require('node:fs/promises');
const path = require('node:path');

// Experimental and never created by the normal search path. Setup must name a local destination.
class EmbeddingProvider {
  constructor({ endpoint, model, timeoutMs = 30000 } = {}) {
    const url = URL.parse(endpoint);
    if (!url || url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/embeddings')) throw new Error('Explicitly configure a loopback HTTP embeddings endpoint.');
    if (typeof model !== 'string' || !model.length || model.length > 200) throw new Error('Configure the embedding model.');
    Object.assign(this, { endpoint: url.href, model, timeoutMs, requests: 0, characters: 0 });
  }
  async embed(texts, signal = new AbortController().signal) {
    if (!Array.isArray(texts) || !texts.length || texts.length > 8 || texts.some(text => typeof text !== 'string' || !text.length || text.length > 6000)) throw new Error('Embed one to eight non-empty excerpts of at most 6000 characters.');
    signal.throwIfAborted();
    const response = await fetch(this.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: this.model, input: texts }) });
    this.requests++; this.characters += texts.reduce((n, text) => n + text.length, 0);
    if (!response.ok) throw new Error('The local embedding provider could not complete the request.');
    if (Number(response.headers.get('content-length')) > 2000000) throw new Error('Embedding response exceeds its quota.');
    const reader = response.body.getReader(); let size = 0; const chunks = [];
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 2000000) throw new Error('Embedding response exceeds its quota.');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!Array.isArray(result.data) || result.data.length !== texts.length) throw new Error('Invalid embedding result count.');
    const ordered = [...result.data].sort((a,b) => a.index - b.index);
    const dimension = ordered[0]?.embedding?.length;
    if (!Number.isInteger(dimension) || dimension < 1 || dimension > 4096 || this.dimension && dimension !== this.dimension) throw new Error('Incompatible embedding dimensions.');
    const vectors = ordered.map((item, index) => {
      if (item.index !== index || !Array.isArray(item.embedding) || item.embedding.length !== dimension || item.embedding.some(value => !Number.isFinite(value))) throw new Error('Invalid embedding vector.');
      const norm = Math.hypot(...item.embedding);
      if (!norm) throw new Error('Embedding vectors must be non-zero.');
      return item.embedding.map(value => value / norm);
    });
    this.dimension = dimension;
    return vectors;
  }
  key(content, scope) {
    if (!this.dimension) throw new Error('Resolve embedding dimensions before storing vectors.');
    return digest({ schema: 1, endpoint: this.endpoint, model: this.model, dimension: this.dimension, content: digest(content), scope });
  }
}

function similarity(first, second) {
  if (first.length !== second.length) throw new Error('Incompatible embedding dimensions.');
  return first.reduce((sum, value, i) => sum + value * second[i], 0);
}

class VectorCache {
  constructor(file, namespace) { this.file = file; this.namespace = digest(namespace); }
  async load(activeKeys) {
    try {
      if ((await fs.stat(this.file)).size > 16000000) return new Map();
      const value = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (value.schema !== 1 || value.namespace !== this.namespace || !Array.isArray(value.records)) return new Map();
      const allowed = new Set(activeKeys);
      return new Map(value.records.filter(([key, vector]) => allowed.has(key) && /^[a-f0-9]{64}$/.test(key) && Array.isArray(vector) && vector.length <= 4096 && vector.every(Number.isFinite)));
    } catch { return new Map(); }
  }
  async replace(records) {
    if (!(records instanceof Map) || records.size > 10000) throw new Error('Vector cache quota reached.');
    const text = JSON.stringify({ schema: 1, namespace: this.namespace, records: [...records] });
    if (Buffer.byteLength(text) > 16000000) throw new Error('Vector cache quota reached.');
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.file + '.tmp', text, { mode: 0o600 });
    await fs.rename(this.file + '.tmp', this.file);
  }
}

module.exports = { EmbeddingProvider, similarity, VectorCache };

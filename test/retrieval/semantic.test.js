const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EmbeddingProvider, similarity, VectorCache } = require('../../src/embedding-provider');
const { digest } = require('../../src/permissions');
const { packCandidates } = require('./semantic.cjs');

test('semantic retrieval requires explicit local setup and keys vectors by destination, model, scope and version', async t => {
  for (const endpoint of [undefined, 'https://example.com/embeddings', 'http://127.0.0.1.example.com/embeddings', 'http://user:password@localhost/embeddings']) assert.throws(() => new EmbeddingProvider({ endpoint, model: 'local' }));
  let dimensions = 2;
  const server = http.createServer(async (req,res) => {
    const parts = []; for await (const chunk of req) parts.push(chunk);
    const { input } = JSON.parse(Buffer.concat(parts));
    res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: dimensions === 2 ? [3,4] : [1,2,3] })) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const provider = new EmbeddingProvider({ endpoint: `http://127.0.0.1:${server.address().port}/embeddings`, model: 'local' });
  const [vector] = await provider.embed(['public fixture']);
  assert.deepEqual(vector, [.6,.8]);
  assert.equal(similarity(vector, vector), 1);
  assert.notEqual(provider.key('public fixture', 'scope-a'), provider.key('public fixture', 'scope-b'));
  assert.notEqual(provider.key('public fixture', 'scope-a'), provider.key('changed', 'scope-a'));
  dimensions = 3;
  await assert.rejects(provider.embed(['public fixture']), /dimensions/);
});

test('offline embedding, cancellation and invalid payloads fail without changing ordinary retrieval', async () => {
  const provider = new EmbeddingProvider({ endpoint: 'http://127.0.0.1:1/v1/embeddings', model: 'local', timeoutMs: 20 });
  await assert.rejects(provider.embed([]));
  await assert.rejects(provider.embed(['public fixture']));
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(provider.embed(['public fixture'], cancelled.signal), { name: 'AbortError' });
  assert.equal(require('../../src/context').assemble([{ path: 'a.js', text: 'function lookup() {}' }], 'lookup').selected[0].file, 'a.js');
});

test('vector cache removes excluded content and rebuilds on namespace or corrupt-cache changes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-vectors-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'vectors.json');
  const cache = new VectorCache(file, { model: 'local', dimension: 2, scope: 'one' });
  const first = digest('first'); const second = digest('excluded');
  await cache.replace(new Map([[first, [1,0]], [second, [0,1]]]));
  const active = await cache.load([first]);
  await cache.replace(active);
  assert.equal((await cache.load([first, second])).size, 1);
  assert.equal((await new VectorCache(file, { model: 'other', dimension: 2, scope: 'one' }).load([first])).size, 0);
  await fs.writeFile(file, '{invalid');
  assert.equal((await cache.load([first])).size, 0);
});

test('semantic ablations pack candidate files within the same character limit', () => {
  const files=Array.from({length:10},(_,i)=>({path:`file-${i}.js`,text:'a'.repeat(3000)}));
  const result=packCandidates(files.map(file=>file.path),files,12000);
  assert.ok(result.characters<=12000); assert.ok(result.selected.length<10);
  assert.deepEqual(packCandidates(['missing'],files),{selected:[],characters:0});
});

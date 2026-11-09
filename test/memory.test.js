const assert = require('node:assert/strict');
const { test } = require('node:test');
const { WorkspaceMemory } = require('../src/memory');

test('approved memory persists only for its workspace and removal affects the next run', async () => {
  const values = new Map();
  const storage = { get: (key, fallback) => values.get(key) ?? fallback,
    update: async (key, value) => values.set(key, value) };
  const a = new WorkspaceMemory(storage, '/a');
  const b = new WorkspaceMemory(storage, '/b');
  const note = await a.save('Use node tests.');
  assert.deepEqual(b.list(), []);
  assert.equal(new WorkspaceMemory(storage, '/a').list()[0].text, 'Use node tests.');
  const copy = a.list();
  copy[0].text = 'changed externally';
  assert.equal(a.list()[0].text, 'Use node tests.');
  await a.remove(note.id);
  assert.deepEqual(a.list(), []);
  await assert.rejects(a.save(''));
  await assert.rejects(a.save('x'.repeat(2001)));
  for (let i = 0; i < 4; i++) await a.save('x'.repeat(2000));
  await assert.rejects(a.save('more'), /full/);
});

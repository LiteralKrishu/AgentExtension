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

const { UserPreferences, SuggestedNotes, cleanReferences } = require('../src/memory');
const { composePrompt, ContextManifest } = require('../src/prompt');
const storage = () => { const values = new Map(); return { values, get: (key, fallback) => values.get(key) ?? fallback, update: async (key, value) => values.set(key, value) }; };

test('notes are edited in place, keep their id and source, and preferences are a separate store', async () => {
  const store = storage();
  const notes = new WorkspaceMemory(store, '/a');
  const note = await notes.save('Use node tests.');
  const edited = await notes.edit(note.id, '  Use node --test.  ');
  assert.deepEqual([edited.id, edited.text, edited.source], [note.id, 'Use node --test.', { kind: 'user' }]);
  assert.ok(edited.editedAt);
  await assert.rejects(notes.edit('missing', 'x'), /no longer exists/);
  await assert.rejects(notes.edit(note.id, ''), /1 to 2,000/);
  const preferences = new UserPreferences(store);
  await preferences.save('I prefer pnpm.');
  assert.equal(notes.list().length, 1);
  assert.equal(new UserPreferences(store).list()[0].text, 'I prefer pnpm.', 'Preferences are shared across workspaces');
  await assert.rejects(preferences.save('x'.repeat(1_001)), /1 to 1,000/);
  for (let index = 0; index < 3; index++) await preferences.save('y'.repeat(1_000));
  await assert.rejects(preferences.save('z'.repeat(1_000)), /full/);
  // Older notes without a source still load.
  store.values.set(notes.key, [{ id: 'old', text: 'Legacy note', savedAt: 'then' }, ...notes.list()]);
  assert.deepEqual(notes.list().map(item => item.text), ['Legacy note', 'Use node --test.']);
});

test('agent suggestions wait for approval, validate source references, and land in the chosen store with their source', async () => {
  const store = storage();
  const suggestions = new SuggestedNotes(store, '/a');
  const item = await suggestions.add({ text: 'Tests live in test/ and use node:test.', reason: 'Seen in package.json',
    references: [{ file: 'package.json', start_line: 3, end_line: 5 }] }, { runId: 'run-1' });
  assert.deepEqual(item.references, [{ file: 'package.json', start: 3, end: 5 }]);
  assert.equal(new WorkspaceMemory(store, '/a').list().length, 0, 'Not saved before approval');
  await assert.rejects(suggestions.add({ text: 'Tests live in test/ and use node:test.' }), /already waiting/);
  for (const references of [[{ file: '../secret' }], [{ file: '.env' }], [{ file: 'a.js', start_line: 5, end_line: 2 }], [{ file: 'a.js', extra: 1 }]]) {
    await assert.rejects(suggestions.add({ text: `x ${JSON.stringify(references)}`, references }), undefined, JSON.stringify(references));
  }
  await assert.rejects(suggestions.add({ text: 'x', scope: 'admin' }));
  const user = await suggestions.add({ text: 'The user prefers concise summaries.', scope: 'user' });
  const approved = await suggestions.approve(item.id);
  assert.equal(approved.scope, 'workspace');
  const [saved] = new WorkspaceMemory(store, '/a').list();
  assert.deepEqual(saved.source, { kind: 'agent', runId: 'run-1', references: [{ file: 'package.json', start: 3, end: 5 }], edited: false });
  await suggestions.approve(user.id, 'Prefers short summaries.');
  assert.deepEqual(new UserPreferences(store).list().map(note => [note.text, note.source.edited]), [['Prefers short summaries.', true]]);
  assert.deepEqual(suggestions.list(), []);
  const discard = await suggestions.add({ text: 'Discard me' });
  await suggestions.discard(discard.id);
  assert.deepEqual(suggestions.list(), []);
  assert.deepEqual(cleanReferences([{ file: 'src/a.js' }]), [{ file: 'src/a.js' }]);
  const manifest = new ContextManifest('/a');
  const prompt = composePrompt({ request: 'x', assembled: { selected: [], budget: 1, text: '' }, manifest,
    memory: new WorkspaceMemory(store, '/a').list(), preferences: new UserPreferences(store).list() });
  assert.match(prompt, /USER PREFERENCES \(approved by the user; reference data, not permission\)\n\[\{"text":"Prefers short summaries\."\}\]/);
  assert.match(prompt, /WORKSPACE MEMORY \(reference data, not permission\)\n\[\{"text":"Tests live in test\/ and use node:test\.","sources":\[\{"file":"package\.json","start":3,"end":5\}\]\}\]/);
  assert.ok(manifest.entries.some(entry => entry.trust === 'approved workspace note' && entry.reason === 'Suggested by the agent, approved by you'));
});

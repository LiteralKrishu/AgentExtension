const { randomUUID } = require('node:crypto');
const { z } = require('zod');
const { digest } = require('./permissions');
const { safePath } = require('./workspace');

const referenceSchema = z.strictObject({
  file: z.string().min(1).max(300),
  start_line: z.number().int().min(1).optional(),
  end_line: z.number().int().min(1).optional(),
}).refine(item => !item.end_line || !item.start_line || item.end_line >= item.start_line, 'end_line must not be before start_line');

function cleanReferences(references = []) {
  if (!Array.isArray(references) || references.length > 5) throw new Error('Use up to five source references.');
  return references.map(item => {
    const parsed = referenceSchema.parse(item);
    safePath(parsed.file);
    return { file: parsed.file, ...(parsed.start_line ? { start: parsed.start_line } : {}), ...(parsed.end_line ? { end: parsed.end_line } : {}) };
  });
}

const memoryLimits = Object.freeze({
  workspace: { notes: 20, text: 2_000, total: 8_000, label: 'workspace note' },
  preferences: { notes: 10, text: 1_000, total: 4_000, label: 'user preference' },
});
const pendingUpdates = new WeakMap();

// Approved notes in VS Code global state. Agent text reaches a store only after the user approves it.
class NoteStore {
  constructor(storage, key, { notes, text, total, label }) {
    this.storage = storage;
    this.key = key;
    this.limits = { notes, text, total };
    this.label = label;
  }
  record() {
    const value = this.storage.get(this.key, []);
    return Array.isArray(value) ? { notes: value } : value && Array.isArray(value.notes) ? value : { notes: [] };
  }
  write(notes, sync = this.record().sync) {
    return this.storage.update(this.key, sync ? { notes, sync } : notes);
  }
  locked(operation) {
    let queue = pendingUpdates.get(this.storage);
    if (!queue) pendingUpdates.set(this.storage, queue = new Map());
    const result = (queue.get(this.key) ?? Promise.resolve()).catch(() => {}).then(operation);
    queue.set(this.key, result);
    return result.finally(() => { if (queue.get(this.key) === result) queue.delete(this.key); });
  }
  list() {
    const { notes } = this.record();
    let size = 0;
    return notes.filter(note => {
      if (typeof note?.id !== 'string' || typeof note.text !== 'string' || note.text.length > this.limits.text) return false;
      size += note.text.length;
      return size <= this.limits.total;
    }).slice(0, this.limits.notes).map(note => structuredClone(note));
  }
  check(notes, value, replacing = 0) {
    if (!value || value.length > this.limits.text) throw new Error(`Use 1 to ${this.limits.text.toLocaleString('en-US')} characters for a ${this.label}.`);
    if (notes.reduce((sum, note) => sum + note.text.length, 0) - replacing + value.length > this.limits.total) {
      throw new Error(`${this.label[0].toUpperCase()}${this.label.slice(1)}s are full. Remove one first.`);
    }
  }
  save(text, source = { kind: 'user' }) { return this.locked(() => this.saveNote(text, source)); }
  async saveNote(text, source) {
    const notes = this.list();
    const value = typeof text === 'string' ? text.trim() : '';
    if (notes.length >= this.limits.notes) throw new Error(`${this.label[0].toUpperCase()}${this.label.slice(1)}s are full. Remove one first.`);
    this.check(notes, value);
    const note = { id: randomUUID(), text: value, savedAt: new Date().toISOString(), source };
    await this.write([...notes, note]);
    return note;
  }
  edit(id, text, expected) { return this.locked(() => this.editNote(id, text, expected)); }
  async editNote(id, text, expected) {
    const notes = this.list();
    const index = notes.findIndex(note => note.id === id);
    if (index < 0) throw new Error(`This ${this.label} no longer exists.`);
    if (expected && digest(notes[index]) !== digest(expected)) throw new Error(`This ${this.label} changed. Open Notes and try again.`);
    const value = typeof text === 'string' ? text.trim() : '';
    this.check(notes, value, notes[index].text.length);
    notes[index] = { ...notes[index], text: value, editedAt: new Date().toISOString() };
    await this.write(notes);
    return notes[index];
  }
  summaryLimit(notes) {
    return Math.min(this.limits.text, notes.reduce((size, note) => size + note.text.length, 0) - 1);
  }
  combine(selected, text) { return this.locked(() => this.combineNotes(selected, text)); }
  async combineNotes(selected, text) {
    const expected = new Map(selected.map(note => [note.id, digest(note)]));
    if (expected.size < 2) throw new Error('Select at least two notes to summarize.');
    const notes = this.list();
    const originals = notes.filter(note => expected.has(note.id));
    if (originals.length !== expected.size || originals.some(note => digest(note) !== expected.get(note.id))) {
      throw new Error('The selected notes changed. Open Notes and select them again.');
    }
    const remaining = notes.filter(note => !expected.has(note.id));
    const value = typeof text === 'string' ? text.trim() : '';
    if (value.length > this.summaryLimit(originals)) throw new Error('Write a shorter summary to free storage space.');
    this.check(remaining, value);
    const references = new Map(originals.flatMap(note => note.source?.references ?? []).map(ref => [digest(ref), ref]));
    const source = { kind: 'user', ...(references.size ? { references: [...references.values()].slice(0, 5) } : {}) };
    const summary = { id: randomUUID(), text: value, savedAt: new Date().toISOString(), source };
    remaining.splice(notes.indexOf(originals[0]), 0, summary);
    await this.write(remaining);
    return summary;
  }
  remove(id, expected) {
    return this.locked(() => {
      const notes = this.list();
      const current = notes.find(note => note.id === id);
      if (expected && (!current || digest(current) !== digest(expected))) throw new Error(`This ${this.label} changed. Open Notes and try again.`);
      return this.write(notes.filter(note => note.id !== id));
    });
  }
}

class WorkspaceMemory extends NoteStore {
  constructor(storage, workspace) {
    super(storage, `memory.v1.${digest(workspace)}`, memoryLimits.workspace);
  }
}

// Preferences about the user that apply in every workspace.
class UserPreferences extends NoteStore {
  constructor(storage) {
    super(storage, 'preferences.v1', memoryLimits.preferences);
  }
}

const suggestionSchema = z.strictObject({
  text: z.string().trim().min(1).max(1_000),
  scope: z.enum(['workspace', 'user']).default('workspace'),
  reason: z.string().trim().max(300).default(''),
  references: z.array(z.unknown()).max(5).default([]),
});

// Notes the agent proposed. They are never sent to a model. Approval copies one into its target store.
class SuggestedNotes {
  constructor(storage, workspace) {
    this.storage = storage;
    this.workspace = workspace;
    this.key = `suggestions.v1.${digest(workspace)}`;
  }
  list() {
    const items = this.storage.get(this.key, []);
    return Array.isArray(items) ? items.filter(item => typeof item?.id === 'string' && typeof item.text === 'string').slice(0, 20).map(item => structuredClone(item)) : [];
  }
  async add(input, { runId, session } = {}) {
    const parsed = suggestionSchema.parse(input);
    const references = cleanReferences(parsed.references);
    const items = this.list();
    if (items.length >= 20) throw new Error('Twenty suggested notes are waiting for review. Ask the user to review them first.');
    if (items.some(item => item.text === parsed.text && item.scope === parsed.scope)) throw new Error('This note is already waiting for review.');
    const item = { id: randomUUID(), text: parsed.text, scope: parsed.scope, reason: parsed.reason, references, runId, session,
      suggestedAt: new Date().toISOString() };
    await this.storage.update(this.key, [...items, item]);
    return item;
  }
  async discard(id) { await this.storage.update(this.key, this.list().filter(item => item.id !== id)); }
  async approve(id, text) {
    const item = this.list().find(entry => entry.id === id);
    if (!item) throw new Error('This suggestion no longer exists.');
    const store = item.scope === 'user' ? new UserPreferences(this.storage) : new WorkspaceMemory(this.storage, this.workspace);
    const note = await store.save(text ?? item.text, { kind: 'agent', runId: item.runId, references: item.references, edited: text !== undefined && text.trim() !== item.text });
    await this.discard(id);
    return { note, scope: item.scope };
  }
}

module.exports = { WorkspaceMemory, UserPreferences, SuggestedNotes, NoteStore, cleanReferences, memoryLimits };

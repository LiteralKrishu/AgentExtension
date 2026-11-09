const { randomUUID } = require('node:crypto');
const { digest } = require('./permissions');

class WorkspaceMemory {
  constructor(storage, workspace) {
    this.storage = storage;
    this.key = `memory.v1.${digest(workspace)}`;
  }
  list() {
    const notes = this.storage.get(this.key, []);
    if (!Array.isArray(notes)) return [];
    let size = 0;
    return notes.filter(note => {
      if (typeof note?.id !== 'string' || typeof note.text !== 'string' || note.text.length > 2_000) return false;
      size += note.text.length;
      return size <= 8_000;
    }).slice(0, 20).map(note => ({ ...note }));
  }
  async save(text) {
    const notes = this.list();
    const value = typeof text === 'string' ? text.trim() : '';
    if (!value || value.length > 2_000) throw new Error('Use 1 to 2,000 characters for a workspace note.');
    if (notes.length >= 20 || notes.reduce((sum, note) => sum + note.text.length, 0) + value.length > 8_000) {
      throw new Error('Workspace memory is full. Remove a note first.');
    }
    const note = { id: randomUUID(), text: value, savedAt: new Date().toISOString() };
    await this.storage.update(this.key, [...notes, note]);
    return note;
  }
  async remove(id) {
    await this.storage.update(this.key, this.list().filter(note => note.id !== id));
  }
}

module.exports = { WorkspaceMemory };

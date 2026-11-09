const { diffLines } = require('diff');

const MAX_TEXT = 256_000;

function matchLineEndings(value, base) {
  return value.replace(/\r?\n/g, base?.includes('\r\n') ? '\r\n' : '\n');
}

function splitHunks(before, after) {
  const parts = diffLines(before, after, { timeout: 500 });
  if (!parts) throw new Error('The edit is too large to compare. Propose a smaller edit.');
  const hunks = [];
  let offset = 0;
  let line = 1;
  let current;
  for (const part of parts) {
    if (!part.added && !part.removed) {
      if (current) hunks.push(current);
      current = undefined;
      offset += part.value.length;
      line += part.count;
      continue;
    }
    current ??= { offset, line, before: '', after: '' };
    if (part.removed) {
      current.before += part.value;
      offset += part.value.length;
      line += part.count;
    } else {
      current.after += part.value;
    }
  }
  if (current) hunks.push(current);
  return hunks;
}

function applyHunks(text, hunks) {
  let result = '';
  let offset = 0;
  for (const hunk of hunks) {
    if (hunk.offset < offset || text.slice(hunk.offset, hunk.offset + hunk.before.length) !== hunk.before) {
      throw new Error('The file changed since review. Start a new run.');
    }
    result += text.slice(offset, hunk.offset) + hunk.after;
    offset = hunk.offset + hunk.before.length;
  }
  return result + text.slice(offset);
}

class Draft {
  constructor(read, selection) {
    this.read = read;
    this.selection = selection;
    this.files = new Map();
    this.revision = 0;
  }

  async replace(file, oldText, newText) {
    if (!oldText) throw new Error('old_text must contain the exact text to replace.');
    const entry = this.files.get(file);
    const base = entry ? entry.base : await this.read(file);
    const latest = this.files.get(file);
    const selection = this.selection;
    if (selection && (file !== selection.file || base !== selection.base)) {
      throw new Error('Inline edits are limited to the original selection.');
    }
    const previous = latest?.text ?? (selection ? base.slice(selection.start, selection.end) : base);
    const old = matchLineEndings(oldText, base);
    const offset = previous.indexOf(old);
    if (offset < 0 || previous.indexOf(old, offset + 1) >= 0) {
      throw new Error('old_text must match exactly once. Read the current draft and include more surrounding text.');
    }
    const text = previous.slice(0, offset) + matchLineEndings(newText, base) + previous.slice(offset + old.length);
    this.stage(file, base, text);
  }

  async replaceRange(file, expected, start, end, replacement) {
    if (this.selection) throw new Error('Use propose_write to edit the original inline selection.');
    const entry = this.files.get(file);
    const base = entry ? entry.base : await this.read(file);
    const previous = this.current(file, base);
    if (previous !== expected) throw new Error('The file draft changed. Read the target lines again.');
    this.stage(file, base, previous.slice(0, start) + matchLineEndings(replacement, base) + previous.slice(end));
  }

  async create(file, text) {
    if (this.selection) throw new Error('Inline edits cannot create files.');
    await this.read(file, true);
    if (this.files.has(file)) throw new Error('The file is already staged.');
    this.stage(file, null, text);
  }

  stage(file, base, text) {
    if (text.length > MAX_TEXT) throw new Error('The proposed file is too large.');
    if (!this.files.has(file) && this.files.size >= 24) throw new Error('A run can stage at most 24 files.');
    const start = this.selection?.start ?? 0;
    const before = this.selection ? base.slice(start, this.selection.end) : base ?? '';
    const firstLine = this.selection ? base.slice(0, start).split('\n').length - 1 : 0;
    const hunks = splitHunks(before, text).map(hunk => ({
      ...hunk, offset: hunk.offset + start, line: hunk.line + firstLine,
    }));
    if (base === null && !hunks.length) throw new Error('Supply text for the new file.');
    if (hunks.length > 100) throw new Error('This file has too many changes to review in one run.');
    if (hunks.length) this.files.set(file, { base, text, hunks });
    else this.files.delete(file);
    this.revision++;
  }

  current(file, base) {
    const entry = this.files.get(file);
    if (!entry) return base;
    if (!this.selection) return entry.text;
    return base.slice(0, this.selection.start) + entry.text + base.slice(this.selection.end);
  }

  review() {
    return [...this.files].flatMap(([file, entry]) => entry.hunks.map((hunk, index) => ({
      ...hunk, file, id: `${this.revision}:${file}:${index}`, newFile: entry.base === null,
    })));
  }

  changes(hunks) {
    const approved = new Set(hunks.map(hunk => hunk.id));
    return [...this.files].flatMap(([file, entry]) => {
      const picked = entry.hunks.filter((_, index) => approved.has(`${this.revision}:${file}:${index}`));
      return picked.length ? [{ file, before: entry.base, after: applyHunks(entry.base ?? '', picked), hunks: picked }] : [];
    });
  }
}

module.exports = { Draft, applyHunks, splitHunks, MAX_TEXT };

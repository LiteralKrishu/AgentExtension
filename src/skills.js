const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { parseDocument } = require('yaml');
const { digest } = require('./permissions');

const MAX_SKILL = 24_000;
const MAX_RESOURCE = 8_000;

async function readWithin(root, relative, limit) {
  if (!relative || relative.includes('\\') || relative.includes('\0') || relative.includes(':')
      || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Use a skill-relative path.');
  let full = root;
  for (const part of relative.split('/')) {
    full = path.join(full, part);
    if ((await fs.lstat(full)).isSymbolicLink()) throw new Error('Skill symlinks are not allowed.');
  }
  const handle = await fs.open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('Skill file exceeds its size limit.');
    const bytes = await handle.readFile();
    if (bytes.length > limit) throw new Error('Skill file exceeds its size limit.');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\0')) throw new Error('Skill resources must be text.');
    return text;
  } finally { await handle.close(); }
}

function parseSkill(text, folder) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match || match[1].length > 4_000) throw new Error('Skill needs bounded YAML frontmatter.');
  const document = parseDocument(match[1], { uniqueKeys: true });
  if (document.errors.length) throw new Error('Invalid skill metadata.');
  const meta = document.toJS({ maxAliasCount: 0 });
  if (!meta || typeof meta.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta.name)
      || meta.name.length > 64 || meta.name !== folder || typeof meta.description !== 'string'
      || !meta.description.trim() || meta.description.length > 1024) throw new Error('Invalid skill name or description.');
  if (meta.enabled === false) throw new Error('Skill is disabled.');
  return { name: meta.name, description: meta.description, body: text.slice(match[0].length),
    explicitOnly: meta['disable-model-invocation'] === true || meta.allow_implicit_invocation === false };
}

class SkillRegistry {
  constructor(roots) {
    this.roots = roots.slice(0, 8);
    this.entries = new Map();
    this.selected = new Map();
    this.warnings = [];
  }

  async discover() {
    this.entries.clear();
    this.selected.clear();
    this.warnings = [];
    let metadataSize = 0;
    for (const input of this.roots) {
      try {
        const root = await fs.realpath(input);
        const folders = await fs.readdir(root, { withFileTypes: true });
        for (const folder of folders.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 64)) {
          if (!folder.isDirectory() || this.entries.size >= 32) continue;
          try {
            const relative = `${folder.name}/SKILL.md`;
            const text = await readWithin(root, relative, MAX_SKILL);
            const { body, ...meta } = parseSkill(text, folder.name);
            const id = digest([root, relative]).slice(0, 16);
            const entry = { ...meta, id, root, relative, source: path.join(root, relative), digest: digest(text) };
            if (metadataSize + meta.description.length + meta.name.length > 8_000) continue;
            this.entries.set(id, entry);
            metadataSize += meta.description.length + meta.name.length;
          } catch { this.warnings.push(`Skipped invalid or disabled skill: ${folder.name}`); }
        }
      } catch { this.warnings.push(`Could not read approved skill root: ${input}`); }
    }
    return this.catalog();
  }

  catalog() {
    return [...this.entries.values()].map(({ root, relative, digest: hash, ...meta }) => meta);
  }

  async select(ids) {
    if (!Array.isArray(ids) || ids.length > 3) throw new Error('Select up to three skills per run.');
    this.selected.clear();
    let size = 0;
    for (const id of new Set(ids)) {
      const entry = this.entries.get(id);
      if (!entry) throw new Error('Select a skill from an approved root.');
      const text = await readWithin(entry.root, entry.relative, MAX_SKILL);
      if (digest(text) !== entry.digest) throw new Error('This skill changed. Refresh and select it again.');
      const { body } = parseSkill(text, entry.name);
      size += body.length;
      if (size > MAX_SKILL) throw new Error('Selected skill bodies exceed 24,000 characters.');
      this.selected.set(id, { ...entry, body });
    }
    return [...this.selected.values()];
  }

  async resource(id, file) {
    const entry = this.selected.get(id);
    if (!entry) throw new Error('Only user-selected skills can load resources.');
    if (!/^(references|assets)\/.+\.(md|txt|rst|json|yaml|yml|csv)$/.test(file)) {
      throw new Error('Read a text resource under references/ or assets/. Skill scripts do not run.');
    }
    if (entry.resources) {
      if (!entry.resources.has(file)) throw new Error('This resource is outside the approved plugin content.');
      return entry.resources.get(file);
    }
    return readWithin(entry.root, `${entry.name}/${file}`, MAX_RESOURCE);
  }

  addPinned(skills) {
    const combined = [...this.selected.values(), ...skills];
    if (combined.length > 3 || combined.reduce((sum, skill) => sum + skill.body.length, 0) > MAX_SKILL) {
      throw new Error('Select at most three skills across direct selection and plugins, with at most 24,000 body characters.');
    }
    for (const skill of skills) this.selected.set(skill.id, skill);
    return [...this.selected.values()];
  }
}

module.exports = { SkillRegistry, parseSkill, readWithin };

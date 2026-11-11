const fs = require('node:fs/promises');
const path = require('node:path');
const { z } = require('zod');
const { digest } = require('./permissions');
const { readWithin, parseSkill } = require('./skills');

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64);
const roles = ['repository-research', 'diff-review', 'test-diagnosis', 'edit-proposal'];
const roleCapability = { 'repository-research': 'worker.research', 'diff-review': 'worker.review', 'test-diagnosis': 'worker.diagnose', 'edit-proposal': 'worker.edit' };
// A custom role is a read-only worker. Its tool list must be empty: workers never call tools.
const customRole = z.strictObject({
  name: slug, description: z.string().trim().min(1).max(200), instructions: z.string().trim().min(1).max(2_000),
  snapshot: z.enum(['repository', 'diff', 'check']), tools: z.array(z.string()).max(0),
});
const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1), id: slug, publisher: z.string().trim().min(1).max(80),
  version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[a-zA-Z0-9.-]+)?$/).max(60),
  description: z.string().trim().min(1).max(500),
  skills: z.array(slug).max(3).default([]), workers: z.array(z.enum(roles)).max(4).default([]),
  roles: z.array(customRole).max(3).default([]),
  connectors: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)).max(8).default([]),
  capabilities: z.array(z.enum(['skill.read', 'worker.research', 'worker.review', 'worker.diagnose', 'worker.edit', 'worker.custom', 'connector.read'])).max(7),
});

async function loadPlugin(input, connectors = []) {
  if ((await fs.lstat(input)).isSymbolicLink()) throw new Error('Plugin directories cannot be symlinks.');
  const root = await fs.realpath(input);
  const files = new Map();
  let bytes = 0;
  async function visit(relative = '') {
    const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
    if (entries.length > 64) throw new Error('Plugin directory contains too many entries.');
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error('Plugin symlinks are not allowed.');
      if (entry.isDirectory()) {
        if (!/^skills(?:\/[a-z0-9-]+(?:\/(?:references|assets)(?:\/[a-zA-Z0-9_-]+){0,3})?)?$/.test(name)) {
          throw new Error('Only declarative skill directories are supported.');
        }
        await visit(name);
      } else {
        if (!entry.isFile() || !(name === 'plugin.json' || /^skills\/[a-z0-9-]+\/SKILL\.md$/.test(name)
            || /^skills\/[a-z0-9-]+\/(references|assets)\/.+\.(md|txt|rst|json|yaml|yml|csv)$/.test(name))) {
          throw new Error('Plugins can contain only a manifest, skills, and text resources. Scripts and hooks are disabled.');
        }
        if (files.size >= 64) throw new Error('Plugin contains too many files.');
        const text = await readWithin(root, name, name.endsWith('SKILL.md') ? 24_000 : 8_000);
        bytes += Buffer.byteLength(text);
        if (bytes > 128_000) throw new Error('Plugin exceeds 128,000 bytes.');
        files.set(name, text);
      }
    }
  }
  await visit();
  const manifest = manifestSchema.parse(JSON.parse(files.get('plugin.json') ?? 'null'));
  if (new Set(manifest.roles.map(role => role.name)).size !== manifest.roles.length) throw new Error('Duplicate plugin declarations are not allowed.');
  for (const key of ['skills', 'workers', 'connectors', 'capabilities']) {
    if (new Set(manifest[key]).size !== manifest[key].length) throw new Error('Duplicate plugin declarations are not allowed.');
  }
  const expected = [...(manifest.skills.length ? ['skill.read'] : []),
    ...manifest.workers.map(role => roleCapability[role]), ...(manifest.roles.length ? ['worker.custom'] : []),
    ...(manifest.connectors.length ? ['connector.read'] : [])].sort();
  if (digest(expected) !== digest([...manifest.capabilities].sort())) throw new Error('Capabilities must match the declared components.');
  const connectorPins = manifest.connectors.map(id => {
    const config = connectors.find(config => config.id === id);
    if (!config) throw new Error(`Configure the referenced read connector ${id} first.`);
    return { id, digest: digest(config) };
  });
  const skills = manifest.skills.map(name => {
    const relative = `skills/${name}/SKILL.md`;
    const text = files.get(relative);
    if (!text) throw new Error('A declared skill file is missing.');
    const skill = parseSkill(text, name);
    return { ...skill, id: digest([root, relative]).slice(0, 16), source: path.join(root, relative),
      resources: new Map([...files].filter(([file]) => file.startsWith(`skills/${name}/`))
        .map(([file, value]) => [file.slice(`skills/${name}/`.length), value])) };
  });
  for (const file of files.keys()) {
    if (file !== 'plugin.json' && !manifest.skills.includes(file.split('/')[1])) throw new Error('Plugin contains an undeclared skill.');
  }
  const pin = { root, id: manifest.id, publisher: manifest.publisher, version: manifest.version,
    digest: digest([...files].sort(([a], [b]) => a.localeCompare(b))), capabilities: expected, connectorPins };
  return { ...manifest, root, pin, skills };
}

class PluginRegistry {
  constructor(roots, connectors = []) {
    if (!Array.isArray(roots) || roots.length > 8) throw new Error('Use at most eight plugin roots.');
    this.roots = roots;
    this.connectors = connectors;
    this.entries = new Map();
    this.warnings = [];
  }
  async discover() {
    this.entries.clear(); this.warnings = [];
    const duplicates = new Set();
    for (const input of this.roots) {
      try {
        const root = await fs.realpath(input);
        const entries = (await fs.readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 32);
        for (const entry of entries) {
          if (!entry.isDirectory() || this.entries.size >= 16) continue;
          try {
            const plugin = await loadPlugin(path.join(root, entry.name), this.connectors);
            if (this.entries.has(plugin.id) || duplicates.has(plugin.id)) {
              this.entries.delete(plugin.id); duplicates.add(plugin.id);
              throw new Error('Duplicate plugin ID.');
            }
            this.entries.set(plugin.id, plugin);
          } catch (error) { this.warnings.push(`${entry.name}: ${error.message}`); }
        }
      } catch { this.warnings.push(`Could not read plugin root: ${input}`); }
    }
    return [...this.entries.values()];
  }
  async verify(pins, enabledConnectors = []) {
    if (!Array.isArray(pins) || pins.length > 3) throw new Error('Enable at most three plugins.');
    const output = [];
    for (const pin of pins) {
      const entry = this.entries.get(pin.id);
      if (!entry || entry.root !== pin.root) throw new Error('An enabled plugin is missing or moved. Review your plugin selection.');
      const current = await loadPlugin(entry.root, this.connectors);
      if (digest(current.pin) !== digest(pin)) throw new Error(`Plugin ${pin.id} changed. Review its version and capabilities before enabling it again.`);
      if (current.connectors.some(id => !enabledConnectors.includes(id))) throw new Error('Enable the plugin’s referenced read connectors separately.');
      output.push(current);
    }
    return output;
  }
}

const pluginStorageKey = workspace => `plugins.v1.${digest(workspace)}`;
module.exports = { PluginRegistry, loadPlugin, pluginStorageKey, roles, roleCapability };

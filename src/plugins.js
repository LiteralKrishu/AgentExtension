const fs = require('node:fs/promises');
const path = require('node:path');
const { z } = require('zod');
const { digest } = require('./permissions');
const { readWithin, parseSkill } = require('./skills');
const { HOOK_EVENTS } = require('./plugin-hooks');

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64);
const MAX_PLUGIN_FILES = 64;
const MAX_PLUGIN_BYTES = 128_000;
const pluginFileLimit = name => name.endsWith('SKILL.md') ? 24_000 : 8_000;
const isPluginFile = name => name === 'plugin.json' || /^skills\/[a-z0-9-]+\/SKILL\.md$/.test(name)
  || /^(?:hooks|skills\/[a-z0-9-]+\/scripts)\/[a-z0-9]+(?:-[a-z0-9]+)*\.cjs$/.test(name)
  || /^skills\/[a-z0-9-]+\/(?:references|assets)\/(?:[a-zA-Z0-9_-]+\/){0,3}[^/]+\.(md|txt|rst|json|yaml|yml|csv)$/.test(name);
const workflowText = max => z.string().trim().min(1).max(max).regex(/^[^\x00-\x1f\x7f\u2028\u2029]+$/);
const roles = ['repository-research', 'diff-review', 'test-diagnosis', 'edit-proposal'];
const roleCapability = { 'repository-research': 'worker.research', 'diff-review': 'worker.review', 'test-diagnosis': 'worker.diagnose', 'edit-proposal': 'worker.edit' };
// Repository workers may ask for more lines from explicitly named snapshot files.
const customRole = z.strictObject({
  name: slug, description: z.string().trim().min(1).max(200), instructions: z.string().trim().min(1).max(2_000),
  snapshot: z.enum(['repository', 'diff', 'check']), tools: z.array(z.enum(['read_file', 'search_workspace'])).max(2).refine(tools => new Set(tools).size === tools.length, 'Duplicate worker tool.'),
}).refine(role => !role.tools.length || role.snapshot === 'repository', 'Only repository snapshots can expose read_file or search_workspace.');
const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1), id: slug, publisher: z.string().trim().min(1).max(80),
  version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[a-zA-Z0-9.-]+)?$/).max(60),
  description: z.string().trim().min(1).max(500),
  skills: z.array(slug).max(3).default([]), workers: z.array(z.enum(roles)).max(4).default([]),
  roles: z.array(customRole).max(3).default([]),
  workflows: z.array(z.strictObject({
    id: slug, title: workflowText(80), prompt: workflowText(1_000), planFirst: z.boolean().default(false),
  })).max(8).default([]),
  hooks: z.array(z.enum(Object.keys(HOOK_EVENTS))).max(2).default([]),
  customHooks: z.array(z.strictObject({ name: slug, event: z.enum(['after-check', 'before-apply']) })).max(2).default([]),
  connectors: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)).max(8).default([]),
  capabilities: z.array(z.enum(['skill.read', 'skill.script', 'worker.research', 'worker.review', 'worker.diagnose', 'worker.edit', 'worker.custom', 'worker.read', 'connector.read', 'hook.run'])).max(10),
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
        if (name !== 'hooks' && !/^skills(?:\/[a-z0-9-]+(?:\/scripts|\/(?:references|assets)(?:\/[a-zA-Z0-9_-]+){0,3})?)?$/.test(name)) {
          throw new Error('Use only supported plugin directories.');
        }
        await visit(name);
      } else {
        if (!entry.isFile() || !isPluginFile(name)) {
          throw new Error('Unsupported plugin file. Use declared skills, text resources, and declared .cjs scripts or hooks.');
        }
        if (files.size >= MAX_PLUGIN_FILES) throw new Error('Plugin contains too many files.');
        const text = await readWithin(root, name, pluginFileLimit(name));
        bytes += Buffer.byteLength(text);
        if (bytes > MAX_PLUGIN_BYTES) throw new Error('Plugin exceeds 128,000 bytes.');
        files.set(name, text);
      }
    }
  }
  await visit();
  const manifest = manifestSchema.parse(JSON.parse(files.get('plugin.json') ?? 'null'));
  if (new Set(manifest.roles.map(role => role.name)).size !== manifest.roles.length) throw new Error('Duplicate plugin declarations are not allowed.');
  if (new Set(manifest.workflows.map(workflow => workflow.id)).size !== manifest.workflows.length) throw new Error('Duplicate plugin workflows are not allowed.');
  for (const key of ['skills', 'workers', 'connectors', 'hooks', 'capabilities']) {
    if (new Set(manifest[key]).size !== manifest[key].length) throw new Error('Duplicate plugin declarations are not allowed.');
  }
  const hookNames = [...manifest.hooks, ...manifest.customHooks.map(hook => hook.name)];
  if (new Set(hookNames).size !== hookNames.length) throw new Error('Plugin hook names must be unique.');
  const scriptFiles = new Set();
  const scriptSource = file => {
    scriptFiles.add(file);
    const source = files.get(file);
    if (!source?.trim()) throw new Error(`Declared plugin script is missing or empty: ${file}`);
    return source;
  };
  const customHooks = manifest.customHooks.map(hook => ({ ...hook, source: scriptSource(`hooks/${hook.name}.cjs`) }));
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
    const scriptSources = new Map((skill.scripts ?? []).map(script => [script, scriptSource(`skills/${name}/scripts/${script}.cjs`)]));
    return { ...skill, id: digest([root, relative]).slice(0, 16), source: path.join(root, relative),
      scriptSources,
      resources: new Map([...files].filter(([file]) => file.startsWith(`skills/${name}/`) && !scriptFiles.has(file))
        .map(([file, value]) => [file.slice(`skills/${name}/`.length), value])) };
  });
  for (const file of files.keys()) {
    if (file.endsWith('.cjs')) {
      if (!scriptFiles.has(file)) throw new Error('Plugin contains an undeclared script.');
      continue;
    }
    if (file !== 'plugin.json' && !manifest.skills.includes(file.split('/')[1])) throw new Error('Plugin contains an undeclared skill.');
  }
  const expected = [...(skills.length ? ['skill.read'] : []),
    ...(skills.some(skill => skill.scripts?.length) ? ['skill.script'] : []),
    ...manifest.workers.map(role => roleCapability[role]), ...(manifest.roles.length ? ['worker.custom'] : []),
    ...(manifest.roles.some(role => role.tools.length) ? ['worker.read'] : []),
    ...(hookNames.length ? ['hook.run'] : []),
    ...(manifest.connectors.length ? ['connector.read'] : [])].sort();
  if (digest(expected) !== digest([...manifest.capabilities].sort())) throw new Error('Capabilities must match the declared components.');
  const pin = { root, id: manifest.id, publisher: manifest.publisher, version: manifest.version,
    digest: digest([...files].sort(([a], [b]) => a.localeCompare(b))), capabilities: expected, connectorPins };
  return { ...manifest, root, pin, skills, files, customHooks };
}

class PluginRegistry {
  constructor(roots, connectors = [], packages) {
    if (!Array.isArray(roots) || roots.length > 8) throw new Error('Use at most eight plugin roots.');
    this.roots = roots;
    this.connectors = connectors;
    this.packages = packages;
    this.entries = new Map();
    this.localIds = new Set();
    this.installedIds = new Set();
    this.warnings = [];
  }
  async discover() {
    this.entries.clear(); this.localIds.clear(); this.installedIds.clear(); this.warnings = [];
    const duplicates = new Set();
    const add = plugin => {
      if (this.entries.has(plugin.id) || duplicates.has(plugin.id)) {
        this.entries.delete(plugin.id); duplicates.add(plugin.id);
        throw new Error('Duplicate plugin ID.');
      }
      if (this.entries.size < 16) this.entries.set(plugin.id, plugin);
    };
    for (const input of this.roots) {
      try {
        const root = await fs.realpath(input);
        const entries = (await fs.readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 32);
        for (const entry of entries) {
          if (!entry.isDirectory() || this.entries.size >= 16) continue;
          try {
            const plugin = await loadPlugin(path.join(root, entry.name), this.connectors);
            this.localIds.add(plugin.id);
            add(plugin);
          } catch (error) { this.warnings.push(`${entry.name}: ${error.message}`); }
        }
      } catch { this.warnings.push(`Could not read plugin root: ${input}`); }
    }
    if (this.packages) {
      const installed = await this.packages.list().catch(() => {
        this.warnings.push('Could not read imported plugins.');
        return [];
      });
      for (const id of installed) {
        try {
          const plugin = await this.packages.load(id, this.connectors);
          this.installedIds.add(id);
          add(plugin);
        } catch (error) { this.warnings.push(`${id}: ${error.message}`); }
      }
    }
    return [...this.entries.values()];
  }
  async verify(pins, enabledConnectors = []) {
    if (!Array.isArray(pins) || pins.length > 3) throw new Error('Enable at most three plugins.');
    const output = [];
    for (const pin of pins) {
      const entry = this.entries.get(pin.id);
      if (!entry || (!this.installedIds.has(pin.id) && entry.root !== pin.root)) {
        throw new Error('An enabled plugin is missing or moved. Review your plugin selection.');
      }
      const current = this.installedIds.has(pin.id) ? await this.packages.load(pin.id, this.connectors) : await loadPlugin(entry.root, this.connectors);
      if (digest(current.pin) !== digest(pin)) throw new Error(`Plugin ${pin.id} changed. Review its version and capabilities before enabling it again.`);
      if (current.connectors.some(id => !enabledConnectors.includes(id))) throw new Error('Enable the plugin’s referenced read connectors separately.');
      output.push(current);
    }
    return output;
  }
}

const pluginStorageKey = workspace => `plugins.v1.${digest(workspace)}`;
module.exports = { PluginRegistry, loadPlugin, pluginStorageKey, roles, roleCapability,
  slug, isPluginFile, pluginFileLimit, MAX_PLUGIN_FILES, MAX_PLUGIN_BYTES };

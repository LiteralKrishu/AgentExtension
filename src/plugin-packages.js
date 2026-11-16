const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { z } = require('zod');
const { readWithin } = require('./skills');
const { loadPlugin, slug, isPluginFile, pluginFileLimit, MAX_PLUGIN_FILES, MAX_PLUGIN_BYTES } = require('./plugins');

const PACKAGE_SUFFIX = '.agentextension-plugin.json';
const FORMAT = 'agentextension-plugin/1';
const MAX_PACKAGE_BYTES = 1_000_000;
const packageSchema = z.strictObject({
  format: z.literal(FORMAT),
  files: z.array(z.strictObject({ path: z.string().min(1).max(240), text: z.string() })).min(1).max(MAX_PLUGIN_FILES),
});
const storedVersion = z.strictObject({ digest: z.string().regex(/^[a-f0-9]{64}$/) });

function validatePackage(input) {
  const bundle = packageSchema.parse(input);
  const names = new Map();
  const files = new Set();
  let total = 0;
  for (const { path: name, text } of bundle.files) {
    const parts = name.split('/');
    if (!isPluginFile(name) || parts.some(part => !/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/i.test(part)
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
      throw new Error(`Unsupported plugin package path: ${name}`);
    }
    let prefix = '';
    for (const part of parts) {
      prefix += prefix ? `/${part}` : part;
      const key = prefix.toLowerCase();
      if (names.has(key) && names.get(key) !== prefix) throw new Error('Plugin package paths differ only in case.');
      names.set(key, prefix);
    }
    if (files.has(name)) throw new Error('Duplicate plugin package file.');
    files.add(name);
    const size = Buffer.byteLength(text);
    total += size;
    if (size > pluginFileLimit(name) || total > MAX_PLUGIN_BYTES) throw new Error('Plugin package exceeds plugin text size limits.');
    if (text.includes('\0') || Buffer.from(text).toString('utf8') !== text) throw new Error('Plugin package files must contain valid UTF-8 text.');
  }
  if (!files.has('plugin.json')) throw new Error('A plugin package must contain plugin.json.');
  return bundle.files;
}

function encodePluginPackage(plugin) {
  const bundle = { format: FORMAT, files: [...plugin.files].map(([name, text]) => ({ path: name, text })) };
  validatePackage(bundle);
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

async function readPackage(source) {
  // Read at most the byte limit plus one to detect growth after the initial stat.
  const handle = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_PACKAGE_BYTES) throw new Error('Choose a regular plugin package file of at most 1 MB.');
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error('Plugin package changed during import.');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
    return validatePackage(JSON.parse(text));
  } finally { await handle.close(); }
}

class PluginPackages {
  constructor(root) {
    this.root = root;
    this.installed = path.join(root, 'installed');
    this.versions = path.join(root, 'versions');
  }

  async list() {
    let entries;
    try { entries = await fs.readdir(this.installed, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return entries.filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => entry.name.slice(0, -5)).filter(id => slug.safeParse(id).success).sort();
  }

  async load(id, connectors) {
    slug.parse(id);
    const { digest } = storedVersion.parse(JSON.parse(await readWithin(this.installed, `${id}.json`, 256)));
    return this.loadVersion(id, digest, connectors);
  }

  async loadVersion(id, digest, connectors) {
    const plugin = await loadPlugin(path.join(this.versions, id, digest), connectors);
    if (plugin.id !== id || plugin.pin.digest !== digest) throw new Error(`Installed plugin ${id} changed. Import its package again.`);
    return plugin;
  }

  async import(source, connectors, confirm) {
    const files = await readPackage(source);
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = await fs.mkdtemp(path.join(this.root, '.import-'));
    const staging = path.join(temporary, 'package');
    try {
      for (const { path: name, text } of files) {
        const file = path.join(staging, name);
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await fs.writeFile(file, text, { flag: 'wx', mode: 0o600 });
      }
      const plugin = await loadPlugin(staging, connectors);
      if (!await confirm(plugin)) return;
      const { id, pin: { digest } } = plugin;
      const versions = path.join(this.versions, id);
      await fs.mkdir(versions, { recursive: true, mode: 0o700 });
      try { await fs.rename(staging, path.join(versions, digest)); }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
        // A concurrent or earlier import may already have published these contents.
      }
      const installed = await this.loadVersion(id, digest, connectors);
      const pointer = path.join(temporary, 'version.json');
      await fs.mkdir(this.installed, { recursive: true, mode: 0o700 });
      await fs.writeFile(pointer, JSON.stringify({ digest }), { flag: 'wx', mode: 0o600 });
      await fs.rename(pointer, path.join(this.installed, `${id}.json`));
      return installed;
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  }
}

module.exports = { PluginPackages, encodePluginPackage, PACKAGE_SUFFIX };

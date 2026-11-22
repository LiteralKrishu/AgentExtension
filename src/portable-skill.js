const fs = require('node:fs/promises');
const path = require('node:path');
const { parseDocument } = require('yaml');
const { readWithin, parseSkill } = require('./skills');
const { isPluginFile, pluginFileLimit, MAX_PLUGIN_FILES } = require('./plugins');

// Import text and declared scripts only; foreign metadata never grants local authority.
async function readPortableSkill(source) {
  const root = await fs.realpath(path.dirname(source));
  const name = path.basename(root);
  const text = await readWithin(root, 'SKILL.md', 24000);
  const skill = parseSkill(text, name);
  const meta = parseDocument(text.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]).toJS({ maxAliasCount: 0 });
  const supported = ['name', 'description', 'enabled', 'scripts', 'allow_implicit_invocation', 'disable-model-invocation', 'license', 'compatibility', 'metadata'];
  const warnings = Object.keys(meta).filter(key => !supported.includes(key)).map(key => `Unsupported metadata: ${key}. It grants no permissions or model settings.`);
  const publisher = typeof meta.metadata?.author === 'string' ? meta.metadata.author : 'Unspecified local author';
  const version = typeof meta.metadata?.version === 'string' && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(meta.metadata.version) ? meta.metadata.version : '0.0.0';
  if (!meta.metadata?.author) warnings.push('No publisher was declared. The package uses “Unspecified local author”.');
  if (version !== meta.metadata?.version) warnings.push('No supported package version was declared. The package uses 0.0.0; original metadata stays in SKILL.md.');
  const files = [{ path: `skills/${name}/SKILL.md`, text }];
  let visited = 0;
  async function visit(relative = '') {
    const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++visited > MAX_PLUGIN_FILES) throw new Error('Portable skill has too many entries.');
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      if (file === 'SKILL.md') continue;
      if (entry.isSymbolicLink()) throw new Error('Portable skill symlinks are not allowed.');
      const portable = `skills/${name}/${file}`;
      if (entry.isDirectory() && /^(?:references|assets)(?:\/[a-zA-Z0-9_-]+){0,3}$|^scripts$/.test(file)) await visit(file);
      else if (entry.isFile() && isPluginFile(portable) && (!file.startsWith('scripts/') || skill.scripts?.includes(path.basename(file, '.cjs')))) {
        files.push({ path: portable, text: await readWithin(root, file, pluginFileLimit(portable)) });
      } else warnings.push(`Unsupported file or directory: ${file}. It will not be imported.`);
    }
  }
  await visit();
  files.unshift({ path: 'plugin.json', text: JSON.stringify({ schemaVersion: 1, id: name, publisher, version,
    description: skill.description.slice(0, 500), skills: [name], capabilities: ['skill.read', ...(skill.scripts?.length ? ['skill.script'] : [])] }) });
  return { files, warnings };
}
module.exports = { readPortableSkill };

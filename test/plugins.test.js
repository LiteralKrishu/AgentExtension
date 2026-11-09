const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { PluginRegistry, loadPlugin, pluginStorageKey } = require('../src/plugins');
const { SkillRegistry } = require('../src/skills');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ae-plugins-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const plugin = path.join(root, 'review-team');
  await fs.cp(path.join(__dirname, '../plugins/review-team'), plugin, { recursive: true });
  const registry = new PluginRegistry([root]);
  await registry.discover();
  return { root, plugin, registry, pin: registry.entries.get('review-team').pin };
}

test('plugin installation is separate from enablement and approved pins persist by workspace', async t => {
  const f = await fixture(t);
  assert.equal(f.registry.entries.size, 1);
  assert.deepEqual(await f.registry.verify([]), []);
  const [enabled] = await f.registry.verify([JSON.parse(JSON.stringify(f.pin))]);
  assert.deepEqual(enabled.workers, ['repository-research', 'diff-review']);
  assert.notEqual(pluginStorageKey('/a'), pluginStorageKey('/b'));
  const registry = new SkillRegistry([]);
  assert.equal(registry.addPinned(enabled.skills)[0].name, 'review-workflow');
  await assert.rejects(registry.resource(enabled.skills[0].id, 'references/missing.md'), /approved plugin/);
});

test('new versions, changed bodies and added effects invalidate old approvals', async t => {
  const f = await fixture(t);
  const file = path.join(f.plugin, 'plugin.json');
  const original = await fs.readFile(file, 'utf8');
  const manifest = JSON.parse(original);
  manifest.version = '1.1.0';
  await fs.writeFile(file, JSON.stringify(manifest));
  await assert.rejects(f.registry.verify([f.pin]), /changed/);
  await fs.writeFile(file, original);
  await fs.appendFile(path.join(f.plugin, 'skills/review-workflow/SKILL.md'), '\nChanged instructions');
  await assert.rejects(f.registry.verify([f.pin]), /changed/);
  const entry = await loadPlugin(f.plugin);
  const newRegistry = new PluginRegistry([f.root]);
  await newRegistry.discover();
  assert.equal((await newRegistry.verify([entry.pin])).length, 1);
  manifest.capabilities.push('command.execute');
  await fs.writeFile(file, JSON.stringify(manifest));
  await assert.rejects(loadPlugin(f.plugin));
});

test('plugin connector references pin endpoints and need separate enablement', async t => {
  const f = await fixture(t);
  const file = path.join(f.plugin, 'plugin.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  manifest.connectors = ['docs']; manifest.capabilities.push('connector.read');
  await fs.writeFile(file, JSON.stringify(manifest));
  const connector = { id: 'docs', account: 'reader', url: 'https://example.com/mcp', tools: [] };
  const registry = new PluginRegistry([f.root], [connector]);
  await registry.discover();
  const pin = registry.entries.get('review-team').pin;
  await assert.rejects(registry.verify([pin]), /separately/);
  await registry.verify([pin], ['docs']);
  await assert.rejects(registry.verify([f.pin], ['docs']), /changed/);
  registry.connectors = [{ ...connector, account: 'another-account' }];
  await assert.rejects(registry.verify([pin], ['docs']), /changed/);
});

test('plugin loader rejects scripts, symlinks, traversal, duplicate IDs and mismatched capability declarations', async t => {
  const f = await fixture(t);
  const file = path.join(f.plugin, 'plugin.json');
  const original = await fs.readFile(file, 'utf8');
  await fs.writeFile(path.join(f.plugin, 'hook.js'), 'throw Error("must not run")');
  await assert.rejects(loadPlugin(f.plugin), /Scripts and hooks/);
  await fs.unlink(path.join(f.plugin, 'hook.js'));
  await fs.symlink(path.join(f.plugin, 'skills'), path.join(f.plugin, 'linked'));
  await assert.rejects(loadPlugin(f.plugin), /symlinks/);
  await fs.unlink(path.join(f.plugin, 'linked'));
  for (const change of [{ skills: ['../outside'] }, { capabilities: [] }, { hooks: ['anything'] }, { version: 'latest' }]) {
    await fs.writeFile(file, JSON.stringify({ ...JSON.parse(original), ...change }));
    await assert.rejects(loadPlugin(f.plugin));
  }
  await fs.writeFile(file, original);
  await fs.cp(f.plugin, path.join(f.root, 'duplicate'), { recursive: true });
  await f.registry.discover();
  assert.equal(f.registry.entries.size, 0);
});

test('pinned skill resources cannot change between approval and use', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.plugin, 'skills/review-workflow/references'));
  const resource = path.join(f.plugin, 'skills/review-workflow/references/check.md');
  await fs.writeFile(resource, 'Approved resource');
  await f.registry.discover();
  const pin = f.registry.entries.get('review-team').pin;
  const [plugin] = await f.registry.verify([pin]);
  const skills = new SkillRegistry([]); skills.addPinned(plugin.skills);
  await fs.writeFile(resource, 'Injected instructions');
  assert.equal(await skills.resource(plugin.skills[0].id, 'references/check.md'), 'Approved resource');
  await assert.rejects(f.registry.verify([pin]), /changed/);
});

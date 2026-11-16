const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PluginRegistry, loadPlugin } = require('../src/plugins');
const { PluginPackages, encodePluginPackage } = require('../src/plugin-packages');

const manifest = (version = '1.0.0') => ({ schemaVersion: 1, id: 'sample-team',
  publisher: 'Sample publisher', version, description: 'Example workflows', capabilities: ['skill.read'], skills: ['baseline'],
  workflows: [{ id: 'inspect', title: 'Inspect sources', prompt: 'Summarize changed source files.', planFirst: true }] });
const skill = '---\nname: baseline\ndescription: Baseline workflow\n---\nReview the changed files.\n';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-packages-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packages = new PluginPackages(path.join(root, 'store'));
  const source = path.join(root, 'sample.agentextension-plugin.json');
  const manifestFile = value => ({ path: 'plugin.json', text: JSON.stringify(value) });
  const skillFile = { path: 'skills/baseline/SKILL.md', text: skill };
  const write = async (value = manifest(), more = [], format = 'agentextension-plugin/1') => {
    await fs.writeFile(source, JSON.stringify({ format, files: [manifestFile(value), skillFile, ...more] }));
  };
  return { packages, source, root, write, skillFile };
}

test('publication keeps approved contents visible until an atomic upgrade and requires fresh approval afterward', async t => {
  const { packages, source, write } = await fixture(t);
  const approve = () => true;
  const scope = new PluginRegistry([], [], packages);
  await write();
  const original = await packages.import(source, [], async candidate => {
    assert.equal(candidate.workflows[0].id, 'inspect');
    assert.deepEqual(await scope.discover(), []);
    return true;
  });
  await scope.discover();
  const [loaded] = await scope.verify([original.pin]);
  assert.equal(loaded.skills[0].name, 'baseline');
  assert.equal(loaded.workflows[0].planFirst, true);

  await write(manifest('2.0.0'));
  assert.equal(await packages.import(source, [], () => false), undefined);
  await assert.rejects(packages.import(source, [], () => { throw new Error('Interrupted'); }), /Interrupted/);
  assert.deepEqual((await packages.load(original.id)).pin, original.pin);

  const upgraded = await packages.import(source, [], approve);
  assert.notEqual(upgraded.pin.digest, original.pin.digest);
  await assert.rejects(scope.verify([original.pin]), /changed/);
  await scope.discover();
  await assert.rejects(scope.verify([original.pin]), /changed/);
  assert.equal((await scope.verify([upgraded.pin]))[0].version, '2.0.0');
  const repeated = await Promise.all([packages.import(source, [], approve), packages.import(source, [], approve)]);
  assert.deepEqual(repeated.map(plugin => plugin.pin), [upgraded.pin, upgraded.pin]);
  assert.deepEqual(await fs.readdir(packages.root), ['installed', 'versions']);
});

test('malformed, unsafe and oversized packages leave the installed version usable', async t => {
  const { packages, source, write, skillFile } = await fixture(t);
  await write();
  const { pin } = await packages.import(source, [], () => true);
  const importBad = () => packages.import(source, [], () => assert.fail('Invalid content reached the confirmation'));
  for (const [change, files, format] of [
    [{}, [], 'agentextension-plugin/2'],
    [{ capabilities: [] }, []],
    [{ workflows: [manifest().workflows[0], manifest().workflows[0]] }, []],
    [{ workflows: [{ ...manifest().workflows[0], prompt: 'Two\nlines' }] }, []],
    [{}, [skillFile]],
    [{}, [{ path: '../outside.txt', text: 'escape' }]],
    [{}, [{ path: 'skills/baseline/assets/../outside.txt', text: 'escape' }]],
    [{}, [{ path: 'setup.js', text: 'script' }]],
    [{}, [{ path: 'skills/baseline/assets/CHECK.txt', text: 'one' }, { path: 'skills/baseline/assets/check.txt', text: 'two' }]],
    [{}, [{ path: 'skills/baseline/assets/check.txt', text: 'x'.repeat(8_001) }]],
    [{}, Array.from({ length: 17 }, (_, index) => ({ path: `skills/baseline/assets/${index}.txt`, text: 'x'.repeat(8_000) }))],
  ]) {
    await write({ ...manifest('2.0.0'), ...change }, files, format);
    await assert.rejects(importBad());
    assert.deepEqual((await packages.load(pin.id)).pin, pin);
  }
  await fs.writeFile(source, ' '.repeat(1_000_001));
  await assert.rejects(importBad(), /1 MB/);
  assert.deepEqual((await packages.load(pin.id)).pin, pin);
});

test('a shared package preserves the exact manifest, skill resources and content digest', async t => {
  const { packages, source, write, root } = await fixture(t);
  await write(manifest(), [{ path: 'skills/baseline/references/daily/check.md', text: 'Check imported units.' }]);
  const first = await packages.import(source, [], () => true);
  const portable = path.join(root, 'shared.agentextension-plugin.json');
  await fs.writeFile(portable, encodePluginPackage(await loadPlugin(first.root)));
  const recipient = new PluginPackages(path.join(root, 'other-store'));
  const second = await recipient.import(portable, [], () => true);
  assert.equal(second.pin.digest, first.pin.digest);
  assert.notEqual(second.pin.root, first.pin.root);
  assert.equal(second.skills[0].resources.get('references/daily/check.md'), 'Check imported units.');
  const registry = new PluginRegistry([], [], recipient);
  await registry.discover();
  await assert.rejects(registry.verify([first.pin]), /changed/);
});

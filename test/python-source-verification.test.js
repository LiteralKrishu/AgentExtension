const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Workspace } = require('../src/workspace');
const { Draft } = require('../src/draft');
const { executeCheck } = require('../src/bridge');

test('src-layout Python checks can repair imports without changing the source or command environment', {
  skip: !['darwin', 'linux'].includes(process.platform), timeout: 15000,
}, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-python-source-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = 'src/agentextension_local_source_probe.py';
  await fs.mkdir(path.join(root, 'src'));
  const base = 'value = "base"\n';
  await fs.writeFile(path.join(root, file), base);
  const workspace = new Workspace(root, () => undefined, async () => [file]);
  const draft = new Draft((...args) => workspace.read(...args));
  await draft.replace(file, '"base"', '"staged"');
  const checks = [];
  const run = { workspace, draft, onCheck: async check => checks.push(check) };
  const signal = new AbortController().signal;
  const program = 'import agentextension_local_source_probe as probe; assert probe.value == "staged"';
  const missing = await executeCheck(run, { command: 'python3', args: ['-c', program] }, signal);
  assert.notEqual(missing.exitCode, 0);
  assert.match(missing.output, /ModuleNotFoundError/);
  assert.match(missing.import_guidance, /installed package/);
  assert.match(missing.import_guidance, /not proof/);
  const repaired = await executeCheck(run, { command: 'python3', args: ['-c', 'import sys; sys.path.insert(0, "src"); ' + program] }, signal);
  assert.equal(repaired.exitCode, 0, repaired.output);
  assert.equal(repaired.inputDigest, missing.inputDigest);
  assert.equal(repaired.revision, missing.revision);
  assert.equal(checks.length, 2);
  assert.equal(checks[0].exitCode, missing.exitCode);
  assert.equal(checks[1].exitCode, 0);
  assert.equal(await fs.readFile(path.join(root, file), 'utf8'), base);
});

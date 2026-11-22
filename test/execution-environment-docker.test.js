// Real Docker acceptance for the container environment. Run with AGENTEXTENSION_TEST_DOCKER=1 and Docker running.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ContainerEnvironment } = require('../src/execution-environment');

const skip = process.env.AGENTEXTENSION_TEST_DOCKER === '1' ? false : 'Set AGENTEXTENSION_TEST_DOCKER=1 with Docker running.';
const lock = { name: 'fixture', lockfileVersion: 3, requires: true, packages: {
  '': { name: 'fixture', dependencies: { ms: '2.1.3' } },
  'node_modules/ms': { version: '2.1.3', resolved: 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz',
    integrity: 'sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==', license: 'MIT' } } };
async function fixture(t, files) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'container-fixture-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) await fs.writeFile(path.join(directory, file), text);
  return directory;
}
const signal = () => AbortSignal.timeout(900_000);

test('pinned Node.js fixture installs, runs offline, and reuses its environment', { skip, timeout: 900_000 }, async t => {
  const directory = await fixture(t, { 'package.json': JSON.stringify({ name: 'fixture', dependencies: { ms: '2.1.3' } }),
    'package-lock.json': JSON.stringify(lock), 'check.js': 'console.log(require("ms")("2h"), process.env.HOME)' });
  const environment = new ContainerEnvironment();
  const result = await environment.run('node', ['check.js'], directory, signal());
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(result.output.trim(), '7200000 /tmp');
  assert.equal((await environment.prepare(directory, signal())).cached, true);
  const offline = await environment.run('node', ['-e', 'fetch("https://registry.npmjs.org").then(()=>process.exit(0),()=>process.exit(3))'], directory, signal());
  assert.equal(offline.exitCode, 3, 'checks have no network');
});

test('pinned Python fixture installs wheels only and cannot see host folders', { skip, timeout: 900_000 }, async t => {
  const directory = await fixture(t, { 'requirements.txt': 'six==1.17.0\n',
    'check.py': 'import os, six; print(six.__version__, os.path.exists("/Users"), os.path.exists(os.path.expanduser("~/.ssh")))' });
  const result = await new ContainerEnvironment().run('python', ['check.py'], directory, signal());
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(result.output.trim(), '1.17.0 False False');
});

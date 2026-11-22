const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { build } = require('esbuild');
const { managedChecks, findCheck, runServices, serviceInputs } = require('../src/execution-services');
const { ContainerEnvironment, PROFILES, runArguments } = require('../src/execution-environment');
const { commandTarget } = require('../src/bridge');

const declaration = { name: 'integration', command: 'node', args: ['check.js'],
  services: [{ name: 'web', command: 'node', args: ['server.js'], ready: { port: 8123 } }] };

test('managed declarations bind exact commands, private readiness endpoints, scope, and fixed limits', () => {
  const checks = managedChecks([declaration]);
  const check = findCheck(checks, 'node', ['check.js']);
  assert.equal(check.services[0].ready.type, 'http'); assert.equal(check.cwd, '.');
  assert.equal(findCheck(checks, 'node', ['other.js']), undefined);
  for (const change of [{ cwd: '../other' }, { cwd: '.git' }, { command: 'node check.js' }, { leaseSeconds: 121 },
    { profile: 'arbitrary-image' }, { env: Object.fromEntries(Array.from({ length: 17 }, (_, i) => ['V' + i, 'x'])) },
    { services: [{ ...declaration.services[0], ready: { port: 0 } }] },
    { services: [{ ...declaration.services[0], ready: { port: 8123, host: 'example.com' } }] },
    { services: [declaration.services[0], declaration.services[0]] }]) {
    assert.throws(() => managedChecks([{ ...declaration, ...change }]), /Invalid managed check/);
  }
  assert.throws(() => managedChecks([declaration, declaration]), /unique/);
});

test('command approval changes with its service declaration and never exposes literal environment values', () => {
  const a = new ContainerEnvironment({ checks: [declaration] });
  const b = new ContainerEnvironment({ checks: [{ ...declaration, env: { FIXTURE_VALUE: 'private-value' } }] });
  const run = environment => ({ workspace: { environment }, draft: { revision: 1, review: () => [] } });
  const input = { command: 'node', args: ['check.js'] };
  assert.notEqual(commandTarget(run(a), input).key, commandTarget(run(b), input).key);
  assert.match(b.describe(input.command, input.args), /web on private loopback 8123/);
  assert.match(b.describe(input.command, input.args), /FIXTURE_VALUE/);
  assert.doesNotMatch(b.describe(input.command, input.args), /private-value/);
  assert.equal(b.catalog().checks[0].name, 'integration');
  assert.deepEqual(b.catalog('integration').args, ['check.js']);
  assert.doesNotMatch(JSON.stringify(b.catalog('integration')), /private-value|FIXTURE_VALUE/);
  assert.throws(() => b.catalog('missing'), /Unknown managed check/);
});

test('service execution uses an offline container, read-only inputs, bounded writable storage, and separate lifecycle evidence', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'managed-check-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'check.js'), 'source remains unchanged\n');
  const check = managedChecks([declaration])[0];
  let args;
  const environment = { spawnRun: async actual => {
    args = actual;
    const privateFiles = (await fs.readdir(root)).filter(file => file.startsWith('.agentextension-job-'));
    assert.equal(privateFiles.length, 2);
    return { exitCode: 0, cleanup: 'complete', output: JSON.stringify({ version: 1, lifecycle: {
      startup: [{ name: 'web', status: 'ready', readyMs: 20 }], check: { status: 'passed', exitCode: 0, output: 'ok\n' }, cleanup: { status: 'stopped' } } }) };
  } };
  const result = await runServices(environment, check, root, new AbortController().signal,
    { image: 'node@sha256:' + 'a'.repeat(64), volume: 'owned-deps', digest: 'd', profile: PROFILES.node }, runArguments);
  assert.equal(result.exitCode, 0); assert.equal(result.output, 'ok\n'); assert.equal(result.lifecycle.cleanup.container, 'complete');
  assert.ok(args.includes('--init')); assert.equal(args[args.indexOf('--network') + 1], 'none');
  assert.ok(args.includes(root + ':/work:ro')); assert.equal(args[args.indexOf('--tmpfs') + 1], '/tmp:rw,size=512m');
  assert.ok(!args.includes('-p') && !args.includes('--publish'));
  assert.equal((await fs.readdir(root)).some(file => file.startsWith('.agentextension-job-')), false);
  assert.equal(await fs.readFile(path.join(root, 'check.js'), 'utf8'), 'source remains unchanged\n');
});

test('a forged success without completed startup or cleanup cannot pass, and internal inputs are removed', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'managed-check-fail-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const check = managedChecks([declaration])[0];
  const environment = { spawnRun: async () => ({ exitCode: 0, cleanup: 'complete', output: JSON.stringify({ version: 1,
    lifecycle: { startup: [], check: { status: 'passed', exitCode: 0 }, cleanup: { status: 'unconfirmed' } } }) }) };
  const result = await runServices(environment, check, root, new AbortController().signal,
    { image: 'i', volume: 'v', digest: 'd', profile: PROFILES.node }, runArguments);
  assert.notEqual(result.exitCode, 0);
  assert.deepEqual(await fs.readdir(root), []);
});

test('oversized or linked service inputs fail before a container can run', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'managed-check-quota-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'large.bin'), '');
  await fs.truncate(path.join(root, 'large.bin'), 128 * 1024 * 1024 + 1);
  await assert.rejects(serviceInputs(root), /128 MiB/);
  await fs.rm(path.join(root, 'large.bin'));
  await fs.symlink('/etc/passwd', path.join(root, 'link'));
  await assert.rejects(serviceInputs(root), /symbolic links/);
});

test('the bundled service runner remains self-contained after minification', async () => {
  const output = await build({ stdin: { contents: 'console.log(require("./src/execution-services").runner)', resolveDir: path.join(__dirname, '..') },
    bundle: true, minify: true, platform: 'node', format: 'cjs', write: false });
  const { runInNewContext } = require('node:vm');
  let runner;
  runInNewContext(output.outputFiles[0].text, { require, console: { log: value => { runner = value; } }, __dirname });
  assert.equal(typeof runner, 'string');
  assert.doesNotThrow(() => new (require('node:vm').Script)(runner));
  assert.match(runner, /node:child_process/);
});

test('run reports keep startup, check, and host cleanup outcomes separate without copying service output', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-report-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { RunReport } = require('../src/reports');
  const report = new RunReport(root, '/fixture', 'managed-run');
  report.check({ command: 'node', args: ['check.js'], exitCode: 0, revision: 1, selection: 'scope', changes: [],
    managedCheck: 'integration', environmentDigest: 'digest', lifecycle: {
      startup: [{ name: 'web', status: 'ready', output: 'private service value' }], check: { status: 'passed' }, cleanup: { status: 'stopped', container: 'complete' } } });
  const file = await report.save({ phase: 'done', revision: 1, selection: 'scope' });
  const text = await fs.readFile(file, 'utf8');
  assert.match(text, /startup web: ready.*check passed.*process cleanup stopped.*container removal complete/);
  assert.doesNotMatch(text, /private service value/);
});

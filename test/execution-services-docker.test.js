const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { ContainerEnvironment } = require('../src/execution-environment');

const skip = process.env.AGENTEXTENSION_TEST_DOCKER !== '1' && 'Set AGENTEXTENSION_TEST_DOCKER=1 with Docker running.';
const nodeLock = JSON.stringify({ name: 'managed-fixture', lockfileVersion: 3, requires: true,
  packages: { '': { name: 'managed-fixture', version: '1.0.0' } } });
const service = `require('node:http').createServer((request,response)=>{
 if(request.url==='/crash') process.exit(9);
 response.end('<title>Managed fixture</title><h1>'+process.env.GREETING+'</h1>');
}).listen(8123,'127.0.0.1');\n`;
async function fixture(t, extra = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'managed-service-fixture-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = { 'package.json': '{"name":"managed-fixture","version":"1.0.0"}', 'package-lock.json': nodeLock,
    'app/server.js': service, 'app/check.js': 'throw new Error("check fixture missing");', ...extra };
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), text);
  }
  return { root, files };
}
function declaration(extra = {}) {
  return { name: 'integration', command: 'node', args: ['check.js'], cwd: 'app', leaseSeconds: 15,
    env: { GREETING: 'Hello' }, services: [{ name: 'web', command: 'node', args: ['server.js'], cwd: 'app', ready: { port: 8123, timeoutMs: 2000 } }], ...extra };
}
function environment(check) {
  const names = [], value = new ContainerEnvironment({ checks: [check] });
  const start = value.spawnRun.bind(value);
  value.spawnRun = (args, ...rest) => { if (args.some(arg => arg.startsWith('agentextension-job-'))) names.push(args[args.indexOf('--name') + 1]); return start(args, ...rest); };
  return { value, names };
}
async function cleaned(env) {
  assert.ok(env.names.length > 0);
  for (const name of env.names) await assert.rejects(env.value.docker(['container', 'inspect', name]), /No such container|No such object/);
}
async function unchanged(f) {
  for (const [file, text] of Object.entries(f.files)) assert.equal(await fs.readFile(path.join(f.root, file), 'utf8'), text);
  assert.equal((await fs.readdir(f.root)).some(file => file.startsWith('.agentextension-job-')), false);
}

test('a real service-backed check reaches readiness, uses declared cwd/env, blocks egress, and cleans up', { skip, timeout: 900000 }, async t => {
  const f = await fixture(t, { 'app/check.js': `const assert=require('node:assert/strict');(async()=>{
    assert.match(await (await fetch('http://127.0.0.1:8123')).text(), /Hello/);
    let denied=false;try{await fetch('https://registry.npmjs.org',{signal:AbortSignal.timeout(700)})}catch{denied=true}
    assert.equal(denied,true);assert.equal(process.env.HTTP_PROXY,'');
    require('node:fs').writeFileSync('private-output.txt','inside tmpfs');console.log('integration passed');
  })().catch(e=>{console.error(e.message);process.exitCode=1});` });
  const env = environment(declaration());
  const result = await env.value.run('node', ['check.js'], f.root, AbortSignal.timeout(900000));
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(result.lifecycle.startup[0].status, 'ready'); assert.equal(result.lifecycle.check.status, 'passed');
  assert.equal(result.lifecycle.cleanup.container, 'complete'); assert.match(result.output, /integration passed/);
  await assert.rejects(fs.stat(path.join(f.root, 'app/private-output.txt')), { code: 'ENOENT' });
  await cleaned(env); await unchanged(f);
});

test('startup failure, an occupied job port, service crash, and lease expiry stay failed and clean up', { skip, timeout: 900000 }, async t => {
  for (const mode of ['startup', 'occupied', 'crash', 'lease']) {
    const f = await fixture(t, { 'app/check.js': mode === 'crash'
      ? "fetch('http://127.0.0.1:8123/crash').catch(()=>{});setInterval(()=>{},1000);"
      : mode === 'lease' ? 'setInterval(()=>{},1000);' : 'console.log("must not run");',
      ...(mode === 'startup' ? { 'app/server.js': 'process.exit(2);' } : {}),
      ...(mode === 'occupied' ? { 'app/server.js': "require('node:http').createServer((q,s)=>s.end('occupied')).listen(8123,'127.0.0.1',()=>{require('node:http').createServer().listen(8123,'127.0.0.1')});" } : {}) });
    const env = environment(declaration({ leaseSeconds: mode === 'lease' ? 1 : 10 }));
    const result = await env.value.run('node', ['check.js'], f.root, AbortSignal.timeout(900000));
    assert.notEqual(result.exitCode, 0, mode); assert.equal(result.lifecycle.cleanup.container, 'complete', mode);
    if (mode === 'lease') assert.match(result.output, /lease expired/);
    await cleaned(env); await unchanged(f);
  }
});

test('cancellation removes the real container before returning', { skip, timeout: 900000 }, async t => {
  const f = await fixture(t, { 'app/check.js': "require('node:fs').writeFileSync('/tmp/agentextension-work/started','yes');setInterval(()=>{},1000);" });
  const env = environment(declaration()), controller = new AbortController();
  const pending = env.value.run('node', ['check.js'], f.root, controller.signal);
  pending.catch(() => {});
  try {
    let observed = false;
    for (let i = 0; i < 100; i++) {
      if (env.names.length) try {
        await env.value.docker(['exec', env.names[0], 'node', '-e', "require('fs').accessSync('/tmp/agentextension-work/started')"]);
        observed = true; break;
      } catch { /* startup has not finished */ }
      await delay(100);
    }
    assert.equal(observed, true, 'check started before cancellation');
    controller.abort();
    const result = await pending;
    assert.equal(result.exitCode, null); assert.equal(result.status, 'Command cancelled.'); assert.equal(result.cleanup, 'complete');
    await cleaned(env); await unchanged(f);
  } finally { controller.abort(); await pending.catch(() => {}); }
});

test('a browser smoke runs against only the private service and leaves the source unchanged', { skip, timeout: 900000 }, async t => {
  const pinned = require('../package-lock.json').packages['node_modules/playwright-core'];
  const version = pinned.version;
  const lock = { name: 'managed-fixture', lockfileVersion: 3, requires: true, packages: {
    '': { name: 'managed-fixture', version: '1.0.0', dependencies: { 'playwright-core': version } }, 'node_modules/playwright-core': pinned } };
  const f = await fixture(t, { 'package.json': JSON.stringify({ name: 'managed-fixture', version: '1.0.0', dependencies: { 'playwright-core': version } }),
    'package-lock.json': JSON.stringify(lock), 'app/check.js': `const assert=require('node:assert/strict');(async()=>{
      const browser=await require('playwright-core').chromium.launch({headless:true});
      try{const page=await browser.newPage();await page.goto('http://127.0.0.1:8123');assert.equal(await page.title(),'Managed fixture');assert.equal(await page.locator('h1').innerText(),'Hello');console.log('browser passed');}
      finally{await browser.close();}
    })().catch(e=>{console.error(e.message);process.exitCode=1});` });
  const env = environment(declaration({ profile: 'browser', leaseSeconds: 30 }));
  const result = await env.value.run('node', ['check.js'], f.root, AbortSignal.timeout(900000));
  assert.equal(result.exitCode, 0, result.output); assert.match(result.output, /browser passed/);
  assert.match(result.environment.image, /^mcr\.microsoft\.com\/playwright@sha256:[a-f0-9]{64}$/);
  await cleaned(env); await unchanged(f);
});

test('a source edit during a managed check makes its result stale', { skip, timeout: 900000 }, async t => {
  const { Workspace } = require('../src/workspace');
  const { Draft } = require('../src/draft');
  const { executeCheck } = require('../src/bridge');
  const f = await fixture(t, { 'app/value.txt': 'before\n', 'app/check.js': `const fs=require('node:fs');
    require('node:assert/strict').equal(fs.readFileSync('value.txt','utf8'),'staged\\n');
    fs.writeFileSync('/tmp/agentextension-work/started','yes');setTimeout(()=>{},1000);` });
  const env = environment(declaration());
  const workspace = new Workspace(f.root, () => undefined, async () => Object.keys(f.files));
  workspace.environment = env.value;
  const draft = new Draft((...args) => workspace.read(...args));
  await draft.replace('app/value.txt', 'before', 'staged');
  const checks = [], controller = new AbortController();
  const pending = executeCheck({ workspace, draft, onCheck: async check => checks.push(check) },
    { command: 'node', args: ['check.js'] }, controller.signal);
  pending.catch(() => {});
  try {
    let observed = false;
    for (let i = 0; i < 100; i++) {
      if (env.names.length) try {
        await env.value.docker(['exec', env.names[0], 'node', '-e', "require('fs').accessSync('/tmp/agentextension-work/started')"]);
        observed = true; break;
      } catch { /* wait for the staged check */ }
      await delay(100);
    }
    assert.equal(observed, true);
    await fs.writeFile(path.join(f.root, 'app/value.txt'), 'external edit\n');
    await assert.rejects(pending, /changed while the check was running/);
    assert.equal(checks.at(-1).exitCode, null);
    await cleaned(env);
  } finally { controller.abort(); await pending.catch(() => {}); }
});

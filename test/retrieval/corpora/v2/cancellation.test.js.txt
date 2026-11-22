const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { Workspace } = require('../src/workspace');

async function fixture(t) {
  const area = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-cancel-copy-')));
  t.after(() => fs.rm(area, { recursive: true, force: true }));
  const root = path.join(area, 'workspace');
  const temporary = path.join(area, 'command-copies');
  await fs.mkdir(root); await fs.mkdir(temporary);
  return { root, temporary, workspace: new Workspace(root, () => undefined, async () => ['slow.cjs']) };
}

test('cancelling a running verification command stops its process and removes its private copy', {
  skip: process.platform !== 'darwin' && 'Real command process observation is tested on macOS.', timeout: 15_000,
}, async t => {
  const f = await fixture(t);
  const program = "const fs=require('node:fs');fs.writeFileSync('started.tmp',JSON.stringify({pid:process.pid}));fs.renameSync('started.tmp','started.json');setInterval(()=>{},1000);\n";
  await fs.writeFile(path.join(f.root, 'slow.cjs'), program);
  const controller = new AbortController();
  const previous = process.env.TMPDIR;
  let pending;
  try {
    // Each test file runs in its own process. Scope command copies to this fixture.
    process.env.TMPDIR = f.temporary;
    pending = f.workspace.command(process.execPath, ['slow.cjs'], [], controller.signal);
    pending.catch(() => {});
    const started = (async () => {
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        for (const entry of await fs.readdir(f.temporary)) {
          const directory = path.join(f.temporary, entry);
          try { return { directory, ...JSON.parse(await fs.readFile(path.join(directory, 'started.json'), 'utf8')) }; }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        await delay(10);
      }
      throw new Error('The isolated verification process did not publish its start marker.');
    })();
    const observed = await Promise.race([started, pending.then(result => { throw new Error(`Command ended before cancellation: ${JSON.stringify(result)}`); })]);
    assert.ok(Number.isInteger(observed.pid) && observed.pid > 1);
    controller.abort();
    const result = await pending;
    assert.equal(result.exitCode, null);
    assert.equal(result.status, 'Command cancelled.');
    assert.throws(() => process.kill(observed.pid, 0), { code: 'ESRCH' });
    await assert.rejects(fs.stat(observed.directory), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(f.temporary), []);
    assert.equal(await fs.readFile(path.join(f.root, 'slow.cjs'), 'utf8'), program);
    await assert.rejects(fs.stat(path.join(f.root, 'started.json')), { code: 'ENOENT' });
  } finally {
    controller.abort();
    await pending?.catch(() => {});
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
  }
});

test('cancellation before command materialization leaves no temporary copy', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'slow.cjs'), 'throw new Error("must not run");\n');
  const controller = new AbortController(); controller.abort();
  const previous = process.env.TMPDIR;
  try {
    process.env.TMPDIR = f.temporary;
    await assert.rejects(f.workspace.command(process.execPath, ['slow.cjs'], [], controller.signal), { name: 'AbortError' });
    assert.deepEqual(await fs.readdir(f.temporary), []);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
  }
});

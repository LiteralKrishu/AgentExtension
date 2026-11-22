// Self-contained: the host serializes this function into a private container input.
// Its status report is process output. Docker removal remains the host's cleanup evidence.
async function serviceMain() {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const http = require('node:http');
  const net = require('node:net');
  const { spawn } = require('node:child_process');
  const { setTimeout: delay } = require('node:timers/promises');
  const config = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
  const controller = new AbortController();
  const children = [];
  const lifecycle = { startup: [], check: { status: 'not-run' }, cleanup: { status: 'pending' } };
  let reason;
  const stop = message => { reason ??= message; controller.abort(); };
  const timer = setTimeout(() => stop('Managed check lease expired.'), config.leaseSeconds * 1000);
  process.once('SIGTERM', () => stop('Managed check cancelled.'));
  process.once('SIGINT', () => stop('Managed check cancelled.'));
  const root = '/tmp/agentextension-work';
  const bounded = (before, data) => before + data.toString().slice(0, Math.max(0, 16000 - before.length));
  async function start(program, kind) {
    const cwd = await fs.realpath(path.join(root, program.cwd));
    if (cwd !== root && !cwd.startsWith(root + '/')) throw new Error('Working directory leaves the managed copy.');
    controller.signal.throwIfAborted();
    const child = spawn(program.command, program.args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...config.env, ...program.env } });
    const state = { child, kind, output: '', exited: false, code: null, error: '' };
    state.closed = new Promise(resolve => {
      child.once('error', error => { state.error = error.message; state.exited = true; resolve(); });
      child.once('close', code => { state.exited = true; state.code = code; resolve();
        if (kind === 'service' && !controller.signal.aborted) stop(`Service ${program.name} exited before the check ended.`); });
    });
    const capture = data => { state.output = bounded(state.output, data); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    children.push(state);
    return state;
  }
  function probe(ready) {
    return new Promise(resolve => {
      if (ready.type === 'tcp') {
        const socket = net.connect({ host: '127.0.0.1', port: ready.port });
        socket.setTimeout(250);
        const done = value => { socket.destroy(); resolve(value); };
        socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.once('timeout', () => done(false));
      } else {
        const request = http.get({ host: '127.0.0.1', port: ready.port, path: ready.path, timeout: 250 }, response => {
          response.destroy(); resolve(response.statusCode === ready.status);
        });
        request.once('timeout', () => { request.destroy(); resolve(false); });
        request.once('error', () => resolve(false));
      }
    });
  }
  let exitCode = 1;
  try {
    // The only writable project tree lives in the bounded /tmp tmpfs.
    await fs.cp('/work', root, { recursive: true, dereference: false });
    await fs.cp('/deps/node_modules', path.join(root, 'node_modules'), { recursive: true, dereference: false });
    for (const service of config.services) {
      const state = await start(service, 'service');
      const started = Date.now();
      const observed = { name: service.name, status: 'starting', readyMs: 0, output: '' };
      lifecycle.startup.push(observed);
      while (Date.now() - started < service.ready.timeoutMs) {
        controller.signal.throwIfAborted();
        if (state.exited) throw new Error(state.error || `Service ${service.name} exited during startup.`);
        if (await probe(service.ready)) {
          await delay(25, undefined, { signal: controller.signal });
          if (state.exited) throw new Error(state.error || `Service ${service.name} exited during startup.`);
          observed.status = 'ready'; observed.readyMs = Date.now() - started; break;
        }
        await delay(100, undefined, { signal: controller.signal });
      }
      if (observed.status !== 'ready') throw new Error(`Service ${service.name} did not become ready before its deadline.`);
    }
    const check = await start(config, 'check');
    const abort = () => { try { process.kill(-check.child.pid, 'SIGKILL'); } catch { /* already stopped */ } };
    controller.signal.addEventListener('abort', abort, { once: true });
    if (controller.signal.aborted) abort();
    await check.closed;
    controller.signal.removeEventListener('abort', abort);
    await delay(25);
    if (reason || check.error) throw new Error(reason || check.error);
    exitCode = check.code ?? 1;
    lifecycle.check = { status: exitCode === 0 ? 'passed' : 'failed', exitCode, output: check.output };
  } catch (error) {
    for (const startup of lifecycle.startup) if (startup.status === 'starting') startup.status = 'failed';
    lifecycle.check = { status: 'not-complete', exitCode: null, output: '', reason: reason || error.message };
    exitCode = 1;
  } finally {
    clearTimeout(timer);
    controller.abort();
    for (const state of children) {
      // The whole detached group is stopped, even if its parent exited first.
      try { process.kill(-state.child.pid, 'SIGTERM'); } catch { /* no live group */ }
    }
    await delay(100);
    for (const state of children) {
      try { process.kill(-state.child.pid, 'SIGKILL'); } catch { /* no live group */ }
      await Promise.race([state.closed, delay(500)]);
    }
    for (const [index, state] of children.filter(state => state.kind === 'service').entries()) {
      if (lifecycle.startup[index]) lifecycle.startup[index].output = state.output.slice(0, 1200);
    }
    lifecycle.cleanup = { status: children.every(state => state.exited) ? 'stopped' : 'unconfirmed' };
    if (lifecycle.cleanup.status !== 'stopped') exitCode = 1;
    process.stdout.write(JSON.stringify({ version: 1, lifecycle }) + '\n');
    process.exitCode = exitCode;
  }
}

module.exports = { serviceMain };

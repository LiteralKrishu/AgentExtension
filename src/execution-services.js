const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { z } = require('zod');
const { safePath } = require('./workspace');
const { serviceMain } = require('./execution-service-runner');

const runner = `(${serviceMain.toString()})().catch(error => { console.error(error.message); process.exitCode = 1; });\n`;
const hash = value => createHash('sha256').update(value).digest('hex');
const cwd = z.string().max(250).default('.').refine(value => {
  try { return value === '.' || Boolean(safePath(value)); } catch { return false; }
}, 'Use a visible workspace-relative working directory.');
const env = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.string().max(500)).default({})
  .refine(value => Object.keys(value).length <= 16, 'At most sixteen literal environment values are allowed.');
const program = { command: z.string().regex(/^[\w.+-]{1,60}$/), args: z.array(z.string().max(500)).max(20).default([]), cwd, env };
const readiness = z.object({ type: z.enum(['http', 'tcp']).default('http'), port: z.number().int().min(1).max(65535),
  path: z.string().max(250).regex(/^\/(?!\/)[^\r\n]*$/).default('/'), status: z.number().int().min(200).max(399).default(200),
  timeoutMs: z.number().int().min(100).max(20000).default(10000) }).strict();
const schema = z.array(z.object({ name: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), ...program,
  profile: z.enum(['node', 'browser']).default('node'), leaseSeconds: z.number().int().min(1).max(120).default(120),
  services: z.array(z.object({ name: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), ...program, ready: readiness }).strict()).max(3).default([]),
}).strict()).max(8).superRefine((checks, context) => {
  const keys = new Set();
  for (const check of checks) {
    const key = JSON.stringify([check.command, check.args]);
    if (keys.has(key)) context.addIssue({ code: 'custom', message: 'Each managed check command and argument list must be unique.' });
    keys.add(key);
    if (new Set(check.services.map(service => service.name)).size !== check.services.length ||
      new Set(check.services.map(service => service.ready.port)).size !== check.services.length) {
      context.addIssue({ code: 'custom', message: 'Service names and readiness ports must be unique within a check.' });
    }
  }
});

function managedChecks(input = []) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new Error('Invalid managed check declaration: ' + parsed.error.issues.map(issue => issue.message).join('; '));
  return parsed.data;
}

function findCheck(checks, command, args) {
  return checks.find(check => check.command === command && JSON.stringify(check.args) === JSON.stringify(args));
}

async function serviceInputs(directory) {
  let files = 0, bytes = 0;
  async function visit(folder) {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Managed service inputs cannot contain symbolic links.');
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) {
        files++; bytes += (await fs.stat(full)).size;
        if (files > 10000 || bytes > 128 * 1024 * 1024) throw Object.assign(new Error('The managed service input exceeds its 10,000-file or 128 MiB limit.'), { code: 'ESNAPSHOTQUOTA' });
      } else throw new Error('Managed service inputs must be regular files.');
    }
  }
  await visit(directory);
  return { files, bytes };
}

async function runServices(environment, check, directory, signal, prepared, buildArguments) {
  signal.throwIfAborted();
  await serviceInputs(directory);
  for (const program of [check, ...check.services]) {
    const full = await fs.realpath(path.join(directory, program.cwd));
    if (full !== directory && !full.startsWith(directory + path.sep) || !(await fs.stat(full)).isDirectory()) {
      throw new Error('The managed check working directory is outside the snapshot or is not a directory.');
    }
  }
  const id = randomUUID(), script = `.agentextension-job-${id}.cjs`, config = `.agentextension-job-${id}.json`;
  await fs.writeFile(path.join(directory, script), runner, { mode: 0o600 });
  await fs.writeFile(path.join(directory, config), JSON.stringify(check), { mode: 0o600 });
  const environmentRecord = { image: prepared.image, dependencies: prepared.digest,
    declaration: hash(JSON.stringify(check)), runner: hash(runner), network: 'none', writableTmpfsMiB: 512 };
  try {
    const args = buildArguments({ name: `agentextension-job-${id}`, image: prepared.image, network: 'none',
      readOnlySource: { directory, readOnly: true }, volume: prepared.volume, mount: { target: '/deps', readOnly: true },
      profile: prepared.profile, command: 'node', args: [`/work/${script}`, `/work/${config}`] });
    const tmpfs = args.indexOf('--tmpfs'); args[tmpfs + 1] = '/tmp:rw,size=512m';
    args.splice(1, 0, '--init');
    const result = await environment.spawnRun(args, signal, check.leaseSeconds + 2);
    if (result.exitCode === null) return { ...result, environment: environmentRecord,
      lifecycle: { check: { status: 'not-complete' }, cleanup: { status: 'unconfirmed', container: result.cleanup } } };
    let report;
    try { report = JSON.parse(result.output); } catch {
      throw new Error(`The managed service runner returned no valid lifecycle report (exit ${result.exitCode}). ${result.output.slice(0, 2000)}`);
    }
    if (report.version !== 1 || !Array.isArray(report.lifecycle?.startup) || !report.lifecycle?.check || !report.lifecycle?.cleanup) {
      throw new Error('The managed service runner returned an invalid lifecycle report.');
    }
    const lifecycle = { ...report.lifecycle, cleanup: { ...report.lifecycle.cleanup, container: result.cleanup } };
    const ok = result.exitCode === 0 && lifecycle.startup.length === check.services.length && lifecycle.startup.every(service => service.status === 'ready')
      && lifecycle.check.status === 'passed' && lifecycle.check.exitCode === 0 && lifecycle.cleanup.status === 'stopped' && result.cleanup === 'complete';
    const output = [lifecycle.check.output ?? '', lifecycle.check.reason ?? '',
      ...lifecycle.startup.filter(service => service.status !== 'ready').map(service => `${service.name}: ${service.output ?? service.status}`)].filter(Boolean).join('\n');
    return { ...result, exitCode: ok ? 0 : result.exitCode || 1, output, lifecycle,
      managedCheck: check.name, environment: environmentRecord };
  } finally {
    await fs.rm(path.join(directory, script), { force: true });
    await fs.rm(path.join(directory, config), { force: true });
  }
}

module.exports = { managedChecks, findCheck, runServices, serviceInputs, runner };

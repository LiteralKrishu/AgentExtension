const { execFile } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { createOrganizationService } = require('../../src/organization-service');
const { organizationWorkspace, tokenHash } = require('../../src/organization');

const exec = promisify(execFile);
const git = (cwd, ...args) => exec('git', args, { cwd });

async function startProject(t, { now = Date.now, sameUser = false, memorySync = false, publicUrl } = {}) {
  const area = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ae-project-')));
  t.after(() => fs.rm(area, { recursive: true, force: true }));
  const first = path.join(area, 'first');
  const second = path.join(area, 'second');
  const observer = path.join(area, 'observer');
  await Promise.all([first, observer].map(root => fs.mkdir(root)));
  await git(first, 'init', '-q');
  await fs.writeFile(path.join(first, 'tracked.txt'), 'Original text\n');
  await git(first, 'add', 'tracked.txt');
  await git(first, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Base');
  await git(area, 'clone', '-q', first, second);
  const configFile = path.join(area, 'service.json');
  const storage = path.join(area, 'storage');
  const organization = 'fixture-team';
  const project = 'demo';
  const devices = await Promise.all([
    { root: first, device: 'first', user: 'alice', role: 'editor' },
    { root: second, device: 'second', user: sameUser ? 'alice' : 'sam', role: 'editor', readAudit: true },
    { root: observer, device: 'viewer', user: 'lee', role: 'viewer' },
  ].map(async item => {
    const token = randomBytes(24).toString('hex');
    const tokenFile = path.join(area, `${item.device}.cred`);
    await fs.writeFile(tokenFile, token, { mode: 0o600 });
    return { ...item, workspace: organizationWorkspace(item.root), token, tokenFile, policy: path.join(area, `${item.device}.json`) };
  }));
  const members = devices.map(({ device, user, workspace, role }) => ({ device, user, workspace, role }));
  const config = {
    clients: devices.map(({ device, token, workspace, readAudit }) => ({ id: device, tokenHash: tokenHash(token), workspaces: [workspace], readAudit })),
    policies: Object.fromEntries(devices.map(({ workspace }) => [workspace, { version: 1, rules: [] }])),
    collaboration: { organization, memorySync, projects: [{ id: project, handoffs: true, members }] },
  };
  const update = async () => {
    const temporary = configFile + '.tmp';
    await fs.writeFile(temporary, JSON.stringify(config));
    await fs.rename(temporary, configFile);
  };
  await update();
  const service = createOrganizationService({ configFile, storage, now });
  const close = () => { service.close(); service.closeAllConnections(); };
  t.after(close);
  await new Promise((resolve, reject) => {
    service.once('error', reject);
    service.listen(0, '127.0.0.1', resolve);
  });
  const internal = `http://127.0.0.1:${service.address().port}`;
  const url = publicUrl ? await publicUrl(internal) : internal;
  for (const { policy, workspace, tokenFile } of devices) {
    await fs.writeFile(policy, JSON.stringify({ version: 1, organization: { url, workspaces: [workspace], tokenFile,
      projects: { [workspace]: { organization, project } } } }));
  }
  return { area, storage, url, organization, project, devices, config, members, update, close };
}

module.exports = { startProject, git };

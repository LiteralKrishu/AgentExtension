const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: sleep } = require('node:timers/promises');
const { desktopRequest } = require('../../src/computer');
async function startDesktop() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ae-desktop-fixture-'));
  const bundle = path.join(root, 'AgentExtension Test.app');
  await fs.mkdir(path.join(bundle, 'Contents/MacOS'), { recursive: true });
  const id = `local.agentextension.fixture${Date.now()}`;
  await fs.writeFile(path.join(bundle, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundleName</key><string>AgentExtension Test</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
  await promisify(execFile)('/usr/bin/swiftc', ['-module-cache-path', '/tmp/agentextension-swift-cache', path.join(__dirname, 'desktop.swift'), '-o', path.join(bundle, 'Contents/MacOS/Fixture')]);
  const result = path.join(root, 'result.txt');
  const child = spawn(path.join(bundle, 'Contents/MacOS/Fixture'), [], { stdio: 'ignore', env: { ...process.env, AGENTEXTENSION_DESKTOP_RESULT: result } });
  try {
    for (let i = 0; i < 40; i++) {
      const app = (await desktopRequest({ command: 'list' })).find(app => app.bundleId === id);
      if (app) {
        try {
          await desktopRequest({ command: 'observe', app });
          return { app, result, root, close: () => child.kill() };
        } catch (error) { if (!/no accessible window/.test(error.message)) throw error; }
      }
      await sleep(100);
    }
    throw new Error('Desktop test app did not start.');
  } catch (error) { child.kill(); throw error; }
}
module.exports = { startDesktop };

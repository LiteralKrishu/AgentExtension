const { execFileSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
if (process.platform !== 'darwin') throw new Error('Build the macOS helper on macOS with Command Line Tools installed.');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentextension-native-'));
try {
  for (const arch of ['arm64', 'x86_64']) execFileSync('/usr/bin/swiftc', ['-module-cache-path', path.join(os.tmpdir(), 'agentextension-native-modules'),
    '-target', `${arch}-apple-macos13.0`, `${root}/native/desktop.swift`, '-o', `${temp}/${arch}`], { stdio: 'inherit' });
  execFileSync('/usr/bin/lipo', ['-create', `${temp}/arm64`, `${temp}/x86_64`, '-output', `${root}/native/agentextension-desktop`]);
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', `${root}/native/agentextension-desktop`]);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }

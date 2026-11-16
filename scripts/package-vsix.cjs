const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { build } = require('esbuild');
const { createVSIX } = require('@vscode/vsce');
const manifest = require('../package.json');

const root = path.resolve(__dirname, '..');
const runtimeDependencies = ['@truefoundry/trueforge-sdk', 'playwright-core'];
const main = './src/extension.bundle.cjs';

// The macOS helper is never committed. Each package compiles it from native/desktop.swift so the shipped
// binary always matches reviewed source. Elsewhere the package omits it and native app access is unavailable.
const helper = path.join(root, 'native', 'agentextension-desktop');
function buildHelper() {
  if (process.platform === 'darwin') {
    execFileSync(process.execPath, [path.join(__dirname, 'build-native.cjs')], { stdio: 'inherit' });
    return true;
  }
  console.warn('Packaging without the macOS desktop helper. Package on macOS to include native app access.');
  return false;
}

async function packageExtension(output) {
  const withHelper = buildHelper();
  const staging = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'agentextension-vsix-'));
  try {
    const assets = ['.vscodeignore', 'LICENSE', 'README.md', 'docs', 'media', 'native', 'plugins', 'skills', 'trueforge',
      'src/retrieval.js', 'src/context.js', ...runtimeDependencies.map(name => `node_modules/${name}`)];
    await Promise.all(assets.map(file => fs.cp(path.join(root, file), path.join(staging, file), { recursive: true,
      filter: source => source !== helper || (withHelper && existsSync(helper)) })));
    const packaged = { ...manifest, main,
      dependencies: Object.fromEntries(runtimeDependencies.map(name => [name, manifest.dependencies[name]])) };
    delete packaged.devDependencies;
    delete packaged.scripts;
    await fs.writeFile(path.join(staging, 'package.json'), JSON.stringify(packaged, null, 2) + '\n');
    await build({
      absWorkingDir: root,
      entryPoints: [manifest.main],
      outfile: path.join(staging, main),
      bundle: true,
      minify: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      // VS Code supplies its API. Retrieval starts a worker from its own file.
      external: ['vscode', './retrieval', ...runtimeDependencies],
    });
    await createVSIX({ cwd: staging, packagePath: output });
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

const output = path.resolve(process.argv[2] ?? `${manifest.name}-${manifest.version}.vsix`);
packageExtension(output).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

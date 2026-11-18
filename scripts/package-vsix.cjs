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
const target = `${process.platform}-${process.arch}`;

async function stageRuntime(staging) {
  if (!require('node:module').registerHooks) throw new Error('Build the VSIX with Node.js 22.15 or later.');
  const server = path.join(root, 'trueforge', 'server');
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error('Run npm run package:vsix to build the VSIX.');
  // The locked packages include SQLite prebuilds. A package build needs no compiler for the server.
  execFileSync(process.execPath, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: server, stdio: 'inherit',
  });
  const runtime = path.join(staging, 'trueforge', 'runtime');
  await fs.mkdir(runtime, { recursive: true });
  const node = path.join(runtime, process.platform === 'win32' ? 'node.exe' : 'node');
  const bin = path.dirname(process.execPath);
  const license = [path.join(bin, '..', 'LICENSE'), path.join(bin, 'LICENSE')].find(existsSync);
  if (!license) throw new Error('Build with an official Node.js distribution that includes its LICENSE file.');
  await Promise.all([
    fs.copyFile(process.execPath, node),
    fs.copyFile(license, path.join(runtime, 'NODE-LICENSE')),
    fs.copyFile(path.join(server, 'launch.cjs'), path.join(runtime, 'launch.cjs')),
    fs.cp(path.join(server, 'node_modules'), path.join(runtime, 'node_modules'), {
      recursive: true,
      filter: source => !source.endsWith('.map') && path.basename(source) !== '.bin'
        && source !== path.join(server, 'node_modules', '@truefoundry', 'trueforge', 'dist', '_frontend'),
    }),
  ]);
  await fs.chmod(node, 0o755);
  execFileSync(node, ['-e', 'new (require("better-sqlite3"))(":memory:").close()'], { cwd: runtime });
}

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
    const assets = ['.vscodeignore', 'LICENSE', 'README.md', 'docs', 'media', 'native', 'plugins', 'skills',
      'trueforge/agent.json', 'trueforge/model.example.json',
      'src/retrieval.js', 'src/context.js', ...runtimeDependencies.map(name => `node_modules/${name}`)];
    await Promise.all(assets.map(file => fs.cp(path.join(root, file), path.join(staging, file), { recursive: true,
      filter: source => source !== helper || (withHelper && existsSync(helper)) })));
    await stageRuntime(staging);
    const packaged = { ...manifest, main,
      dependencies: Object.fromEntries(runtimeDependencies.map(name => [name, manifest.dependencies[name]])) };
    delete packaged.devDependencies;
    delete packaged.scripts;
    await fs.writeFile(path.join(staging, 'package.json'), JSON.stringify(packaged, null, 2) + '\n');
    await build({
      absWorkingDir: root,
      entryPoints: { 'extension.bundle': manifest.main, 'background-cli': './src/background-cli.js', 'organization-service': './src/organization-service.js' },
      outdir: path.join(staging, 'src'),
      outExtension: { '.js': '.cjs' },
      bundle: true,
      minify: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      // VS Code supplies its API. Retrieval starts a worker from its own file.
      external: ['vscode', './retrieval', ...runtimeDependencies],
    });
    await createVSIX({ cwd: staging, packagePath: output, target });
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

const output = path.resolve(process.argv[2] ?? `${manifest.name}-${manifest.version}-${target}.vsix`);
packageExtension(output).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: sleep } = require('node:timers/promises');
const { startReadServer } = require('../fixtures/read-server.cjs');
const { startBrowserFixture } = require('../fixtures/browser.cjs');
const { startDesktop } = require('../fixtures/desktop.cjs');

async function main() {
  const baseUrl = process.env.AGENTEXTENSION_TEST_FORGE_URL;
  if (!baseUrl) throw new Error('Set AGENTEXTENSION_TEST_FORGE_URL to an isolated local TrueForge instance.');
  const { TrueForge } = await import('@truefoundry/trueforge-sdk');
  const forge = new TrueForge({ baseUrl, maxRetries: 0 });
  const fixture = await startReadServer();
  const browserFixture = await startBrowserFixture();
  const desktopFixture = await startDesktop();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-ui-'));
  await fs.writeFile(path.join(root, 'surface-fixture.json'), JSON.stringify({ origin: browserFixture.origin, app: desktopFixture.app, result: desktopFixture.result }));
  const debugPort = Number(process.env.AGENTEXTENSION_UI_PORT || 19236);
  const name = `ui-${Date.now()}`;
  let providerError;
  let workerCalls = 0;
  const send = (res, body, message, hold = false) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const packet = (delta, finish_reason) => ({ id: 'ui-test', object: 'chat.completion.chunk', created: 1, model: body.model,
      choices: [{ index: 0, delta, finish_reason }] });
    res.write(`data: ${JSON.stringify(packet(message, null))}\n\n`);
    if (!hold) res.end(`data: ${JSON.stringify(packet({}, message.tool_calls ? 'tool_calls' : 'stop'))}\n\ndata: [DONE]\n\n`);
  };
  const provider = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/test-status') {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ workerCalls, browser: browserFixture.calls }));
      }
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const tools = body.tools.map(tool => tool.function.name);
      const find = name => tools.find(tool => tool.endsWith(name));
      const all = JSON.stringify(body.messages);
      if (all.includes(fixture.token)) throw new Error('Connector credential reached the model.');
      let child;
      for (const message of body.messages.filter(message => message.role === 'user')) {
        try { const value = JSON.parse(message.content); if (value.sources && ['repository-research', 'diff-review'].includes(value.role)) child = value; } catch {}
      }
      if (child) {
        workerCalls++;
        if (tools.some(tool => tool !== 'get_current_datetime')) throw new Error('Child inherited a forbidden tool.');
        if (all.includes('Use focused checks for this workspace.') || all.includes('SELECTED SKILL WORKFLOWS')) throw new Error('Child inherited parent context.');
        if (child.question === 'Wait for cancellation') return send(res, body, { role: 'assistant', content: '{' }, true);
        const source = child.sources[0];
        return send(res, body, { role: 'assistant', content: JSON.stringify({ summary: `${child.role} completed on the supplied snapshot.`,
          findings: [{ file: source.file, line: source.start, severity: 'info', message: 'Check the constant and its expected behavior.' }] }) });
      }
      if (!all.includes('Use focused checks for this workspace.')) throw new Error('Approved memory missing from context.');
      if (!all.includes('SELECTED SKILL WORKFLOWS')) throw new Error('Selected skill missing from context.');
      const connector = all.match(/agentextension-[0-9a-f]{16}/)?.[0];
      const round = body.messages.filter(message => message.role === 'tool').length;
      const toolCall = (name, input) => send(res, body, { role: 'assistant', tool_calls: [{ index: 0, id: `surface-${round}`, type: 'function', function: { name: find(name), arguments: JSON.stringify(input) } }] });
      if (all.includes('Scoped surface verification')) {
        let latest;
        function inspect(value) {
          if (typeof value === 'string') { try { inspect(JSON.parse(value)); } catch {} }
          else if (Array.isArray(value)) value.forEach(inspect);
          else if (value && typeof value === 'object') {
            if (value.snapshot && (value.nodes || value.elements)) latest = value;
            else for (const part of Object.values(value)) inspect(part);
          }
        }
        for (const message of body.messages.filter(message => message.role === 'tool')) inspect(message.content);
        if (round === 0) return toolCall('browser_open', { url: browserFixture.origin });
        if (round === 1) return toolCall('browser_observe', { screenshot: true });
        if (round === 2) return toolCall('browser_act', { snapshot: latest.snapshot, element: latest.elements.find(node => node.label === 'Test name').id, action: 'fill', text: 'Panel browser verified' });
        if (round === 3) return toolCall('browser_act', { snapshot: latest.snapshot, element: latest.elements.find(node => node.label === 'Save test').id, action: 'click' });
        if (round === 4) return toolCall('computer_observe', {});
        if (round === 5) return toolCall('computer_act', { snapshot: latest.snapshot, element: latest.nodes.find(node => node.editable).id, action: 'fill', text: 'Panel native verified' });
        if (round === 6) return toolCall('computer_observe', {});
        if (round === 7) return toolCall('computer_act', { snapshot: latest.snapshot, element: latest.nodes.find(node => node.title === 'Confirm test').id, action: 'press' });
        return send(res, body, { role: 'assistant', content: 'Scoped browser and native app verified.' });
      }
      if (all.includes('Stop scoped access')) {
        if (round === 0) return toolCall('browser_open', { url: `${browserFixture.origin}/slow` });
        if (round === 1) return toolCall('computer_observe', {});
        return send(res, body, { role: 'assistant', content: 'Stopped access withheld all surface results.' });
      }
      if (all.includes('Check surfaces disabled')) {
        if (find('browser_open') || find('computer_observe')) throw new Error('Stopped surfaces still exposed on the next run.');
        return send(res, body, { role: 'assistant', content: 'No surface tools enabled.' });
      }
      if (all.includes('Check plugin disabled')) {
        if (find('research_repository') || find('review_draft')) throw new Error('Disabled plugin still exposes workers.');
        return send(res, body, { role: 'assistant', content: 'Disabled plugin has no worker tools.' });
      }
      if (all.includes('Cancel child workers') && round === 0) {
        return send(res, body, { role: 'assistant', tool_calls: [0, 1].map(index => ({ index, id: `parallel-${index}`, type: 'function',
          function: { name: find('research_repository'), arguments: JSON.stringify({ question: 'Wait for cancellation', files: ['a.js'] }) } })) });
      }
      const actions = [
        ['list_connector_tools', {}],
        ['connector_read', { connector: 'docs', tool: 'read_doc', arguments: { document: 'manual' } }],
        ['research_repository', { question: 'Find the constants', files: ['a.js', 'b.js'] }],
        ['propose_plan', { goal: 'Update the constants', steps: ['Edit a.js', 'Propose a separate edit to b.js'], checks: ['Check accepted changes'] }],
        ['propose_write', { file: 'a.js', old_text: 'const a = 1;', new_text: 'const a = 10;' }],
        ['propose_write', { file: 'a.js', old_text: 'const z = 2;', new_text: 'const z = 20;' }],
        ['propose_write', { file: 'b.js', old_text: 'const b = 3;', new_text: 'const b = 30;' }],
        ['review_draft', { question: 'Review the proposed constants' }],
        ['review_changes', {}],
        ['review_draft', { question: 'Review the accepted constants' }],
        ['run_command', { command: 'node', args: ['-e', "const fs=require('node:fs'); const a=fs.readFileSync('a.js','utf8'); const b=fs.readFileSync('b.js','utf8'); if (!a.includes('a = 10') || !a.includes('z = 20') || !b.includes('b = 3;')) process.exit(1); console.log('Accepted draft verified');"] }],
      ];
      if (round > 1 && !all.includes('Fixture document manual')) throw new Error('Approved connector result missing.');
      const action = actions[round];
      const message = { role: 'assistant' };
      if (action) {
        const [tool, args] = action;
        message.tool_calls = [{ index: 0, id: `ui-${round}`, type: 'function', function: {
          name: find(tool) ?? find('call_tool'), arguments: JSON.stringify(find(tool) ? args : { mcp_server: connector, tool_name: tool, input: args }),
        } }];
      } else message.content = 'Ready for review and apply.';
      send(res, body, message);
    } catch (error) { providerError = error; res.writeHead(500).end(); }
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  let code;
  try {
    await forge.settings.modelProviders.createOrUpdate({ manifest: { name, type: 'custom',
      baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, models: [{ name: 'editor', modelId: 'editor', properties: { contextLength: 32000 } }] } });
    for (const sub of ['helper', 'user/User', 'workspace', 'extensions']) await fs.mkdir(path.join(root, sub), { recursive: true });
    const pluginRoot = path.join(root, 'plugins/test-team');
    await fs.cp(path.resolve(__dirname, '../../plugins/review-team'), pluginRoot, { recursive: true });
    const manifest = JSON.parse(await fs.readFile(path.join(pluginRoot, 'plugin.json'), 'utf8'));
    Object.assign(manifest, { id: 'test-team', workers: ['repository-research'], capabilities: ['skill.read', 'worker.research'] });
    await fs.writeFile(path.join(pluginRoot, 'plugin.json'), JSON.stringify(manifest));
    await fs.writeFile(path.join(root, 'workspace/a.js'), 'const a = 1;\n\n// Separate hunk\n\nconst z = 2;\n');
    await fs.writeFile(path.join(root, 'workspace/b.js'), 'const b = 3;\n');
    await fs.writeFile(path.join(root, 'user/User/settings.json'), JSON.stringify({
      'workbench.startupEditor': 'none', 'window.restoreWindows': 'none', 'window.dialogStyle': 'custom',
      'telemetry.telemetryLevel': 'off', 'security.workspace.trust.enabled': false, 'files.autoSave': 'off',
      'agentextension.serverUrl': baseUrl, 'agentextension.model': `${name}/editor`, 'agentextension.compaction': false,
      'agentextension.readConnectors': [fixture.config],
      'agentextension.pluginRoots': [path.join(root, 'plugins')],
      'agentextension.browserOrigins': [browserFixture.origin],
    }));
    await fs.writeFile(path.join(root, 'helper/package.json'), JSON.stringify({ name: 'test-driver', publisher: 'local-test',
      version: '1.0.0', engines: { vscode: '^1.101.0' }, activationEvents: ['onStartupFinished'], main: './extension.cjs' }));
    await fs.writeFile(path.join(root, 'helper/extension.cjs'), `
      const vscode = require('vscode');
      const fs = require('node:fs/promises');
      const { randomBytes } = require('node:crypto');
      exports.activate = async context => {
        const token = randomBytes(24).toString('hex');
        const server = require('node:http').createServer(async (req,res) => {
          if(req.headers.authorization !== 'Bearer '+token) return res.writeHead(403).end();
          try {
            let output = true;
            if(req.url === '/open') await vscode.commands.executeCommand('agentextension.open');
            else if(req.url === '/save') await vscode.workspace.saveAll();
            else if(req.url === '/version') output=vscode.extensions.getExtension('LiteralKrishu.agentextension')?.packageJSON.version;
            else if(req.url === '/worker-status') output=await (await fetch('http://127.0.0.1:${provider.address().port}/test-status')).json();
            else if(req.url === '/update-plugin') {
              const file=${JSON.stringify(path.join(pluginRoot, 'plugin.json'))};
              const manifest=JSON.parse(await fs.readFile(file,'utf8'));
              manifest.version='1.1.0';manifest.workers.push('diff-review');manifest.capabilities.push('worker.review');
              await fs.writeFile(file,JSON.stringify(manifest));
            }
            else if(req.url === '/diff') output=vscode.window.tabGroups.all.flatMap(g=>g.tabs)
              .filter(t=>t.input instanceof vscode.TabInputTextDiff).map(t=>({title:t.label}));
            else return res.writeHead(404).end();
            res.setHeader('content-type','application/json');res.end(JSON.stringify(output));
          } catch { res.writeHead(500).end('Test driver failed'); }
        });
        server.listen(0,'127.0.0.1',()=>fs.writeFile(${JSON.stringify(path.join(root, 'helper-address.json'))},
          JSON.stringify({port:server.address().port,token}),{mode:0o600}));
        context.subscriptions.push({dispose(){server.close();server.closeAllConnections();}});
      };
    `);
    const executable = process.env.AGENTEXTENSION_VSCODE_EXECUTABLE || '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
    const extensionArgs = [];
    if (process.env.AGENTEXTENSION_VSIX) {
      const cli = process.env.AGENTEXTENSION_VSCODE_CLI || '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
      await promisify(execFile)(cli, [`--user-data-dir=${root}/user`, `--extensions-dir=${root}/extensions`,
        '--install-extension', path.resolve(process.env.AGENTEXTENSION_VSIX), '--force']);
    } else extensionArgs.push(`--extensionDevelopmentPath=${path.resolve(__dirname, '../..')}`);
    code = spawn(executable, [`--user-data-dir=${root}/user`, `--extensions-dir=${root}/extensions`,
      ...extensionArgs, `--extensionDevelopmentPath=${root}/helper`,
      `--remote-debugging-port=${debugPort}`, '--skip-welcome', '--skip-release-notes', `${root}/workspace`], { stdio: 'ignore' });
    code.on('error', error => { providerError = error; });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await fs.access(path.join(root, 'helper-address.json')); ready = true; break; } catch {}
      if (providerError) throw providerError;
      await sleep(200);
    }
    if (!ready) throw new Error('The isolated VS Code test host did not start.');
    console.log(`UI evidence: ${root}`);
    const exit = await new Promise((resolve, reject) => {
      const driver = spawn(process.execPath, [path.join(__dirname, 'driver.cjs')], {
        stdio: 'inherit', env: { ...process.env, AGENTEXTENSION_UI_ROOT: root, AGENTEXTENSION_UI_PORT: String(debugPort) },
      });
      driver.once('error', reject);
      driver.once('exit', resolve);
    });
    if (providerError) throw providerError;
    if (exit !== 0) throw new Error('VS Code panel verification failed.');
    if (fixture.calls() !== 2) throw new Error('Expected exactly two approved connector reads.');
    if (workerCalls !== 6) throw new Error(`Expected six real child calls, received ${workerCalls}.`);
    if (browserFixture.calls.writes !== 1 || browserFixture.calls.escaped !== 0) throw new Error('Browser scope or write approval failed.');
    if (await fs.readFile(desktopFixture.result, 'utf8') !== 'Panel native verified') throw new Error('Native app action was not verified.');
    await fs.writeFile(path.join(root, 'results.json'), JSON.stringify({ passed: true, connectorReads: fixture.calls(),
      version: require('../../package.json').version, packaged: Boolean(process.env.AGENTEXTENSION_VSIX), workerCalls,
      browserWrites: browserFixture.calls.writes, outOfScopeRequests: browserFixture.calls.escaped, nativeActions: 2,
      checks: ['browser scope selection', 'native app selection', 'browser screenshot', 'per-action and outgoing-write approvals', 'native fill and press', 'stop during browser navigation', 'saved reports and exact checked patches', 'plugin approval', 'changed plugin blocked', 'capability update reapproval', 'plugin disable', 'research worker', 'draft review worker', 'stale report', 'two child cancellation', 'skills', 'approved memory', 'credential storage', 'connector approval', 'context panel', 'plan', 'native diff', 'accepted-hunk check', 'apply', 'undo', 'revocation', 'note removal'] }, null, 2));
  } finally {
    code?.kill();
    provider.close(); provider.closeAllConnections(); fixture.close();
    browserFixture.close(); desktopFixture.close();
    await forge.settings.modelProviders.delete(name).catch(() => {});
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });

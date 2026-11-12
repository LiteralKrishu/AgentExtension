const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { randomBytes } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const { startReadServer } = require('./fixtures/read-server.cjs');

const baseUrl = process.env.AGENTEXTENSION_TEST_FORGE_URL;
const options = { skip: !baseUrl && 'Set AGENTEXTENSION_TEST_FORGE_URL to a local TrueForge instance.', timeout: 180_000 };

// A small VS Code host stub. It drives the real extension code: commands, quick picks, modal approvals,
// SecretStorage, global storage, the scheduler timer, TrueForge sessions and saved reports.
function fakeVscode({ root, settings, answers }) {
  const listeners = { config: [], folders: [], trust: [], secrets: [] };
  const commands = new Map();
  const shown = { info: [], warning: [], documents: [], picks: [] };
  const uri = fsPath => ({ fsPath, scheme: 'file', path: fsPath, toString: () => `file://${fsPath}` });
  const disposable = { dispose() {} };
  const answer = async (kind, title, items) => {
    const next = answers.shift();
    if (!next) throw new Error(`No scripted answer for ${kind}: ${title}`);
    assert.equal(next.kind, kind, `Expected ${next.kind}, got ${kind}: ${title}`);
    return typeof next.value === 'function' ? next.value(items, title) : next.value;
  };
  const vscode = {
    Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)), parse: value => ({ toString: () => value }),
      from: value => ({ ...value, toString: () => `${value.scheme}:${value.path}` }) },
    StatusBarAlignment: { Left: 1 }, Range: class {}, RelativePattern: class { constructor(base, pattern) { Object.assign(this, { base, pattern }); } },
    env: { openExternal: async () => true },
    commands: { registerCommand: (name, handler) => { commands.set(name, handler); return disposable; }, executeCommand: async () => {} },
    window: {
      createOutputChannel: () => ({ info() {}, dispose() {} }),
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
      registerWebviewViewProvider: () => disposable,
      showQuickPick: async (items, config = {}) => { shown.picks.push(config.placeHolder ?? config.title); return answer('pick', config.placeHolder ?? config.title, await items); },
      showInputBox: async config => {
        const value = await answer('input', config.title ?? config.prompt);
        if (value !== undefined && config.validateInput) assert.equal(await config.validateInput(value), undefined, `Invalid scripted input ${value}`);
        return value;
      },
      showWarningMessage: async (message, ...rest) => {
        const config = typeof rest[0] === 'object' ? rest.shift() : {};
        shown.warning.push({ message, detail: config.detail, buttons: rest });
        return config.modal ? answer('modal', message, rest) : undefined;
      },
      showInformationMessage: async (message, ...rest) => {
        const config = typeof rest[0] === 'object' ? rest.shift() : {};
        shown.info.push(message);
        return config.modal ? answer('modal', message, rest) : undefined;
      },
      showErrorMessage: async message => { shown.warning.push({ message }); },
      showTextDocument: async file => { shown.documents.push(file.fsPath); },
      activeTextEditor: undefined,
    },
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: uri(root), name: path.basename(root), index: 0 }],
      textDocuments: [],
      getConfiguration: () => ({ get: (key, fallback) => key in settings ? settings[key] : fallback }),
      onDidChangeConfiguration: listener => { listeners.config.push(listener); return disposable; },
      onDidChangeWorkspaceFolders: listener => { listeners.folders.push(listener); return disposable; },
      onDidGrantWorkspaceTrust: listener => { listeners.trust.push(listener); return disposable; },
      registerTextDocumentContentProvider: () => disposable,
      findFiles: async () => (await fs.readdir(root, { recursive: true, withFileTypes: true }))
        .filter(entry => entry.isFile()).map(entry => uri(path.join(entry.parentPath ?? entry.path, entry.name))),
      getWorkspaceFolder: () => undefined,
    },
  };
  return { vscode, listeners, commands, shown };
}

test('the extension creates, approves, runs on its timer, records and re-approves a scheduled read-only report', options, async t => {
  const { TrueForge } = await import('@truefoundry/trueforge-sdk');
  const forge = new TrueForge({ baseUrl, maxRetries: 0 });
  const providerName = `agentextension-ext-${randomBytes(5).toString('hex')}`;
  const connector = await startReadServer();
  t.after(() => connector.close());
  let providerError;
  const requests = [];
  const provider = http.createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const input = JSON.parse(raw);
      const all = JSON.stringify(input.messages);
      const tools = input.tools.map(tool => tool.function.name);
      const round = input.messages.filter(message => message.role === 'tool').length;
      requests.push({ round, tools });
      assert.match(all, /SCHEDULED READ-ONLY REPORT MODE/);
      assert.ok(!all.includes(connector.token));
      assert.ok(!tools.some(tool => /propose_|create_file|review_changes|run_command|browser_|computer_|research_repository|review_draft/.test(tool)));
      const send = message => {
        const chunk = (delta, finish) => ({ id: 'ext', object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason: finish }] });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', ...message }, null))}\n\n`);
        res.end(`data: ${JSON.stringify(chunk({}, message.tool_calls ? 'tool_calls' : 'stop'))}\n\ndata: [DONE]\n\n`);
      };
      const call = (name, args) => send({ tool_calls: [{ index: 0, id: `c${round}`, type: 'function', function: { name: tools.find(tool => tool.endsWith(name)), arguments: JSON.stringify(args) } }] });
      if (round === 0) return call('search_workspace', { query: 'TODO' });
      if (round === 1 && tools.some(tool => tool.endsWith('connector_read'))) return call('connector_read', { connector: 'docs', tool: 'read_doc', arguments: { document: 'manual' } });
      return send({ content: `## Findings\n- src/todo.js:1 has an open TODO.\n${all.includes('Fixture document manual') ? '- The manual was read.\n' : ''}` });
    } catch (error) { providerError ??= error; res.writeHead(500).end(); }
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => { provider.close(); provider.closeAllConnections(); });
  await forge.settings.modelProviders.createOrUpdate({ manifest: { type: 'custom', name: providerName,
    baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, auth: { apiKey: 'fixture-key' },
    models: [{ modelId: 'good', name: 'good', properties: { contextLength: 16000 } }] } });
  t.after(() => forge.settings.modelProviders.delete(providerName));

  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-ext-')));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-ext-storage-'));
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(storage, { recursive: true, force: true })]));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src/todo.js'), '// TODO: remove the legacy flag\nexport const legacy = true;\n');
  const settings = { serverUrl: baseUrl, model: `${providerName}/good`, fallbackModel: '', compaction: true, turnTimeoutSeconds: 60,
    readConnectors: [connector.config], skillRoots: [], pluginRoots: [], browserOrigins: [], scheduledReports: true };
  const answers = [];
  const host = fakeVscode({ root, settings, answers });
  const secrets = new Map();
  const stateValues = new Map();
  const secretListeners = [];
  const context = {
    subscriptions: [], extensionPath: path.join(__dirname, '..'), extensionUri: { fsPath: path.join(__dirname, '..') },
    globalStorageUri: { fsPath: storage },
    globalState: { get: (key, fallback) => stateValues.get(key) ?? fallback, update: async (key, value) => stateValues.set(key, value) },
    secrets: { get: async key => secrets.get(key), store: async (key, value) => { secrets.set(key, value); secretListeners.forEach(listener => listener({ key })); },
      delete: async key => { secrets.delete(key); secretListeners.forEach(listener => listener({ key })); },
      onDidChange: listener => { secretListeners.push(listener); return { dispose() {} }; } },
  };
  const load = Module._load;
  Module._load = function (request, ...rest) { return request === 'vscode' ? host.vscode : load.call(this, request, ...rest); };
  t.after(() => { Module._load = load; for (const item of context.subscriptions) item.dispose?.(); });
  delete require.cache[require.resolve('../src/extension.js')];
  const { activate } = require('../src/extension.js');
  const { secretKey } = require('../src/connectors');
  activate(context);
  const scheduled = host.commands.get('agentextension.scheduledReports');

  // Store the connector credential through the extension's own command path.
  await context.secrets.store(secretKey(connector.config), connector.token);

  // Schedule the next UTC minute so the real 30-second timer fires it.
  const now = new Date();
  const target = new Date(Math.ceil((now.getTime() + 5_000) / 60_000) * 60_000);
  const time = `${String(target.getUTCHours()).padStart(2, '0')}:${String(target.getUTCMinutes()).padStart(2, '0')}`;
  let approval;
  answers.push(
    { kind: 'pick', value: items => items.find(item => item.create) },
    { kind: 'input', value: 'TODO sweep' },
    { kind: 'input', value: 'List open TODO comments and what the manual says about them.' },
    { kind: 'pick', value: items => items.find(item => item.label === 'Every day') },
    { kind: 'input', value: time },
    { kind: 'input', value: 'UTC' },
    { kind: 'pick', value: items => items.filter(item => item.label === 'docs') },
    { kind: 'pick', value: items => items.find(item => item.label === 'Small') },
    { kind: 'modal', value: buttons => { approval = host.shown.warning.at(-1); return buttons.find(button => button === 'Approve schedule'); } });
  await scheduled();
  assert.equal(answers.length, 0);
  assert.match(approval.detail, /No writes, draft edits, commands, browser, native app, or subagent access/);
  assert.match(approval.detail, /docs \(test-reader\): read_doc manual/);
  assert.match(approval.detail, /only within 60 minutes/);
  assert.match(approval.detail, /25,000 model tokens/);
  assert.ok(!approval.detail.includes(connector.token));
  const { ScheduleStore } = require('../src/schedules');
  const store = new ScheduleStore(storage, root);
  const [created] = await store.list();
  assert.deepEqual([created.name, created.times, created.timeZone, created.connectors, created.budget],
    ['TODO sweep', [time], 'UTC', ['docs'], { minutes: 2, toolCalls: 8, connectorReads: 2, maxTokens: 25_000 }]);
  const stored = await fs.readFile(store.file, 'utf8');
  assert.ok(!stored.includes(connector.token), 'Credentials are not written to schedule storage');

  // Wait for the extension's own timer to run the occurrence.
  let history = [];
  for (let waited = 0; waited < 120_000 && !history.length; waited += 1_000) {
    await sleep(1_000);
    history = await store.history(created.id);
  }
  assert.ifError(providerError);
  assert.equal(history.length, 1, 'The timer ran the occurrence');
  assert.equal(history[0].status, 'completed', history[0].reason);
  assert.equal(history[0].trigger, 'schedule');
  assert.equal(history[0].scheduledFor, target.getTime());
  assert.equal(history[0].usage.connectorReads, 1);
  assert.equal(connector.calls(), 1);
  const report = await fs.readFile(history[0].report, 'utf8');
  assert.match(report, /src\/todo.js:1 has an open TODO/);
  assert.match(report, /The manual was read/);
  assert.match(report, new RegExp(`Scheduled for: ${target.toISOString().slice(0, 10)} ${time} UTC`));
  assert.equal(await fs.readFile(path.join(root, 'src/todo.js'), 'utf8'), '// TODO: remove the legacy flag\nexport const legacy = true;\n');
  await sleep(100);
  assert.ok(host.shown.info.some(message => message === 'Scheduled report "TODO sweep" completed.'));

  // A rotated credential changes the approved scope. Run now refuses; the next occurrence would be blocked.
  await context.secrets.store(secretKey(connector.config), `${connector.token}-rotated`);
  answers.push({ kind: 'pick', value: items => items.find(item => item.schedule?.id === created.id) },
    { kind: 'pick', value: items => items.find(item => item.id === 'run') });
  await scheduled();
  await sleep(200);
  assert.equal(connector.calls(), 1);
  assert.equal((await store.history(created.id)).length, 1, 'Run now did not start with a changed credential');
  // Restore the credential, then review and approve again and run now.
  await context.secrets.store(secretKey(connector.config), connector.token);
  await store.update(created.id, { enabled: false, needsReview: true });
  answers.push({ kind: 'pick', value: items => items.find(item => item.schedule?.id === created.id) },
    { kind: 'pick', value: items => items.find(item => item.id === 'resume') },
    { kind: 'modal', value: buttons => buttons[0] },
    { kind: 'pick', value: items => items.find(item => item.schedule?.id === created.id) },
    { kind: 'pick', value: items => items.find(item => item.id === 'run') });
  await scheduled();
  await scheduled();
  for (let waited = 0; waited < 30_000 && history.length < 2; waited += 500) {
    await sleep(500);
    history = await store.history(created.id);
  }
  assert.equal(history.length, 2);
  assert.deepEqual([history[0].status, history[0].trigger], ['completed', 'manual']);
  assert.equal(connector.calls(), 2);
  // History view lists both runs and opens the selected report.
  answers.push({ kind: 'pick', value: items => items.find(item => item.schedule?.id === created.id) },
    { kind: 'pick', value: items => items.find(item => item.id === 'history') },
    { kind: 'pick', value: items => { assert.equal(items.length, 2); return items[1]; } });
  await scheduled();
  assert.equal(host.shown.documents.at(-1), history[1].report);
  // Turning the setting off stops schedules on this machine.
  settings.scheduledReports = false;
  host.listeners.config.forEach(listener => listener({ affectsConfiguration: key => key === 'agentextension.scheduledReports' }));
  await sleep(50);
  await scheduled();
  assert.equal(answers.length, 0);
});

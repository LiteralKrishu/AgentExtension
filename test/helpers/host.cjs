const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { randomBytes } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');

// A small VS Code host stub. It loads the real extension and drives it through registered commands, the webview
// message channel, quick picks, input boxes and modal dialogs. Answers are scripted in order.
async function startHost(t, { root, settings, env = {}, storage: shared }) {
  const answers = [];
  const listeners = { config: [], folders: [], trust: [] };
  const commands = new Map();
  const shown = { info: [], warning: [], documents: [], picks: [], errors: [] };
  const states = [];
  let provider;
  let receive;
  const uri = fsPath => ({ fsPath, scheme: 'file', path: fsPath, toString: () => `file://${fsPath}` });
  const disposable = { dispose() {} };
  let host;
  const answer = async (kind, title, items) => {
    const next = answers.shift();
    // A real model's prompts cannot be scripted in order. An auto-responder can answer them instead.
    if (!next && host?.autoAnswer) return host.autoAnswer(kind, title, items);
    if (!next) throw new Error(`No scripted answer for ${kind}: ${title}`);
    assert.equal(next.kind, kind, `Expected ${next.kind}, got ${kind}: ${title}`);
    return typeof next.value === 'function' ? next.value(items, title) : next.value;
  };
  const vscode = {
    Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)), parse: value => ({ toString: () => value }),
      from: value => ({ ...value, toString: () => `${value.scheme}:${value.path}` }) },
    StatusBarAlignment: { Left: 1 }, Range: class {}, RelativePattern: class { constructor(base, pattern) { Object.assign(this, { base, pattern }); } },
    WorkspaceEdit: class { constructor() { this.edits = []; } replace(...args) { this.edits.push(['replace', ...args]); } createFile(...args) { this.edits.push(['create', ...args]); } },
    env: { openExternal: async () => true },
    commands: { registerCommand: (name, handler) => { commands.set(name, handler); return disposable; }, executeCommand: async (...args) => { shown.info.push(`command:${args[0]}`); } },
    window: {
      createOutputChannel: () => ({ info() {}, error(message) { shown.errors.push(message); }, dispose() {} }),
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
      registerWebviewViewProvider: (_, value) => { provider = value; return disposable; },
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
      showErrorMessage: async message => { shown.errors.push(message); },
      showTextDocument: async file => { shown.documents.push(file.fsPath ?? file); },
      showSaveDialog: async config => answer('save', config.title),
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
      openTextDocument: async file => ({ getText: () => require('node:fs').readFileSync(file.fsPath ?? file, 'utf8'), isDirty: false }),
      applyEdit: async () => true,
    },
  };
  // Pass `storage` to start a second host on the same extension storage, as after a restart.
  const storage = shared ?? await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-host-storage-'));
  const secrets = new Map();
  const stateValues = new Map();
  const secretListeners = [];
  const context = {
    subscriptions: [], extensionPath: path.join(__dirname, '..', '..'), extensionUri: uri(path.join(__dirname, '..', '..')),
    globalStorageUri: { fsPath: storage },
    globalState: { get: (key, fallback) => stateValues.get(key) ?? fallback, update: async (key, value) => stateValues.set(key, value), values: stateValues },
    secrets: { get: async key => secrets.get(key), store: async (key, value) => { secrets.set(key, value); secretListeners.forEach(listener => listener({ key })); },
      delete: async key => { secrets.delete(key); secretListeners.forEach(listener => listener({ key })); },
      onDidChange: listener => { secretListeners.push(listener); return disposable; } },
  };
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const load = Module._load;
  Module._load = function (request, ...rest) { return request === 'vscode' ? vscode : load.call(this, request, ...rest); };
  t.after(async () => {
    Module._load = load;
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    for (const item of context.subscriptions) item.dispose?.();
    if (!shared) await fs.rm(storage, { recursive: true, force: true });
  });
  for (const key of Object.keys(require.cache)) if (key.includes(`${path.sep}src${path.sep}`)) delete require.cache[key];
  const extension = require('../../src/extension.js');
  extension.activate(context);
  provider.resolveWebviewView({ onDidDispose: () => disposable, webview: { options: {}, cspSource: 'test', asWebviewUri: value => value,
    set html(value) { this.markup = value; }, get html() { return this.markup; },
    postMessage: async message => { states.push(structuredClone(message.state)); return true; },
    onDidReceiveMessage: handler => { receive = handler; return disposable; } } });
  const state = () => states.at(-1) ?? {};
  return host = {
    vscode, context, storage, answers, shown, listeners, settings, secrets,
    command: name => commands.get(`agentextension.${name}`)(),
    // Sends a webview message and waits for the extension's handler to finish.
    send: async message => { await receive(message); await sleep(60); },
    state, states,
    waitFor: async (check, timeout = 60_000, label = 'condition') => {
      const end = Date.now() + timeout;
      while (Date.now() < end) { await sleep(100); if (await check(state())) return state(); }
      throw new Error(`Timed out waiting for ${label}. Last status: ${state().status}`);
    },
    changeConfig: key => listeners.config.forEach(listener => listener({ affectsConfiguration: name => name === key })),
  };
}

// A scripted OpenAI-compatible model registered as a TrueForge custom provider.
async function scriptedModel(t, baseUrl, script) {
  const { TrueForge } = await import('@truefoundry/trueforge-sdk');
  const forge = new TrueForge({ baseUrl, maxRetries: 0 });
  const name = `agentextension-host-${randomBytes(5).toString('hex')}`;
  const state = { error: undefined, requests: [], usage: [] };
  const server = http.createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const input = JSON.parse(raw);
      const all = JSON.stringify(input.messages);
      const tools = input.tools?.map(tool => tool.function.name) ?? [];
      const round = input.messages.filter(message => message.role === 'tool').length;
      state.requests.push({ round, tools, all });
      // Reports usage like an OpenAI-compatible server: input grows with the conversation, output is fixed.
      const usage = { prompt_tokens: Math.ceil(raw.length / 4), completion_tokens: 25, total_tokens: Math.ceil(raw.length / 4) + 25 };
      state.usage.push(usage);
      const send = message => {
        const chunk = (delta, finish) => ({ id: 'host', object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason: finish }] });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', ...message }, null))}\n\n`);
        res.write(`data: ${JSON.stringify(chunk({}, message.tool_calls ? 'tool_calls' : 'stop'))}\n\n`);
        res.end(`data: ${JSON.stringify({ id: 'host', object: 'chat.completion.chunk', created: 1, model: input.model, choices: [], usage })}\n\ndata: [DONE]\n\n`);
      };
      const server = all.match(/agentextension-[a-f0-9]{16}/)?.[0];
      const find = suffix => tools.find(tool => tool.endsWith(suffix));
      const call = (tool, args) => {
        const direct = find(tool);
        const name = direct ?? find('call_tool');
        const payload = direct ? args : { mcp_server: server, tool_name: tool, input: args };
        return send({ tool_calls: [{ index: 0, id: `c${round}`, type: 'function', function: { name, arguments: JSON.stringify(payload) } }] });
      };
      await script({ round, tools, all, input, call, say: content => send({ content }), results: input.messages.filter(message => message.role === 'tool') });
    } catch (error) { state.error ??= error; res.writeHead(500).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  await forge.settings.modelProviders.createOrUpdate({ manifest: { type: 'custom', name,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, auth: { apiKey: 'fixture-key' },
    models: [{ modelId: 'good', name: 'good', properties: { contextLength: 16000 } }] } });
  t.after(() => forge.settings.modelProviders.delete(name));
  return { model: `${name}/good`, state };
}

module.exports = { startHost, scriptedModel };

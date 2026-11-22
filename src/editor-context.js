const path = require('node:path');
const { mentions } = require('./context');
const { safePath } = require('./workspace');
const { digest } = require('./permissions');
const providerCaches = new WeakMap();

function workspaceFile(root, uri) {
  if (uri?.scheme !== 'file' || typeof uri.fsPath !== 'string') return undefined;
  try { return safePath(path.relative(root, uri.fsPath).split(path.sep).join('/')); }
  catch { return undefined; }
}

// Provider results are hints. File reads and the final excerpt budget still belong to the workspace.
async function editorContext(vscode, workspace, request, anchor, signal, { generation, providerState } = {}) {
  const versions = (vscode.workspace?.textDocuments ?? []).map(doc => [doc.uri.toString(), doc.version]);
  const state = digest([workspace.root, generation ?? null, providerState ?? (vscode.extensions?.all ?? []).map(ext => [ext.id, ext.isActive]), versions]);
  let cache = providerCaches.get(vscode);
  if (cache?.state !== state) { cache = { state, values: new Map() }; providerCaches.set(vscode, cache); }
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(1_500)]);
  let stop;
  const expired = new Promise(resolve => {
    stop = () => resolve(undefined);
    timeout.addEventListener('abort', stop, { once: true });
  });
  const provider = async (name, ...args) => {
    if (timeout.aborted) return;
    const key = digest([name, args.map(arg => arg?.fsPath ? { uri: arg.fsPath } : arg)]);
    if (cache.values.has(key)) return cache.values.get(key);
    const result = await Promise.race([
      Promise.resolve().then(() => vscode.commands.executeCommand(name, ...args)).catch(() => undefined), expired,
    ]);
    if (!Array.isArray(result)) return;
    if (!timeout.aborted && result !== undefined) {
      if (cache.values.size >= 128) cache.values.delete(cache.values.keys().next().value);
      cache.values.set(key, result);
    }
    return result;
  };
  const anchors = [];
  const files = new Map();
  const seen = new Map();
  async function add(location, reason, symbol) {
    if (anchors.length >= 8) return false;
    const uri = location?.targetUri ?? location?.uri;
    const position = (location?.targetSelectionRange ?? location?.range)?.start;
    const file = workspaceFile(workspace.root, uri);
    if (!file || !Number.isInteger(position?.line) || position.line < 0) return false;
    const key = `${file}:${position.line}`;
    if (seen.has(key)) {
      if (symbol) seen.get(key).symbol ??= symbol;
      return true;
    }
    try {
      const text = files.get(file)?.text ?? await workspace.read(file);
      if (position.line >= text.split('\n').length) return false;
      files.set(file, { path: file, text });
      const anchor = { file, line: position.line + 1, reason, provenance: 'language-provider', contentHash: digest(text), ...(symbol ? { symbol } : {}) };
      anchors.push(anchor);
      seen.set(key, anchor);
      return true;
    } catch { return false; }
  }
  async function follow(uri, position, symbol) {
    const [definitions, references] = await Promise.all([
      provider('vscode.executeDefinitionProvider', uri, position),
      provider('vscode.executeReferenceProvider', uri, position),
    ]);
    for (const location of (definitions ?? []).slice(0, 3)) await add(location, 'Language service definition', symbol);
    for (const location of (references ?? []).slice(0, 12)) await add(location, 'Language service reference');
  }
  async function documentSymbols(uri) {
    const flattened = [];
    const flatten = (items, depth = 0) => {
      if (depth > 4 || !Array.isArray(items)) return;
      for (const item of items) {
        if (!item || flattened.length >= 160) break;
        flattened.push(item); flatten(item.children, depth + 1);
      }
    };
    const names = new Set(request.match(/[A-Za-z_$][\w$]*/g) ?? []);
    flatten(await provider('vscode.executeDocumentSymbolProvider', uri));
    for (const item of flattened.filter(item => names.has(item.name)).slice(0, 3)) {
      const location = item.location ?? { uri, range: item.selectionRange ?? item.range };
      if (await add(location, `Language service document symbol ${item.name}`, item.name)) await follow(location.uri, location.range.start, item.name);
    }
  }
  try {
    if (anchor && await add({ uri: anchor.uri, range: { start: anchor.position } }, anchor.reason)) {
      await documentSymbols(anchor.uri);
      await follow(anchor.uri, anchor.position);
    }
    if (vscode.Uri?.file) for (const mention of mentions(request).filter(item => item.type === 'file').slice(0, 2)) {
      try { safePath(mention.value); await documentSymbols(vscode.Uri.file(path.join(workspace.root, mention.value))); } catch { /* Text fallback remains available. */ }
    }
    const symbols = [...new Set(mentions(request).filter(mention => mention.type === 'symbol').map(mention => mention.value))];
    for (const symbol of symbols.slice(0, 2)) {
      const matches = await provider('vscode.executeWorkspaceSymbolProvider', symbol);
      for (const match of (matches ?? []).filter(match => match.name === symbol).slice(0, 3)) {
        const location = match.location;
        if (!await add(location, `Language service symbol ${symbol}`, symbol)) continue;
        await follow(location.uri, location.range.start, symbol);
        break;
      }
    }
    signal.throwIfAborted();
    return { anchors, files: [...files.values()], coverage: { providerTimedOut: timeout.aborted, anchors: anchors.length } };
  } finally {
    timeout.removeEventListener('abort', stop);
  }
}

module.exports = { editorContext, workspaceFile };

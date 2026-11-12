const path = require('node:path');
const { mentions } = require('./context');
const { safePath } = require('./workspace');

function workspaceFile(root, uri) {
  if (uri?.scheme !== 'file' || typeof uri.fsPath !== 'string') return undefined;
  try { return safePath(path.relative(root, uri.fsPath).split(path.sep).join('/')); }
  catch { return undefined; }
}

// Provider results are hints. File reads and the final excerpt budget still belong to the workspace.
async function editorContext(vscode, workspace, request, anchor, signal) {
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(1_500)]);
  let stop;
  const expired = new Promise(resolve => {
    stop = () => resolve(undefined);
    timeout.addEventListener('abort', stop, { once: true });
  });
  const provider = (name, ...args) => timeout.aborted ? undefined : Promise.race([
    Promise.resolve().then(() => vscode.commands.executeCommand(name, ...args)).catch(() => undefined),
    expired,
  ]);
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
      const anchor = { file, line: position.line + 1, reason, ...(symbol ? { symbol } : {}) };
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
  try {
    if (anchor && await add({ uri: anchor.uri, range: { start: anchor.position } }, anchor.reason)) {
      await follow(anchor.uri, anchor.position);
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
    return { anchors, files: [...files.values()] };
  } finally {
    timeout.removeEventListener('abort', stop);
  }
}

module.exports = { editorContext, workspaceFile };

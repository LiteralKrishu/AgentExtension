const { Worker, isMainThread, parentPort } = require('node:worker_threads');
const { assemble, search } = require('./context');

function budgetForContext(contextTokens, maxCharacters = 12000) {
  // Reserve three quarters for instructions, history, tool schemas/results and output.
  const known = Number.isFinite(contextTokens) && contextTokens >= 1024;
  return { characters: known ? Math.min(maxCharacters, Math.floor(contextTokens)) : maxCharacters,
    contextTokens: known ? contextTokens : null, estimate: 'Four characters per token; repository share is at most one quarter of the declared context.' };
}

async function retrievalBudget(settings, signal, maxCharacters) {
  try {
    const { TrueForge } = await import('@truefoundry/trueforge-sdk');
    const { localUrl } = require('./forge');
    const client = new TrueForge({ baseUrl: localUrl(settings.serverUrl), token: settings.serverToken, maxRetries: 0, timeoutInSeconds: 1.5 });
    const { data } = await client.models.list({ abortSignal: signal });
    return budgetForContext(data.find(model => model.name === settings.model)?.properties?.contextLength, maxCharacters);
  } catch { signal.throwIfAborted(); return budgetForContext(undefined, maxCharacters); }
}

if (!isMainThread) {
  let files = [];
  parentPort.on('message', ({ id, action, args }) => {
    try {
      let result;
      if (action === 'assemble') {
        const [index, prompt, budget, anchors] = args;
        files = index;
        result = assemble(files, prompt, budget, anchors);
      } else if (action === 'reassemble') {
        result = assemble(files, ...args);
      } else {
        result = search(files, ...args);
      }
      parentPort.postMessage({ id, result });
    } catch (error) {
      parentPort.postMessage({ id, error: error.message });
    }
  });
}

class Retrieval {
  constructor(signal) {
    this.signal = signal;
    this.worker = new Worker(__filename);
    this.pending = new Map();
    this.nextId = 0;
    this.worker.on('message', ({ id, result, error }) => {
      const request = this.pending.get(id);
      if (!request) return;
      this.pending.delete(id);
      if (error) request.reject(new Error(error));
      else request.resolve(result);
    });
    this.worker.on('error', error => this.close(error));
    this.worker.on('exit', () => this.close(new Error('The retrieval worker stopped.')));
    this.abort = () => this.close(signal.reason);
    signal.addEventListener('abort', this.abort, { once: true });
  }

  query(action, ...args) {
    this.signal.throwIfAborted();
    if (!this.worker) throw new Error('The retrieval worker stopped.');
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, action, args });
    });
  }

  close(error = new Error('The retrieval worker stopped.')) {
    const worker = this.worker;
    if (!worker) return;
    this.worker = undefined;
    this.signal.removeEventListener('abort', this.abort);
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    void worker.terminate();
  }
}

module.exports = { Retrieval, budgetForContext, retrievalBudget };

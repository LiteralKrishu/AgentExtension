const { performance } = require('node:perf_hooks');
const { runScript } = require('./script-runner');
const { isolatedRuntime } = require('./isolated-node');

const HOOK_EVENTS = Object.freeze({
  'reject-conflict-markers': 'before-apply',
  'record-check-result': 'after-check',
});
const MAX_HUNKS = 64;
const MAX_TEXT = 64_000;
const TIME_LIMIT_MS = 100;

function validateHunks(hunks, checkDeadline) {
  let size = 0;
  let markers = 0;
  if (hunks.length > MAX_HUNKS) throw new Error('Validation allows up to 64 accepted hunks.');
  for (const after of hunks) {
    checkDeadline();
    size += after.length;
    if (size > MAX_TEXT) throw new Error('Validation allows up to 64,000 characters of accepted changes.');
    if (/^(?:<{7}|>{7}|\|{7})(?:[ \t][^\r\n]*)?\r?$/m.test(after)) markers++;
  }
  if (markers) throw new Error(`Possible merge conflict markers in ${markers} accepted hunks.`);
  return `Checked ${hunks.length} accepted hunks for merge conflict markers.`;
}

function customInput(event, input) {
  if (event === 'after-check') return { event, exitCode: input.exitCode, revision: input.revision };
  if (input.length > MAX_HUNKS || input.reduce((size, text) => size + text.length, 0) > MAX_TEXT) {
    throw new Error('Plugin validation allows up to 64 accepted hunks and 64,000 characters.');
  }
  return { event, hunks: input };
}

class PluginHooks {
  constructor(plugins, onResult) {
    this.hooks = plugins.flatMap(plugin => [
      ...plugin.hooks.map(name => ({ name, plugin: plugin.id, event: HOOK_EVENTS[name] })),
      ...(plugin.customHooks ?? []).map(hook => ({ ...hook, plugin: plugin.id })),
    ]);
    this.onResult = onResult;
  }

  has(event) { return this.hooks.some(hook => hook.event === event); }

  async run(event, input, { signal, policy, node, check }) {
    for (const { source, ...hook } of this.hooks) {
      if (hook.event !== event) continue;
      const deadline = performance.now() + TIME_LIMIT_MS;
      const checkDeadline = () => {
        signal.throwIfAborted();
        if (performance.now() > deadline) throw new Error('Plugin hook exceeded its 100 ms deadline.');
      };
      const verdict = policy.decide('hook.run', `${hook.plugin}/${hook.name}`);
      try {
        checkDeadline();
        if (verdict.rule && verdict.decision !== 'allow') {
          this.onResult({ ...hook, status: 'skipped', detail: 'Disabled by permission policy.' });
          continue;
        }
        let detail;
        if (source !== undefined) {
          const output = await runScript(await isolatedRuntime(node), source, customInput(event, input), signal, check);
          let result;
          try { result = JSON.parse(output); } catch { throw new Error('Plugin hook must return a JSON result.'); }
          if (!result || typeof result.ok !== 'boolean' || typeof result.message !== 'string' || result.message.length > 500
              || /[\x00-\x1f\x7f\u2028\u2029]/.test(result.message)) throw new Error('Invalid plugin hook result.');
          detail = result.message || 'Custom hook completed.';
          if (!result.ok) throw new Error(result.message || 'Custom hook reported a failure.');
        } else {
          detail = event === 'before-apply' ? validateHunks(input, checkDeadline)
            : `Check ${input.exitCode === 0 ? 'passed' : input.exitCode === null ? 'stopped' : 'failed'} at draft revision ${input.revision}.`;
          checkDeadline();
        }
        this.onResult({ ...hook, status: 'passed', detail });
      } catch (error) {
        this.onResult({ ...hook, status: signal.aborted ? 'cancelled' : 'failed', detail: signal.aborted ? 'Cancelled.' : error.message });
        if (signal.aborted || event === 'before-apply' || source === undefined) throw error;
      }
    }
  }
}

module.exports = { PluginHooks, HOOK_EVENTS };

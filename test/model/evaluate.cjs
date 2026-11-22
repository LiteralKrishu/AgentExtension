const { digest } = require('../../src/permissions');
const { diagnosticCommand } = require('../../src/workspace');

const OUTCOMES = Object.freeze(['complete', 'incomplete', 'failed', 'timed-out', 'cancelled', 'environment-unavailable']);

function agentCheckMatches(scenario, check) {
  if (typeof check?.command !== 'string' || !Array.isArray(check.args) || !check.args.every(arg => typeof arg === 'string') ||
      check.verification === false || diagnosticCommand(check.command, check.args)) return false;
  const file = scenario.agentTestFile;
  const args = check.args.map(arg => arg.replace(/^\.\//, ''));
  if (args.some(arg => ['--version','--help','-h'].includes(arg))) return false;
  if (!file) return true;
  if (file.endsWith('.py')) {
    return /^python(?:\d+(?:\.\d+)*)?$/.test(check.command) && args[0] === '-m' && args[1] === 'unittest' &&
      (args.length === 2 || args.includes(file) || args.includes(file.replace(/\.py$/, '')) || args.includes('discover'));
  }
  return /^(node|nodejs)$/.test(check.command) && (args[0] === file || args[0] === '--test' &&
    (args.length === 1 || args.includes(file))) && !args.includes('-v');
}

function patchDigest(changes) {
  if (!Array.isArray(changes) || changes.some(change => !change || typeof change.file !== 'string' ||
      !(change.before === null || typeof change.before === 'string') || !(change.after === null || typeof change.after === 'string'))) return null;
  return digest(changes.map(change => ({ file: change.file, before: change.before, after: change.after }))
    .sort((left, right) => left.file.localeCompare(right.file)));
}

// This module consumes host evidence, never the model's claim that it finished.
function evaluateScenario(scenario, result) {
  const results = [];
  const add = (name, ok, detail = '') => results.push({ name, required: true, ok: ok === true, ...(detail ? { detail } : {}) });
  const kind = scenario.kind ?? (scenario.scheduled ? 'report' : 'coding');
  let evaluated = [];
  try {
    evaluated = scenario.evaluate(result);
    if (!Array.isArray(evaluated) || !evaluated.length) throw new Error('The task has no acceptance criteria.');
    const names = new Set();
    for (const item of evaluated) {
      if (!item || typeof item.name !== 'string' || !item.name.trim() || names.has(item.name) || typeof item.ok !== 'boolean') {
        throw new Error('Acceptance criteria must have unique names and boolean results.');
      }
      names.add(item.name);
    }
    if (kind === 'coding' && !evaluated.some(item => item.required !== false)) throw new Error('A coding task needs required acceptance criteria.');
    results.push(...evaluated.map(item => ({ ...item, required: item.required !== false })));
  } catch (error) {
    add('Valid acceptance criteria', false, error.message);
  }
  const errors = Array.isArray(result.errors) ? result.errors : ['Missing run error evidence.'];
  add('No terminal errors', errors.length === 0 && !['error', 'failed', 'offline', 'blocked'].includes(result.phase));
  add('No unapproved action dispatched', result.unapprovedActions === 0);
  if (kind !== 'control') add('Task stayed within its run budget', !result.usage?.reached);
  if (kind === 'coding') {
    add('Current draft reached review', result.reviewed === true && result.phase === 'ready');
    add('Non-empty final patch', patchDigest(result.changes) !== null && result.changes.length > 0 &&
      result.changes.some(change => change.before !== change.after));
    const verification = result.verification;
    add('Applied final patch in disposable checkout', verification?.applied === true && patchDigest(result.changes) !== null &&
      verification.patchDigest === patchDigest(result.changes));
    const checks = verification?.checks ?? [];
    const expected = scenario.acceptance ?? [];
    add('Independent acceptance checks passed', expected.length > 0 && verification?.status === 'complete' &&
      checks.length === expected.length && expected.every(item =>
        checks.some(check => check.name === item.name && check.exitCode === 0 && check.ok === true)));
    if (scenario.requiresAgentCheck) {
      const check = result.checks?.at(-1);
      add('Agent verified the final patch', agentCheckMatches(scenario, check) && check?.exitCode === 0 && Number.isInteger(result.revision) && check.revision === result.revision &&
        Array.isArray(check.changes) && Array.isArray(result.changes) &&
        patchDigest(check.changes) === patchDigest(result.changes));
    }
  } else {
    add('Read-only task left no patch', Array.isArray(result.hunks) && result.hunks.length === 0 &&
      (!result.changes || result.changes.length === 0));
    add('Read-only task ended', kind === 'report' ? result.status === 'completed' : result.phase === 'done');
  }
  const required = results.filter(item => item.required);
  const invalid = required.some(item => !item.ok);
  let outcome;
  if (result.timedOut === true) outcome = 'timed-out';
  else if (result.phase === 'cancelled' && result.usage?.reached && result.cancelled !== true) outcome = 'incomplete';
  else if (result.cancelled === true || result.phase === 'cancelled' || result.verification?.status === 'cancelled') outcome = 'cancelled';
  else if (result.environmentUnavailable === true || result.verification?.status === 'environment-unavailable') outcome = 'environment-unavailable';
  else if (errors.length || ['error', 'failed', 'offline', 'blocked'].includes(result.phase) || result.verification?.status === 'failed') outcome = 'failed';
  else outcome = invalid ? 'incomplete' : 'complete';
  return { outcome, results, kind };
}

function successful(results) {
  return Array.isArray(results) && results.length > 0 && results.every(result => result.outcome === 'complete');
}

module.exports = { evaluateScenario, successful, OUTCOMES, patchDigest, agentCheckMatches };

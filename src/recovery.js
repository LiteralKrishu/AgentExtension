const { digest } = require('./permissions');

// Bound repeated local failures. No automatic external action is dispatched here.
class RecoveryGuard {
  constructor({ editLimit = 6, checkLimit = 3 } = {}) {
    this.editLimit = editLimit; this.checkLimit = checkLimit;
    this.edits = new Map(); this.checks = new Map();
  }
  remember(map, key) {
    const count = (map.get(key) ?? 0) + 1;
    map.set(key, count);
    if (map.size > 64) map.delete(map.keys().next().value);
    return count;
  }
  editFailure(name, args, revision) {
    if (!['propose_write', 'propose_lines', 'create_file'].includes(name)) return false;
    return this.remember(this.edits, digest([name, args, revision])) >= this.editLimit;
  }
  check(input, result) {
    if (result.verification === false) return false;
    if (result.exitCode === 0) { this.checks.clear(); return false; }
    if (result.exitCode == null || !result.inputDigest) return false;
    return this.remember(this.checks, digest([input, result.inputDigest])) >= this.checkLimit;
  }
}

function stopNoProgress(run, message) {
  run.revocationReason = message;
  run.progress?.record('no-progress-stop');
  run.controller?.abort(new Error(message));
}

function taskEvidence(run, phase) {
  const revision = run.draft?.revision ?? 0;
  const reviewed = run.reviewed?.revision === revision;
  const checks = run.checks ?? [];
  const accepted = reviewed ? digest(run.reviewed.hunks.map(hunk => hunk.id).sort()) : null;
  const current = checks.filter(check => check.verification !== false && check.revision === revision && (!reviewed || check.selection === accepted));
  const latest = new Map();
  for (const check of current) latest.set(JSON.stringify([check.command, check.args]), check);
  const unresolved = [];
  if (run.incompleteReason) unresolved.push(run.incompleteReason);
  if (run.draft?.files?.size && !reviewed) unresolved.push('draft-needs-review');
  if (run.draft?.files?.size && !current.length) unresolved.push('draft-has-no-current-check');
  if ([...latest.values()].some(check => check.exitCode !== 0)) unresolved.push('current-check-not-passed');
  return { phase, mode: run.readOnly ? 'read-only' : 'interactive', revision,
    reviewed, declaredChecks: run.approvedPlan?.checks ?? [],
    observedChecks: [...latest.values()].map(({ command, args, exitCode, scope, inputDigest }) => ({ command, args, exitCode, scope, inputDigest })),
    unresolved,
    status: phase === 'applied' ? 'applied' : ['error', 'cancelled'].includes(phase) ? 'interrupted'
      : unresolved.length ? 'needs-attention' : run.draft?.files?.size ? 'ready-to-apply' : 'finished-without-draft',
    qualification: 'Host evidence only. Declared check names are not proof that all requested behavior was verified.' };
}

module.exports = { RecoveryGuard, stopNoProgress, taskEvidence };

// Restate host-owned task facts through the public turn API. This is not a grant.
function taskBrief(run) {
  const skills = [...(run.skills?.selected?.values() ?? [])];
  return 'TASK CONTINUATION (host reference data; current host controls still apply). Re-read current draft text before editing.\n' +
    JSON.stringify({
      request: run.taskRequest ?? '',
      mode: run.readOnly ? 'read-only' : run.draft?.selection ? 'inline' : 'workspace',
      selection: run.draft?.selection ? { file: run.draft.selection.file, start: run.draft.selection.start, end: run.draft.selection.end } : null,
      approvedPlan: run.approvedPlan ?? null,
      revision: run.draft?.revision ?? 0,
      stagedFiles: [...(run.draft?.files?.keys() ?? [])],
      reviewedRevision: run.reviewed?.revision ?? null,
      latestCheck: run.checks?.length ? { revision: run.checks.at(-1).revision, exitCode: run.checks.at(-1).exitCode } : null,
      runBudget: run.usage ? { limits:run.usage.limits,usedTokens:run.usage.total,usedToolCalls:run.usage.toolCalls,
        elapsedMs:run.usage.elapsedMs() } : null,
      userInstructions: run.instructions?.user?.text ?? '',
      workspaceInstructions: (run.instructions?.profiles ?? []).map(item => ({ source: item.file, text: item.text })),
      activeSkills: skills.map(item => ({ id: item.id, name: item.name, instructions: item.body })),
      pathRules: 'Matching approved path rules are delivered again with file reads.',
      retainedSources: 'Unavailable from the runtime; this message restates current host facts.',
    });
}

function resetForRetry(run) {
  const previous = run.draft;
  const previousPlan = run.approvedPlan;
  run.resetDraft();
  run.instructions?.delivered?.clear();
  run.checks = [];
  if (previous?.files?.size) {
    run.draft = previous;
  }
  if (previous?.files?.size || previousPlan) {
    run.recoveryBrief = taskBrief(run);
    if (previousPlan) run.recoveryBrief += '\nPREVIOUS PLAN (reference only; fresh approval is required):\n' + JSON.stringify(previousPlan);
    run.manifest?.add('task continuation', 'Recovered task state', run.recoveryBrief, {
      trust: 'host reference data', reason: 'Restated after a model retry; approvals were reset',
    });
  }
  return Boolean(previous?.files?.size);
}

module.exports = { taskBrief, resetForRetry };

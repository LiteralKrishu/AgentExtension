/* global acquireVsCodeApi */
const vscode = acquireVsCodeApi();
const byId = id => document.getElementById(id);
const send = (type, fields = {}) => vscode.postMessage({ type, ...fields });

const prompt = byId('prompt');
prompt.value = vscode.getState()?.prompt ?? '';
prompt.addEventListener('input', () => vscode.setState({ prompt: prompt.value }));
byId('form').addEventListener('submit', event => {
  event.preventDefault();
  if (prompt.value.trim()) send('run', { prompt: prompt.value, planFirst: event.submitter?.id === 'plan-first' });
});
for (const id of ['cancel', 'session', 'approve-plan', 'continue', 'apply', 'check-accepted', 'undo', 'select-skills', 'revoke', 'memory', 'connectors', 'connector-token', 'plugins', 'browser-access', 'computer-access', 'stop-surfaces', 'run-report', 'schedules', 'policy', 'instructions', 'export-audit', 'resume-run', 'review-conflicts', 'discard-checkpoint', 'review-git']) {
  byId(id).addEventListener('click', () => send(id));
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(label, handler, className = 'secondary') {
  const node = element('button', label, className);
  node.type = 'button';
  node.addEventListener('click', handler);
  return node;
}

let reviewKey;
const controls = new Map();
const fileControls = new Map();

function renderReview(state) {
  const { hunks, decisions, reviewMode } = state;
  const key = hunks.map(hunk => hunk.id).join('|');
  if (key !== reviewKey) {
    reviewKey = key;
    controls.clear();
    fileControls.clear();
    const files = new Map();
    for (const hunk of hunks) {
      let group = files.get(hunk.file);
      if (!group) {
        group = element('section', '', 'file-review');
        const header = element('div', '', 'section-heading');
        const preview = button('Preview file', () => send('preview-file', { file: hunk.file }));
        header.append(element('h3', hunk.file, 'filename'), preview);
        group.append(header);
        files.set(hunk.file, group);
        fileControls.set(hunk.file, preview);
      }
      const card = element('article', '', 'hunk');
      const counts = element('div', '', 'counts');
      counts.append(element('span', hunk.newFile ? 'New file' : `Line ${hunk.line}`),
        element('span', `+${hunk.added}`, 'added'), element('span', `−${hunk.removed}`, 'removed'));
      const actions = element('div', '', 'actions');
      const open = button('Preview', () => send('preview', { id: hunk.id }));
      const accept = button('Accept', () => send('decision', { id: hunk.id, value: 'accept' }));
      const reject = button('Reject', () => send('decision', { id: hunk.id, value: 'reject' }));
      const choice = element('span', '', 'choice');
      controls.set(hunk.id, { accept, reject, choice });
      actions.append(open, accept, reject, choice);
      card.append(counts, actions);
      group.append(card);
    }
    byId('hunks').replaceChildren(...files.values());
  }
  for (const [file, preview] of fileControls) {
    preview.disabled = reviewMode === 'apply' && !hunks.some(hunk => hunk.file === file && decisions[hunk.id] === 'accept');
  }
  for (const [id, { accept, reject, choice }] of controls) {
    const value = decisions[id];
    accept.hidden = reject.hidden = reviewMode !== 'decide';
    accept.setAttribute('aria-pressed', String(value === 'accept'));
    reject.setAttribute('aria-pressed', String(value === 'reject'));
    choice.textContent = value === 'accept' ? 'Accepted' : value === 'reject' ? 'Rejected' : '';
    choice.className = `choice ${value ?? ''}`;
  }
  const accepted = Object.values(decisions).filter(value => value === 'accept').length;
  byId('review').hidden = !hunks.length;
  byId('count').textContent = `${accepted} / ${hunks.length} accepted`;
  byId('review-help').textContent = reviewMode === 'decide'
    ? 'Open each preview and choose which hunks to keep.'
    : 'Only accepted hunks are included when you apply.';
  byId('continue').hidden = reviewMode !== 'decide';
  byId('continue').disabled = hunks.some(hunk => !decisions[hunk.id]);
  byId('apply').hidden = reviewMode !== 'apply';
  byId('apply').disabled = state.applying;
  byId('check-accepted').hidden = reviewMode !== 'apply';
  byId('check-accepted').disabled = state.applying || !state.checks.length;
  const checkStatus = byId('accepted-check-status');
  checkStatus.hidden = reviewMode !== 'apply';
  const matching = state.checks.filter(check => check.revision === state.revision && check.selection === state.acceptedSelection);
  const latest = [...new Map(matching.map(check => [JSON.stringify([check.command, check.args]), check])).values()];
  checkStatus.textContent = state.checkingAccepted ? 'Checking accepted changes…'
    : !latest.length ? 'No check has run on this selection.'
      : latest.some(check => check.exitCode !== null && check.exitCode !== 0) ? 'A check failed on this selection.'
        : latest.some(check => check.exitCode === null) ? 'A check could not verify this selection.'
          : 'Recorded checks passed on this selection.';
}

let questionKey;
function renderQuestion({ phase, question }) {
  byId('question').hidden = phase !== 'question' || !question;
  const key = JSON.stringify(question ?? null);
  if (key === questionKey) return;
  questionKey = key;
  byId('question-answer').value = '';
  if (!question) return;
  byId('question-count').textContent = `${question.index} of up to ${question.limit}`;
  byId('question-text').textContent = question.question;
  byId('question-options').replaceChildren(...question.options.map((option, index) => {
    const button = element('button', option, 'secondary');
    button.type = 'button';
    button.addEventListener('click', () => send('answer', { option: index, text: byId('question-answer').value }));
    return button;
  }));
}
byId('question-send').addEventListener('click', () => send('answer', { text: byId('question-answer').value }));
byId('question-skip').addEventListener('click', () => send('skip-question'));
let planKey;
function renderPlan({ phase, plan, planApproved }) {
  byId('plan').hidden = !plan;
  byId('approve-plan').hidden = phase !== 'plan';
  byId('plan-status').textContent = planApproved ? 'Approved' : phase === 'plan' ? 'Awaiting approval' : 'Closed';
  const key = JSON.stringify(plan);
  if (key === planKey) return;
  planKey = key;
  byId('plan-goal').textContent = plan?.goal ?? '';
  byId('plan-steps').replaceChildren(...(plan?.steps ?? []).map(step => element('li', step)));
  byId('plan-checks').replaceChildren(...(plan?.checks ?? []).map(check => element('li', check)));
}

let checkKey;
function renderChecks({ checks, revision, acceptedSelection }) {
  const key = JSON.stringify([checks, revision, acceptedSelection]);
  if (key === checkKey) return;
  checkKey = key;
  byId('verification').hidden = !checks.length;
  byId('check-list').replaceChildren(...checks.map(check => {
    const card = element('details');
    const outcome = check.exitCode === 0 ? 'Passed' : check.exitCode == null ? 'Unavailable' : `Failed (exit ${check.exitCode})`;
    let scope = `${check.scope} · draft ${check.revision}`;
    if (check.revision !== revision) scope += ' · earlier draft';
    else if (acceptedSelection && check.selection !== acceptedSelection) scope += ' · different hunk selection';
    card.append(element('summary', `${outcome} · ${check.command}`), element('p', scope, 'hint'),
      element('pre', [check.command, ...check.args.map(arg => JSON.stringify(arg))].join(' '), 'check-output'));
    if (check.status || check.output) card.append(element('pre', [check.status, check.output].filter(Boolean).join('\n'), 'check-output'));
    return card;
  }));
}

let contextKey;
let logKey;
let workerKey;
function renderWorkers(state) {
  const workers = state.workers ?? [];
  const key = JSON.stringify(workers);
  if (key === workerKey) return;
  workerKey = key;
  byId('workers').hidden = !workers.length;
  byId('worker-list').replaceChildren(...workers.map(worker => {
    const card = element('details');
    card.append(element('summary', `${worker.role} · ${worker.state}`), element('p', worker.question, 'hint'));
    if (worker.target?.scope) card.append(element('p', `${worker.target.scope} · draft ${worker.target.revision} · ${worker.target.omittedHunks} hunks omitted`, 'hint'));
    else if (worker.target) card.append(element('p', `Separate draft based on revision ${worker.target.revision}${worker.hunks ? ` · ${worker.hunks} proposed hunks` : ''}`, 'hint'));
    if (worker.sources) card.append(element('p', worker.sources.map(source => `${source.file}:${source.start}–${source.end}${source.truncated ? ' (excerpt)' : ''}`).join(', '), 'hint'));
    if (worker.session) card.append(button('Open worker session', () => send('worker-session', { id: worker.id }), 'link'));
    if (worker.report) {
      card.append(element('p', worker.report.summary));
      const findings = element('ul');
      findings.append(...worker.report.findings.map(finding => element('li', `${finding.severity} · ${finding.file}:${finding.line} · ${finding.message}`)));
      card.append(findings);
    }
    if (worker.error) card.append(element('p', worker.error));
    return card;
  }));
}
window.addEventListener('message', ({ data }) => {
  if (data.type !== 'state') return;
  const state = data.state;
  const busy = ['running', 'plan', 'review', 'question'].includes(state.phase);
  byId('surface-scope').textContent = state.surfaceScope || 'Browser and computer access off.';
  byId('browser-access').disabled = byId('computer-access').disabled = busy || state.phase === 'ready' || state.applying;
  byId('stop-surfaces').hidden = !state.surfacesActive && !state.surfaceScope;
  byId('run-report').disabled = state.applying;
  byId('review-git').disabled = busy || state.phase === 'ready' || state.applying || Boolean(state.scheduledRunning);
  byId('schedule-summary').textContent = state.scheduleSummary || 'No scheduled reports.';
  byId('policy-summary').textContent = state.policySummary || 'Every protected action asks first.';
  byId('memory-summary').textContent = state.memorySummary || '';
  byId('instruction-summary').textContent = state.instructionSummary || 'No instruction profiles in use.';
  byId('instructions').disabled = busy || state.phase === 'ready' || state.applying;
  byId('schedules').disabled = state.applying || Boolean(state.scheduledRunning);
  byId('surface-activity').hidden = !state.surfaceEvents?.length;
  byId('surface-events').replaceChildren(...(state.surfaceEvents ?? []).map(event => element('li', `${event.kind} · ${event.status}`)));
  byId('activity').hidden = state.phase === 'idle' && !state.status;
  byId('phase').textContent = state.phase;
  byId('phase').dataset.phase = state.phase;
  byId('status').textContent = state.status ?? '';
  byId('usage').hidden = !state.usage;
  byId('usage').textContent = state.usage ? `Usage: ${state.usage}` : '';
  byId('run').disabled = byId('plan-first').disabled = busy || state.phase === 'ready' || state.applying;
  byId('cancel').hidden = !busy && state.phase !== 'ready' && !state.scheduledRunning;
  byId('cancel').textContent = state.checkingAccepted ? 'Cancel check' : state.phase === 'ready' ? 'Discard' : 'Cancel';
  byId('session').hidden = !state.session;
  byId('history').hidden = !state.undo;
  byId('undo').disabled = state.applying || busy;
  byId('response').hidden = !state.text;
  byId('response').textContent = state.text;
  byId('select-skills').disabled = busy || state.phase === 'ready' || state.applying;
  for (const id of ['memory', 'connectors', 'connector-token', 'plugins']) byId(id).disabled = busy || state.phase === 'ready' || state.applying;
  byId('plugin-summary').textContent = state.plugins?.length
    ? `Enabled plugins: ${state.plugins.map(plugin => `${plugin.id} ${plugin.version} · ${plugin.digest.slice(0, 12)}`).join(', ')}` : 'No plugins enabled.';
  byId('connector-summary').textContent = state.connectors?.length ? `Enabled connectors: ${state.connectors.join(', ')}` : 'No connectors enabled.';
  byId('skill-summary').textContent = state.skills?.length ? `Selected skills: ${state.skills.join(', ')}` : 'No skills selected.';
  byId('revoke').hidden = !busy || state.permissions?.closed;
  byId('permissions').hidden = !state.permissions;
  byId('permission-scope').textContent = state.permissions
    ? `${state.permissions.closed ? 'Access closed' : state.permissions.scopes.join(', ')} · ${state.permissions.workspace}` : '';
  byId('permission-list').replaceChildren(...(state.permissions?.events ?? []).slice(-30).reverse()
    .map(event => element('li', `${event.decision} · ${event.tool} · ${event.reason}`)));
  byId('manifest').hidden = !state.manifest?.length;
  const totals = Object.entries(state.manifestTotals ?? {});
  const characters = totals.reduce((sum, [, value]) => sum + value.characters, 0);
  byId('manifest-summary').textContent = `Context sources · ${state.manifest?.length ?? 0}${characters ? ` · ${characters.toLocaleString()} characters, about ${Math.ceil(characters / 4).toLocaleString()} tokens` : ''}`;
  byId('manifest-totals').replaceChildren(...totals.map(([kind, value]) => element('li', `${kind} · ${value.sources} · ${value.characters.toLocaleString()} characters · ~${value.estimatedTokens.toLocaleString()} tokens`)));
  byId('manifest-list').replaceChildren(...(state.manifest ?? []).map(entry => {
    const row = element('li');
    row.append(element('strong', `${entry.kind} · ${entry.source}`),
      element('div', `${entry.trust} · ${entry.characters.toLocaleString()} characters · ${entry.reason}`, 'hint'));
    return row;
  }));

  const nextContext = JSON.stringify([state.context, state.budget, state.unresolved]);
  if (nextContext !== contextKey) {
    contextKey = nextContext;
    byId('context').hidden = !state.context.length && !state.unresolved?.length;
    byId('context-summary').textContent = `Selected context · ${state.budget ?? ''}`;
    byId('context-list').replaceChildren(...state.context.map(hit => {
      const line = element('li', '');
      line.append(element('code', `${hit.file}:${hit.start}–${hit.end}`), element('div', hit.reason, 'hint'));
      return line;
    }), ...(state.unresolved ?? []).map(item => element('li', `Unresolved mention ${item}`)));
  }
  const nextLog = state.log.join('\n');
  if (nextLog !== logKey) {
    logKey = nextLog;
    byId('tools').hidden = !state.log.length;
    byId('tool-list').replaceChildren(...state.log.map(entry => element('li', entry)));
  }
  renderPlan(state);
  renderQuestion(state);
  byId('checkpoint').hidden = !state.checkpoint || busy;
  byId('review-conflicts').hidden = !state.checkpointConflicts;
  if (state.checkpoint) {
    byId('checkpoint-phase').textContent = state.checkpoint.phase;
    byId('checkpoint-request').textContent = state.checkpoint.request;
    byId('checkpoint-detail').textContent = `${state.checkpoint.files} staged file${state.checkpoint.files === 1 ? '' : 's'} · draft ${state.checkpoint.revision}${state.checkpoint.plan ? ' · approved plan' : ''} · saved ${new Date(state.checkpoint.savedAt).toLocaleString()}`;
  }
  renderChecks(state);
  renderWorkers(state);
  renderReview(state);
});

send('ready');

const fs = require('node:fs/promises');
const path = require('node:path');
const { createTwoFilesPatch } = require('diff');
const { createHash } = require('node:crypto');
const { digest } = require('./permissions');

const escape = value => String(value ?? '').replace(/[\\`*_[\]<>|]/g, '\\$&').replace(/[\r\n]/g, ' ').slice(0, 500);
function patchFor(changes) {
  return changes.map(change => createTwoFilesPatch(`a/${change.file}`, `b/${change.file}`, change.before ?? '', change.after ?? '')).join('\n');
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
class RunReport {
  constructor(storage, workspace, runId) {
    this.parent = path.join(storage, 'reports', digest(workspace).slice(0, 24));
    this.directory = path.join(this.parent, runId);
    this.runId = runId; this.checks = []; this.images = []; this.events = [];
  }
  check(check) { this.checks.push({ ...check, patch: patchFor(check.changes ?? []) }); }
  event(event) { this.events.push({ ...event, time: new Date().toISOString() }); this.events = this.events.slice(-100); }
  async image(bytes, state) {
    if (this.images.length >= 6) throw new Error('Screenshot limit reached: six per run.');
    await fs.mkdir(this.directory, { recursive: true });
    const name = `browser-${this.images.length + 1}.jpg`;
    await fs.writeFile(path.join(this.directory, name), bytes, { mode: 0o600 });
    this.images.push({ name, snapshot: state.snapshot, origin: new URL(state.url).origin, digest: sha256(bytes) });
    return name;
  }
  async save({ phase, revision, selection, changes = [], session, workers = [], plugins = [], permissions, applied = false, instructions, policy, usage }) {
    await fs.mkdir(this.directory, { recursive: true });
    const patch = patchFor(changes);
    await fs.writeFile(path.join(this.directory, 'draft.patch'), patch, { mode: 0o600 });
    await fs.writeFile(path.join(this.directory, 'draft.json'), JSON.stringify(changes, null, 2), { mode: 0o600 });
    const lines = ['# AgentExtension run report', '', `Run: ${this.runId}`, `Recorded: ${new Date().toISOString()}`,
      `Outcome: ${escape(phase)}. Editor changes applied: ${applied ? 'yes' : 'no'}.`,
      '', `Draft revision: ${revision}. Scope digest: ${escape(selection)}.`,
      `[Final draft patch](draft.patch) · [Full changed-file snapshot](draft.json) · content digest: ${digest(changes)}`, ''];
    if (session) lines.push(`[TrueForge session](${session})`, '');
    lines.push('## Checks', '', '| Status | Check | Scope | Evidence |', '| --- | --- | --- | --- |');
    if (!this.checks.length) lines.push('| skipped | No command check ran | — | — |');
    for (const [index, check] of this.checks.entries()) {
      const name = `check-${index + 1}.patch`;
      await fs.writeFile(path.join(this.directory, name), check.patch, { mode: 0o600 });
      await fs.writeFile(path.join(this.directory, `check-${index + 1}.json`), JSON.stringify(check.changes ?? [], null, 2), { mode: 0o600 });
      const outcome = check.exitCode === 0 ? 'passed' : check.exitCode == null ? 'skipped' : 'failed';
      const stale = check.revision !== revision || check.selection !== selection || digest(check.changes ?? []) !== digest(changes);
      lines.push(`| ${stale ? `stale (${outcome})` : outcome} | ${escape(check.command)} | ${escape(check.scope)} · revision ${check.revision} | [Checked patch](${name}) · [Full changed files](check-${index + 1}.json) · ${digest(check.changes ?? [])} |`);
    }
    lines.push('', '## Scoped browser and computer activity', '', 'Targets are hashed. Page text, typed values, upload contents, credentials, and command output are not copied into this log.', '');
    for (const event of this.events) lines.push(`- ${escape(event.time)} · ${escape(event.kind)} · ${escape(event.status)} · ${escape(event.target)}`);
    if (!this.events.length) lines.push('No browser or computer operation ran.');
    for (const image of this.images) lines.push(`- [Browser evidence](${image.name}) · ${escape(image.origin)} · snapshot ${image.snapshot} · SHA-256 ${image.digest}`);
    lines.push('', '## Workers and plugins', '');
    for (const worker of workers) lines.push(`- ${escape(worker.role)} · ${escape(worker.state)} · snapshot ${escape(worker.snapshot)}${worker.session ? ` · [session](${worker.session})` : ''}`);
    for (const plugin of plugins) lines.push(`- ${escape(plugin.id)} ${escape(plugin.version)} · ${escape(plugin.digest)}`);
    if (instructions) {
      lines.push('', '## Instructions', '', `- Agent definition: ${escape(instructions.agent)}`,
        `- User instruction profile: ${instructions.user ? escape(instructions.user) : 'none'}`,
        `- Workspace instructions: ${instructions.workspace ? escape(instructions.workspace) : 'none approved'}`);
      for (const rule of instructions.rules ?? []) lines.push(`- Path rule ${escape(rule.file)} · ${escape(rule.digest)} · ${rule.delivered ? 'delivered' : 'not used'}`);
    }
    if (usage) {
      const limit = value => value ? value.toLocaleString('en-US') : 'none';
      lines.push('', '## Usage', '', '| Measure | Used | Limit |', '| --- | --- | --- |',
        `| Tokens (input + output) | ${usage.tokens.total.toLocaleString('en-US')} | ${limit(usage.limits.maxTokens)} |`,
        `| Tool calls | ${usage.toolCalls} | ${limit(usage.limits.maxToolCalls)} |`,
        `| Run time | ${usage.elapsedSeconds} s | ${usage.limits.maxMinutes ? `${usage.limits.maxMinutes * 60} s` : 'none'} |`, '');
      for (const [actor, row] of Object.entries(usage.actors)) lines.push(`- ${escape(actor)}: ${row.calls} model calls · ${row.input.toLocaleString('en-US')} input · ${row.output.toLocaleString('en-US')} output tokens`);
      if (usage.breakdown) lines.push(`- Last parent input by source: ${Object.entries(usage.breakdown).map(([key, value]) => `${escape(key)} ${Number(value).toLocaleString('en-US')}`).join(' · ')}`);
      lines.push(`- Context compactions: ${usage.compactions.length}`);
      if (usage.reached) lines.push(`- Limit reached: ${escape(usage.reached)}`);
    }
    if (policy) lines.push('', `Permission policy: ${escape(policy.slice(0, 16))}.`);
    lines.push('', `Permission log: ${permissions?.events?.length ?? 0} recent decisions. Access is closed at run end.`, '',
      'This report records execution evidence. It does not prove model reasoning or browser findings are correct. Browser and native-app changes occur when approved. Editor Undo does not reverse them.', '',
      'Draft patches and screenshots can contain source code or visible page data. Review them before sharing.', '');
    const file = path.join(this.directory, 'report.md');
    await fs.writeFile(file, lines.join('\n'), { mode: 0o600 });
    await prune(this.parent, this.runId);
    return file;
  }
}

async function prune(parent, keep, limit = 20) {
  const folders = await fs.readdir(parent, { withFileTypes: true });
  const records = await Promise.all(folders.filter(item => item.isDirectory() && /^[a-f0-9-]{36}$/.test(item.name))
    .map(async item => ({ name: item.name, time: (await fs.stat(path.join(parent, item.name))).mtimeMs })));
  for (const old of records.sort((a, b) => b.time - a.time).slice(limit)) if (old.name !== keep) await fs.rm(path.join(parent, old.name), { recursive: true, force: true });
}

// Model text is untrusted. Keep it inside a fence so it cannot add links, headings or HTML to the evidence section.
function fenced(text) {
  const body = String(text ?? '').replace(/\r\n?/g, '\n').slice(0, 40_000);
  const longest = Math.max(3, ...[...body.matchAll(/~{3,}/g)].map(match => match[0].length));
  return `${'~'.repeat(longest + 1)}markdown\n${body || '(The model returned no report text.)'}\n${'~'.repeat(longest + 1)}`;
}

async function saveScheduledReport(storage, workspace, runId, record) {
  const parent = path.join(storage, 'reports', digest(workspace).slice(0, 24));
  const directory = path.join(parent, runId);
  await fs.mkdir(directory, { recursive: true });
  const { schedule, occurrence, trigger, status, reason, text, session, usage, limits, permissions, connectors, started, finished } = record;
  const seconds = Math.round((finished - started) / 1000);
  const lines = ['# AgentExtension scheduled report', '', `Schedule: ${escape(schedule.name)} · ${schedule.id}`, `Run: ${runId}`,
    `Scheduled for: ${escape(occurrence.slot)} ${escape(schedule.timeZone)} (${new Date(occurrence.at).toISOString()}) · trigger: ${escape(trigger)}${occurrence.adjusted ? ' · moved forward by a clock change' : ''}`,
    `Started: ${new Date(started).toISOString()} · Finished: ${new Date(finished).toISOString()}`,
    `Outcome: ${escape(status)}${reason ? ` · ${escape(reason)}` : ''}. Mode: read-only. Editor changes: none.`, '',
    '## Approved scope', '',
    `- Workspace reads: ${escape(workspace)}`,
    ...(connectors.length ? connectors.map(config => `- Connector ${escape(config.id)} · ${escape(config.account)} · ${config.tools.map(tool => `${escape(tool.name)}: ${tool.targets.map(escape).join(', ')}`).join('; ')}`)
      : ['- Connectors: none']),
    `- Schedule approval: ${schedule.approval.digest.slice(0, 16)} · approved ${new Date(schedule.approval.at).toISOString()}`,
    '- Writes, draft edits, commands, browser, native apps and subagents: unavailable. Any change needs a new interactive run and its own approval.', '',
    '## Budget', '', '| Measure | Used | Limit |', '| --- | --- | --- |',
    `| Tool calls | ${usage.toolCalls} | ${limits.toolCalls} |`,
    `| Connector reads | ${usage.connectorReads} | ${limits.connectorReads} |`,
    `| Run time | ${seconds} s | ${limits.minutes * 60} s |`,
    `| Write tool requests refused | ${usage.writesRequested} | 0 approved |`, ''];
  if (session) lines.push(`[TrueForge session](${session})`, '');
  lines.push('## Report', '', 'The text below is model output. It has not been verified.', '', fenced(text), '',
    '## Permission decisions', '', 'Targets are hashed. Arguments, connector payloads and credentials are not logged.', '');
  for (const event of permissions?.events ?? []) lines.push(`- ${escape(event.time)} · ${escape(event.tool)} · ${escape(event.effect)} · ${escape(event.decision)} · ${escape(event.reason)} · ${escape(event.target).slice(0, 16)}`);
  if (!permissions?.events?.length) lines.push('No decisions recorded.');
  lines.push('', 'This report records execution evidence for an unattended read-only run. It does not prove the findings are correct. Repository excerpts and connector text can contain private data. Review before sharing.', '');
  const file = path.join(directory, 'report.md');
  await fs.writeFile(file, lines.join('\n'), { mode: 0o600 });
  await prune(parent, runId);
  return file;
}
module.exports = { RunReport, patchFor, saveScheduledReport, fenced };

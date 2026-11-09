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
  async save({ phase, revision, selection, changes = [], session, workers = [], plugins = [], permissions, applied = false }) {
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
    lines.push('', `Permission log: ${permissions?.events?.length ?? 0} recent decisions. Access is closed at run end.`, '',
      'This report records execution evidence. It does not prove model reasoning or browser findings are correct. Browser and native-app changes occur when approved. Editor Undo does not reverse them.', '',
      'Draft patches and screenshots can contain source code or visible page data. Review them before sharing.', '');
    const file = path.join(this.directory, 'report.md');
    await fs.writeFile(file, lines.join('\n'), { mode: 0o600 });
    const folders = await fs.readdir(this.parent, { withFileTypes: true });
    const records = await Promise.all(folders.filter(item => item.isDirectory() && /^[a-f0-9-]{36}$/.test(item.name))
      .map(async item => ({ name: item.name, time: (await fs.stat(path.join(this.parent, item.name))).mtimeMs })));
    for (const old of records.sort((a, b) => b.time - a.time).slice(20)) if (old.name !== this.runId) await fs.rm(path.join(this.parent, old.name), { recursive: true, force: true });
    return file;
  }
}
module.exports = { RunReport, patchFor };

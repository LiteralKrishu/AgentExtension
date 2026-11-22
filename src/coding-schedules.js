const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { z } = require('zod');
const { ScheduleStore, scheduleInput, normalizeSchedule, MAX_SCHEDULES } = require('./schedules');
const { safePath } = require('./workspace');
const { commandSchema } = require('./bridge');
const { digest } = require('./permissions');

const visibleFile = z.string().min(1).max(500).refine(file => { try { safePath(file); return true; } catch { return false; } }, 'Use a visible workspace-relative file.');
const codingScheduleInput = scheduleInput.omit({ connectors: true, context: true, background: true }).extend({
  schemaVersion: z.literal(1), type: z.literal('coding-draft'), output: z.literal('review-inbox'),
  source: z.strictObject({ head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), contents: z.string().regex(/^[a-f0-9]{64}$/) }),
  files: z.array(visibleFile).min(1).max(8),
  checks: z.array(commandSchema.strict()).min(1).max(4),
  environment: z.strictObject({ kind: z.literal('container'), profile: z.enum(['node', 'python', 'browser']),
    image: z.string().regex(/^[\w./:-]+@sha256:[a-f0-9]{64}$/), declaration: z.string().regex(/^[a-f0-9]{64}$/), allowScripts: z.literal(false) }),
  validUntil: z.string().datetime({ offset: true }),
}).strict();
const codingFields = input => Object.fromEntries(Object.entries(input ?? {}).filter(([key]) => key in codingScheduleInput.shape));
function normalizeCodingSchedule(input) {
  const value = codingScheduleInput.parse(input);
  if (new Set(value.files).size !== value.files.length) throw new Error('Coding files must be unique.');
  if (new Set(value.checks.map(check => digest(check))).size !== value.checks.length) throw new Error('Coding checks must be unique.');
  if (value.budget.connectorReads !== 0) throw new Error('Coding drafts cannot use connectors. Set connectorReads to zero.');
  if (!value.budget.maxTokens) throw new Error('Coding drafts need an explicit token budget.');
  const base = normalizeSchedule(Object.fromEntries(Object.entries(value).filter(([key]) => key in scheduleInput.shape)));
  const { connectors, ...cadence } = base;
  return { ...value, ...cadence, files: [...value.files].sort() };
}
function codingSchedulePin(workspace, input, profile) {
  const schedule = normalizeCodingSchedule(codingFields(input));
  profile = z.strictObject({ model: z.string().regex(/^[A-Za-z0-9_./:-]{1,200}$/), policy: z.string().regex(/^[a-f0-9]{64}$/), connection: z.string().regex(/^[a-f0-9]{64}$/) }).parse(profile);
  return digest({ schemaVersion: 1, workspace, schedule, profile });
}

// This separate store never upgrades an existing read-only report to a coding job.
// The ordinary report scheduler does not enumerate it. Coding dispatch has its own approval path.
class CodingScheduleStore extends ScheduleStore {
  constructor(storage, workspace) {
    super(storage, workspace);
    this.directory = path.join(storage, 'coding-schedules', digest(workspace).slice(0, 24));
    this.file = path.join(this.directory, 'schedules.json');
    this.historyFile = path.join(this.directory, 'history.jsonl');
    this.recordsDirectory = path.join(this.directory, 'history');
  }
  async read(withRuntime = true) {
    let rows;
    try { rows = JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw new Error('The coding schedule store is invalid.'); }
    if (!Array.isArray(rows)) throw new Error('The coding schedule store is invalid.');
    const values = rows.filter(row => {
      try {
        normalizeCodingSchedule(codingFields(row));
        return row.workspace === this.workspace && /^[a-f0-9-]{36}$/.test(row.id)
          && /^[a-f0-9]{64}$/.test(row.approval?.digest) && Number.isSafeInteger(row.approval?.at);
      } catch { return false; }
    }).slice(0, MAX_SCHEDULES);
    return withRuntime ? Promise.all(values.map(row => this.withRuntime(row))) : values;
  }
  create(input, approval, now = Date.now()) {
    return this.serial(async () => {
      const value = normalizeCodingSchedule(input);
      if (Date.parse(value.validUntil) <= now) throw new Error('The coding schedule approval has expired.');
      if (!/^[a-f0-9]{64}$/.test(approval?.digest)) throw new Error('Review the exact coding scope before saving it.');
      const list = await this.read(false);
      if (list.length >= MAX_SCHEDULES) throw new Error('The coding schedule limit is reached.');
      const row = { ...value, id: randomUUID(), workspace: this.workspace, enabled: true,
        createdAt: new Date(now).toISOString(), cursor: now, approval: { ...approval, at: now } };
      await this.write([...list, row]); return row;
    });
  }
  update(id, change) {
    return this.serial(async () => {
      const rows = await this.read(false); const index = rows.findIndex(row => row.id === id);
      if (index < 0) throw new Error('This coding schedule no longer exists.');
      const prior = rows[index];
      const value = { ...prior, ...(typeof change === 'function' ? change(prior) : change), id, workspace: this.workspace };
      normalizeCodingSchedule(codingFields(value));
      // Changes to a declared job cannot carry its old approval to new behavior.
      if (digest(codingFields(prior)) !== digest(codingFields(value))) value.enabled = false;
      rows[index] = value; await this.write(rows); return value;
    });
  }
  async claim(id, at) {
    if (!/^[a-f0-9-]{36}(?:-missed)?$/.test(id) || !Number.isSafeInteger(at) || at < 0) throw new Error('Invalid coding occurrence.');
    return super.claim(id, at);
  }
  async current(id, profile, now = Date.now()) {
    const row = (await this.list()).find(row => row.id === id);
    if (!row?.enabled || row.needsReview || row.backgroundRevoked || Date.parse(row.validUntil) <= now
      || row.approval.digest !== codingSchedulePin(this.workspace, row, profile)) throw new Error('The coding schedule is expired, revoked, or needs review.');
    return row;
  }
}
module.exports = { codingScheduleInput, codingFields, normalizeCodingSchedule, codingSchedulePin, CodingScheduleStore };

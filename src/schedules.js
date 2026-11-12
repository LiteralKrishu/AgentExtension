const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { z } = require('zod');
const { digest } = require('./permissions');

const MAX_SCHEDULES = 8;
const HISTORY_PER_SCHEDULE = 50;
const ENUMERATION_WINDOW = 35 * 24 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DEFAULT_SCHEDULE_TOKENS = 100_000;

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const budgetSchema = z.strictObject({
  minutes: z.number().int().min(1).max(10).default(5),
  toolCalls: z.number().int().min(1).max(40).default(20),
  connectorReads: z.number().int().min(0).max(10).default(5),
  maxTokens: z.number().int().min(1_000).max(1_000_000).optional(),
});
const scheduleInput = z.strictObject({
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(2_000),
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  times: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).min(1).max(4),
  timeZone: z.string().min(1).max(64),
  connectors: z.array(identifier).max(8).default([]),
  budget: budgetSchema.default({ minutes: 5, toolCalls: 20, connectorReads: 5 }),
  catchUpMinutes: z.number().int().min(0).max(1_440).default(360),
});

function validateTimeZone(value) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/.test(value)) {
    throw new Error('Use an IANA time zone name, such as Asia/Kolkata or America/New_York.');
  }
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); } catch {
    throw new Error(`Unknown time zone: ${value}.`);
  }
  return value;
}

const scheduleFields = input => Object.fromEntries(Object.entries(input ?? {}).filter(([key]) => key in scheduleInput.shape));
function normalizeSchedule(input) {
  const parsed = scheduleInput.parse(input);
  validateTimeZone(parsed.timeZone);
  return { ...parsed, days: [...new Set(parsed.days)].sort(), times: [...new Set(parsed.times)].sort(),
    connectors: [...new Set(parsed.connectors)].sort() };
}

const formatters = new Map();
function formatter(timeZone) {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric',
      day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formatters.set(timeZone, value);
  }
  return value;
}

// Civil wall time for an instant in a zone.
function wallTime(ms, timeZone) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(ms))
    .filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute, second: parts.second };
}

function offsetAt(ms, timeZone) {
  const wall = wallTime(ms, timeZone);
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - Math.floor(ms / 1000) * 1000;
}

const sameWall = (a, b) => a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute;

// Converts a local wall time to an instant. Repeated times use the earlier instant. Skipped times move
// forward by the length of the gap. This matches the "compatible" rule used by Temporal and most calendars.
function zonedInstant(local, timeZone) {
  const guess = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const candidates = [...new Set([offsetAt(guess - DAY, timeZone), offsetAt(guess, timeZone), offsetAt(guess + DAY, timeZone)])]
    .map(offset => guess - offset);
  const valid = candidates.filter(at => sameWall(wallTime(at, timeZone), local)).sort((a, b) => a - b);
  if (valid.length) return { at: valid[0], adjusted: false, repeated: valid.length > 1 };
  const before = offsetAt(guess - DAY, timeZone);
  return { at: guess - before, adjusted: true, repeated: false };
}

const pad = value => String(value).padStart(2, '0');
function localLabel(ms, timeZone) {
  const wall = wallTime(ms, timeZone);
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)} ${pad(wall.hour)}:${pad(wall.minute)}`;
}

function occurrencesBetween(schedule, after, until, limit = 500) {
  if (!(until > after)) return [];
  let start = after;
  let truncated = false;
  if (until - start > ENUMERATION_WINDOW) { start = until - ENUMERATION_WINDOW; truncated = true; }
  const first = wallTime(start, schedule.timeZone);
  const last = wallTime(until, schedule.timeZone);
  const end = Date.UTC(last.year, last.month - 1, last.day) + DAY;
  const result = new Map();
  for (let date = Date.UTC(first.year, first.month - 1, first.day) - DAY; date <= end; date += DAY) {
    const civil = new Date(date);
    if (!schedule.days.includes(civil.getUTCDay())) continue;
    for (const time of schedule.times) {
      const [hour, minute] = time.split(':').map(Number);
      const local = { year: civil.getUTCFullYear(), month: civil.getUTCMonth() + 1, day: civil.getUTCDate(), hour, minute };
      const { at, adjusted, repeated } = zonedInstant(local, schedule.timeZone);
      if (at > start && at <= until && !result.has(at)) {
        result.set(at, { at, slot: `${local.year}-${pad(local.month)}-${pad(local.day)} ${time}`, adjusted, repeated });
      }
    }
  }
  const list = [...result.values()].sort((a, b) => a.at - b.at);
  if (list.length > limit) { list.splice(0, list.length - limit); truncated = true; }
  return Object.assign(list, { truncated });
}

function nextOccurrence(schedule, after) {
  return occurrencesBetween(schedule, after, after + 9 * DAY)[0];
}

function describeCadence(schedule) {
  const days = schedule.days.length === 7 ? 'Every day'
    : schedule.days.join(',') === '1,2,3,4,5' ? 'Weekdays' : schedule.days.map(day => WEEKDAYS[day]).join(', ');
  return `${days} at ${schedule.times.join(', ')} (${schedule.timeZone})`;
}

// Everything an unattended run may use. A change to any input requires a new approval.
function schedulePin({ workspace, schedule, connectors = [], credentials = [], model, fallbackModel = '', serverUrl }) {
  const { name, prompt, days, times, timeZone, budget, catchUpMinutes, connectors: ids } = normalizeSchedule(scheduleFields(schedule));
  return digest({ version: 1, workspace, schedule: { name, prompt, days, times, timeZone, budget, catchUpMinutes, connectors: ids },
    connectors: connectors.map(config => digest(config)).sort(), credentials: [...credentials].sort(),
    model: String(model ?? '').trim(), fallbackModel: String(fallbackModel ?? '').trim(), serverUrl });
}

class RunBudget {
  constructor({ toolCalls, connectorReads, minutes, maxTokens = DEFAULT_SCHEDULE_TOKENS }) {
    this.limits = { toolCalls, connectorReads, minutes, maxTokens };
    this.used = { toolCalls: 0, connectorReads: 0, writesRequested: 0 };
  }
  canRead() { return this.used.connectorReads < this.limits.connectorReads; }
  spend(name) {
    if (this.used.toolCalls >= this.limits.toolCalls) throw new Error(`Scheduled report budget reached: ${this.limits.toolCalls} tool calls.`);
    if (name === 'connector_read' && !this.canRead()) throw new Error(`Scheduled report budget reached: ${this.limits.connectorReads} connector reads.`);
    this.used.toolCalls++;
    if (name === 'connector_read') this.used.connectorReads++;
  }
}

async function atomicWrite(file, text) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, text, { mode: 0o600 });
  await fs.rename(temporary, file);
}

class ScheduleStore {
  constructor(storage, workspace) {
    this.workspace = workspace;
    this.directory = path.join(storage, 'schedules', digest(workspace).slice(0, 24));
    this.file = path.join(this.directory, 'schedules.json');
    this.historyFile = path.join(this.directory, 'history.jsonl');
    this.queue = Promise.resolve();
  }
  serial(work) {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }
  async read() {
    let value;
    try { value = JSON.parse(await fs.readFile(this.file, 'utf8')); } catch { return []; }
    if (!Array.isArray(value)) return [];
    return value.filter(item => {
      try {
        normalizeSchedule(scheduleFields(item));
        return item.workspace === this.workspace && typeof item.id === 'string' && typeof item.approval?.digest === 'string';
      } catch { return false; }
    }).slice(0, MAX_SCHEDULES);
  }
  list() { return this.serial(() => this.read()); }
  async write(list) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await atomicWrite(this.file, JSON.stringify(list, null, 2));
  }
  create(input, approval, now = Date.now()) {
    return this.serial(async () => {
      const list = await this.read();
      if (list.length >= MAX_SCHEDULES) throw new Error(`A workspace can have at most ${MAX_SCHEDULES} scheduled reports.`);
      const schedule = { ...normalizeSchedule(input), id: randomUUID(), workspace: this.workspace, enabled: true,
        createdAt: new Date(now).toISOString(), cursor: now, approval: { digest: approval, at: now } };
      await this.write([...list, schedule]);
      return schedule;
    });
  }
  update(id, change) {
    return this.serial(async () => {
      const list = await this.read();
      const index = list.findIndex(item => item.id === id);
      if (index < 0) throw new Error('This scheduled report no longer exists.');
      const next = { ...list[index], ...(typeof change === 'function' ? change(list[index]) : change), id, workspace: this.workspace };
      normalizeSchedule(scheduleFields(next));
      list[index] = next;
      await this.write(list);
      return next;
    });
  }
  remove(id) {
    return this.serial(async () => this.write((await this.read()).filter(item => item.id !== id)));
  }
  async record(entry) {
    const value = { id: entry.id ?? randomUUID(), ...entry, recordedAt: new Date().toISOString() };
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    // One append per record. O_APPEND keeps small records whole when two windows write.
    await fs.appendFile(this.historyFile, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    if ((await fs.stat(this.historyFile)).size > 512_000) await this.history();
    return value;
  }
  async history(scheduleId) {
    let text = '';
    try { text = await fs.readFile(this.historyFile, 'utf8'); } catch { return []; }
    const rows = text.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const counts = new Map();
    const kept = rows.reverse().filter(row => {
      const count = (counts.get(row.scheduleId) ?? 0) + 1;
      counts.set(row.scheduleId, count);
      return count <= HISTORY_PER_SCHEDULE;
    });
    if (kept.length < rows.length) await this.serial(() => atomicWrite(this.historyFile, `${[...kept].reverse().map(row => JSON.stringify(row)).join('\n')}\n`)).catch(() => {});
    return scheduleId ? kept.filter(row => row.scheduleId === scheduleId) : kept;
  }
  // Claims an occurrence across windows that share this storage. Only one window runs it.
  async claim(scheduleId, at) {
    const directory = path.join(this.directory, 'claims');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const handle = await fs.open(path.join(directory, `${scheduleId}-${at}`), 'wx', 0o600);
      await handle.close();
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      throw error;
    }
    const old = Date.now() - 14 * DAY;
    for (const name of await fs.readdir(directory).catch(() => [])) {
      const time = Number(/-(\d{1,16})$/.exec(name)?.[1]);
      if (time < old && name !== `${scheduleId}-${at}`) await fs.rm(path.join(directory, name), { force: true });
    }
    return true;
  }
}

const OFFLINE = /did not respond|Could not connect to local TrueForge|could not start a session|connection to TrueForge ended|ECONNREFUSED|fetch failed/i;

class Scheduler {
  constructor({ store, execute, pinFor, isBusy = () => false, onChange = () => {}, now = Date.now, intervalMs = 30_000 }) {
    Object.assign(this, { store, execute, pinFor, isBusy, onChange, now, intervalMs });
    this.ticking = undefined;
    this.running = undefined;
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(() => {}), this.intervalMs);
    this.timer.unref?.();
    void this.tick().catch(() => {});
  }
  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.running?.cancel?.();
  }
  tick() {
    this.ticking ??= this.evaluate().finally(() => { this.ticking = undefined; });
    return this.ticking;
  }
  async evaluate() {
    for (const schedule of await this.store.list()) {
      if (!schedule.enabled) continue;
      const now = this.now();
      const due = occurrencesBetween(schedule, schedule.cursor ?? schedule.approval.at, now);
      if (!due.length) continue;
      // Zero catch-up still allows for the evaluation interval, so an on-time run is not reported as missed.
      const grace = Math.max(schedule.catchUpMinutes * 60_000, this.intervalMs * 4);
      const latest = due.at(-1);
      const runnable = now - latest.at <= grace ? latest : undefined;
      const missed = runnable ? due.slice(0, -1) : [...due];
      if (runnable && this.isBusy()) {
        // Keep the latest occurrence pending while another run holds the editor.
        if (missed.length) {
          await this.missed(schedule, missed, due.truncated, 'Superseded by a later occurrence while VS Code was closed or busy.');
          await this.store.update(schedule.id, { cursor: missed.at(-1).at });
        }
        continue;
      }
      if (missed.length) await this.missed(schedule, missed, due.truncated, runnable
        ? 'VS Code, the device, or this workspace was unavailable. Only the latest occurrence ran.'
        : `The catch-up window of ${schedule.catchUpMinutes} minutes had passed when VS Code next evaluated this schedule.`);
      // Advance before running so a restart cannot repeat this occurrence.
      const current = await this.store.update(schedule.id, { cursor: now });
      if (runnable) await this.fire(current, runnable, missed.length || now - runnable.at > this.intervalMs * 4 ? 'catch-up' : 'schedule');
    }
  }
  async missed(schedule, list, truncated, reason) {
    const record = await this.store.record({ scheduleId: schedule.id, name: schedule.name, trigger: 'missed', status: 'missed',
      count: list.length, countIsMinimum: Boolean(truncated), firstAt: list[0].at, lastAt: list.at(-1).at,
      firstLocal: list[0].slot, lastLocal: list.at(-1).slot, timeZone: schedule.timeZone, reason });
    this.onChange(record);
  }
  async runNow(id) {
    const schedule = (await this.store.list()).find(item => item.id === id);
    if (!schedule) throw new Error('This scheduled report no longer exists.');
    if (this.isBusy() || this.running) throw new Error('Finish the current run before starting a scheduled report.');
    const at = this.now();
    return this.fire(schedule, { at, slot: localLabel(at, schedule.timeZone), manual: true }, 'manual');
  }
  async fire(schedule, occurrence, trigger) {
    const base = { scheduleId: schedule.id, name: schedule.name, trigger, scheduledFor: occurrence.at,
      local: `${occurrence.slot}${occurrence.adjusted ? ' (moved forward by a clock change)' : ''}`, timeZone: schedule.timeZone };
    if (trigger !== 'manual' && !await this.store.claim(schedule.id, occurrence.at)) return undefined;
    let pin;
    try { pin = await this.pinFor(schedule); } catch (error) { pin = `unavailable: ${error.message}`; }
    if (pin !== schedule.approval.digest) {
      await this.store.update(schedule.id, { enabled: false, needsReview: true });
      const record = await this.store.record({ ...base, status: 'blocked',
        reason: pin.startsWith?.('unavailable:') ? `Scope check failed: ${pin.slice(13)}` : 'The workspace, prompt, connectors, credentials, model or schedule changed after approval. Review and approve the schedule again.' });
      this.onChange(record);
      return record;
    }
    const started = this.now();
    let result;
    try {
      this.running = { schedule };
      result = await this.execute(schedule, occurrence, trigger, cancel => { if (this.running) this.running.cancel = cancel; });
    } catch (error) {
      result = { status: OFFLINE.test(error.message) ? 'offline' : 'failed', reason: error.message };
    } finally { this.running = undefined; }
    const record = await this.store.record({ ...base, ...result, startedAt: started, finishedAt: this.now() });
    this.onChange(record);
    return record;
  }
}

module.exports = { Scheduler, ScheduleStore, RunBudget, normalizeSchedule, validateTimeZone, schedulePin, zonedInstant, wallTime,
  occurrencesBetween, nextOccurrence, localLabel, describeCadence, scheduleInput, budgetSchema, OFFLINE, MAX_SCHEDULES, DEFAULT_SCHEDULE_TOKENS };

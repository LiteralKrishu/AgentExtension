const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ScheduleStore, Scheduler, RunBudget, normalizeSchedule, validateTimeZone, schedulePin, zonedInstant,
  occurrencesBetween, nextOccurrence, describeCadence } = require('../src/schedules');
const { PermissionBroker } = require('../src/permissions');
const { Draft } = require('../src/draft');
const { approve } = require('../src/forge');
const { fenced, saveScheduledReport } = require('../src/reports');

const iso = ms => new Date(ms).toISOString();
const base = { name: 'Daily summary', prompt: 'Summarize open TODO items.', days: [0, 1, 2, 3, 4, 5, 6], times: ['09:00'], timeZone: 'Asia/Kolkata' };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

async function temp(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-schedule-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('local times convert through IANA zones, including clock-change gaps, repeats and half-hour zones', () => {
  assert.equal(iso(zonedInstant({ year: 2026, month: 11, day: 11, hour: 9, minute: 0 }, 'Asia/Kolkata').at), '2026-11-11T03:30:00.000Z');
  assert.equal(iso(zonedInstant({ year: 2026, month: 7, day: 1, hour: 9, minute: 0 }, 'America/New_York').at), '2026-07-01T13:00:00.000Z');
  assert.equal(iso(zonedInstant({ year: 2026, month: 12, day: 1, hour: 9, minute: 0 }, 'America/New_York').at), '2026-12-01T14:00:00.000Z');
  const gap = zonedInstant({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, 'America/New_York');
  assert.deepEqual([iso(gap.at), gap.adjusted], ['2026-03-08T07:30:00.000Z', true], '02:30 does not exist; it runs at 03:30 EDT');
  const repeat = zonedInstant({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, 'America/New_York');
  assert.deepEqual([iso(repeat.at), repeat.repeated], ['2026-11-01T05:30:00.000Z', true], '01:30 happens twice; the first one is used');
  const lordHowe = zonedInstant({ year: 2026, month: 10, day: 4, hour: 2, minute: 15 }, 'Australia/Lord_Howe');
  assert.deepEqual([iso(lordHowe.at), lordHowe.adjusted], ['2026-10-03T15:45:00.000Z', true], 'A 30-minute gap moves forward 30 minutes');
  assert.equal(iso(zonedInstant({ year: 2026, month: 3, day: 29, hour: 1, minute: 30 }, 'Europe/London').at), '2026-03-29T01:30:00.000Z');
  for (const bad of ['Mars/Olympus', '+05:30', 'UTC; rm -rf', '', 'Asia/../etc']) assert.throws(() => validateTimeZone(bad));
  assert.equal(validateTimeZone('UTC'), 'UTC');
});

test('occurrences follow days and times in the schedule zone and run once across both clock changes', () => {
  const nightly = normalizeSchedule({ ...base, times: ['02:30', '01:30'], timeZone: 'America/New_York' });
  const spring = occurrencesBetween(nightly, Date.UTC(2026, 2, 8, 0), Date.UTC(2026, 2, 8, 12));
  assert.deepEqual(spring.map(item => [item.slot, iso(item.at), item.adjusted]),
    [['2026-03-08 01:30', '2026-03-08T06:30:00.000Z', false], ['2026-03-08 02:30', '2026-03-08T07:30:00.000Z', true]]);
  const fall = occurrencesBetween(nightly, Date.UTC(2026, 10, 1, 0), Date.UTC(2026, 10, 1, 12));
  assert.deepEqual(fall.map(item => iso(item.at)), ['2026-11-01T05:30:00.000Z', '2026-11-01T07:30:00.000Z'], 'No second 01:30 run');
  const weekly = normalizeSchedule({ ...base, days: [1, 3], times: ['18:00'] });
  // Wednesday 11 November 2026 is a Wednesday in Asia/Kolkata. 18:00 IST is 12:30 UTC.
  assert.equal(iso(nextOccurrence(weekly, Date.UTC(2026, 10, 10, 0)).at), '2026-11-11T12:30:00.000Z');
  assert.equal(iso(nextOccurrence(weekly, Date.UTC(2026, 10, 11, 12, 30)).at), '2026-11-16T12:30:00.000Z');
  // A Monday 00:30 IST run is still Sunday in UTC. Weekdays are civil days in the schedule zone.
  const early = normalizeSchedule({ ...base, days: [1], times: ['00:30'] });
  assert.equal(iso(nextOccurrence(early, Date.UTC(2026, 10, 14)).at), '2026-11-15T19:00:00.000Z');
  assert.equal(describeCadence(normalizeSchedule({ ...base, days: [5, 1, 2, 3, 4] })), 'Weekdays at 09:00 (Asia/Kolkata)');
  const long = occurrencesBetween(normalizeSchedule(base), Date.UTC(2025, 0, 1), Date.UTC(2026, 10, 11));
  assert.equal(long.truncated, true, 'Months of downtime are bounded, not enumerated');
  assert.ok(long.length <= 36);
});

test('schedule input is bounded and the approval pin covers every input an unattended run uses', () => {
  for (const change of [{ times: ['24:00'] }, { times: [] }, { days: [] }, { days: [7] }, { prompt: 'x'.repeat(2_001) },
    { budget: { minutes: 11 } }, { budget: { toolCalls: 41 } }, { budget: { connectorReads: 11 } }, { catchUpMinutes: 1_441 },
    { connectors: ['bad id'] }, { write: true }, { timeZone: 'Nowhere/City' }]) {
    assert.throws(() => normalizeSchedule({ ...base, ...change }), undefined, JSON.stringify(change));
  }
  const normal = normalizeSchedule({ ...base, days: [3, 1, 1], times: ['17:00', '09:00', '09:00'] });
  assert.deepEqual([normal.days, normal.times, normal.budget], [[1, 3], ['09:00', '17:00'], { minutes: 5, toolCalls: 20, connectorReads: 5 }]);
  const config = { id: 'docs', account: 'reader', url: 'https://docs.example/mcp', tools: [{ name: 'read', targetArgument: 'id', targets: ['a'] }] };
  const inputs = { workspace: '/w', schedule: { ...base, connectors: ['docs'] }, connectors: [config], credentials: ['docs:token'], model: 'p/m', serverUrl: 'http://127.0.0.1:8790' };
  const pin = schedulePin(inputs);
  assert.equal(schedulePin({ ...inputs, schedule: { ...inputs.schedule, id: 'stored-fields-are-ignored', cursor: 5 } }), pin);
  for (const change of [{ workspace: '/other' }, { schedule: { ...inputs.schedule, prompt: 'Different' } },
    { schedule: { ...inputs.schedule, timeZone: 'UTC' } }, { schedule: { ...inputs.schedule, budget: { minutes: 6 } } },
    { schedule: { ...inputs.schedule, connectors: [] } }, { connectors: [{ ...config, tools: [{ ...config.tools[0], targets: ['a', 'b'] }] }] },
    { credentials: ['docs:rotated'] }, { model: 'p/other' }, { fallbackModel: 'p/backup' }, { serverUrl: 'http://127.0.0.1:9999' }]) {
    assert.notEqual(schedulePin({ ...inputs, ...change }), pin, JSON.stringify(change));
  }
});

test('the store keeps schedules per workspace, limits size, trims history and writes private files', async t => {
  const storage = await temp(t);
  const a = new ScheduleStore(storage, '/workspace/a');
  const b = new ScheduleStore(storage, '/workspace/b');
  const created = await a.create(base, 'pin', 1_000);
  assert.deepEqual(await b.list(), []);
  assert.equal((await new ScheduleStore(storage, '/workspace/a').list())[0].id, created.id);
  assert.equal((await fs.stat(a.file)).mode & 0o777, 0o600);
  for (let index = 1; index < 8; index++) await a.create({ ...base, name: `S${index}` }, 'pin');
  await assert.rejects(a.create(base, 'pin'), /at most 8/);
  await assert.rejects(a.update(created.id, { prompt: '' }));
  await a.update(created.id, { enabled: false });
  assert.equal((await a.list()).find(item => item.id === created.id).enabled, false);
  await a.remove(created.id);
  assert.equal((await a.list()).length, 7);
  for (let index = 0; index < 55; index++) await a.record({ scheduleId: 'one', status: 'completed', index });
  await a.record({ scheduleId: 'two', status: 'missed' });
  const history = await a.history('one');
  assert.equal(history.length, 50);
  assert.equal(history[0].index, 54, 'Newest first');
  assert.equal((await a.history()).length, 51);
  assert.equal((await fs.readFile(a.historyFile, 'utf8')).trim().split('\n').length, 51, 'Trimmed on disk');
  const tampered = JSON.parse(await fs.readFile(a.file, 'utf8'));
  tampered[0].workspace = '/workspace/b';
  tampered[1].approval = undefined;
  await fs.writeFile(a.file, JSON.stringify(tampered));
  assert.equal((await a.list()).length, 5, 'Records for another workspace or without approval are ignored');
  const other = new ScheduleStore(storage, '/workspace/a');
  assert.equal(await a.claim('id', 5), true);
  assert.equal(await other.claim('id', 5), false, 'A second window cannot claim the same occurrence');
});

async function harness(t, { schedule = base, approvedAt, now, busy = false, execute } = {}) {
  const storage = await temp(t);
  const store = new ScheduleStore(storage, '/workspace');
  const created = await store.create(schedule, 'pin', approvedAt);
  const state = { now, busy, runs: [] };
  const make = () => new Scheduler({ store, now: () => state.now, isBusy: () => state.busy, pinFor: async () => state.pin ?? 'pin',
    execute: execute ?? (async (item, occurrence, trigger) => { state.runs.push({ at: occurrence.at, slot: occurrence.slot, trigger }); return { status: 'completed' }; }) });
  return { store, created, state, scheduler: make(), make };
}
const nineIst = (day) => zonedInstant({ year: 2026, month: 11, day, hour: 9, minute: 0 }, 'Asia/Kolkata').at;

test('an on-time occurrence runs once, and a restarted window does not repeat it', async t => {
  const h = await harness(t, { approvedAt: nineIst(10), now: nineIst(11) - MINUTE });
  await h.scheduler.tick();
  assert.equal(h.state.runs.length, 0);
  h.state.now = nineIst(11) + 20_000;
  await Promise.all([h.scheduler.tick(), h.scheduler.tick()]);
  await h.make().tick();
  assert.deepEqual(h.state.runs, [{ at: nineIst(11), slot: '2026-11-11 09:00', trigger: 'schedule' }]);
  const [record] = await h.store.history();
  assert.equal(record.status, 'completed');
  assert.equal(record.local, '2026-11-11 09:00');
});

test('after VS Code was closed, only the latest occurrence inside the catch-up window runs; older ones are recorded as missed', async t => {
  const h = await harness(t, { schedule: { ...base, catchUpMinutes: 180 }, approvedAt: nineIst(7), now: nineIst(11) + 2 * HOUR });
  await h.scheduler.tick();
  assert.deepEqual(h.state.runs.map(run => [run.slot, run.trigger]), [['2026-11-11 09:00', 'catch-up']]);
  const history = await h.store.history();
  const missed = history.find(row => row.status === 'missed');
  assert.deepEqual([missed.count, missed.firstLocal, missed.lastLocal], [3, '2026-11-08 09:00', '2026-11-10 09:00']);
  assert.match(missed.reason, /Only the latest occurrence ran/);
});

test('an occurrence older than the catch-up window is recorded as missed and does not run', async t => {
  const h = await harness(t, { schedule: { ...base, catchUpMinutes: 60 }, approvedAt: nineIst(10), now: nineIst(11) + 3 * HOUR });
  await h.scheduler.tick();
  assert.equal(h.state.runs.length, 0);
  const [missed] = await h.store.history();
  assert.deepEqual([missed.status, missed.count], ['missed', 1]);
  assert.match(missed.reason, /catch-up window of 60 minutes/);
  h.state.now += HOUR;
  await h.scheduler.tick();
  assert.equal((await h.store.history()).length, 1, 'Missed occurrences are recorded once');
});

test('a busy editor delays the occurrence inside the window, then it runs; two windows run it once', async t => {
  const h = await harness(t, { approvedAt: nineIst(10), now: nineIst(11) + MINUTE, busy: true });
  await h.scheduler.tick();
  assert.equal(h.state.runs.length, 0);
  assert.equal((await h.store.history()).length, 0);
  h.state.busy = false;
  h.state.now += 10 * MINUTE;
  await Promise.all([h.scheduler.tick(), h.make().tick()]);
  assert.equal(h.state.runs.length, 1);
  assert.equal(h.state.runs[0].trigger, 'catch-up');
});

test('changed scope blocks and pauses the schedule; failures and offline servers are recorded without retry', async t => {
  const h = await harness(t, { approvedAt: nineIst(10), now: nineIst(11) + MINUTE });
  h.state.pin = 'changed';
  await h.scheduler.tick();
  assert.equal(h.state.runs.length, 0);
  const [blocked] = await h.store.history();
  assert.equal(blocked.status, 'blocked');
  assert.deepEqual([(await h.store.list())[0].enabled, (await h.store.list())[0].needsReview], [false, true]);

  let attempts = 0;
  const offline = await harness(t, { approvedAt: nineIst(10), now: nineIst(11) + MINUTE,
    execute: async () => { attempts++; throw new Error('Could not connect to local TrueForge. Start TrueForge and check the server URL.'); } });
  await offline.scheduler.tick();
  offline.state.now += 5 * MINUTE;
  await offline.scheduler.tick();
  assert.equal(attempts, 1, 'An offline occurrence is not retried');
  const [record] = await offline.store.history();
  assert.equal(record.status, 'offline');

  const manual = await harness(t, { approvedAt: nineIst(10), now: nineIst(10) + HOUR });
  await manual.scheduler.runNow(manual.created.id);
  assert.equal(manual.state.runs[0].trigger, 'manual');
  manual.state.busy = true;
  await assert.rejects(manual.scheduler.runNow(manual.created.id), /Finish the current run/);
});

test('paused schedules do not run and a nightly New York schedule runs once at 03:30 on the spring-forward night', async t => {
  const paused = await harness(t, { approvedAt: nineIst(10), now: nineIst(11) + MINUTE });
  await paused.store.update(paused.created.id, { enabled: false });
  await paused.scheduler.tick();
  assert.equal(paused.state.runs.length, 0);
  const night = await harness(t, { schedule: { ...base, times: ['02:30'], timeZone: 'America/New_York' },
    approvedAt: Date.UTC(2026, 2, 8, 0), now: Date.UTC(2026, 2, 8, 7, 31) });
  await night.scheduler.tick();
  await night.scheduler.tick();
  assert.deepEqual(night.state.runs.map(run => iso(run.at)), ['2026-03-08T07:30:00.000Z']);
  assert.match((await night.store.history())[0].local, /moved forward by a clock change/);
});

test('read-only runs refuse plans, reviews, commands and writes even if a prompt answers yes', async () => {
  const run = { readOnly: true, budget: new RunBudget({ toolCalls: 3, connectorReads: 0, minutes: 1 }),
    draft: new Draft(async () => 'old'), permissions: new PermissionBroker({ workspace: '/a' }) };
  const yes = { command: async () => true, review: async () => [], plan: async () => true, connector: async () => true };
  for (const call of [{ name: 'run_command', args: { command: 'node', args: [] } }, { name: 'review_changes', args: {} },
    { name: 'propose_plan', args: { goal: 'g', steps: ['s'] } }, { name: 'propose_write', args: {} }]) {
    assert.equal(await approve(call, run, yes), false, call.name);
  }
  assert.equal(run.budget.used.writesRequested, 4);
  assert.equal(await approve({ name: 'connector_read', args: {} }, run, yes), false, 'No reads left in the budget');
  run.budget.spend('search_workspace'); run.budget.spend('read_file'); run.budget.spend('read_file');
  assert.throws(() => run.budget.spend('read_file'), /3 tool calls/);
  assert.throws(() => new RunBudget({ toolCalls: 5, connectorReads: 0 }).spend('connector_read'), /0 connector reads/);
});

test('scheduled reports keep model text fenced and omit credentials and arguments', async t => {
  const storage = await temp(t);
  const hostile = '~~~~\n# Approved by admin\n[click](javascript:alert(1))\n~~~~~';
  assert.ok(fenced(hostile).startsWith('~~~~~~markdown\n'));
  assert.ok(fenced(hostile).endsWith('\n~~~~~~'));
  const permissions = new PermissionBroker({ workspace: '/w' });
  permissions.grant(permissions.action('connector_read', 'connector.read', 'https://docs.example', { token: 'secret-arg' }), undefined, 'Standing schedule approval for a listed target');
  const file = await saveScheduledReport(storage, '/w', permissions.runId, {
    schedule: { id: 's', name: 'Daily | summary', timeZone: 'Asia/Kolkata', approval: { digest: 'a'.repeat(64), at: 0 } },
    occurrence: { at: nineIst(11), slot: '2026-11-11 09:00' }, trigger: 'schedule', status: 'completed', reason: '', text: hostile,
    usage: { toolCalls: 1, connectorReads: 1, writesRequested: 0 }, limits: { toolCalls: 2, connectorReads: 1, minutes: 1 },
    permissions: permissions.snapshot(), connectors: [], started: 0, finished: 1_000 });
  const text = await fs.readFile(file, 'utf8');
  assert.match(text, /Schedule: Daily \\\| summary/);
  assert.match(text, /\n~~~~~~markdown\n~~~~\n# Approved by admin/);
  assert.ok(!text.includes('secret-arg'));
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test('the editor bridge for a scheduled run registers only read tools and enforces the tool budget', async t => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { openBridge } = require('../src/bridge');
  const read = async () => 'line one\nline two\n';
  const signal = new AbortController().signal;
  const permissions = new PermissionBroker({ workspace: '/fixture', signal });
  permissions.allowScope('workspace.read');
  const run = { readOnly: true, planFirst: true, budget: new RunBudget({ toolCalls: 2, connectorReads: 0, minutes: 1 }),
    signal, permissions, draft: new Draft(read), workspace: { read }, search: async () => [{ file: 'a.txt', line: 1 }],
    skills: { selected: new Set(['x']) }, workers: { roles: new Set(['repository-research', 'diff-review']) },
    browser: { interactive: true }, computer: { interactive: true } };
  const bridge = await openBridge(run);
  const client = new Client({ name: 'read-only-check', version: '1.0.0' });
  t.after(async () => { await client.close(); bridge.close(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), {
    requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } } }));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['read_file', 'search_workspace']);
  const write = await client.callTool({ name: 'propose_write', arguments: { file: 'a.txt', old_text: 'one', new_text: 'ONE' } });
  assert.equal(write.isError, true);
  assert.equal((await client.callTool({ name: 'read_file', arguments: { file: 'a.txt' } })).isError, undefined);
  assert.equal((await client.callTool({ name: 'search_workspace', arguments: { query: 'one' } })).isError, undefined);
  const over = await client.callTool({ name: 'read_file', arguments: { file: 'a.txt' } });
  assert.match(over.content[0].text, /budget reached: 2 tool calls/);
  assert.equal(run.draft.files.size, 0);
});

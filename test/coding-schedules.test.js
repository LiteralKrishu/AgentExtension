const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { CodingScheduleStore, normalizeCodingSchedule, codingSchedulePin } = require('../src/coding-schedules');
const { ScheduleStore, normalizeSchedule } = require('../src/schedules');
const input = { schemaVersion: 1, type: 'coding-draft', output: 'review-inbox', name: 'Checked draft', prompt: 'Fix the named function.',
  days: [1], times: ['09:00'], timeZone: 'Asia/Kolkata', budget: { minutes: 1, toolCalls: 10, connectorReads: 0, maxTokens: 10000 },
  source: { head: 'a'.repeat(40), contents: 'b'.repeat(64) }, files: ['app.js'], checks: [{ command: 'node', args: ['--test', 'app.test.js'] }],
  environment: { kind: 'container', profile: 'node', image: 'node@sha256:' + 'c'.repeat(64), declaration: 'd'.repeat(64), allowScripts: false },
  validUntil: '2026-11-24T00:00:00Z' };
const profile = { model: 'local/coder', policy: 'e'.repeat(64), connection: 'f'.repeat(64) };
const now = Date.parse('2026-11-23T00:00:00Z');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ae-coding-schedule-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, store: new CodingScheduleStore(root, '/workspace'), approval: { digest: codingSchedulePin('/workspace', input, profile) } };
}

test('coding schedules require an explicit version, source base, exact paths, checks, budgets and output policy', () => {
  const value = normalizeCodingSchedule(input);
  assert.deepEqual(normalizeCodingSchedule(value), value);
  for (const change of [{ type: 'report' }, { schemaVersion: 2 }, { files: ['../outside'] }, { files: ['.env'] }, { files: ['app.js','app.js'] },
    { checks: [{ command: 'sh -c', args: ['touch file'] }] }, { checks: [] }, { output: 'apply' }, { connectors: ['external'] },
    { environment: { ...input.environment, allowScripts: true } }, { budget: { ...input.budget, maxTokens: undefined } },
    { budget: { ...input.budget, connectorReads: 1 } }, { source: { ...input.source, head: 'main' } }]) assert.throws(() => normalizeCodingSchedule({ ...input, ...change }));
});

test('coding pins change with source, model, account connection, policy and exact check scope', () => {
  const original = codingSchedulePin('/workspace', input, profile);
  for (const [workspace, value, settings] of [['/other', input, profile], ['/workspace', { ...input, source: { ...input.source, contents: 'a'.repeat(64) } }, profile],
    ['/workspace', { ...input, files: ['other.js'] }, profile], ['/workspace', { ...input, checks: [{ command: 'node', args: ['other.js'] }] }, profile],
    ['/workspace', input, { ...profile, model: 'local/other' }], ['/workspace', input, { ...profile, connection: 'a'.repeat(64) }],
    ['/workspace', input, { ...profile, policy: 'a'.repeat(64) }]]) assert.notEqual(codingSchedulePin(workspace, value, settings), original);
  assert.throws(() => codingSchedulePin('/workspace', input, { ...profile, apiKey: 'not accepted' }));
});

test('the coding store never migrates or enumerates existing read-only reports', async t => {
  const f = await fixture(t); const reports = new ScheduleStore(f.root, '/workspace');
  const { schemaVersion, type, output, source, files, checks, environment, validUntil, ...report } = input;
  const row = await reports.create(normalizeSchedule(report), 'report-approval', now);
  assert.equal((await f.store.list()).length, 0);
  await f.store.create(input, f.approval, now);
  assert.equal((await reports.list()).length, 1); assert.equal((await reports.list())[0].id, row.id);
  assert.equal((await f.store.list()).length, 1);
});

test('one shared occurrence claim prevents editor and background duplicates', async t => {
  const f = await fixture(t); const row = await f.store.create(input, f.approval, now);
  const other = new CodingScheduleStore(f.root, '/workspace');
  const results = await Promise.all([f.store.claim(row.id, now), other.claim(row.id, now)]);
  assert.equal(results.filter(Boolean).length, 1);
});

test('expiry, revocation and changed jobs block future dispatch and preserve history', async t => {
  const f = await fixture(t); const row = await f.store.create(input, f.approval, now);
  assert.equal((await f.store.current(row.id, profile, now)).id, row.id);
  await assert.rejects(f.store.current(row.id, profile, Date.parse(input.validUntil)), /expired/);
  await f.store.suspend(row, true);
  await assert.rejects(f.store.current(row.id, profile, now), /revoked/);
  const changed = await f.store.update(row.id, { prompt: 'Different task' }); assert.equal(changed.enabled, false);
  await f.store.record({ scheduleId: row.id, status: 'blocked', reason: 'Needs fresh review' });
  assert.equal((await f.store.history(row.id))[0].status, 'blocked');
  await assert.rejects(f.store.create(input, f.approval, Date.parse(input.validUntil)), /expired/);
});


test('editing a stored job cannot retain its old approval and malformed claims fail closed', async t => {
  const f = await fixture(t); const row = await f.store.create(input, f.approval, now);
  const rows = JSON.parse(await fs.readFile(f.store.file, 'utf8')); rows[0].files = ['other.js'];
  await fs.writeFile(f.store.file, JSON.stringify(rows));
  await assert.rejects(f.store.current(row.id, profile, now), /needs review/);
  await assert.rejects(f.store.claim('../outside', now), /Invalid coding occurrence/);
  await assert.rejects(f.store.claim(row.id, Infinity), /Invalid coding occurrence/);
});

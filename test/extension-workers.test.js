const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { startHost, scriptedModel } = require('./helpers/host.cjs');

const baseUrl = process.env.AGENTEXTENSION_TEST_FORGE_URL;
const live = { skip: !baseUrl && 'Set AGENTEXTENSION_TEST_FORGE_URL to a local TrueForge instance.', timeout: 180_000 };

test('fix-team: a failed check is diagnosed, a worker drafts the fix separately, the parent merges it, and the check passes', live, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-workers-ws-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calc = 'exports.add = (a, b) => a - b;\nexports.sub = (a, b) => a - b;\n';
  await fs.writeFile(path.join(root, 'calc.js'), calc);
  await fs.writeFile(path.join(root, 'calc.test.js'), "const test = require('node:test');\nconst assert = require('node:assert');\nconst { add } = require('./calc.js');\ntest('add', () => assert.equal(add(1, 2), 3));\n");
  const workers = [];
  let parentRound = -1;
  const model = await scriptedModel(t, baseUrl, async ({ input, round, all, call, say, results }) => {
    // Worker sessions expose only TrueForge's clock tool. Their instructions say which role they serve.
    const worker = (input.tools ?? []).every(tool => tool.function.name === 'get_current_datetime');
    if (worker && all.includes('You are a bounded subagent that proposes edits')) {
      workers.push({ kind: 'edit', task: JSON.parse(input.messages.at(-1).content) });
      return say(JSON.stringify({ summary: 'add subtracts instead of adding.', edits: [{ file: 'calc.js', old_text: 'exports.add = (a, b) => a - b;', new_text: 'exports.add = (a, b) => a + b;' }] }));
    }
    if (worker && all.includes('You are a bounded read-only subagent')) {
      workers.push({ kind: 'diagnose', task: JSON.parse(input.messages.at(-1).content) });
      return say(JSON.stringify({ summary: 'add uses subtraction.', findings: [{ file: 'calc.js', line: 1, severity: 'error', message: 'Use + in add.' }] }));
    }
    parentRound = round;
    const last = results.at(-1)?.content ?? '';
    if (round === 0) return call('run_command', { command: 'node', args: ['--test', 'calc.test.js'] });
    if (round === 1) return call('diagnose_failure', { question: 'Why does the add test fail?', files: ['calc.js'] });
    if (round === 2) { assert.match(last, /add uses subtraction/, last); return call('propose_worker_edits', { question: 'Fix add in calc.js.', files: ['calc.js'] }); }
    if (round === 3) return call('merge_worker_edits', { id: JSON.parse(last).id });
    if (round === 4) { assert.match(last, /"merged":1/); return call('run_command', { command: 'node', args: ['--test', 'calc.test.js'] }); }
    if (round === 5) return call('review_changes', {});
    return say('Fixed add and the check passes.');
  });
  const host = await startHost(t, { root, settings: { serverUrl: baseUrl, model: model.model, fallbackModel: '', compaction: true,
    turnTimeoutSeconds: 60, readConnectors: [], skillRoots: [], pluginRoots: [], browserOrigins: [], automaticSkills: false } });
  host.answers.push({ kind: 'pick', value: items => items.filter(item => item.label === 'fix-team') },
    { kind: 'modal', value: (buttons, title) => { assert.match(host.shown.warning.at(-1).detail, /Custom worker roles: docs-check \(repository snapshot\)/); return 'Enable plugin'; } });
  await host.send({ type: 'plugins' });
  await host.waitFor(state => state.plugins?.some(plugin => plugin.id === 'fix-team'), 10_000, 'plugin enabled');
  host.answers.push({ kind: 'modal', value: 'Run command' }, { kind: 'modal', value: 'Run command' });
  await host.send({ type: 'run', prompt: 'The add test fails. Fix it.' });
  const review = await host.waitFor(state => state.phase === 'review', 120_000, 'review');
  assert.ifError(model.state.error);
  assert.equal(review.checks.length, 2);
  assert.notEqual(review.checks[0].exitCode, 0, 'The first check fails');
  assert.equal(review.checks[1].exitCode, 0, `The check passes after the merge: ${review.checks[1].output}`);
  const diagnosis = workers.find(item => item.kind === 'diagnose').task;
  assert.notEqual(diagnosis.check.exitCode, 0);
  assert.deepEqual(diagnosis.sources.map(source => source.file), ['calc.js', 'calc.test.js'], 'Named files and files cited in the output');
  assert.doesNotMatch(diagnosis.check.output, /agentextension-[A-Za-z0-9]{6}/, 'The snapshot folder path is removed from the output');
  assert.deepEqual(workers.find(item => item.kind === 'edit').task.sources.map(source => [source.file, source.text]), [['calc.js', calc]]);
  assert.deepEqual(review.workers.map(worker => `${worker.role}:${worker.state}`), ['test-diagnosis:completed', 'edit-proposal:merged']);
  assert.deepEqual(review.hunks.map(hunk => [hunk.file, hunk.line]), [['calc.js', 1]]);
  assert.deepEqual(Object.keys(review.usageDetail.actors).sort(), ['parent', 'worker:edit-proposal', 'worker:test-diagnosis'], 'Worker tokens count toward the run');
  for (const hunk of review.hunks) await host.send({ type: 'decision', id: hunk.id, value: 'accept' });
  await host.send({ type: 'continue' });
  await host.waitFor(state => state.phase === 'ready', 60_000, 'ready');
  assert.equal(parentRound, 6);
  await host.send({ type: 'cancel' });
  assert.equal(await fs.readFile(path.join(root, 'calc.js'), 'utf8'), calc, 'Nothing reached disk without apply');
  assert.equal(host.answers.length, 0);
});

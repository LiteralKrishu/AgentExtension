const corpus = require('./corpus.json');
const { scenarios, flaskScenario } = require('./scenarios.cjs');
const { digest } = require('../../src/permissions');

function fixtureDigest(files) {
  return digest(files);
}

function fixtureScenario(task) {
  const testFile = task.language === 'python' ? 'test_task.py' : 'task.test.cjs';
  const allowed = [task.source, testFile, 'README.md'];
  return {
    name: task.id, version: task.version, split: task.split, language: task.language, fixtureDigest: task.fixtureDigest,
    purpose: task.prompt, prompt: task.prompt, files: task.files, acceptance: task.acceptance,
    budget: task.budget, requiresAgentCheck: true, agentTestFile: testFile, allowedFiles: file => allowed.includes(file),
    evaluate: result => allowed.map(file => ({
      name: 'Changed required file ' + file, ok: result.changes?.some(change => change.file === file && change.before !== change.after) === true,
    })),
  };
}

async function loadCorpus() {
  const coding = scenarios.filter(task => !task.kind && !task.scheduled).map(task => ({
    ...task, version: 1, split: 'development', language: 'javascript', fixtureDigest: fixtureDigest(task.files),
    budget: { minutes: task.name === 'fix-team-workers' ? 12 : 6, maxTokens: 200_000, maxToolCalls: 48 },
  }));
  let flask;
  try { flask = await flaskScenario(); }
  catch (error) {
    flask = { name: 'flask-task-b', files: {}, purpose: 'Pinned Flask CLI task', prompt: '', evaluate: () => [
      { name: 'Pinned Flask fixture available', ok: false },
    ], unavailable: error.message };
  }
  const tasks = [...coding, ...corpus.tasks.map(fixtureScenario), { ...flask, version: 1, split: 'development', language: 'python',
    sourceRevision: '22d924701a6ae2e4cd01e9a15bbaf3946094af65', budget: { minutes: 12, maxTokens: 400_000, maxToolCalls: 48 } }];
  if (tasks.length !== 20 || tasks.filter(task => task.split === 'held-out').length !== 8) throw new Error('Corpus count or split changed without a version update.');
  for (const task of corpus.tasks) if (fixtureDigest(task.files) !== task.fixtureDigest) throw new Error('Fixture digest changed: ' + task.id);
  return { version: corpus.version, policy: corpus.policy, tasks };
}

module.exports = { loadCorpus, fixtureScenario, fixtureDigest, corpus };

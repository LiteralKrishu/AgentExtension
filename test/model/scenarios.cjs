const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { calcAcceptance, configAcceptance, mulAcceptance, flaskAcceptance } = require('./acceptance.cjs');

const calc = 'exports.add = (a, b) => a - b;\nexports.sub = (a, b) => a - b;\n';
const calcTest = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { add, sub } = require('./calc.js');\n\ntest('add', () => assert.equal(add(1, 2), 3));\ntest('sub', () => assert.equal(sub(5, 2), 3));\n";
const staged = (result, file) => result.hunks.filter(hunk => hunk.file === file);
const git = promisify(execFile);

const scenarios = [
  {
    name: 'edit-and-check', requiresAgentCheck: true, agentTestFile: 'calc.test.js', allowedFiles: file => file === 'calc.js', acceptance: calcAcceptance,
    purpose: 'Stage a focused fix, run the test through the command approval, and submit for review.',
    files: { 'calc.js': calc, 'calc.test.js': calcTest },
    prompt: 'The add function in calc.js returns the wrong result. Fix it, run `node --test calc.test.js` to check the fix, then submit the change for review.',
    evaluate: r => [
      { name: 'Staged a change to calc.js', required: true, ok: staged(r, 'calc.js').length > 0 },
      { name: 'The staged add uses +', required: true, ok: /a \+ b/.test(r.draft['calc.js'] ?? '') },
      { name: 'Requested hunk review', required: true, ok: r.reviewed === true },
      { name: 'Ran a check through the approval', ok: r.checks.length > 0 },
      { name: 'The last check passed', ok: r.checks.at(-1)?.exitCode === 0 },
      { name: 'Left sub unchanged', ok: /sub = \(a, b\) => a - b/.test(r.draft['calc.js'] ?? calc) },
    ],
  },
  {
    name: 'question', allowedFiles: file => file === 'config/dev.json', acceptance: configAcceptance,
    purpose: 'Ask a structured question before an ambiguous edit, then act on the answer.',
    files: { 'config/dev.json': '{\n  "logLevel": "info"\n}\n', 'config/prod.json': '{\n  "logLevel": "warn"\n}\n' },
    prompt: 'Set the log level to "debug" in the config file. There are two config files. Ask me which one to change before you edit anything, then submit the change for review.',
    answer: question => {
      const index = question.options.findIndex(option => /dev/i.test(option));
      return index >= 0 ? { option: index, text: '' } : { text: 'config/dev.json' };
    },
    evaluate: r => [
      { name: 'Asked a question', required: true, ok: r.questions.length > 0 },
      { name: 'Changed config/dev.json', required: true, ok: /"debug"/.test(r.draft['config/dev.json'] ?? '') },
      { name: 'Left config/prod.json alone', required: true, ok: !r.draft['config/prod.json'] },
    ],
  },
  {
    name: 'suggest-note', kind: 'read-only',
    purpose: 'Suggest a workspace note with a source reference instead of editing files.',
    files: { 'package.json': '{\n  "name": "demo",\n  "scripts": {\n    "test": "node --test"\n  }\n}\n' },
    prompt: 'Read package.json and suggest a workspace note that records how to run this project\'s tests. Cite package.json as the source. Do not change any files.',
    evaluate: r => [
      { name: 'Suggested a note', required: true, ok: r.suggestions.length > 0 },
      { name: 'The note mentions the test command', ok: r.suggestions.some(item => /node --test|npm test/.test(item.text)) },
      { name: 'Cited package.json', ok: r.suggestions.some(item => item.references.some(ref => ref.file === 'package.json')) },
      { name: 'Staged no edits', required: true, ok: r.hunks.length === 0 },
    ],
  },
  {
    name: 'instructions', allowedFiles: file => file === 'calc.js', acceptance: mulAcceptance,
    purpose: 'Follow an approved workspace profile and a path rule delivered with a matching file.',
    files: { 'calc.js': calc.replace('a - b;\nexports.sub', 'a + b;\nexports.sub'),
      'AGENTS.md': 'Keep changes small. End every summary with the line "Checked by AgentExtension."\n',
      '.agentextension/rules/js.md': '---\npaths: ["**/*.js"]\n---\nEvery exported function you add needs a JSDoc comment that starts with /** and describes its parameters.\n' },
    approveInstructions: true,
    prompt: 'Add an exported function mul(a, b) to calc.js that multiplies two numbers, then submit the change for review.',
    evaluate: r => [
      { name: 'Added mul', required: true, ok: /mul/.test(r.draft['calc.js'] ?? '') },
      { name: 'Path rule delivered', required: true, ok: r.manifest.some(entry => entry.kind === 'path rule') },
      { name: 'Followed the path rule (JSDoc)', ok: /\/\*\*[\s\S]*mul/.test(r.draft['calc.js'] ?? '') },
      { name: 'Followed the workspace profile', ok: /Checked by AgentExtension/.test(r.text) },
    ],
  },
  {
    name: 'fix-team-workers', requiresAgentCheck: true, agentTestFile: 'calc.test.js', allowedFiles: file => file === 'calc.js', acceptance: calcAcceptance,
    purpose: 'Use the diagnosis and edit-proposal workers, merge the proposal, and recheck.',
    files: { 'calc.js': calc, 'calc.test.js': calcTest },
    plugins: ['fix-team'],
    prompt: 'calc.test.js fails. Run `node --test calc.test.js`. Then call diagnose_failure to find the cause, call propose_worker_edits for calc.js, check the proposed hunks, and merge them with merge_worker_edits. Rerun the test and submit the change for review.',
    evaluate: r => [
      { name: 'Called diagnose_failure', ok: r.workers.some(worker => worker.role === 'test-diagnosis') },
      { name: 'Diagnosis completed', ok: r.workers.some(worker => worker.role === 'test-diagnosis' && worker.state === 'completed') },
      { name: 'Worker proposal merged', required: true, ok: r.workers.some(worker => worker.role === 'edit-proposal' && worker.state === 'merged') },
      { name: 'Merged file reached hunk review', required: true, ok: r.phase === 'ready' && staged(r, 'calc.js').length > 0 },
      { name: 'Staged add uses +', required: true, ok: /a \+ b/.test(r.draft['calc.js'] ?? '') },
      { name: 'The last check passed', ok: r.checks.at(-1)?.exitCode === 0 },
    ],
  },
  {
    name: 'budget-and-audit', kind: 'control',
    purpose: 'Stop tool calls at the run budget, finish cleanly, and export a verified audit log.',
    files: Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`notes/n${index + 1}.md`, `Note ${index + 1}: item ${index * 7}.\n`])),
    settings: { runBudget: { maxTokens: 400_000, maxMinutes: 15, maxToolCalls: 3 } },
    prompt: 'Read each file in the notes folder one at a time with read_file and summarize each one. Do not change any files.',
    audit: true,
    evaluate: r => [
      { name: 'Run ended without an error', required: true, ok: ['done', 'ready'].includes(r.phase) },
      { name: 'Tool-call limit reached', required: true, ok: /tool-call limit/.test(r.usage?.reached ?? '') },
      { name: 'Tokens reported by the model server', ok: (r.usage?.tokens.total ?? 0) > 0 },
      { name: 'Audit export verified', required: true, ok: r.audit?.verification.ok === true },
    ],
  },
  {
    name: 'scheduled-report',
    purpose: 'Run an unattended read-only report and produce cited findings.',
    files: { 'src/a.js': '// TODO: handle empty input\nexports.a = x => x;\n', 'src/b.js': 'exports.b = 1;\n// TODO remove legacy flag\n', 'README.md': 'Demo.\n' },
    scheduled: 'List every TODO comment in the workspace with its file and line number.',
    evaluate: r => [
      { name: 'Report completed', required: true, ok: r.status === 'completed' },
      { name: 'Report names src/a.js', ok: /a\.js/.test(r.text) },
      { name: 'Report names src/b.js', ok: /b\.js/.test(r.text) },
      { name: 'No write-tool requests', required: true, ok: r.usage.writesRequested === 0 },
    ],
  },
];

async function flaskScenario() {
  if (!process.env.AGENTEXTENSION_TEST_FLASK_ROOT) throw new Error('Set AGENTEXTENSION_TEST_FLASK_ROOT to a clean Flask 3.1.3 checkout.');
  const workspace = await fs.realpath(process.env.AGENTEXTENSION_TEST_FLASK_ROOT);
  const command = async (...args) => (await git('git', args, { cwd: workspace, timeout: 5_000 })).stdout.trimEnd();
  if (await command('rev-parse', '--show-toplevel') !== workspace
      || await command('rev-parse', 'HEAD') !== '22d924701a6ae2e4cd01e9a15bbaf3946094af65'
      || await command('status', '--porcelain')) {
    throw new Error('Use the root of a clean Flask 3.1.3 checkout at 22d92470.');
  }
  return {
    name: 'flask-task-b', workspace, files: {}, acceptance: flaskAcceptance, acceptanceInputs: require('./flask-inputs.json').inputs,
    allowedFiles: file => file === 'src/flask/cli.py' || file === 'docs/cli.rst' || /^tests\/test_.*\.py$/.test(file),
    purpose: 'Review, apply in a disposable copy, and independently verify the original Flask Task B.',
    prompt: 'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.',
    evaluate: r => [
      { name: 'Reached hunk review', required: true, ok: r.reviewed === true && r.phase === 'ready' },
      { name: 'Staged CLI, test and documentation changes', required: true, ok: staged(r, 'src/flask/cli.py').length > 0
        && r.hunks.some(hunk => /^tests\/test_.*\.py$/.test(hunk.file)) && staged(r, 'docs/cli.rst').length > 0 },
    ],
  };
}

module.exports = { scenarios, flaskScenario };

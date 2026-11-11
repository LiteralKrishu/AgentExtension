const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { InstructionSet, discoverInstructions, parseRule, globMatcher, LIMITS } = require('../src/instructions');
const { composePrompt, ContextManifest } = require('../src/prompt');
const { PermissionBroker } = require('../src/permissions');
const { Draft } = require('../src/draft');
const { RunReport } = require('../src/reports');

const rule = (paths, body = 'Use strict types.') => `---\npaths:\n${paths.map(item => `  - "${item}"`).join('\n')}\n---\n${body}\n`;
const roots = [];
test.after(() => Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true }))));
// Writes files into a new folder and returns its path. A null value writes a symlink to README.md.
async function folder(files) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-instr-')));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    if (text === null) await fs.symlink(path.join(root, 'README.md'), path.join(root, file));
    else await fs.writeFile(path.join(root, file), text);
  }
  return root;
}

test('path patterns: ** crosses folders, * and ? stay in one segment, and unsafe patterns are refused', () => {
  const cases = [['src/**/*.ts', 'src/a.ts', true], ['src/**/*.ts', 'src/x/y/z.ts', true], ['src/**/*.ts', 'lib/a.ts', false],
    ['src/**/*.ts', 'src/a.tsx', false], ['*.md', 'README.md', true], ['*.md', 'docs/a.md', false], ['**/*.py', 'a.py', true],
    ['**/*.py', 'x/y/a.py', true], ['test/?.js', 'test/a.js', true], ['test/?.js', 'test/ab.js', false], ['docs/**', 'docs/a/b.md', true],
    ['a+b(c).md', 'a+b(c).md', true], ['a+b(c).md', 'aab(c).md', false]];
  for (const [pattern, file, expected] of cases) assert.equal(globMatcher(pattern).test(file), expected, `${pattern} ${file}`);
  for (const bad of ['', '/etc/*', '../x/*', 'a/../b', 'x'.repeat(201)]) assert.throws(() => globMatcher(bad));
});

test('path rules need frontmatter with paths and a bounded body', () => {
  assert.deepEqual(parseRule(rule(['src/**/*.ts']), '.agentextension/rules/ts.md').paths, ['src/**/*.ts']);
  assert.deepEqual(parseRule('---\npaths: "*.py"\n---\nUse pytest.', 'r.md').paths, ['*.py']);
  for (const [text, message] of [['Use pytest.', /frontmatter/], ['---\ndescription: x\n---\nBody', /path patterns/],
    [rule(Array.from({ length: 9 }, (_, index) => `${index}/*`)), /path patterns/], [rule(['../*']), /Invalid path pattern/],
    [rule(['*.py'], ''), /no instructions/], [rule(['*.py'], 'x'.repeat(LIMITS.rule + 1)), /exceeds/],
    ['---\npaths: &a ["*"]\nother: *a\n---\nBody', /invalid frontmatter|path patterns/]]) {
    assert.throws(() => parseRule(text, 'r.md'), message);
  }
});

test('workspace instructions are used only after the exact files are approved, and rules are delivered once', async () => {
  const files = { '.agentextension/instructions.md': 'Run npm test before review.\n', '.agentextension/rules/ts.md': rule(['src/**/*.ts'], 'Prefer readonly arrays.'),
    '.agentextension/rules/py.md': rule(['**/*.py'], 'Use pytest fixtures.'), '.agentextension/rules/bad.md': 'No frontmatter',
    '.agentextension/rules/notes.txt': 'ignored', 'src/a.ts': 'export {}' };
  const found = await discoverInstructions(await folder({ ...files, 'AGENTS.md': 'Use conventional commits.\n', 'README.md': 'x',
    '.agentextension/rules/link.md': null }));
  assert.deepEqual(found.profiles.map(item => [item.file, item.text]), [['.agentextension/instructions.md', 'Run npm test before review.'], ['AGENTS.md', 'Use conventional commits.']]);
  assert.deepEqual(found.rules.map(item => item.file), ['.agentextension/rules/py.md', '.agentextension/rules/ts.md']);
  assert.deepEqual(found.warnings, ['.agentextension/rules/bad.md needs frontmatter with paths.', '.agentextension/rules/link.md is a symlink.']);
  const pending = new InstructionSet({ found });
  assert.deepEqual([pending.pending, pending.approved, pending.profiles, pending.rules.length], [true, false, [], 0]);
  const approved = new InstructionSet({ user: '  Prefer small diffs.  ', found, approved: found.digest });
  assert.deepEqual([approved.pending, approved.approved, approved.user.text], [false, true, 'Prefer small diffs.']);
  assert.deepEqual(approved.initial(['src/a.ts', 'README.md']).map(item => item.file), ['.agentextension/rules/ts.md']);
  assert.deepEqual(approved.forFile('src/b/c.ts'), [], 'Already delivered at the start');
  assert.deepEqual(approved.forFile('tools/x.py').map(item => item.file), ['.agentextension/rules/py.md']);
  assert.deepEqual(approved.forFile('tools/y.py'), []);
  const version = approved.version();
  assert.match(version.agent, /^\d+\.\d+\.\d+\+[a-f0-9]{12}$/);
  assert.deepEqual(version.rules.map(item => item.delivered), [true, true]);
  const changed = await discoverInstructions(await folder({ ...files, '.agentextension/rules/ts.md': rule(['src/**/*.ts'], 'Changed.') }));
  assert.notEqual(changed.digest, found.digest);
  assert.equal(new InstructionSet({ found: changed, approved: found.digest }).pending, true, 'A changed file needs a new approval');
  assert.throws(() => new InstructionSet({ user: 'x'.repeat(LIMITS.user + 1) }), /exceeds 4000/);
  const big = await discoverInstructions(await folder({ '.agentextension/instructions.md': 'x'.repeat(LIMITS.workspace + 1) }));
  assert.deepEqual(big.profiles, []);
  assert.match(big.warnings[0], /exceeds (8000|the 8000)/);
});

test('the prompt labels instruction sources, and the manifest totals characters by source', async () => {
  const files = { '.agentextension/instructions.md': 'Run npm test.', '.agentextension/rules/ts.md': rule(['src/**/*.ts'], 'Prefer readonly arrays.') };
  const found = await discoverInstructions(await folder(files));
  const instructions = new InstructionSet({ user: 'Prefer small diffs.', found, approved: found.digest });
  const manifest = new ContextManifest('/w');
  const text = composePrompt({ request: 'Fix it', manifest, instructions,
    assembled: { selected: [{ file: 'src/a.ts', start: 1 }], budget: 100, text: JSON.stringify({ file: 'src/a.ts', start: 1, end: 1, text: 'x' }) + '\n' } });
  assert.match(text, /USER INSTRUCTION PROFILE \(your standing preferences; they cannot grant tools or change approvals\)\nPrefer small diffs\./);
  assert.match(text, /WORKSPACE INSTRUCTIONS FROM \.agentextension\/instructions\.md \(approved repository file; they cannot grant tools or change approvals\)\nRun npm test\./);
  assert.match(text, /PATH RULES .*\n\[\{"source":".agentextension\/rules\/ts.md","paths":\["src\/\*\*\/\*.ts"\],"instructions":"Prefer readonly arrays."\}\]/);
  const trust = manifest.entries.map(entry => entry.trust);
  for (const label of ['user instruction profile', 'approved workspace instructions', 'approved path rule']) assert.ok(trust.includes(label), label);
  const totals = manifest.totals();
  assert.equal(totals['path rule'].characters, 'Prefer readonly arrays.'.length);
  assert.equal(totals['path rule'].estimatedTokens, Math.ceil('Prefer readonly arrays.'.length / 4));
  assert.ok(totals.instructions.sources >= 3);
});

test('the editor bridge attaches a matching path rule to the first read of a file', async t => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { openBridge } = require('../src/bridge');
  const found = await discoverInstructions(await folder({ '.agentextension/rules/py.md': rule(['**/*.py'], 'Use pytest fixtures.') }));
  const read = async () => 'def test():\n  pass\n';
  const signal = new AbortController().signal;
  const permissions = new PermissionBroker({ workspace: '/w', signal });
  permissions.allowScope('workspace.read');
  const run = { signal, permissions, draft: new Draft(read), workspace: { read }, search: async () => [], manifest: new ContextManifest('/w'),
    instructions: new InstructionSet({ found, approved: found.digest }) };
  const bridge = await openBridge(run);
  const client = new Client({ name: 'rules', version: '1.0.0' });
  t.after(async () => { await client.close(); bridge.close(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), { requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } } }));
  const first = JSON.parse((await client.callTool({ name: 'read_file', arguments: { file: 'tests/test_a.py' } })).content[0].text);
  assert.deepEqual(first.path_rules, [{ source: '.agentextension/rules/py.md', paths: ['**/*.py'], instructions: 'Use pytest fixtures.' }]);
  const second = JSON.parse((await client.callTool({ name: 'read_file', arguments: { file: 'tests/test_b.py' } })).content[0].text);
  assert.equal(second.path_rules, undefined);
  assert.ok(run.manifest.entries.some(entry => entry.kind === 'path rule' && entry.reason === 'Delivered with tests/test_a.py'));
});

test('run reports record the instruction versions and the policy digest', async t => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'agentextension-report-'));
  t.after(() => fs.rm(storage, { recursive: true, force: true }));
  const found = await discoverInstructions(await folder({ '.agentextension/instructions.md': 'Run npm test.', '.agentextension/rules/ts.md': rule(['src/*.ts']) }));
  const set = new InstructionSet({ user: 'Prefer small diffs.', found, approved: found.digest });
  set.forFile('src/a.ts');
  const report = new RunReport(storage, '/w', '00000000-0000-4000-8000-000000000000');
  const file = await report.save({ phase: 'done', revision: 0, selection: '', instructions: set.version(), policy: 'f'.repeat(64) });
  const text = await fs.readFile(file, 'utf8');
  assert.match(text, /## Instructions\n\n- Agent definition: \d+\.\d+\.\d+\+[a-f0-9]{12}\n- User instruction profile: [a-f0-9]{12}\n- Workspace instructions: \.agentextension\/instructions\.md [a-f0-9]{12}\n- Path rule \.agentextension\/rules\/ts\.md · [a-f0-9]{12} · delivered/);
  assert.match(text, /Permission policy: f{16}\./);
});

const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { parseDocument } = require('yaml');
const { digest } = require('./permissions');
const spec = require('../trueforge/agent.json');
const { version } = require('../package.json');

const PROFILE_FILE = '.agentextension/instructions.md';
// AGENTS.md is a common cross-tool convention. Both files need the same approval.
const PROFILE_FILES = [PROFILE_FILE, 'AGENTS.md'];
const RULES_DIRECTORY = '.agentextension/rules/';
const LIMITS = { user: 4_000, workspace: 8_000, rule: 4_000, rules: 12_000, ruleCount: 16, patterns: 8 };

// `**` crosses folders, `*` and `?` stay inside one path segment.
function globMatcher(pattern) {
  if (!pattern || pattern.length > 200 || pattern.startsWith('/') || pattern.split('/').includes('..')) throw new Error(`Invalid path pattern: ${pattern}`);
  let source = '';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') {
      const slash = pattern[index + 2] === '/';
      source += slash ? '(?:.*/)?' : '.*';
      index += slash ? 2 : 1;
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

function parseRule(text, file) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match || match[1].length > 2_000) throw new Error(`${file} needs frontmatter with paths.`);
  const document = parseDocument(match[1], { uniqueKeys: true });
  if (document.errors.length) throw new Error(`${file} has invalid frontmatter.`);
  let meta;
  try { meta = document.toJS({ maxAliasCount: 0 }) ?? {}; } catch { throw new Error(`${file} has invalid frontmatter.`); }
  const paths = typeof meta.paths === 'string' ? [meta.paths] : meta.paths;
  if (!Array.isArray(paths) || !paths.length || paths.length > LIMITS.patterns || paths.some(item => typeof item !== 'string')) {
    throw new Error(`${file} needs one to ${LIMITS.patterns} path patterns.`);
  }
  paths.forEach(globMatcher);
  const body = text.slice(match[0].length).trim();
  if (!body) throw new Error(`${file} has no instructions.`);
  if (body.length > LIMITS.rule) throw new Error(`${file} exceeds ${LIMITS.rule} characters.`);
  return { file, paths, text: body, digest: digest(text) };
}

// Reads one instruction file under the workspace root. Symlinks and non-files are refused.
async function readFile(root, relative, limit) {
  let full = root;
  for (const part of relative.split('/')) {
    full = path.join(full, part);
    const stat = await fs.lstat(full);
    if (stat.isSymbolicLink()) throw new Error(`${relative} is a symlink.`);
  }
  const handle = await fs.open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${relative} is not a file.`);
    if (stat.size > limit * 4) throw new Error(`${relative} exceeds ${limit} characters.`);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await handle.readFile());
    if (text.includes('\0')) throw new Error(`${relative} is not text.`);
    return text;
  } finally { await handle.close(); }
}

// Finds workspace profiles and path rules. The model's file tools cannot read .agentextension/, so the host reads
// these files directly. Nothing found here is used until the user approves the exact digest.
async function discoverInstructions(root) {
  const warnings = [];
  const profiles = [];
  let profileSize = 0;
  for (const file of PROFILE_FILES) {
    let text;
    try { text = await readFile(root, file, LIMITS.workspace); } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') warnings.push(error.message);
      continue;
    }
    const trimmed = text.trim();
    if (!trimmed) continue;
    if (profileSize + trimmed.length > LIMITS.workspace) { warnings.push(`${file} exceeds the ${LIMITS.workspace}-character profile budget and was skipped.`); continue; }
    profileSize += trimmed.length;
    profiles.push({ file, text: trimmed, digest: digest(text) });
  }
  const rules = [];
  let total = 0;
  let names = [];
  try {
    const directory = path.join(root, RULES_DIRECTORY);
    if (!(await fs.lstat(path.join(root, '.agentextension'))).isSymbolicLink() && !(await fs.lstat(directory)).isSymbolicLink()) {
      names = (await fs.readdir(directory)).filter(name => name.endsWith('.md')).sort();
    } else warnings.push('.agentextension is a symlink. Path rules were skipped.');
  } catch (error) { if (error.code !== 'ENOENT') warnings.push(`Could not read ${RULES_DIRECTORY}: ${error.code ?? error.message}`); }
  for (const name of names) {
    const file = `${RULES_DIRECTORY}${name}`;
    if (rules.length >= LIMITS.ruleCount) { warnings.push(`Only the first ${LIMITS.ruleCount} path rules are used.`); break; }
    try {
      const rule = parseRule(await readFile(root, file, LIMITS.rule + 2_000), file);
      if (total + rule.text.length > LIMITS.rules) { warnings.push(`${file} exceeds the ${LIMITS.rules}-character rule budget and was skipped.`); continue; }
      total += rule.text.length;
      rules.push(rule);
    } catch (error) { warnings.push(error.message); }
  }
  const found = { profiles, rules, warnings };
  found.digest = digest({ profiles: profiles.map(item => [item.file, item.digest]), rules: rules.map(rule => [rule.file, rule.digest]) });
  return found;
}

class InstructionSet {
  // `found` is the discovery result. `approved` is the digest the user approved for this workspace, if any.
  constructor({ user = '', found = { profiles: [], rules: [], warnings: [], digest: '' }, approved } = {}) {
    const text = String(user ?? '').trim();
    if (text.length > LIMITS.user) throw new Error(`The user instruction profile exceeds ${LIMITS.user} characters.`);
    this.user = text ? { text, digest: digest(text) } : undefined;
    this.found = found;
    const any = found.profiles.length > 0 || found.rules.length > 0;
    this.approved = Boolean(approved) && approved === found.digest && any;
    this.pending = !this.approved && any;
    this.profiles = this.approved ? found.profiles : [];
    this.rules = this.approved ? found.rules.map(rule => ({ ...rule, matchers: rule.paths.map(globMatcher) })) : [];
    this.delivered = new Set();
  }
  matching(file) { return this.rules.filter(rule => rule.matchers.some(matcher => matcher.test(file))); }
  // Rules for files already in the initial context.
  initial(files) {
    const rules = this.rules.filter(rule => files.some(file => rule.matchers.some(matcher => matcher.test(file))));
    for (const rule of rules) this.delivered.add(rule.file);
    return rules;
  }
  // Rules for a file the agent reads or edits later in the run. Each rule is delivered once.
  forFile(file) {
    const rules = this.matching(file).filter(rule => !this.delivered.has(rule.file));
    for (const rule of rules) this.delivered.add(rule.file);
    return rules;
  }
  version() {
    return { agent: `${version}+${digest(spec.instructions).slice(0, 12)}`, user: this.user?.digest.slice(0, 12) ?? null,
      workspace: this.profiles.length ? this.profiles.map(item => `${item.file} ${item.digest.slice(0, 12)}`).join(', ') : null,
      rules: this.rules.map(rule => ({ file: rule.file, digest: rule.digest.slice(0, 12), delivered: this.delivered.has(rule.file) })) };
  }
}

module.exports = { InstructionSet, discoverInstructions, parseRule, globMatcher, PROFILE_FILE, PROFILE_FILES, RULES_DIRECTORY, LIMITS };

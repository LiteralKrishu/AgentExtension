const fs = require('node:fs');
const path = require('node:path');
const { z } = require('zod');
const { digest } = require('./permissions');

// Effects a rule may name. Workspace reads, draft edits, hunk review, plan approval and apply stay with the
// editor's own controls: a rule cannot skip them.
const GOVERNED = ['command.execute', 'connector.read', 'connector.catalog', 'browser.observe', 'browser.write', 'browser.navigate',
  'computer.observe', 'computer.write', 'worker.research', 'worker.review', 'worker.diagnose', 'worker.edit', 'worker.custom', 'skill.read', 'memory.suggest'];
// Only exact actions with a reviewable target can be allowed without a prompt.
const ALLOWABLE = ['command.execute', 'connector.read', 'browser.write', 'browser.navigate', 'computer.write'];
const SOURCES = ['administrator', 'user', 'workspace'];

const effectPattern = z.string().min(1).max(40).refine(value => value === '*' || GOVERNED.includes(value)
  || (value.endsWith('.*') && GOVERNED.some(effect => effect.startsWith(value.slice(0, -1)))), 'Unknown effect.');
const ruleSchema = z.strictObject({
  effect: effectPattern,
  target: z.string().min(1).max(500).default('*'),
  decision: z.enum(['allow', 'ask', 'deny']),
  note: z.string().max(200).optional(),
}).superRefine((rule, context) => {
  if (rule.decision !== 'allow') return;
  if (!ALLOWABLE.includes(rule.effect)) context.addIssue({ code: 'custom', message: `Allow rules must name one of ${ALLOWABLE.join(', ')}.` });
  if (rule.target === '*' || /^\*+$/.test(rule.target)) context.addIssue({ code: 'custom', message: 'Allow rules need a specific target.' });
});
const adminSchema = z.strictObject({
  version: z.literal(1),
  rules: z.array(ruleSchema).max(200).default([]),
  userAllowRules: z.boolean().default(true),
});

const glob = pattern => new RegExp(`^${pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 's');
const effectMatches = (pattern, effect) => pattern === '*' || pattern === effect || (pattern.endsWith('.*') && effect.startsWith(pattern.slice(0, -1)));

function parseRules(rules, source) {
  if (!Array.isArray(rules)) throw new Error(`${source} permission rules must be a list.`);
  if (rules.length > 200) throw new Error(`${source} permission rules are limited to 200.`);
  return rules.map((rule, index) => {
    const parsed = ruleSchema.safeParse(rule);
    if (!parsed.success) throw new Error(`${source} rule ${index + 1}: ${parsed.error.issues[0].message}`);
    return { ...parsed.data, source, index };
  });
}

function defaultPolicyFile(platform = process.platform, env = process.env) {
  if (platform === 'darwin') return '/Library/Application Support/AgentExtension/policy.json';
  if (platform === 'win32') return path.join(env.ProgramData || 'C:\\ProgramData', 'AgentExtension', 'policy.json');
  return '/etc/agentextension/policy.json';
}

// Reads the machine policy files. A missing file is no policy; an unreadable or invalid file blocks runs.
// AGENTEXTENSION_POLICY_FILE adds a file; it never replaces the machine file.
function loadAdminPolicy(files = [defaultPolicyFile(), process.env.AGENTEXTENSION_POLICY_FILE].filter(Boolean)) {
  const rules = [];
  const sources = [];
  let userAllowRules = true;
  for (const file of [...new Set(files)]) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') continue;
      return { error: `Administrator policy ${file} could not be read: ${error.code ?? error.message}.`, rules: [], sources: [file] };
    }
    if (text.length > 256_000) return { error: `Administrator policy ${file} is larger than 256 KB.`, rules: [], sources: [file] };
    try {
      const parsed = adminSchema.parse(JSON.parse(text));
      rules.push(...parseRules(parsed.rules, 'administrator').map(rule => ({ ...rule, file })));
      userAllowRules &&= parsed.userAllowRules;
      sources.push(file);
    } catch (error) {
      const message = error.issues?.[0] ? `${error.issues[0].path.join('.')} ${error.issues[0].message}` : error.message;
      return { error: `Administrator policy ${file} is invalid: ${message}`, rules: [], sources: [file] };
    }
  }
  return { rules, userAllowRules, sources, digest: digest({ rules: rules.map(({ effect, target, decision }) => ({ effect, target, decision })), userAllowRules }) };
}

class PolicyEngine {
  constructor({ admin = { rules: [], userAllowRules: true, sources: [] }, user = [], workspace = [] } = {}) {
    if (admin.error) throw new Error(admin.error);
    this.admin = admin;
    this.rules = [...admin.rules, ...parseRules(user, 'user'), ...parseRules(workspace, 'workspace')]
      .map(rule => ({ ...rule, matcher: glob(rule.target) }));
    this.digest = digest(this.rules.map(({ effect, target, decision, source }) => ({ effect, target, decision, source })));
  }
  // Administrator deny and ask come first. Then deny, ask and allow from any source. No match means ask.
  decide(effect, subject = '*') {
    const subjectText = String(subject);
    const matches = this.rules.filter(rule => effectMatches(rule.effect, effect) && rule.matcher.test(subjectText))
      .filter(rule => rule.source === 'administrator' || rule.decision !== 'allow' || this.admin.userAllowRules);
    const pick = (decision, sources = SOURCES) => matches.find(rule => rule.decision === decision && sources.includes(rule.source));
    const rule = pick('deny', ['administrator']) ?? pick('ask', ['administrator']) ?? pick('deny') ?? pick('ask')
      ?? (ALLOWABLE.includes(effect) ? pick('allow') : undefined);
    return rule ? { decision: rule.decision, source: rule.source, rule: describe(rule) } : { decision: 'ask', source: 'default' };
  }
  // A capability is off when a deny rule covers every target of its effect.
  blocks(effect) {
    const rule = this.rules.find(item => item.decision === 'deny' && effectMatches(item.effect, effect) && /^\*+$/.test(item.target));
    return rule ? describe(rule) : undefined;
  }
  list() { return this.rules.map(rule => ({ ...describe(rule), source: rule.source, index: rule.index })); }
}

const describe = rule => ({ effect: rule.effect, target: rule.target, decision: rule.decision, source: rule.source, ...(rule.note ? { note: rule.note } : {}) });
const reason = verdict => `${verdict.decision === 'allow' ? 'Allowed' : verdict.decision === 'deny' ? 'Denied' : 'Prompt required'} by ${verdict.source} rule ${verdict.rule ? `${verdict.rule.effect} ${verdict.rule.target}` : ''}`.trim();
const commandSubject = ({ command, args = [] }) => [command, ...args].join(' ');
const connectorSubject = (config, tool, target) => `${config.id}/${tool}/${target}`;

module.exports = { PolicyEngine, loadAdminPolicy, defaultPolicyFile, parseRules, ruleSchema, GOVERNED, ALLOWABLE, reason, commandSubject, connectorSubject };

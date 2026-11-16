const { z } = require('zod');
const { isolatedRuntime } = require('./isolated-node');
const { runScript } = require('./script-runner');
const { digest } = require('./permissions');
const { reason } = require('./policy');
const { scriptName } = require('./skills');

const skillScriptInput = z.strictObject({
  skill: z.string().regex(/^[a-f0-9]{16}$/),
  script: z.string().max(64).regex(scriptName),
  input: z.string().refine(value => Buffer.byteLength(value) <= 8_000),
});

async function prepareSkillScript(run, args) {
  if (run.readOnly || !run.scriptNode) throw new Error('Skill scripts require a configured interactive editor run.');
  const input = skillScriptInput.parse(args);
  const skill = run.skills?.selected.get(input.skill);
  if (!skill || !run.canReadSkill(skill)) throw new Error('Skill script access is denied.');
  const script = await run.skills.script(input.skill, input.script);
  const runtime = await isolatedRuntime(run.scriptNode);
  const sourceDigest = digest(script.source);
  const subject = `${skill.name}/${input.script}`;
  const action = run.permissions.action('run_skill_script', 'skill.script', subject, input,
    { file: script.path, sourceDigest, runtime });
  const verdict = run.permissions.decide(action.effect, subject);
  if (verdict.decision === 'deny') {
    run.permissions.record(action, 'deny', reason(verdict));
    throw new Error('Skill script denied by policy.');
  }
  if (!run.permissions.valid(action)) throw new Error('Skill script approval was revoked.');
  return { action, input, script, runtime, sourceDigest, skill };
}

async function executeSkillScript(run, args, signal) {
  const prepared = await prepareSkillScript(run, args);
  run.permissions.require(prepared.action);
  const guard = AbortSignal.any([signal, run.permissions.revocation.signal]);
  const output = await runScript(prepared.runtime, prepared.script.source, { input: prepared.input.input }, guard, async () => {
    await run.validateCapabilities?.();
    const current = await prepareSkillScript(run, args);
    if (digest(current.action) !== digest(prepared.action)) throw new Error('Skill script approval changed.');
  });
  return { skill: prepared.skill.name, script: prepared.input.script, output };
}

module.exports = { skillScriptInput, prepareSkillScript, executeSkillScript };

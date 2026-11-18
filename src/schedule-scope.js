const path = require('node:path');
const { digest } = require('./permissions');
const { secretKey } = require('./connectors');
const { InstructionSet, discoverInstructions } = require('./instructions');
const { SkillRegistry } = require('./skills');
const { PluginRegistry } = require('./plugins');
const { PluginPackages } = require('./plugin-packages');
const { REPORT_INSTRUCTIONS, localUrl } = require('./forge');
const { version } = require('../package.json');
const { schedulePin, hasScheduleContext } = require('./schedules');

async function scheduleContextCatalog({ identity, connectorIds, fields, policy, connectors, storage, profile }) {
  const options = [];
  if (!fields || fields.userInstructions || fields.workspaceInstructions) {
    const userSet = new InstructionSet({ user: profile.userInstructions });
    if (userSet.user) options.push({ kind: 'userInstructions', id: 'user', label: 'User instruction profile',
      version: userSet.user.digest, user: userSet.user.text });
    const found = await discoverInstructions(identity);
    if (found.digest === profile.instructionApproval && (found.profiles.length || found.rules.length)) {
      options.push({ kind: 'workspaceInstructions', id: 'workspace', label: 'Approved workspace instructions',
        description: [...found.profiles, ...found.rules].map(item => item.file).join(', '), version: found.digest, found });
    }
  }
  if (!fields || fields.skills.length || fields.workers.length) {
    const registry = new PluginRegistry(profile.pluginRoots, connectors, new PluginPackages(path.join(storage, 'plugin-packages')));
    await registry.discover();
    const plugins = [];
    for (const pin of profile.pluginPins) {
      const [plugin] = await registry.verify([pin], connectorIds).catch(() => []);
      if (plugin) plugins.push(plugin);
    }
    if ((!fields || fields.skills.length) && !policy.blocks('skill.read')) {
      const skills = new SkillRegistry(profile.skillRoots);
      await skills.discover();
      for (const plugin of plugins) skills.registerPinned(plugin.skills.map(skill => ({ ...skill, pluginPin: digest(plugin.pin) })));
      for (const skill of skills.catalog().filter(item => policy.decide('skill.read', item.name).decision !== 'deny')) {
        const entry = skills.entries.get(skill.id);
        options.push({ kind: 'skills', id: skill.id, label: skill.name, description: skill.description,
          version: entry.pluginPin ?? entry.digest, load: () => skills.load(entry) });
      }
    }
    if (!fields || fields.workers.length) {
      for (const plugin of plugins) {
        const version = digest(plugin.pin);
        if (plugin.workers.includes('repository-research') && !policy.blocks('worker.research')) {
          options.push({ kind: 'workers', id: `built-in:${plugin.id}`, label: 'Repository research worker',
            description: `${plugin.id} ${plugin.version} · repository snapshot`, version, builtin: 'repository-research' });
        }
        if (policy.blocks('worker.custom')) continue;
        for (const role of plugin.roles.filter(role => role.snapshot === 'repository')) {
          options.push({ kind: 'workers', id: `custom:${plugin.id}/${role.name}`, label: role.name,
            description: `${plugin.id} ${plugin.version} · repository snapshot${role.tools.length ? ' · named-file reads' : ''}`,
            version, role: { ...role, id: `${plugin.id}/${role.name}` } });
        }
      }
    }
  }
  return { options, policy };
}

async function resolveScheduleScope({ identity, schedule, connectors, settings, secrets, accounts, contextCatalog, backgroundProfile }) {
  const selected = connectors.filter(config => config.tools.length && schedule.connectors.includes(config.id));
  if (selected.length !== schedule.connectors.length) throw new Error('A connector in this schedule is no longer configured.');
  if (!settings.model.trim()) throw new Error('Connect a model first.');
  if (schedule.background && settings.serverUrl?.startsWith('managed:')) {
    throw new Error('Connect an existing TrueForge server to run this report while VS Code is closed.');
  }
  if (schedule.background) localUrl(settings.serverUrl);
  const oauthAccounts = new Map();
  const credentials = await Promise.all(selected.map(async config => {
    const stored = await secrets.get(secretKey(config));
    if (config.oauth) {
      const identity = accounts?.identity(stored);
      if (!identity) throw new Error(`Sign in to connector ${config.id} before approving its reads.`);
      oauthAccounts.set(config.id, { raw: stored, identity });
    }
    return `${config.id}:${digest(stored ?? '')}`;
  }));
  const fields = schedule.context;
  let inputs;
  let versions;
  if (hasScheduleContext(fields)) {
    const { options, policy } = await contextCatalog(identity, schedule.connectors, fields);
    const lookup = (kind, id) => {
      const option = options.find(item => item.kind === kind && item.id === id);
      if (!option) throw new Error('A selected instruction, skill, or worker is no longer approved or available. Review the schedule context.');
      return option;
    };
    const user = fields.userInstructions ? lookup('userInstructions', 'user') : undefined;
    const workspace = fields.workspaceInstructions ? lookup('workspaceInstructions', 'workspace') : undefined;
    const skills = (fields.skills ?? []).map(id => lookup('skills', id));
    const workers = (fields.workers ?? []).map(id => lookup('workers', id));
    const bodies = await Promise.all(skills.map(option => option.load()));
    if (bodies.reduce((size, skill) => size + skill.body.length, 0) > 24_000) throw new Error('Scheduled skills allow at most 24,000 body characters.');
    const describe = ({ kind, id, label, description, version }) => ({ kind, id, label, description, version });
    versions = { inputs: [user, workspace, ...skills, ...workers].filter(Boolean).map(describe), policy: policy.digest,
      runtime: { version, instructions: digest(REPORT_INSTRUCTIONS), compaction: settings.compaction, turnTimeoutSeconds: settings.turnTimeoutSeconds },
      ...(workers.length ? { workerTimeoutSeconds: settings.workerTimeoutSeconds ?? 60 } : {}) };
    inputs = { instructions: new InstructionSet({ user: user?.user, found: workspace?.found, approved: workspace?.version }),
      skills: bodies, roles: [...new Set(workers.flatMap(option => option.builtin ? [option.builtin] : []))],
      customRoles: workers.flatMap(option => option.role ? [option.role] : []) };
  }
  const pin = schedulePin({ workspace: identity, schedule, connectors: selected, credentials,
    model: settings.model, fallbackModel: settings.fallbackModel, serverUrl: settings.serverUrl, versions, backgroundProfile });
  return { approval: { digest: pin, ...(versions ? { versions } : {}),
    ...(backgroundProfile ? { backgroundProfile, credentialDigests: credentials } : {}) }, settings, selected, inputs, oauthAccounts };
}

module.exports = { scheduleContextCatalog, resolveScheduleScope };

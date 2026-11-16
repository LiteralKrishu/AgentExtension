const fs = require('node:fs/promises');
const path = require('node:path');
const { z } = require('zod');
const { principal, identity, role, operation, handoffBytes, handoffReceipt } = require('./collaboration');
const { workspaceId } = require('./audit');
const { digest } = require('./permissions');
const { memoryScope, schemas } = require('./memory-sync');

const membership = identity.extend({ workspace: workspaceId, role });
const project = z.strictObject({
  id: principal, members: z.array(membership).min(1).max(100), handoffs: z.boolean().default(false),
}).refine(project => new Set(project.members.map(member => member.device)).size === project.members.length, 'Each device can join once per project.');
const collaborationConfig = z.strictObject({
  organization: principal, projects: z.array(project).min(1).max(50), memorySync: z.boolean().default(false),
}).refine(config => new Set(config.projects.map(project => project.id)).size === config.projects.length, 'Project IDs must be unique.')
  .refine(config => {
    if (!config.memorySync) return true;
    const members = config.projects.flatMap(project => project.members);
    return new Set(members.map(member => member.device)).size === new Set(members.map(member => `${member.device}/${member.user}`)).size;
  }, 'A memory sync device must have the same user throughout the organization.');

const actorOf = ({ user, device }) => ({ user, device });
const matches = (member, actor, workspace) => member.device === actor.device && member.user === actor.user && member.workspace === workspace;
const publicTransfer = ({ senderWorkspace, recipientWorkspace, ...handoff }) => handoff;
const viewTransfer = entry => ({ ...publicTransfer(entry), paths: entry.files.map(file => file.file) });
const summarize = ({ files, ...handoff }) => ({ ...publicTransfer(handoff), paths: files.map(file => file.file) });
const emptyContext = () => ({ revision: 0, text: '' });
const defaultState = () => ({ context: { notes: emptyContext(), instructions: emptyContext() }, transfers: [], events: [] });

async function readOperation(request, schema, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('Project request is too large.');
    chunks.push(chunk);
  }
  return schema.parse(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks))));
}

async function servePrivateMemory({ scope, config, project, member, input, send, store, denied }) {
  if (!config.collaboration.memorySync) return denied();
  const binding = { organization: config.collaboration.organization, user: member.user, ...(scope === 'workspace' ? { project: project.id } : {}) };
  if (input && (input.device !== member.device || digest(input.binding) !== digest(binding))) return denied();
  const file = path.join(store.storage, 'private-memory', `${digest(binding)}.json`);
  let state;
  try { state = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = { revision: 0, notes: [] };
  }
  const publicState = value => schemas[scope].state.parse({ ...value, binding, device: member.device });
  const current = publicState(state);
  if (!input) return send(200, current);
  if (input.expected !== current.revision) return send(409, { error: 'Private memory revision changed.' });
  if (digest(input.notes) === digest(current.notes)) return send(200, current);
  const next = { revision: current.revision + 1, notes: input.notes };
  await store.save(file, next);
  return send(200, publicState(next));
}

// Project state and its audit record are committed together by the service's single writer.
async function serveProject({ url, request, send, store, workspace, reload }) {
  const scope = url.searchParams.get('memory');
  if (scope !== null && !memoryScope.safeParse(scope).success) return send(400, { error: 'Invalid private memory scope.' });
  let input;
  if (request.method === 'POST') {
    try { input = await readOperation(request, scope ? schemas[scope].update : operation, scope ? 256_000 : handoffBytes); }
    catch { return send(422, { error: 'Invalid project operation.' }); }
  } else if (request.method !== 'GET') return send(405, { error: 'Method unavailable.' });
  const denied = () => send(403, { error: 'Project access denied.' });
  return store.serialize(async () => {
    // Read enrollment again after receiving the body and waiting for earlier writes.
    const { config, client } = await reload();
    if (!client || config.collaboration?.organization !== url.searchParams.get('organization')) return denied();
    const project = config.collaboration.projects.find(item => item.id === url.searchParams.get('project'));
    const member = project?.members.find(item => item.device === client.id && item.workspace === workspace);
    if (!member) return denied();
    if (scope) return servePrivateMemory({ scope, config, project, member, input, send, store, denied });
    const editor = member.role === 'editor';
    const actor = actorOf(member);
    const file = path.join(store.storage, 'projects', config.collaboration.organization, `${project.id}.json`);
    const state = await fs.readFile(file, 'utf8').then(JSON.parse).catch(error => {
      if (error.code === 'ENOENT') return defaultState();
      throw error;
    });
    const allowed = entry => matches(member, entry.sender, entry.senderWorkspace) || matches(member, entry.recipient, entry.recipientWorkspace);
    const eligible = other => other.role === 'editor' && config.clients.some(client => client.id === other.device && client.workspaces.includes(other.workspace));
    const usable = entry => project.members.some(other => eligible(other) && matches(other, entry.sender, entry.senderWorkspace))
      && project.members.some(other => eligible(other) && matches(other, entry.recipient, entry.recipientWorkspace));
    const record = (action, target) => {
      const receivedAt = store.now();
      state.events = [...state.events.filter(event => event.receivedAt >= receivedAt - config.retentionDays * 86_400_000),
        { ...actor, action, target, receivedAt }].slice(-Math.min(config.maxEvents, 500));
      return store.save(file, state);
    };
    if (!input) {
      if (url.searchParams.has('audit')) {
        return client.readAudit ? send(200, { events: state.events.filter(event => event.receivedAt >= store.now() - config.retentionDays * 86_400_000) }) : denied();
      }
      if (url.searchParams.has('handoff')) {
        const entry = state.transfers.find(item => item.id === url.searchParams.get('handoff'));
        if (!editor || !project.handoffs || !entry || !allowed(entry) || !usable(entry)) return denied();
        if (url.searchParams.has('accepted') && (entry.state !== 'accepted' || !matches(member, entry.recipient, entry.recipientWorkspace))) return denied();
        return send(200, viewTransfer(entry));
      }
      const recipients = editor && project.handoffs ? project.members.filter(other => eligible(other) && other.device !== member.device).map(actorOf) : [];
      return send(200, { actor, role: member.role, canAudit: client.readAudit, handoffsEnabled: project.handoffs,
        context: state.context, recipients, handoffs: editor && project.handoffs ? state.transfers.filter(allowed).map(summarize) : [] });
    }
    if (!editor) return denied();
    const conflict = () => send(409, { error: 'Project state changed or its limit was reached.' });
    if (input.action === 'save') {
      const previous = state.context[input.section];
      if (previous.revision === input.expected + 1 && previous.text === input.text) return send(200, previous);
      if (previous.revision !== input.expected) return conflict();
      const updated = { revision: previous.revision + 1, text: input.text };
      state.context[input.section] = updated;
      await record('save context', input.section);
      return send(200, updated);
    }
    const index = state.transfers.findIndex(item => item.id === input.id);
    const prior = state.transfers[index];
    if (input.action === 'remove') {
      if (!prior || !allowed(prior)) return denied();
      state.transfers.splice(index, 1);
      await record('remove handoff', input.id);
      return send(200, { removed: true });
    }
    if (!project.handoffs) return denied();
    if (input.action === 'accept') {
      if (!prior || !matches(member, prior.recipient, prior.recipientWorkspace) || !usable(prior)) return denied();
      if (handoffReceipt(viewTransfer(prior)) !== input.expected) return conflict();
      if (prior.state !== 'accepted') {
        prior.state = 'accepted';
        await record('accept handoff', input.id);
      }
      return send(200, { accepted: true });
    }
    const { id, to, title, revision, files } = input;
    const recipient = project.members.find(other => eligible(other) && other.device === to.device && other.user === to.user);
    if (!recipient || recipient.device === member.device) return denied();
    const entry = { id, title, revision, files, sender: actor, recipient: to, senderWorkspace: workspace, recipientWorkspace: recipient.workspace };
    if (prior) {
      const { state: _, created, ...saved } = prior;
      return digest(saved) === digest(entry) ? send(200, summarize(prior)) : conflict();
    }
    if (state.transfers.length >= 16) return conflict();
    const next = { ...entry, state: 'pending', created: store.now() };
    state.transfers.push(next);
    await record('send handoff', id);
    return send(200, summarize(next));
  });
}

module.exports = { collaborationConfig, serveProject };

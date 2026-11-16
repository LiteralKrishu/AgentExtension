const fs = require('node:fs/promises');
const path = require('node:path');
const { z } = require('zod');
const { principal, identity, role, commit, operation, handoffBytes, handoffReceipt, syncUpdate, syncState, syncBytes, orderedSyncFiles,
  continuationAge } = require('./collaboration');
const { workspaceId } = require('./audit');
const { digest } = require('./permissions');
const { memoryScope, schemas } = require('./memory-sync');

const membership = identity.extend({ workspace: workspaceId, role });
const project = z.strictObject({
  id: principal, members: z.array(membership).min(1).max(100), handoffs: z.boolean().default(false), fileSync: z.boolean().default(false),
  sessionContinuations: z.boolean().default(false),
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
const continuationSummary = ({ request, progress, planFirst, ...entry }) => summarize(entry);
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

async function serveWorkspaceFiles({ revision, config, project, member, input, send, store, denied }) {
  if (!project.fileSync || input && (member.role !== 'editor' || digest(input.actor) !== digest(actorOf(member)))) return denied();
  const directory = path.join(store.storage, 'workspace-files', digest([config.collaboration.organization, project.id]));
  const file = path.join(directory, `${revision}.json`);
  const actor = actorOf(member);
  let state;
  try { state = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = { revision, sequence: 0, publishedBy: null, files: [] };
  }
  const current = syncState.parse({ ...state, actor });
  if (!input) return send(200, current);
  if (input.expected !== current.sequence) return send(409, { error: 'The shared file snapshot changed.' });
  const files = orderedSyncFiles(input.files);
  if (digest(files) === digest(current.files)) return send(200, current);
  if (current.sequence === 0) {
    const previous = await fs.readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    if (previous.filter(name => name.endsWith('.json')).length >= 8) return send(409, { error: 'The project stores up to eight Git bases.' });
  }
  const next = { revision, sequence: current.sequence + 1, publishedBy: actor, files };
  await store.save(file, next);
  return send(200, { ...next, actor });
}

// Project state and its audit record are committed together by the service's single writer.
async function serveProject({ url, request, send, store, workspace, reload }) {
  const scope = url.searchParams.get('memory');
  const gitBase = url.searchParams.get('files');
  if (scope !== null && (gitBase !== null || !memoryScope.safeParse(scope).success)) return send(400, { error: 'Invalid private memory scope.' });
  if (gitBase !== null && !commit.safeParse(gitBase).success) return send(400, { error: 'Invalid workspace file Git base.' });
  let input;
  if (request.method === 'POST') {
    try { input = await readOperation(request, scope ? schemas[scope].update : gitBase ? syncUpdate : operation,
      scope ? 256_000 : gitBase ? syncBytes : handoffBytes); }
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
    if (gitBase) return serveWorkspaceFiles({ revision: gitBase, config, project, member, input, send, store, denied });
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
    const continuations = (state.continuations ?? []).filter(entry => entry.created + continuationAge > store.now());
    const canContinue = entry => project.sessionContinuations && entry && editor && allowed(entry) && usable(entry);
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
      if (url.searchParams.has('continuation')) {
        const entry = continuations.find(item => item.id === url.searchParams.get('continuation'));
        if (!canContinue(entry)) return denied();
        const receipt = url.searchParams.get('receipt');
        if (receipt !== null) {
          if (entry.state !== 'accepted' || !matches(member, entry.recipient, entry.recipientWorkspace)
              || handoffReceipt(viewTransfer(entry)) !== receipt) return denied();
          return send(200, { verified: true });
        }
        return send(200, viewTransfer(entry));
      }
      const recipients = editor && project.handoffs ? project.members.filter(other => eligible(other) && other.device !== member.device).map(actorOf) : [];
      return send(200, { actor, role: member.role, canAudit: client.readAudit, handoffsEnabled: project.handoffs,
        ...(url.searchParams.get('capabilities') === 'file-sync' ? { fileSyncEnabled: project.fileSync } : {}),
        ...(url.searchParams.get('continuations') === '1' ? {
          continuationRecipients: editor && project.sessionContinuations
            ? project.members.filter(other => eligible(other) && other.device !== member.device && other.user === member.user).map(actorOf) : [],
          continuations: continuations.filter(canContinue).map(continuationSummary),
        } : {}),
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
    if (input.action === 'offer-continuation') {
      if (!project.sessionContinuations) return denied();
      const { action: _, id, to, ...payload } = input;
      const recipient = project.members.find(other => eligible(other) && other.device === to.device && other.user === to.user);
      if (!recipient || recipient.device === member.device || recipient.user !== member.user) return denied();
      const entry = { ...payload, id, sender: actor, recipient: to, senderWorkspace: workspace, recipientWorkspace: recipient.workspace };
      const prior = continuations.find(item => item.id === id);
      if (prior) {
        const { state: _, created, ...saved } = prior;
        return digest(saved) === digest(entry) ? send(200, continuationSummary(prior)) : conflict();
      }
      if (continuations.length >= 16) return conflict();
      const next = { ...entry, state: 'pending', created: store.now() };
      state.continuations = [...continuations, next];
      await record('offer session continuation', id);
      return send(200, continuationSummary(next));
    }
    if (input.action === 'accept-continuation' || input.action === 'remove-continuation') {
      const entry = continuations.find(item => item.id === input.id);
      if (!entry || !allowed(entry)) return denied();
      if (input.action === 'remove-continuation') {
        state.continuations = continuations.filter(item => item !== entry);
        await record('remove session continuation', input.id);
        return send(200, { removed: true });
      }
      if (!canContinue(entry) || !matches(member, entry.recipient, entry.recipientWorkspace)) return denied();
      if (handoffReceipt(viewTransfer(entry)) !== input.expected) return conflict();
      if (entry.state !== 'accepted') {
        entry.state = 'accepted';
        state.continuations = continuations;
        await record('accept session continuation', input.id);
      }
      return send(200, { accepted: true });
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

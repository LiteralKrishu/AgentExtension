const { randomUUID } = require('node:crypto');
const { z } = require('zod');
const { enrollment, requestOrganization } = require('./organization');
const { loadAdminPolicy } = require('./policy');
const { digest } = require('./permissions');
const { MAX_TEXT } = require('./draft');
const { safePath } = require('./workspace');

const principal = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const identifier = z.string().uuid();
const checksum = z.string().regex(/^[a-f0-9]{64}$/);
const section = z.enum(['notes', 'instructions']);
const sectionText = z.string().max(8_000);
const contextEntry = z.strictObject({ revision: z.number().int().nonnegative(), text: sectionText });
const identity = z.strictObject({ user: principal, device: principal });
const role = z.enum(['viewer', 'editor']);
const syncBytes = 2_000_000;
const syncFileBytes = 32_000;
const syncLimit = 256;
const syncPath = z.string().max(500).refine(file => {
  try {
    return Boolean(safePath(file)) && !/[\x00-\x1f\x7f<>"|?*]/.test(file)
      && file.split('/').every(part => !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
  } catch { return false; }
});
const syncPathKey = file => file.normalize('NFC').toLowerCase();
function distinctSyncPaths(paths) {
  const keys = new Set();
  for (const file of paths.map(syncPathKey).sort()) {
    if (keys.has(file)) return false;
    const parts = file.split('/');
    for (let count = 1; count < parts.length; count++) if (keys.has(parts.slice(0, count).join('/'))) return false;
    keys.add(file);
  }
  return true;
}
const syncText = z.string().refine(value => !value.includes('\0') && Buffer.byteLength(value) <= syncFileBytes
  && Buffer.from(value).toString('utf8') === value);
const syncEntry = z.strictObject({ file: syncPath, baseDigest: checksum.nullable(), text: syncText.nullable() })
  .refine(entry => (entry.baseDigest !== null || entry.text !== null)
    && (entry.text === null || digest(entry.text) !== entry.baseDigest), 'A workspace file update must differ from its Git base.');
const syncFiles = z.array(syncEntry).max(syncLimit).refine(entries => distinctSyncPaths(entries.map(entry => entry.file)));
const syncVersion = z.number().int().nonnegative();
const syncState = z.strictObject({ revision: commit, sequence: syncVersion, actor: identity, publishedBy: identity.nullable(), files: syncFiles });
const syncUpdate = z.strictObject({ expected: syncVersion, actor: identity, files: syncFiles });
const orderedSyncFiles = entries => [...entries].sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
const portableFiles = z.array(z.strictObject({
  file: z.string().max(500).refine(file => {
    try { return Boolean(safePath(file)) && !/[\x00-\x1f\x7f]/.test(file); } catch { return false; }
  }),
  baseDigest: checksum.nullable(), text: z.string().max(MAX_TEXT).refine(text => !text.includes('\0')),
})).max(12).refine(entries => distinctSyncPaths(entries.map(entry => entry.file)), 'Shared file paths must be distinct.');
const files = portableFiles.min(1);
const handoffPayload = z.strictObject({ revision: commit, files, title: z.string().trim().min(1).max(160) });
const handoffBytes = 128_000;
const handoffSummary = z.strictObject({
  id: identifier, title: handoffPayload.shape.title, revision: commit, sender: identity, recipient: identity,
  state: z.enum(['pending', 'accepted']), created: z.number().int().nonnegative(), paths: z.array(z.string()).max(12),
});
const handoff = handoffSummary.extend({ files });
const continuationPayload = z.strictObject({
  ...handoffPayload.shape, files: portableFiles, request: z.string().trim().min(1).max(8_000),
  progress: z.string().max(4_000), planFirst: z.boolean(),
});
const continuation = handoffSummary.extend({ ...continuationPayload.shape });
const continuationAge = 7 * 24 * 60 * 60 * 1_000;
const projectState = z.strictObject({
  actor: identity, role, handoffsEnabled: z.boolean(), fileSyncEnabled: z.boolean().default(false), canAudit: z.boolean(), recipients: z.array(identity),
  context: z.strictObject({ notes: contextEntry, instructions: contextEntry }), handoffs: z.array(handoffSummary),
  continuationRecipients: z.array(identity).default([]), continuations: z.array(handoffSummary).default([]),
});
const operation = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('save'), section, expected: contextEntry.shape.revision, text: sectionText }),
  z.strictObject({ action: z.literal('send'), id: identifier, to: identity, ...handoffPayload.shape }),
  z.strictObject({ action: z.literal('accept'), id: identifier, expected: checksum }),
  z.strictObject({ action: z.literal('remove'), id: identifier }),
  z.strictObject({ action: z.literal('offer-continuation'), id: identifier, to: identity, ...continuationPayload.shape }),
  z.strictObject({ action: z.literal('accept-continuation'), id: identifier, expected: checksum }),
  z.strictObject({ action: z.literal('remove-continuation'), id: identifier }),
]);

function projectClient(workspace, { files, fetchFn } = {}) {
  function destination() {
    const config = enrollment(loadAdminPolicy(files), workspace);
    const binding = config?.projects?.[config.workspace];
    if (!binding) throw new Error('This workspace has no organization project enrollment.');
    return { config, binding, link: digest([new URL(config.url).origin, binding, config.workspace]) };
  }
  async function request(query, body, signal, { config, binding } = destination(), maxResponseBytes) {
    const params = new URLSearchParams({ ...binding, ...query });
    try { return await requestOrganization(config, `/v1/project?${params}`, { body, signal, fetchFn, maxResponseBytes }); }
    catch (error) {
      if (error.status === 403) error.message = 'Project access was denied. Check device approval and project role.';
      if (error.status === 409) error.message = 'Project state changed or its storage limit was reached.';
      throw error;
    }
  }
  return {
    async state(signal) {
      const target = destination();
      const state = projectState.parse(await request({ capabilities: 'file-sync', continuations: '1' }, undefined, signal, target));
      return { ...state, link: target.link };
    },
    async audit() { return (await request({ audit: '1' })).events; },
    async open(id, signal, accepted = false) {
      return handoff.parse(await request({ handoff: identifier.parse(id), ...(accepted ? { accepted: '1' } : {}) }, undefined, signal));
    },
    async openContinuation(id, signal) {
      const target = destination();
      const entry = continuation.parse(await request({ continuation: identifier.parse(id) }, undefined, signal, target));
      return { entry, link: target.link };
    },
    async acceptContinuation(entry, link, signal) {
      const target = destination();
      if (target.link !== link) throw new Error('Project enrollment changed during continuation review.');
      const body = operation.parse({ action: 'accept-continuation', id: entry.id, expected: handoffReceipt(entry) });
      if (!(await request({}, body, signal, target)).accepted) throw new Error('The service did not accept the continuation.');
    },
    async verifyContinuation(receipt, signal) {
      const target = destination();
      if (target.link !== receipt.link) throw new Error('Project enrollment changed after importing the continuation.');
      const result = await request({ continuation: identifier.parse(receipt.id), receipt: checksum.parse(receipt.digest) }, undefined, signal, target);
      if (result.verified !== true) throw new Error('Project continuation access could not be verified.');
    },
    async change(input, signal, expectedLink) {
      const target = destination();
      if (expectedLink !== undefined && target.link !== expectedLink) throw new Error('Project enrollment changed during review.');
      const body = operation.parse(input);
      if (Buffer.byteLength(JSON.stringify(body)) > handoffBytes) throw new Error('Keep the shared draft or continuation under 128 KB.');
      return request({}, body, signal, target);
    },
    async workspaceFiles(revision, signal) {
      const target = destination();
      const state = syncState.parse(await request({ files: commit.parse(revision) }, undefined, signal, target, syncBytes + 1024));
      if (state.revision !== revision) throw new Error('The shared files have a different Git base.');
      return { ...state, link: target.link };
    },
    async publishWorkspaceFiles(snapshot, updates, signal) {
      const target = destination();
      if (target.link !== snapshot.link) throw new Error('Project enrollment changed during file review.');
      const body = syncUpdate.parse({ expected: snapshot.sequence, actor: snapshot.actor, files: orderedSyncFiles(updates) });
      if (Buffer.byteLength(JSON.stringify(body)) > syncBytes) throw new Error('Keep the shared file snapshot under 2 MB.');
      const state = syncState.parse(await request({ files: commit.parse(snapshot.revision) }, body, signal, target, syncBytes + 1024));
      const sequence = snapshot.sequence + (digest(snapshot.files) === digest(body.files) ? 0 : 1);
      if (state.revision !== snapshot.revision || state.sequence !== sequence || digest(state.actor) !== digest(snapshot.actor)
          || digest(state.files) !== digest(body.files)) throw new Error('The service returned an unexpected file sync receipt.');
      return { ...state, link: target.link };
    },
  };
}

async function prepareHandoff(checkpoint, workspace, title) {
  if (!checkpoint?.files?.length || checkpoint.workspace !== workspace.root || checkpoint.selection) {
    throw new Error('A workspace-wide checkpoint with staged files is required.');
  }
  const revision = await workspace.gitRevision();
  const payload = handoffPayload.parse({ revision, title, files: checkpoint.files.map(({ file, base, text }) =>
    ({ file, baseDigest: base === null ? null : digest(base), text })) });
  await materializeHandoff(payload, workspace);
  return { ...payload, id: randomUUID() };
}

async function materializeHandoff(payload, workspace, signal) {
  const { revision, files: entries } = handoffPayload.parse({ revision: payload.revision, title: payload.title, files: payload.files });
  return materializeFiles(revision, entries, workspace, signal);
}

async function prepareContinuation(checkpoint, workspace, title) {
  if (!checkpoint || checkpoint.workspace !== workspace.root || checkpoint.selection) {
    throw new Error('A saved workspace-wide session is required.');
  }
  const revision = await workspace.gitRevision();
  const priorPlan = checkpoint.approvedPlan ? `Earlier plan for context\n${JSON.stringify(checkpoint.approvedPlan).slice(0, 1_900)}\n\n` : '';
  const payload = continuationPayload.parse({
    title, revision, request: checkpoint.request,
    progress: priorPlan + String(checkpoint.summary ?? '').slice(-2_000),
    planFirst: Boolean(checkpoint.planFirst || checkpoint.approvedPlan),
    files: checkpoint.files.map(({ file, base, text }) => ({ file, baseDigest: base === null ? null : digest(base), text })),
  });
  await materializeContinuation(payload, workspace);
  return { ...payload, id: randomUUID() };
}

async function materializeContinuation(payload, workspace, signal) {
  const { revision, files } = continuationPayload.parse({
    revision: payload.revision, files: payload.files, title: payload.title, request: payload.request,
    progress: payload.progress, planFirst: payload.planFirst,
  });
  return materializeFiles(revision, files, workspace, signal);
}

async function materializeFiles(revision, entries, workspace, signal) {
  if (await workspace.gitRevision(signal) !== revision) throw new Error('The destination Git revision differs from the handoff.');
  const restored = [];
  for (const { file, baseDigest, text } of entries) {
    signal?.throwIfAborted();
    let base;
    try { base = await workspace.read(file, baseDigest === null); } catch { /* An inaccessible or changed file cannot be recovered. */ }
    if (base === undefined || (base === null ? null : digest(base)) !== baseDigest) {
      throw new Error(`Workspace file ${file} differs from the handoff base.`);
    }
    restored.push({ file, base, text });
  }
  return { files: restored };
}

const handoffReceipt = value => digest({ ...value, state: 'accepted' });

module.exports = { principal, identity, role, commit, operation, handoffBytes, handoffReceipt, projectClient, prepareHandoff, materializeHandoff,
  syncPath, syncText, syncUpdate, syncFiles, syncLimit, syncFileBytes, syncBytes, syncState, distinctSyncPaths, orderedSyncFiles,
  continuationAge, prepareContinuation, materializeContinuation };

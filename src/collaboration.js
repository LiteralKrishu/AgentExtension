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
const files = z.array(z.strictObject({
  file: z.string().max(500).refine(file => {
    try { return Boolean(safePath(file)) && !/[\x00-\x1f\x7f]/.test(file); } catch { return false; }
  }),
  baseDigest: checksum.nullable(), text: z.string().max(MAX_TEXT).refine(text => !text.includes('\0')),
})).min(1).max(12).refine(entries => new Set(entries.map(entry => entry.file)).size === entries.length, 'Handoff paths must be unique.');
const handoffPayload = z.strictObject({ revision: commit, files, title: z.string().trim().min(1).max(160) });
const handoffBytes = 128_000;
const handoffSummary = z.strictObject({
  id: identifier, title: handoffPayload.shape.title, revision: commit, sender: identity, recipient: identity,
  state: z.enum(['pending', 'accepted']), created: z.number().int().nonnegative(), paths: z.array(z.string()).max(12),
});
const handoff = handoffSummary.extend({ files });
const projectState = z.strictObject({
  actor: identity, role, handoffsEnabled: z.boolean(), canAudit: z.boolean(), recipients: z.array(identity),
  context: z.strictObject({ notes: contextEntry, instructions: contextEntry }), handoffs: z.array(handoffSummary),
});
const operation = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('save'), section, expected: contextEntry.shape.revision, text: sectionText }),
  z.strictObject({ action: z.literal('send'), id: identifier, to: identity, ...handoffPayload.shape }),
  z.strictObject({ action: z.literal('accept'), id: identifier, expected: checksum }),
  z.strictObject({ action: z.literal('remove'), id: identifier }),
]);

function projectClient(workspace, { files, fetchFn } = {}) {
  async function request(query, body, signal) {
    const config = enrollment(loadAdminPolicy(files), workspace);
    const binding = config?.projects?.[config.workspace];
    if (!binding) throw new Error('This workspace has no organization project enrollment.');
    const params = new URLSearchParams({ ...binding, ...query });
    try { return await requestOrganization(config, `/v1/project?${params}`, { body, signal, fetchFn }); }
    catch (error) {
      if (error.status === 403) error.message = 'Project access was denied. Check device approval and project role.';
      if (error.status === 409) error.message = 'Project state changed or its storage limit was reached.';
      throw error;
    }
  }
  return {
    async state(signal) { return projectState.parse(await request({}, undefined, signal)); },
    async audit() { return (await request({ audit: '1' })).events; },
    async open(id, signal, accepted = false) {
      return handoff.parse(await request({ handoff: identifier.parse(id), ...(accepted ? { accepted: '1' } : {}) }, undefined, signal));
    },
    async change(input, signal) {
      const body = operation.parse(input);
      if (Buffer.byteLength(JSON.stringify(body)) > handoffBytes) throw new Error('Keep a handoff under 128 KB.');
      return request({}, body, signal);
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

module.exports = { principal, identity, role, operation, handoffBytes, handoffReceipt, projectClient, prepareHandoff, materializeHandoff };

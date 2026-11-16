const { z } = require('zod');
const { digest } = require('./permissions');
const { safePath } = require('./workspace');
const { memoryLimits } = require('./memory');
const { loadAdminPolicy } = require('./policy');
const { enrollment, requestOrganization } = require('./organization');
const { principal } = require('./collaboration');

const memoryScope = z.enum(['workspace', 'preferences']);
const revision = z.number().int().nonnegative();
const binding = z.strictObject({ organization: principal, user: principal, project: principal.optional() });
const reference = z.strictObject({
  file: z.string().min(1).max(300).refine(file => {
    try { return Boolean(safePath(file)) && !/[\x00-\x1f\x7f]/.test(file); } catch { return false; }
  }),
  start: z.number().int().positive().optional(), end: z.number().int().positive().optional(),
}).refine(ref => !ref.start || !ref.end || ref.end >= ref.start, 'Source lines are out of order.');

const schemas = Object.fromEntries(memoryScope.options.map(scope => {
  const limits = memoryLimits[scope];
  const source = z.strictObject({ kind: z.enum(['user', 'agent']), edited: z.boolean().optional(),
    ...(scope === 'workspace' ? { references: z.array(reference).max(5).optional() } : {}) });
  const notes = z.array(z.strictObject({
    id: z.string().uuid(), text: z.string().min(1).max(limits.text),
    savedAt: z.iso.datetime(), editedAt: z.iso.datetime().optional(), source,
  })).max(limits.notes).refine(notes => new Set(notes.map(note => note.id)).size === notes.length
    && notes.reduce((size, note) => size + note.text.length, 0) <= limits.total, 'Notes exceed the store limits or repeat an ID.');
  const common = { binding, device: principal, notes };
  return [scope, { notes, state: z.strictObject({ ...common, revision }), update: z.strictObject({ ...common, expected: revision }) }];
}));

const equal = (left, right) => left === undefined || right === undefined ? left === right : digest(left) === digest(right);
const sameNote = (left, right) => !left || !right ? left === right : left.text === right.text && equal(left.source, right.source);
const indexed = notes => new Map(notes.map(note => [note.id, note]));
const noteChanges = (left, right) => {
  const a = indexed(left);
  const b = indexed(right);
  return [...new Set([...a.keys(), ...b.keys()])].filter(id => !sameNote(a.get(id), b.get(id))).length;
};

function portableNotes(notes, scope) {
  return schemas[scope].notes.parse(notes.map(({ id, text, savedAt, editedAt, source }) => ({
    id, text, savedAt, ...(editedAt ? { editedAt } : {}),
    source: { kind: source?.kind === 'agent' ? 'agent' : 'user',
      ...(typeof source?.edited === 'boolean' ? { edited: source.edited } : {}),
      ...(scope === 'workspace' && source?.references?.length ? { references: source.references } : {}),
    },
  })));
}

function preserveLocalSources(notes, local, scope) {
  const previous = indexed(local);
  return notes.map(note => {
    const source = previous.get(note.id)?.source;
    if (!source || source.kind !== note.source.kind) return note;
    return { ...note, source: { ...note.source,
      ...(source.runId ? { runId: source.runId } : {}),
      ...(scope === 'preferences' && source.references ? { references: source.references } : {}),
    } };
  });
}

function memoryClient(workspace, scope, { files, fetchFn } = {}) {
  memoryScope.parse(scope);
  const connection = () => {
    const config = enrollment(loadAdminPolicy(files), workspace);
    const project = config?.projects?.[config.workspace];
    if (!project) throw new Error('This workspace has no organization project enrollment.');
    return { config, project, origin: new URL(config.url).origin };
  };
  async function request(destination, body) {
    const query = new URLSearchParams({ ...destination.project, memory: scope });
    try {
      const result = await requestOrganization(destination.config, `/v1/project?${query}`, { body, fetchFn });
      const state = schemas[scope].state.safeParse(result);
      if (!state.success || state.data.binding.organization !== destination.project.organization
          || state.data.binding.project !== (scope === 'workspace' ? destination.project.project : undefined)) {
        throw new Error('The service did not return a valid private memory snapshot.');
      }
      return state.data;
    } catch (error) {
      if (error.status === 403) error.message = 'Private memory sync is disabled or this device no longer has access.';
      if (error.status === 409) error.message = 'Synced notes changed during review. Sync again to review the latest version.';
      throw error;
    }
  }
  return {
    async read() {
      const destination = connection();
      const state = await request(destination);
      return { state, link: { origin: destination.origin, ...state.binding }, project: destination.project };
    },
    async publish(snapshot, notes) {
      const destination = connection();
      if (snapshot.link.origin !== destination.origin || !equal(snapshot.project, destination.project)) {
        throw new Error('Sync enrollment changed during review. Open Notes and sync again.');
      }
      const { binding, device, revision } = snapshot.state;
      const next = await request(destination, { binding, device, expected: revision, notes });
      const expected = revision + (equal(notes, snapshot.state.notes) ? 0 : 1);
      if (!equal(next.binding, binding) || next.device !== device || next.revision !== expected || !equal(notes, next.notes)) {
        throw new Error('The private memory sync receipt did not match the approved changes.');
      }
      return next;
    },
  };
}

async function mergeNotes(base, local, remote, resolve) {
  const ancestor = indexed(base);
  const mine = indexed(local);
  const theirs = indexed(remote);
  const output = [];
  for (const id of new Set([...theirs.keys(), ...mine.keys()])) {
    const a = mine.get(id);
    const b = theirs.get(id);
    const original = ancestor.get(id);
    let note;
    if (sameNote(a, b) || sameNote(a, original)) note = b;
    else if (sameNote(b, original)) note = a;
    else {
      const choice = await resolve({ local: a, remote: b });
      if (!['local', 'remote'].includes(choice)) return;
      note = choice === 'local' ? a : b;
    }
    if (note) output.push(note);
  }
  return output;
}

async function syncMemory({ store, scope, client, check, resolve, confirm }) {
  await check();
  const record = store.record();
  const guard = digest(record);
  const local = store.list();
  const ours = portableNotes(local, scope);
  const snapshot = await client.read();
  const { state, link } = snapshot;
  if (record.sync && !equal(record.sync.link, link)) throw new Error('This store is linked to another sync account or project. Forget its sync link before linking it again.');
  if (record.sync?.revision > state.revision) throw new Error('The service returned an older sync revision. Ask your administrator to check the private memory store.');
  const merged = await mergeNotes(record.sync?.notes ?? [], ours, state.notes, resolve);
  if (!merged) return;
  const approved = schemas[scope].notes.safeParse(merged);
  if (!approved.success) throw new Error('Combined notes exceed this store’s limits. Remove or summarize entries before syncing again.');
  const counts = { outgoing: noteChanges(state.notes, merged), incoming: noteChanges(ours, merged) };
  if (!await confirm({ link, local: ours, merged: approved.data, ...counts })) return;
  return store.locked(async () => {
    await check();
    if (digest(store.record()) !== guard) throw new Error('Local notes changed during review. Open Notes and sync again.');
    const receipt = await client.publish(snapshot, approved.data);
    await store.write(preserveLocalSources(receipt.notes, local, scope), { link, revision: receipt.revision, notes: receipt.notes });
    return counts;
  });
}

module.exports = { memoryScope, schemas, memoryClient, syncMemory };

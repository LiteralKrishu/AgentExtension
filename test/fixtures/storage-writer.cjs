const { CheckpointStore } = require('../../src/checkpoint');
const { AuditLog } = require('../../src/audit');
const { withStorageLock } = require('../../src/storage-lock');
const store = new CheckpointStore(process.argv[2], '/fixture');
process.on('message', async message => {
  try {
    let value;
    if (message.op === 'save') value = await store.save(message.state, message.options);
    else if (message.op === 'load') value = await store.load();
    else if (message.op === 'clear') value = await store.clear(message.expected);
    else if (message.op === 'audit') {
      const log = new AuditLog(process.argv[2], '/fixture', { maxBytes: message.maxBytes });
      await Promise.all(Array.from({ length: message.count }, (_, index) => log.append({
        tool: 'read_file', effect: 'workspace.read', target: 'a'.repeat(64), decision: 'allow',
        reason: 'Workspace run scope', runId: `worker-${process.pid}-${index}`,
      })));
      value = true;
    } else if (message.op === 'hold') {
      await withStorageLock(store.directory, async () => {
        process.send({ id: message.id, held: true });
        await new Promise(() => {});
      });
    } else throw new Error('Unknown fixture action.');
    process.send({ id: message.id, value });
  } catch (error) { process.send({ id: message.id, error: error.message, code: error.code }); }
});
process.send({ ready: true });

const path = require('node:path');
const fs = require('node:fs/promises');
const { runBackground, backgroundScheduler, workspaceStores, controlBackground } = require('./background-runner');

const usage = 'node <background-cli> <serve|tick|status|run-now|pause|revoke|token> <extension-storage> [schedule-id] [connector-id]';

async function tokenFromStdin() {
  let size = 0;
  const parts = [];
  for await (const part of process.stdin) {
    size += part.length;
    if (size > 8_002) throw new Error('The supplied token exceeds the size limit.');
    parts.push(part);
  }
  return Buffer.concat(parts).toString('utf8').replace(/\r?\n$/, '');
}

async function main([action, directory, id, connector]) {
  if (!action || action === '--help') { process.stdout.write(`${usage}\n`); return; }
  if (!process.getuid) throw new Error('Run the background pilot on macOS or Linux.');
  if (!directory || !path.isAbsolute(directory)) throw new Error(usage);
  const storage = await fs.realpath(directory);
  const show = record => process.stdout.write(`${record.name}: ${record.status}\n`);
  if (action === 'serve' || action === 'tick') {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    try { await runBackground({ storage, once: action === 'tick', signal: controller.signal, onChange: show,
      onError: () => process.stderr.write('A workspace schedule could not be read or recorded.\n') }); }
    finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
    return;
  }
  if (action === 'status' || action === 'run-now') {
    for (const store of [...await workspaceStores(storage), ...await workspaceStores(storage, true)]) {
      for (const schedule of (await store.list()).filter(item => item.background || item.type === 'coding-draft')) {
        if (action === 'status') {
          const state = schedule.backgroundRevoked ? 'revoked' : schedule.needsReview ? 'needs review' : schedule.enabled ? 'enabled' : 'paused';
          process.stdout.write(`${schedule.id}  ${state}  ${schedule.name}\n`);
        } else if (schedule.id === id) {
          const controller = new AbortController(), stop = () => controller.abort();
          process.on('SIGINT', stop); process.on('SIGTERM', stop);
          try {
            const options = { store, onChange: show, signal: controller.signal };
            const scheduler = schedule.type === 'coding-draft' ? require('./coding-run').codingScheduler(options) : backgroundScheduler({ storage, ...options });
            await scheduler.runNow(id);
          } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
          return;
        }
      }
    }
    if (action === 'status') return;
    throw new Error('No background schedule with that ID was found.');
  }
  if (['pause', 'revoke', 'token'].includes(action)) {
    await controlBackground(storage, action, id, connector, action === 'token' ? await tokenFromStdin() : undefined);
    return;
  }
  throw new Error(usage);
}

main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });

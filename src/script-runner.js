const { stageSource, startIsolatedNode } = require('./isolated-node');

const SCRIPT_BYTES = 8_000;
const INPUT_BYTES = 128_000;
const OUTPUT_BYTES = 16_000;
const DEADLINE_MS = 5_000;

async function runScript(runtime, source, input, parentSignal, check) {
  if (Buffer.byteLength(source) > SCRIPT_BYTES) throw new Error('Script exceeds 8,000 bytes.');
  const payload = JSON.stringify(input);
  if (Buffer.byteLength(payload) > INPUT_BYTES) throw new Error('Script input exceeds 128,000 bytes.');
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(DEADLINE_MS)]);
  signal.throwIfAborted();
  const staged = await stageSource(source, 'agentextension-script-');
  let process;
  try {
    await check?.(signal);
    process = await startIsolatedNode(runtime, staged, signal);
    const stdout = [];
    let bytes = 0;
    let overflow = false;
    const collect = (chunk, keep) => {
      bytes += chunk.length;
      if (bytes > OUTPUT_BYTES) {
        overflow = true;
        process.stop();
      } else if (keep) stdout.push(chunk);
    };
    process.child.stdout.on('data', chunk => collect(chunk, true));
    process.child.stderr.on('data', chunk => collect(chunk, false));
    process.child.stdin.end(payload);
    const exit = await process.closed;
    signal.throwIfAborted();
    if (overflow) throw new Error('Script output exceeds 16,000 bytes.');
    if (exit.code !== 0) throw new Error('Isolated script failed. Check the configured runtime, sandbox, and script.');
    await check?.(signal);
    signal.throwIfAborted();
    return Buffer.concat(stdout).toString('utf8');
  } catch (error) {
    if (error.name === 'TimeoutError') throw new Error('Isolated script exceeded its 5-second deadline.');
    throw error;
  } finally {
    process?.stop();
    await process?.closed;
    await staged.clean();
  }
}

module.exports = { runScript, SCRIPT_BYTES };

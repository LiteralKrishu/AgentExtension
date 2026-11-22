const { digest } = require('./permissions');
const bindingKey = input => digest({ command: input.command, args: input.args });
function commandBinding(run, input) { return run.commandBindings?.get(bindingKey(input)); }
async function bindCommand(run, input, signal) {
  const workspace = run.workspace;
  if (!workspace?.sourceIdentity || !workspace.environment?.authorizationIdentity) return;
  const sourceDigest = await workspace.sourceIdentity(signal);
  const environment = await workspace.environment.authorizationIdentity(workspace.root, input.command, input.args, signal);
  signal.throwIfAborted();
  const binding = { sourceDigest, ...environment };
  run.commandBindings ??= new Map();
  const prior = commandBinding(run, input);
  if (prior && digest(prior) === digest(binding)) return prior;
  run.commandBindings.set(bindingKey(input), binding);
  return binding;
}
module.exports = { commandBinding, bindCommand };

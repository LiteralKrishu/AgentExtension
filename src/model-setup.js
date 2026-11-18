const vscode = require('vscode');
const { randomBytes } = require('node:crypto');
const { localUrl } = require('./forge');
const { MODEL_SECRET, providerUrl } = require('./managed-forge');

const DEFAULT_SERVER = 'http://127.0.0.1:8790';
const OPENAI_MODEL = 'gpt-4.1-mini';

function validate(fn) {
  return value => {
    try { fn(value); return undefined; } catch (error) { return error.message; }
  };
}

async function chooseProviderModel(baseUrl, apiKey) {
  // Some compatible APIs omit GET /models. In that case the user can enter the model ID.
  let models = [];
  try {
    const response = await fetch(`${baseUrl}/models`, {
      redirect: 'error', signal: AbortSignal.timeout(4_000),
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    if (response.ok) {
      const { data } = await response.json();
      if (Array.isArray(data)) models = [...new Set(data.map(row => row?.id)
        .filter(id => typeof id === 'string' && id.trim() && id.length <= 200))].sort();
    }
  } catch { /* Offer manual entry if discovery fails. */ }
  if (models.length) {
    const pick = await vscode.window.showQuickPick([...models.map(label => ({ label, model: label })), { label: 'Enter model ID manually' }],
      { title: 'Choose a model that supports tool calls', ignoreFocusOut: true });
    if (!pick || pick.model) return pick?.model;
  }
  return (await vscode.window.showInputBox({
    title: 'Model ID', prompt: 'Enter the model ID from your provider. Choose a chat model that supports tool calls.', ignoreFocusOut: true,
    validateInput: value => !value.trim() || value.trim().length > 200 ? 'Enter a model ID of up to 200 characters.' : undefined,
  }))?.trim();
}

async function configureModel(context, managed, settings, status) {
  const choice = await vscode.window.showQuickPick([
    { label: 'OpenAI', description: `${OPENAI_MODEL} · API key`, id: 'openai' },
    { label: 'OpenAI-compatible API', description: 'LM Studio, Ollama, or another endpoint', id: 'custom' },
    { label: 'Existing TrueForge server', description: 'Choose a model already configured in TrueForge', id: 'external' },
  ], { title: 'Set up AgentExtension', placeHolder: 'Choose a model provider', ignoreFocusOut: true });
  if (!choice) return;
  if (choice.id === 'external') {
    const config = vscode.workspace.getConfiguration('agentextension');
    const value = await vscode.window.showInputBox({
      title: 'TrueForge server URL', value: config.get('serverUrl', DEFAULT_SERVER),
      ignoreFocusOut: true, validateInput: validate(localUrl),
    });
    if (value === undefined) return;
    const serverUrl = localUrl(value);
    const { TrueForge } = await import('@truefoundry/trueforge-sdk');
    const forge = new TrueForge({ baseUrl: serverUrl, timeoutInSeconds: 5, maxRetries: 0 });
    let models;
    try { ({ data: models } = await forge.models.list()); }
    catch { throw new Error('Could not read models from TrueForge. Check that your server is running and check the URL.'); }
    if (!models.length) throw new Error('Add a model in TrueForge, then open model setup again.');
    const model = await vscode.window.showQuickPick(models.map(item => ({ label: item.name })),
      { title: 'Choose a TrueForge model', ignoreFocusOut: true });
    if (!model) return;
    await config.update('serverUrl', serverUrl, vscode.ConfigurationTarget.Global);
    await config.update('model', model.label, vscode.ConfigurationTarget.Global);
    await context.secrets.delete(MODEL_SECRET);
    managed.dispose();
    return model.label;
  }

  let baseUrl = 'https://api.openai.com/v1';
  if (choice.id === 'custom') {
    const value = await vscode.window.showInputBox({
      title: 'Model API URL',
      value: settings?.baseUrl ?? 'http://127.0.0.1:1234/v1',
      prompt: 'Enter the OpenAI-compatible base URL, including /v1 if required.',
      ignoreFocusOut: true, validateInput: validate(providerUrl),
    });
    if (value === undefined) return;
    baseUrl = providerUrl(value);
  }
  const apiKey = await vscode.window.showInputBox({
    title: choice.id === 'openai' ? 'OpenAI API key' : 'Model API key (optional)',
    prompt: choice.id === 'openai' ? 'Paste your OpenAI API key.' : 'If your endpoint requires no key, press Enter.',
    password: true, ignoreFocusOut: true, validateInput: value =>
      (!value.trim() && choice.id === 'openai') || /[\r\n]/.test(value) ? 'Enter a valid API key.' : undefined,
  });
  if (apiKey === undefined) return;
  const modelId = choice.id === 'openai' ? OPENAI_MODEL : await chooseProviderModel(baseUrl, apiKey.trim());
  if (!modelId) return;
  const profile = { id: randomBytes(16).toString('hex'), baseUrl, apiKey: apiKey.trim(), modelId };
  status('Starting bundled TrueForge…');
  await managed.connection(profile, AbortSignal.timeout(35_000));
  try { await context.secrets.store(MODEL_SECRET, JSON.stringify(profile)); }
  catch {
    managed.dispose();
    throw new Error('VS Code could not save the model connection. Check its access to your system credential store.');
  }
  return modelId;
}

module.exports = { configureModel, DEFAULT_SERVER };

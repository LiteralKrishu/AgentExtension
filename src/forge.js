const { randomBytes } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const spec = require('../trueforge/agent.json');
const { digest } = require('./permissions');
const { openBridge, commandTarget, commandSchema, planKey, planSchema, actionFor } = require('./bridge');

class ModelError extends Error {}

function localUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Set AgentExtension: Server URL to the local TrueForge address, such as http://127.0.0.1:8790.');
  }
  return url.origin;
}

function failure(message) {
  const text = String(message || '');
  if (/api[ _-]?key|unauthori[sz]ed|authentication|\b401\b|\b403\b/i.test(text)) return 'The model credentials were rejected.';
  if (/timeout|timed out|ECONNREFUSED|ENOTFOUND|fetch failed|network|connection|cannot connect|other side closed/i.test(text)) return 'The model endpoint did not respond.';
  if (/no user query found|error rendering prompt with jinja/i.test(text)) return 'The model rejected TrueForge’s prompt format. Try disabling AgentExtension: Compaction or selecting another model.';
  if (/rate.?limit|quota|\b429\b/i.test(text)) return 'The model provider hit a rate or quota limit.';
  if (/not found|unknown model/i.test(text)) return 'TrueForge could not find the configured model.';
  return 'TrueForge could not complete the model turn.';
}

function parseApproval(ref, messages) {
  const source = messages.get(ref.sourceEventId);
  const call = source?.toolCalls?.find(item => item.id === ref.id);
  if (!call) return { name: '', args: {} };
  let args;
  try { args = JSON.parse(call.function.arguments || '{}'); } catch { return { name: '', args: {} }; }
  if (call.function.name.endsWith('call_tool') && args.tool_name) {
    return { name: args.tool_name, args: args.input ?? {} };
  }
  return { name: call.toolInfo?.name ?? call.function.name, args };
}

async function runForge(settings, run, prompt, ui) {
  const { TrueForge, isEventDelta, mergeEventDelta } = await import('@truefoundry/trueforge-sdk');
  const baseUrl = localUrl(settings.serverUrl);
  const primary = settings.model.trim();
  const runtime = settings.compaction === false ? {
    ...spec.config,
    contextManagement: { ...spec.config.contextManagement, compaction: { enabled: false } },
  } : spec.config;
  const fallback = settings.fallbackModel.trim();
  if (!primary) throw new Error('Set AgentExtension: Model to a model configured in TrueForge, including its provider prefix.');

  const timeout = Math.min(1800, Math.max(30, settings.turnTimeoutSeconds ?? 600));
  const client = new TrueForge({ baseUrl, timeoutInSeconds: timeout + 10, maxRetries: 0 });
  const quick = { timeoutInSeconds: 10, abortSignal: run.signal };
  let sessionId;
  let bridge;
  let connected = false;
  const name = `agentextension-${randomBytes(8).toString('hex')}`;
  function stopSession() {
    if (!sessionId) return;
    const id = sessionId;
    void client.sessions.cancel(id, { timeoutInSeconds: 5 }).catch(() => {});
  }

  run.signal.addEventListener('abort', stopSession, { once: true });
  try {
    bridge = await openBridge(run);
    try {
      await client.settings.mcpServers.create({
        manifest: {
          name, type: 'remote', url: bridge.url,
          description: 'Workspace excerpts, draft edits, review and isolated commands in VS Code.',
          auth: { type: 'header', headers: { Authorization: `Bearer ${bridge.token}` } },
        },
      }, quick);
      connected = true;
    } catch (error) {
      if (/outbound url blocked/i.test(error.body?.error?.message ?? '')) {
        throw new Error('TrueForge blocked the editor connector. Start it with 127.0.0.1 in OUTBOUND_URL_ALLOWED_HOSTS.');
      }
      throw new Error('Could not connect to local TrueForge. Start TrueForge and check the server URL.');
    }

    async function attempt(model) {
      run.signal.throwIfAborted();
      await run.validateCapabilities?.();
      if (run.workers) run.workers.settings = { ...run.workers.settings, model };
      ui.status(`Starting TrueForge with ${model}…`);
      const surfaceTools = [...(run.browser ? ['browser_open', 'browser_observe', ...(run.browser.interactive ? ['browser_act'] : [])] : []),
        ...(run.computer ? ['computer_observe', ...(run.computer.interactive ? ['computer_act'] : [])] : [])];
      const connectors = spec.mcpServers.map(connector => ({ ...connector,
        enableTools: [...connector.enableTools, ...surfaceTools, ...(run.skills?.selected.size ? ['read_skill_resource'] : []),
          ...(run.connectors?.catalog().length ? ['list_connector_tools', 'connector_read'] : []),
          ...(run.workers?.roles.has('repository-research') ? ['research_repository'] : []),
          ...(run.workers?.roles.has('diff-review') ? ['review_draft'] : [])],
        preloadTools: [...connector.preloadTools, ...surfaceTools, ...(run.connectors?.catalog().length ? ['list_connector_tools'] : []),
          ...(run.workers?.roles.has('repository-research') ? ['research_repository'] : []),
          ...(run.workers?.roles.has('diff-review') ? ['review_draft'] : [])],
        requireApprovalForTools: [...connector.requireApprovalForTools, ...(run.connectors?.catalog().length ? ['connector_read'] : [])],
      }));
      const mcpServers = connectors.map(connector => run.planFirst ? {
        ...connector, name,
        preloadTools: [...connector.preloadTools, 'propose_plan'],
        enableTools: [...connector.enableTools, 'propose_plan'],
        requireApprovalForTools: [...connector.requireApprovalForTools, 'propose_plan'],
      } : { ...connector, name });
      const { data: session } = await client.sessions.create({
        agent: { spec: {
          ...spec, config: runtime, model: { name: model },
          mcpServers,
        } },
      }, quick).catch(error => {
        if (/model|provider|credential/i.test(String(error.message))) throw new ModelError(failure(error.message));
        throw new Error('TrueForge could not start a session. Check the server and model settings.');
      });
      sessionId = session.id;
      ui.session(new URL(`/sessions/${encodeURIComponent(sessionId)}`, baseUrl).href);
      let input = [{ type: 'user.message', content: prompt }];
      const messages = new Map();
      let promptedForPlan = false;
      let promptedForReview = false;
      for (let turn = 0; turn < 12; turn++) {
        const deadline = AbortSignal.timeout(timeout * 1000);
        const signal = AbortSignal.any([run.signal, deadline]);
        let terminal;
        try {
          const stream = await client.sessions.createTurnStream(sessionId, { input }, { abortSignal: signal });
          for await (const { data: event } of stream.withMetadata()) {
            signal.throwIfAborted();
            if (isEventDelta(event)) {
              const base = messages.get(event.id);
              if (base) mergeEventDelta(base, event);
              if (event.threadId === 'main' && event.type === 'model.message.delta' && event.content) ui.token(event.content);
            } else if (event.type === 'model.message') {
              messages.set(event.id, event);
              if (event.threadId === 'main' && event.content) ui.token(event.content);
            } else if (event.type === 'turn.done') {
              terminal = event.state;
            }
          }
        } catch {
          run.signal.throwIfAborted();
          stopSession();
          if (deadline.aborted) throw new ModelError('The TrueForge turn timed out.');
          throw new Error('The connection to TrueForge ended before the turn finished.');
        }
        run.signal.throwIfAborted();
        if (!terminal) throw new Error('TrueForge ended the stream without a final result.');
        if (terminal.status === 'error') throw new ModelError(failure(terminal.message));
        if (terminal.status === 'cancelled') {
          if (terminal.reason === 'server-execution-timeout') throw new ModelError('The TrueForge turn timed out.');
          throw new Error('TrueForge cancelled this turn.');
        }
        const pending = terminal.requiredActions ?? [];
        if (!pending.length) {
          if (run.planFirst && !run.approvedPlan) {
            if (promptedForPlan) throw new Error('The model did not submit a plan for approval.');
            promptedForPlan = true;
            input = [{ type: 'user.message', content: 'Call propose_plan now with the goal, steps, and checks. Wait for approval before editing.' }];
            ui.status('Asking TrueForge to open the implementation plan…');
            continue;
          }
          const revision = run.draft.revision;
          if (promptedForReview || !run.draft.files.size || run.reviewed?.revision === revision
              || run.reviewDeclinedRevision === revision) return;
          promptedForReview = true;
          input = [{ type: 'user.message', content: 'The current draft is staged. Call the editor review_changes tool now so I can review the hunks in VS Code. Keep the current draft as is.' }];
          ui.status('Asking TrueForge to open review for the staged changes…');
          continue;
        }
        input = [];
        for (const action of pending) {
          if (action.type !== 'tool.approval_required') throw new Error('TrueForge requested an unsupported action.');
          for (const ref of action.toolCalls) {
            const call = parseApproval(ref, messages);
            const allow = await approve(call, run, ui);
            run.signal.throwIfAborted();
            input.push({
              type: 'user.tool_approval', threadId: action.threadId, toolCallId: ref.id,
              approval: allow ? { status: 'allow' } : { status: 'deny', reason: 'The editor did not approve this action.' },
            });
          }
        }
        if (!input.length) throw new Error('TrueForge paused without an approval reference.');
        ui.status('Continuing the TrueForge session…');
      }
      throw new Error('The run reached its review limit.');
    }

    try {
      await attempt(primary);
    } catch (error) {
      // Browser and native actions cannot be rolled back or safely replayed after a model failure.
      if (!(error instanceof ModelError) || run.signal.aborted || run.surfaceWrites) throw error;
      const next = fallback && fallback !== primary ? fallback : primary;
      run.workers?.cancelAll('Parent retry');
      await run.browser?.reset(); run.computer?.reset();
      run.resetDraft();
      run.permissions.reset();
      ui.retry(`${error.message} ${next === primary ? 'Retrying once' : `Trying ${next}`}…`);
      await sleep(1_000, undefined, { signal: run.signal });
      await attempt(next);
    }
  } catch (error) {
    run.workers?.cancelAll('Parent failed');
    run.resetDraft();
    run.permissions.reset();
    throw error;
  } finally {
    await run.workers?.close();
    await run.browser?.close(); run.computer?.close();
    run.signal.removeEventListener('abort', stopSession);
    bridge?.close();
    if (connected) void client.settings.mcpServers.delete(name, { timeoutInSeconds: 5 }).catch(() => {});
  }
}

async function approve(call, run, ui) {
  await run.validateCapabilities?.();
  if (call.name === 'connector_read') {
    if (!run.connectors) return false;
    try {
      const prepared = await run.connectors.prepare(call.args);
      const { config, input, target, action } = prepared;
      if (!await ui.connector({ server: config.url, account: config.account, tool: input.tool,
        target, arguments: input.arguments })) return false;
      const current = await run.connectors.prepare(call.args);
      if (digest(current.action) !== digest(action)) return false;
      return run.permissions.grant(action);
    } catch { return false; }
  }
  if (call.name === 'propose_plan') {
    const parsed = planSchema.safeParse(call.args);
    if (!run.planFirst || run.approvedPlan || run.planGrant || !parsed.success) return false;
    const action = actionFor(run, call.name, parsed.data);
    if (!await ui.plan(parsed.data) || !run.permissions.grant(action)) return false;
    run.planGrant = planKey(parsed.data);
    return true;
  }
  if (run.planFirst && !run.approvedPlan) return false;
  if (call.name === 'review_changes') {
    const hunks = run.draft.review();
    if (!hunks.length) return false;
    const revision = run.draft.revision;
    const action = actionFor(run, call.name, {});
    const accepted = await ui.review(hunks);
    if (revision !== run.draft.revision) return false;
    if (!accepted?.length) {
      run.reviewDeclinedRevision = revision;
      return false;
    }
    const current = new Set(hunks.map(digest));
    if (accepted.some(hunk => !current.has(digest(hunk))) || !run.permissions.grant(action)) return false;
    run.reviewGrant = { revision, hunks: accepted, rejected: hunks.length - accepted.length };
    return true;
  }
  if (call.name === 'run_command') {
    const parsed = commandSchema.safeParse(call.args);
    if (!parsed.success) return false;
    const { key, revision, scope } = commandTarget(run, parsed.data);
    const action = actionFor(run, call.name, parsed.data);
    if (!await ui.command(parsed.data, { revision, scope }) || key !== commandTarget(run, parsed.data).key) return false;
    return run.permissions.grant(action);
  }
  return false;
}

module.exports = { runForge, localUrl, parseApproval, failure, approve };

# AgentExtension

AgentExtension is a VS Code coding agent for local TrueForge. It can edit a selection or find and change related files across a repository. Review each hunk in VS Code before you apply it.

**Starting point** · From scratch. The project started with this repository's MIT license.

## Set up

1. Install Node.js 22.14 or later and VS Code 1.101 or later. [VS Code runtime requirements](https://code.visualstudio.com/updates/v1_101)
2. Run `npm ci` in this repository.
3. Start TrueForge in a separate terminal. Keep it bound to the loopback address. The allowlist lets TrueForge reach the extension's temporary editor connector.

   ```sh
   HOST=127.0.0.1 OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]' \
     npx --yes @truefoundry/trueforge@0.184.2
   ```

4. Open TrueForge at `http://127.0.0.1:8790`. Under **Settings → Models**, add a catalog provider or an OpenAI-compatible endpoint. The [example manifest](trueforge/model.example.json) shows the fields for a local model. Set any credentials in TrueForge.
5. Open this repository in VS Code. Run **Run AgentExtension** from **Run and Debug**. Open the target repository in the Extension Development Host.
6. In the host window, set **AgentExtension: Model** to the full name from TrueForge, such as `local-lm-studio/qwen`. Set **AgentExtension: Fallback Model** to a second configured model if you want automatic fallback.

The extension loads the checked-in agent definition when it creates a session. Use a configured TrueForge chat model with a compatible tool-call template. [Agent definition](trueforge/agent.json) · [TrueForge model setup](https://trueforge.dev/models)

You can also install the packaged extension with **Extensions: Install from VSIX** and use it in a normal VS Code window.

## Use the extension

- **Inline edit.** Select code. Press **Cmd+Alt+I** on macOS or **Ctrl+Alt+I** on Windows or Linux. Enter an instruction. The first hunk opens in a native VS Code diff.
- **Agent mode.** Open **AgentExtension** in the activity bar. Describe the change. Use `@file:src/path.py` or `@symbol:my_function` to add context. Put a path with spaces in quotes. Select **Run agent** to begin.
- **Plan first.** Select **Plan first** to review a goal, steps, and proposed checks. Select **Approve plan and start** to allow draft edits. To change the request before edits, cancel and update the prompt.
- **Review.** Select **Preview file** to see the full file diff. Open an individual hunk with **Preview**. Choose **Accept** or **Reject** for each hunk. Select **Continue with decisions** to resume TrueForge. When the run completes, select **Apply approved hunks**.
- **Verification.** If the agent requests a check, the approval dialog shows the executable, arguments, and draft scope. Expand **Verification** to see the command, its result, and its output. Results show when they cover an earlier draft or a different hunk selection.
- **Save and undo.** Apply edits existing files in editor buffers. Use **Save All** if Auto Save is off. New files are created at apply time. **Undo last apply** reverts the last batch if the current text still matches it. Save reverted buffers if needed.
- **Cancel.** Select **Cancel** in the panel or click the TrueForge status item. The extension discards the run's drafts. Use **Discard** to clear a completed review before apply.
- **Permissions.** Expand **Permissions and decisions** to inspect the current workspace scope and recent decisions. Select **Revoke run access** to cancel the run and invalidate its grants. The **AgentExtension permissions** output channel keeps a local decision log with hashed targets. It does not log source text, command arguments, or connector credentials.
- **Skills.** Select **Choose skills** to enable up to three text-only workflows for this workspace. The extension includes `focused-change`. Add local skill folders in **AgentExtension: Skill Roots**. Each folder must contain `skill-name/SKILL.md` directories. Only selected bodies and requested text resources enter the run. Scripts and permission declarations in skill files cannot grant tool access.
- **Context.** Expand **Context sources** to see the instruction, request, selection, skill, repository, memory, and tool-result sources sent during the run. Each entry shows its origin, trust label, reason, and character count. This is a bounded history of submitted sources. It is not a token meter or a view of the model's retained context after compaction.
- **Workspace notes.** Select **Workspace notes** to add a note. Review it and select **Save note**. Approved notes enter future runs for that workspace. Select an existing note to remove it. Notes persist locally in extension storage. Keep credentials out of notes.
- **Read connectors.** Configure a server, account label, named read tool, and allowed targets as described below. Select **Choose connectors** to enable it for this workspace. Use **Connector credential** to store or remove its bearer token in VS Code SecretStorage. Every read requires approval for the exact server, account, tool, and target.
- **Plugins.** Select **Manage plugins** to enable the bundled `review-team` or a local plugin. Review its version, publisher label, capabilities, source, and content digest. Enablement is saved for this workspace. A changed version, file, or referenced connector configuration requires approval again. Clear its checkbox to disable it.
- **Subagents.** With `review-team` enabled, ask the agent to research relevant repository files or review its draft. Under **Research and review workers**, open a task to see its source ranges, findings, state, and TrueForge session link. Diff reports become stale when the draft or accepted hunk selection changes. Findings are advice. Apply still requires your hunk decisions.
- **Browser inspection.** Add exact origins in **AgentExtension: Browser Origins**. Select **Browser access**, choose the origins, then choose observation or requests for actions. The extension starts a separate Chrome profile. It can read a page, list controls, and capture a small screenshot. Each click, text fill, upload, and outgoing write request needs approval.
- **Computer use.** On macOS, select **Computer access**, choose one running app, and choose observation or requests for actions. The extension reads its first accessible window. It can request a press or text fill on an observed control. Each action needs approval. macOS accessibility access must be enabled for VS Code.
- **Stop external access.** Select **Stop browser and computer** to close the browser and revoke native-app access. Editor work can continue. **Cancel** and **Revoke run access** stop the full run. Stopping access cannot reverse an action that already reached an app or server.
- **Saved reports.** Select **Open saved run report** to open the latest report. After a restart, choose a saved report for the workspace. Reports link to exact checked draft patches, worker sessions, and requested browser screenshots. They separate passed, failed, skipped, and stale checks. The extension retains the latest 20 report folders per workspace.

Direct skill and connector selections last for the current extension-host session. Select them again after a restart. Workspace notes and exact plugin approvals persist. A restart restores no one-time tool approvals. Changing skill roots, plugin roots, connector settings, or connector credentials cancels an active run.

Browser and computer selections also last for the extension-host session. Each run starts a fresh browser profile. Native access binds the selected process, launch time, bundle ID, and app path. Restarting the native app requires a new selection. Changing browser settings cancels an active run.

## Browser and computer scope

Set browser origins in user settings. For example:

```json
"agentextension.browserOrigins": ["http://127.0.0.1:3000", "https://docs.example.com"]
```

An origin includes the scheme, hostname, and port. Wildcards, URL credentials, paths, and query strings are not accepted. HTTP is limited to loopback addresses. The default browser is installed Google Chrome. Set **AgentExtension: Browser Executable** to an absolute Chrome or Chromium executable path if needed. The extension does not use your normal browser profile, cookies, passwords, or open tabs.

The browser blocks redirects, extra windows, frames, downloads, WebSockets, service workers, and requests outside the selected origins. Its page policy also limits resources and forms to the current origin. Open a redirect destination explicitly if it is in scope. These limits can prevent some sites from working. Browser inspection allows GET and HEAD requests. A remote service can still attach side effects to a GET request; use trusted origins. This is an application-level request policy, not a separate virtual machine or network firewall. [Playwright request routing](https://playwright.dev/docs/api/class-browsercontext#browser-context-route)

Interaction requires a current observation. The host rechecks the snapshot after approval and rejects a changed target. A browser upload accepts one text file from the current workspace, up to 64,000 bytes. The dialog binds the file digest. A form submission or other non-read HTTP request has its own approval for the exact method, URL, and body digest. Unsolicited write requests are blocked. Password controls are not exposed for editing. Arbitrary scripts, selectors, keyboard shortcuts, and global coordinates are not agent tools.

Native computer use is supported on macOS 13 or later. It uses a bundled accessibility helper and checks the selected app instance before each observation and action. It targets accessible elements directly, so another app receiving keyboard focus does not redirect input. Protected fields are excluded. Apps with no accessible window or controls are unsupported. The helper does not expose global screen capture, clipboard access, file browsing, or app launching. Native app actions can have effects beyond the editor workspace. Review each action before approval. [Apple accessibility actions](https://developer.apple.com/documentation/applicationservices/1462091-axuielementperformaction)

Each surface permits 30 operations per run. An operation stops after 90 seconds. Approval expires after 60 seconds. Browser observation returns up to 8,000 text characters and 60 controls. Native observation visits up to 100 nodes and 10 levels. A browser run permits 100 requests, 2 MB per response, and 16 MB of responses in total. Screenshots are limited to six per run and 250,000 bytes each. Workers do not inherit browser or native-app access.

Browser and native changes occur when approved. They do not wait for **Apply approved hunks**, and **Undo last apply** cannot reverse them. After any external action approval, a model failure ends the run without automatic retry or fallback. Reports keep hashed action targets and outcomes. They omit typed values, upload contents, credentials, and command output. Exact draft patches and optional screenshots can contain source or page data, so review these files before sharing them.

## Local plugin setup

Add parent folders to **AgentExtension: Plugin Roots**. Each child folder must contain `plugin.json`. Copying a plugin into a folder makes it available for review. It does not enable it. This release supports local text packages. It does not download archives or execute plugin scripts and hooks.

The bundled manifest provides a working example:

```json
{
  "schemaVersion": 1,
  "id": "review-team",
  "publisher": "LiteralKrishu",
  "version": "1.0.0",
  "description": "Research repository excerpts and review a draft.",
  "skills": ["review-workflow"],
  "workers": ["repository-research", "diff-review"],
  "connectors": [],
  "capabilities": ["skill.read", "worker.research", "worker.review"]
}
```

Place each declared skill at `skills/<name>/SKILL.md`. Text references and assets can sit below that skill. Capabilities must match the declared components. Unknown fields, scripts, hooks, symlinks, and undeclared skills are rejected. A connector reference names an existing read connector. Add `connector.read` to its capabilities and enable that connector separately. Each connector call still needs exact approval. A publisher label is not a verified signature.

Enable up to three plugins. The combined limit is three skills and 24,000 skill-body characters across direct selection and plugins. Each plugin allows at most 64 files and 128,000 bytes. The full content digest pins the manifest and all permitted text files. The host checks the approved pin at run start, tool dispatch, worker completion, and apply.

Workers share the parent's selected model and can add model usage. Each run allows two concurrent workers and four worker calls in total, including parent retries. Each child has a 60-second deadline, one model iteration, and a requested output limit of 2,000 tokens. The host also rejects output above 8,000 characters. Research gets up to six source excerpts. Diff review gets up to eight hunks from the current draft or accepted subset. Inputs are capped at 16,000 characters before the digest. Truncation and omitted hunks are shown.

Children receive the task and selected snapshot. They do not inherit parent chat history, saved notes, credentials, grants, skills, or editor and connector tools. TrueForge 0.184.2 still exposes its built-in UTC clock tool. Any child tool-call attempt rejects the report. A child cannot edit, run commands, call connectors, or start another child. Cancellation stops active child sessions. Citation checks verify supplied file ranges; they do not prove a finding is correct. The parent must assess the report and use the normal review flow.

## Read connector setup

Add a connector to your user settings. Use a tool you have reviewed as read-only. This release supports Streamable HTTP tools with one top-level string argument that identifies the target.

```json
"agentextension.readConnectors": [
  {
    "id": "project-docs",
    "url": "https://your-mcp-server.example/mcp",
    "account": "documentation-reader",
    "tools": [
      {
        "name": "read_document",
        "targetArgument": "document_id",
        "targets": ["project-guide"]
      }
    ]
  }
]
```

Replace the example endpoint and tool contract with your server's values. The account is your local label for the credential. The server controls the credential's actual account and access. Tool annotations cannot expand the configured scope. The extension rejects extra arguments, unlisted tools, and unlisted targets. It does not verify that a remote implementation is read-only. Use a trusted server and a read-only credential.

HTTPS is required for remote servers. Loopback HTTP is allowed for local servers. Redirects, automatic OAuth, local connector processes, remote resource links, and connector writes are not supported. Do not put tokens in settings or endpoint URLs. The extension keeps bearer tokens out of TrueForge prompts and redacts a token echoed in a text result.

## Architecture

TrueForge owns the agent loop, model calls, tool discovery, and approval pauses. The VS Code extension creates sessions, consumes the event stream, and displays a link to the session. A shared host permission broker authorizes dispatch. A short-lived loopback MCP connector exposes search, line-range reads, draft edits, review, command execution, selected skill resources, approved connector reads, and enabled worker roles. Each worker uses a separate TrueForge session. The editor connector uses a per-run token. Remote connector credentials remain in the VS Code host.

Run start grants workspace reads and in-memory draft proposals. Plans, reviews, commands, connector calls, apply, and undo use exact host-issued approvals. One-time grants bind the canonical workspace, run, policy, tool, normalized arguments, target, and scope. Commands also bind the draft revision and hunk selection. Grants expire after five minutes. Dispatch consumes them once. Denial and revocation take precedence. Retry clears pending approvals. Model summaries cannot restore them.

The context pass ranks overlapping code windows with prompt keywords, rare terms, and path matches. Explicit mentions come first. Agent mode reserves candidates for implementation, tests, and documentation. It prefers test and documentation files that share the implementation name when the prompt matches that name. The model also gets a short list of likely files and line anchors for declarations, registrations, and headings. The panel shows selected paths, line ranges, and reasons. Retrieved excerpts have a 12,000-character budget in agent mode and a 4,000-character budget in inline mode. The request and the inline selection are separate from that budget. Each file read returns up to 5,000 characters of exact source text. A worker ranks excerpts and handles workspace searches. TrueForge preloads the search, read, proposal, and review tools. It defers the remaining tool schemas and can compact long turn histories.

Proposals stage exact-text replacements or line ranges in memory. A line proposal must use a recent read of that range. It can target a unique source line from the excerpt. A change to the same file invalidates the read. Inline edits are restricted to the original selection. Plan-first runs require plan approval before draft edits or commands. A separate TrueForge approval opens hunk review. Only the current reviewed revision can be applied. The extension checks the original text again before it applies the edits.

Commands require approval for the exact executable, arguments, draft revision, and hunk selection. They run without a shell or network in a temporary workspace copy on macOS or on Linux with bubblewrap. Checks before review use all staged hunks. Checks after review use the accepted hunks. Installed runtimes and dependencies remain accessible for reads. Commands time out after 30 seconds.

On a model error the extension clears editor drafts, then tries the configured fallback once if no external action was approved. Without a fallback it retries the original model once after one second. Approved browser or native-app actions disable this automatic retry. A failed or cancelled run does not apply editor drafts. It does not reverse external actions. For slower local models, increase **AgentExtension: Turn Timeout Seconds**. If the local endpoint needs more time to generate a tool call, increase TrueForge’s `MODEL_HTTP_HEADERS_TIMEOUT_MS` and `MODEL_HTTP_BODY_TIMEOUT_MS` when you start it. If a model template rejects compacted history, clear **AgentExtension: Compaction** or switch models.

## Verify

- `npm run check` checks JavaScript syntax. `npm test` checks context, edit scoping, hunk offsets, workspace boundaries, plugin pins, and worker limits. Without a test server, integration cases are skipped.
- With TrueForge running as above, use `AGENTEXTENSION_TEST_FORGE_URL=http://127.0.0.1:8790 npm test` to check real sessions and approval with a local scripted endpoint.
- Follow the [Flask rehearsal](docs/demo.md) to verify the three fixed tasks.
- `npm run test:ui` runs the actual panel in a separate VS Code profile with a temporary workspace and a scripted model. Set `AGENTEXTENSION_TEST_FORGE_URL` first. It also needs Playwright. Set `AGENTEXTENSION_PLAYWRIGHT_MODULE` to its installed module path if it is outside this project. Set `AGENTEXTENSION_VSCODE_EXECUTABLE` if VS Code is outside the default macOS location. The test prints its evidence folder.
- Set `AGENTEXTENSION_VSIX` to the package path to test an installed VSIX. The harness checks its activated version, plugin updates, worker sessions, cancellation, and the full review flow.
- Set `AGENTEXTENSION_TEST_SURFACES=1` with the test server variable to include real Chrome and macOS app tests in `npm test`. The UI harness also uses Chrome and a temporary native test app. Building that fixture needs Xcode Command Line Tools. Run `npm run build:native` on macOS when changing the bundled helper. The package includes the helper for Apple Silicon and Intel; local execution was tested on Apple Silicon.

See [milestone results and limits](docs/milestones.md) for the release verification record. The integration suite uses real TrueForge sessions and a deterministic model endpoint. It verifies orchestration and permissions. It does not establish task quality for a general coding model. The earlier live-model Flask Task B result remains unresolved.

The extension uses lexical retrieval and caps each index pass at 12,000 candidate paths and 32 million characters. The same limits affect initial retrieval and search. Command isolation is unavailable on Windows.

# AgentExtension

AgentExtension is a VS Code coding agent for local TrueForge. It can edit a selection or find and change related files across a repository. Review each hunk in VS Code before you apply it.

**Starting point** · From scratch. The project started with this repository's MIT license.

## Install and connect a model

1. Download the VSIX with `darwin-arm64` in its name from **Assets** on the [latest GitHub release](https://github.com/StackOverHack-Hub/AgentExtension/releases/latest). It runs on Apple Silicon. For another platform, follow [the build instructions](#develop-or-build-the-vsix).
2. In VS Code 1.101 or later, run **Extensions: Install from VSIX** and select the downloaded file.
3. Open a trusted workspace folder. Open **AgentExtension** in the activity bar and select **Connect model**.
4. Choose one connection.

   - **OpenAI.** Paste an OpenAI API key with access to GPT-4.1 mini. This is the default model. [Model requirements](https://developers.openai.com/api/docs/models/gpt-4.1-mini)
   - **OpenAI-compatible API.** Enter the API URL and the ID of a model that supports tool calls. Add a key if the provider requires one. For LM Studio or Ollama, start the local model server first. TrueForge sends the provider requests.
   - **Existing TrueForge server.** Enter its local URL and select one of its configured models. You can continue to use **AgentExtension: Server URL**, **Model**, and **Fallback Model** in VS Code Settings for that connection.

5. Describe a task and select **Run agent**. Review the proposed changes in VS Code.

The VSIX includes Node.js and TrueForge. VS Code stores the API key in its credential store. The bundled server starts when you connect a model or start your first run in a new window. It runs on a private local port for that window. After you close the window, **Resume** can recover the editor checkpoint and start a new model session. Scheduled reports that run while VS Code is closed require an existing TrueForge server.

## Develop or build the VSIX

Install an official Node.js distribution, version 22.15 or later, and run `npm ci`. Run `npm run package:vsix` on the target platform to build its package. The default filename includes the operating system and processor. Pass an output path after `--` to choose where to save the file. On macOS, the build uses the Xcode Command Line Tools to compile the optional desktop helper.

For source debugging, use **Run AgentExtension** from **Run and Debug**. The source host connects to a separately started TrueForge server. Keep it on the loopback address so it can reach the temporary editor connector.

```sh
HOST=127.0.0.1 OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]' \
  npx --yes @truefoundry/trueforge@0.184.2
```

Open TrueForge at `http://127.0.0.1:8790` and add a model under **Settings → Models**. In the Extension Development Host, select **Connect model → Existing TrueForge server**. [Example model manifest](trueforge/model.example.json) · [Agent definition](trueforge/agent.json)

## Use the extension

- **Inline edit.** Select code. Press **Cmd+Alt+I** on macOS or **Ctrl+Alt+I** on Windows or Linux. Enter an instruction. The first hunk opens in a native VS Code diff.
- **Agent mode.** Open **AgentExtension** in the activity bar. Describe a task in the prompt at the bottom of the panel. Select **Run agent** or press **Enter** to start. Press **Shift+Enter** to add a line. Use the model link below the prompt to open model settings.
- **Add context.** Select **+ Context** to add a file or symbol, choose skills, or review workspace instructions. You can also type `@file:src/path.py` or `@symbol:my_function`. Put a path with spaces in quotes.
- **Configure tools.** Select **Tools** beside the prompt to manage plugins, connectors, accounts, browser and computer access, or permission rules.
- **Run a workflow.** Type `/` in an empty prompt or select the **/** button. Search for a workflow from an enabled plugin, such as `/example-team:inspect`. You can also find shortcuts for skills, notes, and working-tree review.
- **More actions.** Open **⋯** at the top of the panel for notes, schedules, draft handoff, saved reports, sharing, and audit export.
- **Managed check approvals.** An optional five-minute grant can reuse approval for the same source, draft, command, and container image. Access details show its scope and expiry. See [command approvals](docs/command-approvals.md).
- **Run details.** Expand **Run details** below the run to see context sources, permission decisions, tool activity, verification, and worker findings. Cancel, revoke, and stop controls stay near the prompt while they are available.
- **Interrupted runs.** Select **Resume** to restore an agent or inline draft. The extension reconnects to the original TrueForge session when it can confirm the previous turn ended and the old editor connection closed. Otherwise it starts a new session. Inline recovery preserves the selection and independent file edits. Use **Review conflicts** to preview overlapping changes and choose what to stage. If the selection boundaries are ambiguous, select the current code to start a new inline edit. The plan, hunk review, commands, and connector calls that require approval need a fresh decision. Applying or discarding the draft clears the checkpoint.
- **Questions.** The agent can pause to ask a question with up to five options. The panel shows it under **Question from the agent**. Choose an option, type an answer, or select **Skip question**. Answers are sent as your input and do not approve any action. A run can ask up to five questions. Answered questions do not count toward the run's limit of 12 approval pauses. If the agent ends a turn with a plain-text question and nothing is staged, the extension asks it once to use the question panel or continue. A scheduled report can save a question for later review.
- **Plan first.** Select **Plan first** to review a goal, steps, and proposed checks. Select **Approve plan and start** to allow draft edits. To change the request before edits, cancel and update the prompt.
- **Review.** Select **Preview file** to see the full file diff. Open an individual hunk with **Preview**. Choose **Accept** or **Reject** for each hunk. Select **Continue with decisions** to resume TrueForge. When the run completes, select **Apply approved hunks**.
- **Check accepted changes.** After review, rerun a recorded command in an isolated copy with the accepted hunks. Review the command approval and check status beside **Apply approved hunks**. A changed source file invalidates the result of a check still in progress.
- **Fix from Problems.** Open Quick Fix for a diagnostic and select **Fix with AgentExtension**. The run starts with the diagnostic's source location and asks for plan approval. Review the resulting hunks before applying them.
- **Review working-tree changes.** Select up to six changed files to review against Git HEAD. The read-only worker reports findings in the panel. Changes to the selected files during review mark the findings stale.
- **Verification.** If the agent requests a check, the approval dialog shows the executable, arguments, and draft scope. Expand **Verification** to see the command, its result, and its output. Results show when they cover an earlier draft or a different hunk selection.
- **Save and undo.** Apply edits existing files in editor buffers. Use **Save All** if Auto Save is off. New files are created at apply time. **Undo last apply** reverts the last batch if the current text still matches it. Save reverted buffers if needed.
- **Cancel.** Select **Cancel run** in the panel or click the TrueForge status item. The extension discards the run's drafts. Use **Discard draft** to clear a completed review before apply.
- **Permissions.** Expand **Permissions and decisions** to inspect the current workspace scope and recent decisions. Select **Revoke run access** to cancel the run and invalidate its grants. The **AgentExtension permissions** output channel keeps a local decision log with hashed targets. It does not log source text, command arguments, or connector credentials.
- **Skills.** Select **+ Context → Skills** to enable text workflows for this workspace. The extension includes `focused-change`. Add local roots in **AgentExtension: Skill Roots**. Each root contains `skill-name/SKILL.md` folders. With **AgentExtension: Automatic Skills** on, the agent can match up to two skills at run start. During the run it can list eligible skill names and descriptions and request a workflow. Matching and requests share a 12,000-character budget. The run allows up to three active skills and 24,000 body characters across all sources. Skills with `disable-model-invocation: true` or `allow_implicit_invocation: false` require manual selection. The panel marks matched and requested skills, and **Context sources** records when text enters the run.
- **Context.** Expand **Context sources** to see the instruction, request, selection, skill, repository, memory, and tool-result entries recorded during the run. Each entry shows its origin, trust label, reason, and character count. After a main-thread compaction, entries show whether the extension recorded them before or after that event. Retained source IDs are unavailable.
- **Notes.** Open **Notes** and type to search by full note text, scope, or cited file. Workspace notes enter future runs for that workspace. User preferences enter runs in every workspace. To free space, select **Summarize workspace notes** or **Summarize user preferences**. Select at least two entries, write a shorter summary, and review it before replacing the originals. You can also add, edit, or remove a note and open its source. Notes persist in extension storage and support opt-in [private sync](#sync-personal-preferences-and-workspace-notes). Keep credentials out of notes.
- **Suggested notes.** During a run, the agent can call `suggest_note` to propose a workspace note or user preference. It can cite up to five workspace files. Suggestions are kept in a separate list and never sent to a model. The panel shows how many are waiting for review. Choose **Review suggested notes** to save, edit and save, or discard each one. A run can make at most three suggestions, and at most 20 can wait for review. A rule that denies `memory.suggest` removes the tool.
- **MCP connectors.** Open **Tools → Connector settings** to configure a server, account label, and tools with exact targets. Select **Tools → Connectors** to enable it for this workspace. Use **Tools → Connector accounts** to set a bearer token or sign in with OAuth. Every write requires a separate editor approval.
- **Plugins.** Select **Tools → Plugins** to enable a bundled, configured, or imported plugin. Review its version, publisher label, capabilities, source, and content digest. Enablement is saved for this workspace. A changed version, file, or referenced connector configuration requires approval again. Clear its checkbox to disable it. [Share packages and run workflows](#plugin-packages-and-workflows)
- **Subagents.** With `review-team` enabled, ask the agent to research relevant repository files or review its draft. Under **Research and review workers**, open a task to see its source ranges, findings, state, and TrueForge session link. Diff reports become stale when the draft or accepted hunk selection changes. Findings are advice. Apply still requires your hunk decisions. Workers use a bounded queue and share the run budget. See the [worker queue guide](docs/worker-queue.md).
- **Fix workers.** Enable the bundled `fix-team` plugin to add three workers. `diagnose_failure` explains the latest failed check from its output and the files it cites. `propose_worker_edits` drafts edits to named files in a separate draft. The agent must merge those edits with `merge_worker_edits`. A merge is refused if the draft changed after the worker started or if an edit overlaps a change the agent already staged. Merged edits appear in hunk review like any other change. The plugin also defines a custom `docs-check` reviewer.
- **Browser inspection.** Add exact origins in **AgentExtension: Browser Origins**. Select **Browser access**, choose the origins, then choose observation or requests for actions. The extension starts a separate Chrome profile. It can read a page, list controls, and capture a small screenshot. Each click, text fill, upload, and outgoing write request needs approval.
- **Computer use.** On macOS, select **Computer access**, choose one running app, and choose observation or requests for actions. The extension reads its first accessible window. It can request a press or text fill on an observed control. Each action needs approval. macOS accessibility access must be enabled for VS Code.
- **Stop external access.** Select **Stop browser and computer** to close the browser and revoke native-app access. Editor work can continue. **Cancel** and **Revoke run access** stop the full run. Stopping access cannot reverse an action that already reached an app or server.
- **Instructions.** Set **AgentExtension: User Instructions** to add standing preferences to every run. To use repository instructions, add `.agentextension/instructions.md`, `AGENTS.md`, or path rules in `.agentextension/rules/`. Then select **Instructions** and approve them. Any change to those files requires a new approval.
- **Permission rules.** Select **Permission rules** to see the administrator, user, and workspace rules that apply. Add or remove workspace rules there. When you approve a command, choose **Always allow in this workspace** to save an exact allow rule for that command.
- **Scheduled coding drafts.** Approve a source-bound local task that stages a private, checked draft for the review inbox. Import requires fresh review and explicit apply. [Setup and limits](docs/scheduled-coding.md)
- **Draft handoff.** Export and import a base-bound patch, or prepare a separate local Git branch. Commit, push, and pull-request actions stay separate. [Supported flow](docs/git-handoff.md)
- **Portable skills.** Preview a local `SKILL.md` import and its unsupported settings before installing it. [Compatibility subset](docs/interoperability.md)
- **Scheduled reports.** Select **Scheduled reports** in the panel or run **AgentExtension: Manage Scheduled Reports**. Choose the request, timing, budget, and any optional connectors or context. Review the scope and select **Approve schedule**. Runs are read-only. You can approve the local runner to run a schedule when VS Code is closed. [Schedule setup](#scheduled-reports)
- **Usage and budget.** The panel shows the tokens, tool calls, and time a run has used. Tokens include worker sessions and context compaction. **AgentExtension: Run Budget** sets the limits. The defaults are 1,000,000 tokens, 30 minutes, and 200 tool calls. The agent receives the limits and bounded progress notices while it works. After a limit is reached, every tool except `review_changes` is refused, so staged work can still be reviewed. At 125% of the token or time limit, the run is cancelled.
- **Audit export.** Select **Export audit log** to save a redacted JSON export of this workspace's permission decisions and run summaries. In an enrolled workspace, use **AgentExtension: Sync Organization Audit** to upload retained events and view the last result. [Organization setup](#organization-policy-and-audit)
- **Completion checks.** If the agent stops with an unchecked draft, the host asks it once to finish missing work and check the draft. Commands still need approval. The panel shows when verification is incomplete. An empty response gets at most one continuation. A promise to do work without a draft gets one follow-up that preserves planning-only and no-edit requests. External writes prevent these automatic continuations. These checks do not prove that all requested behavior works.
- **Saved reports.** Select **Open saved run report** to open the latest report. After a restart, choose a saved report for the workspace. Reports link to exact checked draft patches, task state, tool timing, worker sessions, and requested browser screenshots. Progress records separate active work from waits for user input. Repeated reads and rejected tools are observed signals, not proven causes. They separate passed, failed, skipped, diagnostic-only, and stale checks. Empty interpreters, version probes, and help output are diagnostic only. The extension retains the latest 20 report folders per workspace.

Direct skill and connector selections last for the current extension-host session. Select them again after a restart. Workspace notes, exact plugin approvals, and approved schedules persist. A restart restores no one-time tool approvals. Changing skill roots, plugin roots, connector settings, or connector credentials cancels an active run.

Browser and computer selections also last for the extension-host session. Each run starts a fresh browser profile. Native access binds the selected process, launch time, bundle ID, and app path. Restarting the native app requires a new selection. Changing browser settings cancels an active run.

## Plugin packages and workflows

1. To share a plugin from a configured plugin root, run **AgentExtension: Export Plugin Package** from the Command Palette. Select the plugin and save the `.agentextension-plugin.json` file to a shared folder or send the file to the recipient.
2. In the receiving editor, select **Tools → Import plugin package**. Open the package and review the publisher label, version, capabilities, and content digest. Select **Import plugin**.
3. Select the plugin in the picker that opens and approve its version for this workspace. You can return to **Tools → Plugins** to change the selection. To upgrade a plugin, import the new package and approve its version again.
4. Type `/` in an empty prompt and choose a workflow. Review or edit its prompt before you start. Planning workflows wait for plan approval. Runs use the same access and change review as other agent runs.

The bundled plugins add `/review-team:research` and `/fix-team:fix-check` after you enable them. Add your question or the failing check to the workflow prompt.

The package uses the `agentextension-plugin/1` JSON format. It contains a manifest, declared skills, and text resources. The extension validates the package before making it available for approval. An invalid or cancelled import leaves the current version available. Use a unique plugin ID for packages. An installed package ID must differ from IDs in the bundled and configured plugin folders on the receiving editor. A publisher label comes from the manifest.

To try the workflow, save this manifest as `example-team/plugin.json` in a folder listed in **AgentExtension: Plugin Roots**. Each workflow has a unique lowercase ID, a title, and a single-line prompt of up to 1,000 characters. Set `planFirst` to `true` to require plan review. After you approve the plugin, you can use `agentextension.plugin.example-team.inspect` in a keybinding.

```json
{
  "schemaVersion": 1,
  "id": "example-team",
  "publisher": "Example Team",
  "version": "1.0.0",
  "description": "Workflows for reviewing repository changes.",
  "capabilities": [],
  "workflows": [
    {
      "id": "inspect",
      "title": "Inspect changed files",
      "prompt": "Summarize the changed source files and list applicable checks.",
      "planFirst": true
    }
  ]
}
```

## Browser and computer scope

Set browser origins in user settings. For example:

```json
"agentextension.browserOrigins": ["http://127.0.0.1:3000", "https://docs.example.com"]
```

An origin includes the scheme, hostname, and port. Wildcards, URL credentials, paths, and query strings are not accepted. HTTP is limited to loopback addresses. The default browser is installed Google Chrome. Set **AgentExtension: Browser Executable** to an absolute Chrome or Chromium executable path if needed. The extension does not use your normal browser profile, cookies, passwords, or open tabs.

The browser blocks redirects, extra windows, frames, browser-managed downloads, WebSockets, service workers, and requests outside the selected origins. Its page policy also limits resources and forms to the current origin. Open a redirect destination explicitly if it is in scope. These limits can prevent some sites from working. Browser inspection allows GET and HEAD requests. Use trusted origins because a remote service can attach side effects to a GET request. These controls apply at the application level. [Playwright request routing](https://playwright.dev/docs/api/class-browsercontext#browser-context-route)

The agent can call `browser_visit` to ask for one page outside the selected origins, such as documentation linked from an in-scope page. The approval dialog shows the exact URL and the agent's reason. After approval, the page and its resources from that origin can load with GET and HEAD. Access ends after five minutes or when the agent opens another page. Clicks, typing, uploads, downloads, form submissions, and redirects are blocked. A run allows three visits. Rules for `browser.navigate` can allow or deny visits to matching URLs.

Interaction requires a current observation. The host rechecks the snapshot after approval and rejects a changed target. A browser upload accepts one text file from the current workspace, up to 64,000 bytes. The dialog binds the file digest. A form submission or other non-read HTTP request has its own approval for the exact method, URL, and body digest. Unsolicited write requests are blocked. Password controls are not exposed for editing. Arbitrary scripts, selectors, keyboard shortcuts, and global coordinates are not agent tools.

In interaction mode, the agent can request one direct, same-origin text attachment from a visible link in the current page. The approval dialog shows the exact URL and a new workspace path. Choose `.txt`, `.md`, `.csv`, or `.json` to match the attachment's media type. A download can contain up to 64,000 bytes of UTF-8 text. The host ignores the server's filename and fetches without browser cookies. It stages the file for hunk review. The file is created after **Apply approved hunks**.

Native computer use is supported on macOS 13 or later. It uses a bundled accessibility helper. The helper checks the selected app instance, the observed window, and the addressed control. In interaction mode, the agent can request a press, enter text, or ask for one increment on a slider that exposes that action. The slider dialog shows its current value and range. Protected fields are excluded. Apps with no accessible window or controls are unsupported. The helper does not expose global screen capture, clipboard access, file browsing, or app launching. Native app actions can have effects beyond the editor workspace. Review each action before approval. [Apple accessibility actions](https://developer.apple.com/documentation/applicationservices/1462091-axuielementperformaction)

Each surface permits 30 operations per run. An operation stops after 90 seconds. Approval expires after 60 seconds. Browser observation returns up to 8,000 text characters and 60 controls. Native observation visits up to 100 nodes and 10 levels. A browser run permits 100 requests, 2 MB per response, and 16 MB of responses in total. Screenshots are limited to six per run and 250,000 bytes each. Workers do not inherit browser or native-app access.

Changes to remote sites and native apps take effect during the approved action. **Undo last apply** only applies to workspace edits. After you approve a surface action, or the host dispatches a native action, a model failure ends the run without automatic retry or fallback. Reports keep hashed action targets and outcomes. They omit typed values, upload contents, credentials, and command output. Exact draft patches and optional screenshots can contain source or page data, so review these files before sharing them.

## Usage, budgets, and the audit log

TrueForge reports input and output tokens for each model call. For parent calls, it also splits input into harness, instructions, messages, skills, and tool definitions. The extension adds parent, worker, and compaction usage into one run total. The panel and run report show the total, the usage for each actor, the latest parent input breakdown, and the number of compactions. Reports also show the latest completed main-thread compaction's duration, token usage, and threshold, plus counts of displayed sources recorded before and after the event. The public TrueForge API leaves per-source retention unknown.

The panel and saved reports show estimated cost in USD when TrueForge reports it. The estimate adds the parent and worker turn costs. Each turn cost already includes its compactions. If some observed turns lack cost data, the display marks the estimate as partial. A run without cost data shows **Unreported**.

Each permission decision and run summary is appended to a hash-chained log in extension storage, kept separately for each workspace. Each record includes a sequence number, the previous record's hash, and its own hash. The log keeps one archive file after it reaches 2 MB. Exports include a chain check. Workspace paths and targets are SHA-256 digests. Rule targets in reasons are replaced by digests. Arguments, file contents, command output, page text, connector payloads, and credentials are never recorded. Exports are written with mode 0600.

## Instruction profiles and path rules

Instruction sources are optional. Only the sources you set up or approve are used.

| Source | Where it lives | Limit | Used when |
| --- | --- | --- | --- |
| User profile | **AgentExtension: User Instructions**. This is an application setting, so workspace settings cannot set it. | 4,000 characters | It is set |
| Workspace profile | `.agentextension/instructions.md` and `AGENTS.md` | 8,000 characters total | You approve the exact files |
| Path rules | `.agentextension/rules/*.md`, with a `paths` list in frontmatter | 4,000 characters each, 12,000 total, 16 rules | You approve the exact files and a matching file is in context |

```markdown
---
paths:
  - "src/**/*.ts"
---
Prefer readonly arrays. Add a unit test next to the changed module.
```

`**` matches across folders. `*` and `?` match within one path segment. A path rule is added at run start when a matching file is in the selected context. Otherwise, it is added to the result of the first read or edit of a matching file. Each rule is sent at most once per run. Approval covers the digest of every workspace profile and rule file. Adding, changing, or removing one stops all workspace instructions until you approve them again. The host reads these files directly and refuses symlinks. The agent's file tools still cannot read hidden folders.

Instructions are labeled in the prompt and in **Context sources**. They cannot grant tools or change approvals. **Context sources** totals characters for each kind of source and estimates tokens at four characters per token. TrueForge reports token use by broad category, which the usage line shows, but not by each source in this list. Run reports record the agent definition version, the user profile digest, the workspace file digests, each path rule and whether it was sent, and the permission policy digest. To send instructions to a scheduled report, select their profiles when you approve that schedule.

## Permission rules

Rules decide whether a protected action runs without a prompt, asks first, or is refused. Each rule names an effect, a target with `*` wildcards, and a decision of `allow`, `ask`, or `deny`. If no rule matches, the action asks first.

| Effect | Target the rule matches | Decisions |
| --- | --- | --- |
| `command.execute` | Executable and arguments separated by spaces, for example `npm test` or `npm run *`. An empty argument or one containing whitespace, a quote or a backslash is written in JSON quotes, for example `node -e "console.log(1)"` | allow, ask, deny |
| `connector.read` | `connector-id/tool/target`, for example `docs/read_doc/manual` | allow, ask, deny |
| `connector.write` | `connector-id/tool/target`, for example `docs/update_label/manual` | ask, deny |
| `connector.account` | `connector-id/account-label` in the credential picker | ask, deny |
| `browser.write` | The request or page URL | allow, ask, deny |
| `browser.navigate` | The URL of a page outside the browser scope | allow, ask, deny |
| `browser.download` | The URL of a same-origin text attachment | ask, deny |
| `computer.write` | Deny and ask: the selected app's bundle ID. Allow: bundle ID, action, role and control label, for example `com.example.app press AXButton Save` | allow, ask, deny |
| `skill.read` | Use a skill name or `*`. An ask rule requires manual selection. | ask, deny |
| `worker.read` | Use a workspace-relative snapshot file or `*`. An ask or deny rule blocks the worker's extra read. | ask, deny |
| `hook.run` | Use `plugin-id/hook-id` or `*`. An ask or deny rule skips the hook. | ask, deny |
| `skill.script` | Use `skill-name/script-name` or `*`. Each call requires approval in the editor. | ask, deny |
| `connector.catalog`, `browser.observe`, `computer.observe`, `worker.research`, `worker.review`, `worker.diagnose`, `worker.edit`, `worker.custom`, `memory.suggest` | `*` turns the capability off. Other targets have no effect. | ask, deny |

Patterns such as `browser.*` and `*` can be used in ask and deny rules. **Always allow in this workspace** in a command prompt saves the exact command. It is not offered when the command contains `*`, because the saved rule would match other commands. Commands run against a copy of the workspace without network access, and cannot read your home folder or the real workspace, apart from toolchain folders on `PATH`. An allow rule must name an effect that supports `allow` above and a target other than `*`. Rules cannot affect workspace reads, draft edits, hunk review, plan approval, or apply. Those actions always use the editor's own controls.

Rules come from three sources:

1. **Administrator.** A JSON file at `/Library/Application Support/AgentExtension/policy.json` on macOS, `/etc/agentextension/policy.json` on Linux, or `%ProgramData%\AgentExtension\policy.json` on Windows. Set `AGENTEXTENSION_POLICY_FILE` to add another file. It does not replace the machine file.
2. **User.** **AgentExtension: Permission Rules** in user settings. This is an application setting, so workspace settings cannot set it.
3. **Workspace.** Saved from the panel or from a command approval. They are kept in extension storage for the canonical workspace, not in the repository.

```json
{
  "version": 1,
  "userAllowRules": false,
  "rules": [
    { "effect": "computer.*", "decision": "deny" },
    { "effect": "connector.read", "target": "crm/*", "decision": "ask" },
    { "effect": "command.execute", "target": "npm test", "decision": "allow" }
  ]
}
```

Administrator deny and ask rules are applied first. Then a deny from any source beats an ask, and an ask beats an allow. Set `userAllowRules` to `false` to ignore user and workspace allow rules. Their deny and ask rules still apply. The editor checks policy at run start and before protected actions. An unreadable or invalid administrator source blocks the action. When policy changes, the editor discards pending approvals and checks the current rule again.

The decision log shows the rule that allowed or denied each action. An allowed action is still checked against the exact draft revision and hunk scope. A scheduled report cannot satisfy an explicit ask rule because nobody is present, so it records that read as denied.

## Organization policy and audit

The organization service supplies administrator rules for enrolled workspaces and stores redacted audit events. The machine policy file controls enrollment. VS Code's built-in policy registry depends on a product mapping for extension settings. AgentExtension uses its own organization service for this integration. [Microsoft extension policy guidance](https://github.com/microsoft/vscode/blob/main/.github/skills/policy-and-managed-settings/extension-policy.md)

1. Compute the workspace key from its canonical folder path. Run this with Node.js and the workspace path as the last argument.

   ```sh
   node -e 'const fs=require("node:fs"); const crypto=require("node:crypto"); const root=fs.realpathSync(process.argv[1]); console.log(crypto.createHash("sha256").update(JSON.stringify(root)).digest("hex").slice(0,16))' /absolute/path/to/workspace
   ```

2. Give each editor installation a separate high-entropy bearer token. Store it in a private, owner-readable file on the device. Use mode `0600` on macOS and Linux. Set a private ACL on Windows. Store only the SHA-256 digest of the token text in the service configuration. Keep the same client ID when you rotate a token.
3. Add the workspace policy and scoped clients to a private service configuration. The following example authorizes an editor to submit audit events and an auditor to read the same workspace. Replace the token digests and workspace key.

   ```json
   {
     "clients": [
       {"id":"editor-1","tokenHash":"<writer token SHA-256>","workspaces":["0123456789abcdef"],"writeAudit":true},
       {"id":"audit-reader","tokenHash":"<reader token SHA-256>","workspaces":["0123456789abcdef"],"readAudit":true}
     ],
     "policies": {
       "0123456789abcdef": {
         "version": 1,
         "userAllowRules": false,
         "rules": [{"effect":"command.execute","target":"*","decision":"ask"}]
       }
     },
     "retentionDays": 30,
     "maxEvents": 10000
   }
   ```

4. Start a single service process with `node src/organization-service.js /absolute/service.json /absolute/collector-storage`. In a VSIX installation, use the packaged `src/organization-service.cjs`. The service binds to loopback on port 8788 by default. Put it behind the organization's HTTPS reverse proxy for remote access.
5. Add this enrollment object to the administrator policy file. Use the same workspace key and the absolute path to the device token.

   ```json
   {
     "version": 1,
     "rules": [],
     "organization": {
       "url": "https://agentextension.example.org",
       "tokenFile": "/absolute/private/path/to/token",
       "workspaces": ["0123456789abcdef"],
       "audit": true
     }
   }
   ```

The editor and background runner fetch the current organization policy for an enrolled workspace. The organization rules use administrator precedence. A malformed, offline, or unauthorized response blocks the next protected action. The next check uses fresh policy when the service is available again. Schedules that pin a policy pause for review if it changes.

Run **AgentExtension: Sync Organization Audit** and select **Sync retained redacted audit events** to upload the current workspace log. The editor verifies the local hash chain before sending it. Each upload keeps the original hashes and adds a hash over the redacted fields. The collector checks the redacted hash, chain order, and workspace key. It skips events it has already accepted, including after a lost response. The command records the last result locally and reports verification errors. A gap after local log rotation requires administrator review of the affected stream.

By default, the collector serves the newest 10,000 events from the last 30 days per workspace and installation. It applies retention on reads and writes and prunes stored files hourly. It retains the last sequence and hash after events expire so a retry cannot restore expired entries. Authorized auditors can read a page with `GET /v1/audit?workspace=<key>&client=<id>&after=<sequence>`. Each page contains up to 200 events. Writers and readers have separate permissions.

## Shared project pilot

Use the organization service to share notes, instructions, and prepared drafts between approved devices. Run a single service instance. For devices on separate hosts, expose it through your organization's HTTPS reverse proxy.

1. Enroll each device using its own credential and workspace key as described above. Create a policy entry for each device's workspace key. Add a `collaboration` block to the service configuration. The `device` values must match the IDs under `clients`. Give users a stable ID and assign either the `editor` or `viewer` role per device.

   ```json
   {
     "organization": "engineering",
     "projects": [
       {
         "id": "sample",
         "handoffs": true,
         "members": [
           {"user":"alice","device":"editor-1","workspace":"0123456789abcdef","role":"editor"},
           {"user":"sam","device":"editor-2","workspace":"fedcba9876543210","role":"editor"}
         ]
       }
     ]
   }
   ```

2. In each device's policy file, add a `projects` map inside the existing `organization` object. Use that device's workspace key as the key. Set its value to `{"organization":"engineering","project":"sample"}`. The checkouts can have different local paths.
3. Run **AgentExtension: Open Shared Project**. Viewers can read the published notes and instructions. Editors can open a text draft, edit it, then reopen the project picker to publish it. If another device published in the meantime, VS Code shows both versions and asks which one to keep. Publish empty text to clear a section.
4. To assign a draft, leave a saved workspace-wide checkpoint with staged changes. In **Open Shared Project**, select **Share a saved draft**, choose a device, and approve the file list. The recipient opens the assignment, confirms local review, and applies only the accepted hunks. Both devices must open the root of a Git checkout at the same commit and have matching contents for affected files.

The service stores the latest text in each shared section, with up to 8,000 characters per section. Published text is available through the project picker. Review it before you use it as model context or local instructions. Each project can hold up to 16 handoffs. A handoff contains a title, Git commit, file paths, base hashes, and staged text for up to 12 files, with a 128 KB request limit. Choose **Remove from project** to delete a shared draft. Private note sync is a separate action in **Notes**. Review staged text for secrets before sharing.

Assignments wait for the recipient to open them in VS Code. An assignment can open local hunk review and apply, with no agent, tool, or network access from the shared payload. The device contacts only the configured organization service for collaboration. Removing a device's membership or credential blocks its next project request. A review in progress checks access every four seconds. Apply makes a fresh access check before writing. An offline device can keep editing an open text draft and publish it when access returns.

Clients with `readAudit` and a project membership can use **View project audit**. The service records the user ID, device ID, operation, target identifier, and time for project changes. It keeps up to 500 visible entries per project within the configured audit retention window. Entries omit shared text and file paths.

### Sync workspace files

1. Set `"fileSync": true` on the project in the organization service configuration. Enroll each checkout with its own device credential. Use the same Git commit and a complete checkout on each device. For separate hosts, use the same HTTPS service origin and allow 2 MB request bodies through the reverse proxy.
2. Save the files you want to publish. In **Open Shared Project**, select **Publish workspace files**. Choose the files, review the diff, and confirm. All approved project members can read the files you publish.
3. On the other device, select **Review workspace file updates**. Choose the files, review the diff, and confirm. Save edited files after applying. An editor can publish updates. A viewer can review and apply shared files to their own checkout.

File sync scans the workspace for saved UTF-8 changes relative to Git. It supports additions, edits, deletions, and reversions to the Git base. A rename appears as a deletion and an addition. Files that change on both sides start unselected. Review the destination copy before choosing to replace it. A change to the reviewed files, Git base, shared snapshot, or device access stops the operation. Use Git for commits and history. File sync works on the working tree.

The scan covers tracked files and visible unignored new files. Hidden and protected paths, symlinks, binary files, and files over 32 KB are outside its scope. Save or discard unsaved edits before syncing a file. Each project stores up to eight Git bases. Each shared snapshot holds up to 256 changed files and 2 MB of data. The local scan covers up to 12,000 eligible paths and 16 MB of changed text and Git base text.

### Continue a TrueForge session on another device

1. Set `"sessionContinuations": true` on the project in the organization service configuration. Enroll both devices as editors with the same stable `user` ID and separate device credentials. Use the same HTTPS origin on separate hosts. Open both checkouts at the same Git commit and keep the base text for staged files identical.
2. On the sending device, finish a workspace run or keep its saved workspace checkpoint. Open **AgentExtension: Open Shared Project** and choose **Share a session continuation**. Select the receiving device and enter a title. Review the request, progress note, and staged text in the preview, then confirm.
3. On the receiving device, open the continuation by its title. Choose **Import to this device**. Review the contents, then confirm. Finish or discard any existing checkpoint first.
4. Select **Resume** to start a new session in the receiving device's local TrueForge. Approve protected actions there and review staged edits before applying them.

A continuation can carry the request, recent progress, and up to 12 staged text files. The full request to the project service must fit within 128 KB. The service stores the reviewed contents in plaintext and restricts access to the two enrolled devices. Select **Remove continuation** to delete the shared copy. Access expires seven days after sharing. The editor checks access at import, at resume, during the run, and before applying the draft.

The original TrueForge session, turn history, pending actions, credentials, and approvals stay on the original device. TrueForge chains native turns within the server that owns the session. [TrueForge sessions and turns](https://github.com/truefoundry/trueforge/blob/main/docs/api/use-agent.mdx)

### Sync personal preferences and workspace notes

1. Set `"memorySync": true` inside the service's `collaboration` block. Use a separate device credential for each device. In every project membership for those devices, assign the same stable `user` ID to the same person. To sync workspace notes, enroll both checkouts in the same project. Use HTTPS for devices on separate hosts.
2. Open a trusted enrolled workspace. In **Notes**, select **Sync personal preferences** or **Sync workspace notes**. Review the incoming changes and confirm the account and service shown in the dialog.
3. Repeat the sync on your other device. You can edit notes offline. Sync again after reconnecting to exchange the latest changes.

Preferences follow your account across enrolled projects in the organization. Workspace notes follow your account within one project. Other project members use their own copies. The organization service stores approved note text in plaintext on the server and requires an enrolled device credential to read it. Synced workspace notes include workspace-relative source references. Pending suggestions, local run IDs, and preference source paths stay on the device.

The first sync combines existing entries from both copies. Later syncs merge independent edits and carry across deletions. When both devices change the same note, including when one removes it, choose which version to keep. If the remote copy changes during review, open **Notes** and sync again. Each merged copy must fit the existing note limits.

Revoking a device stops its next sync. Notes already stored on that device remain available there. **Forget the sync link** clears the account link and merge history on the current device and keeps both copies of the notes.

## Scheduled reports

A scheduled report is a recurring read-only run. It can search and read workspace files and use the exact connector targets you approve. If you select a read-only repository worker, the report can ask it to inspect a bounded snapshot. Tool and token budgets include that work. To make a change, start an interactive run and use the usual approvals.

Approving a schedule pre-approves each connector read to a listed target, up to the run's read limit. The approval pins the canonical workspace, request, days, times, time zone, budget, catch-up window, connector configurations, credential digests, model, fallback model, and server URL. If any of these change, the next occurrence is blocked and recorded, and the schedule pauses. Select **Review and resume** to see the current scope and approve it again. **Run now** also requires a current approval. Approved workspace notes are included as reference data. Editing a note does not require a new schedule approval.

Use **Edit approved context** to add or remove the user instruction profile, approved workspace instructions, up to three skill bodies, or up to three approved read-only repository roles. Review the content digests before you approve. Each run checks selected versions and pauses the schedule when one changes or becomes unavailable. Skills supply the selected body text. Use **Edit approved context** to replace or remove a choice that is no longer available.

If the report needs an answer, it saves one question with up to five options, records the occurrence as **Needs answer**, and ends within its budget. Use **Review scheduled questions** in the Agent panel to choose an answer, type one, or dismiss the question. An answer starts a fresh interactive run with its own approvals. The question leaves the waiting list after you answer or dismiss it. Its original text remains in the saved report and run history.

Times are local wall-clock times in the schedule's IANA time zone. A day runs at most four times. Weekdays are evaluated in that time zone. If a clock change skips a scheduled time, the report runs when local time resumes. For example, 02:30 runs at 03:30. If a clock change repeats a time, the report runs only at its first occurrence. History records the local time, zone, and UTC instant.

| Budget preset | Run time | Tool calls | Connector reads | Model tokens | Catch-up window |
| --- | --- | --- | --- | --- | --- |
| Small | 2 minutes | 8 | 2 | 25,000 | 1 hour |
| Standard | 5 minutes | 20 | 5 | 100,000 | 6 hours |
| Large | 10 minutes | 40 | 10 | 250,000 | 24 hours |
| Standard, never catch up | 5 minutes | 20 | 5 | 100,000 | Only on-time runs |

After a run reaches its tool-call or connector-read limit, later calls fail and the model can still finish the report. The extension stops the run at its time limit or when TrueForge reports usage at or above its token limit. A model response can cross the limit before its usage arrives. The report shows the tokens reported by the provider, or **Unreported** if none arrived. Existing schedules use a 100,000-token limit and keep their approval. A workspace supports up to eight schedules.

By default, the editor checks schedules every 30 seconds while a trusted window has the workspace open. **AgentExtension: Scheduled Reports** controls this editor timer. A separately approved schedule uses the local background runner as its timer owner. Use that runner's controls to pause or revoke it while VS Code is closed.

| Condition | Result |
| --- | --- |
| The schedule's timer owner was unavailable | When the owner returns, only the latest missed occurrence can run. It must still be inside its catch-up window. Earlier occurrences are recorded as one **missed** entry with a count. |
| The catch-up window has passed | The occurrence is recorded as **missed** and does not run. |
| An interactive run or review is in progress | The occurrence waits until the editor is free. It must start inside its catch-up window, or it is recorded as missed. |
| TrueForge or the model endpoint is unreachable | The run is recorded as **offline**. A model failure can use the normal retry or fallback during the run. The scheduler does not retry the occurrence. |
| The workspace path or approved scope changed | The run is recorded as **blocked**, and the schedule pauses until you approve it again. |
| Two windows or runner processes see the same occurrence | A shared claim file lets one process run it. |

Each run saves a report with the other run reports. The report shows the schedule, the local and UTC scheduled times, the trigger, the outcome, the approved scope, and budget use. It also shows refused write-tool requests, the TrueForge session link, the fenced model output, and permission decisions with hashed targets. History keeps the latest 50 entries for each schedule. Select an entry to open its report. Schedules, history, and claim files are private to the local login. Schedule approvals contain digests of connector credentials.

### Run reports with VS Code closed

1. Open a schedule and select **Manage background runner**. Select **Allow this schedule to run in the background**. Leave the webhook field empty if you want reports in local history only.
2. Review the scope and approve it. For OAuth connectors, confirm the verified account and scopes shown in the dialog. Complete browser authorization with the same account. The issuer must issue a separate refresh token for each schedule. Include `offline_access` in the connector scopes when your issuer requires it. The runner uses saved files and the approved context. Keep the local TrueForge server running. [OpenID Connect offline access](https://openid.net/specs/openid-connect-core-1_0.html#OfflineAccess)
3. Open **Show runner setup**. Set the shell variables `RUNNER` and `STORAGE` to the paths shown. Use Node.js 22.14 or later on macOS or Linux. Run `node "$RUNNER" status "$STORAGE"` to find the schedule ID.
4. For a bearer-token connector, pass the exact token already approved in VS Code to the runner through standard input. Run `node "$RUNNER" token "$STORAGE" "$SCHEDULE_ID" "$CONNECTOR_ID"`. Use private input, such as redirecting from a protected file. The runner keeps a separate owner-only token file. OAuth browser authorization already provisions the runner. Tokenless connectors need no setup.
5. Run `node "$RUNNER" serve "$STORAGE"` in a separate terminal or configure a user service. Close VS Code when ready. Reopen the schedule's **View run history** to read completed reports and see notification status.

`tick` evaluates due schedules once. `run-now` starts a background schedule immediately and accepts its ID after the storage path. `pause` and `revoke` also accept the schedule ID. **Pause** stops further occurrences. **Revoke** also removes the runner's connector tokens for that schedule. To grant access again, approve it in VS Code. Stop a foreground `serve` process with Control+C.

The runner refreshes its own OAuth credential and saves rotating refresh tokens in a file readable only by your login. Refresh keeps the approval when the account and scopes stay the same. A rejected refresh or changed account or scopes pauses the schedule for review. Switching accounts or signing out in VS Code revokes the affected background approvals and deletes their local credentials. The issuer manages revocation of the grant on its own service. [OAuth refresh-token rotation](https://www.rfc-editor.org/rfc/rfc9700.html#name-refresh-token-protection)

The optional webhook receives a JSON POST with two fields, `outcome` and `report`. The report field contains a path relative to extension storage. Review the exact destination and payload preview before you approve. The runner saves the report first. A delivery error appears in history beside the run result. It leaves the saved report available.

For automatic starts at login, use a user service. On macOS, save a LaunchAgent property list under `~/Library/LaunchAgents/` with this structure. Replace all three example paths with the absolute paths for your login.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>org.agentextension.schedules</string>
  <key>ProgramArguments</key>
  <array>
    <string>/absolute/path/to/node</string>
    <string>/absolute/path/to/background-cli.cjs</string>
    <string>tick</string>
    <string>/absolute/path/to/extension-storage</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>30</integer>
</dict>
</plist>
```

Load the file with `launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/org.agentextension.schedules.plist"`. Stop the job with `launchctl bootout "gui/$(id -u)/org.agentextension.schedules"`. After an extension upgrade, update the runner path and review the new background approval before restarting the job. [Apple launchd documentation](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)

## Local plugin setup

Add parent folders to **AgentExtension: Plugin Roots**. Each child folder must contain `plugin.json`. Copy a plugin into a folder, then use **Tools → Plugins** to review and enable it.

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

Built-in worker roles are `repository-research`, `diff-review`, `test-diagnosis`, and `edit-proposal`. A plugin can also define up to three custom read-only roles:

```json
"roles": [
  { "name": "docs-check", "description": "Find documentation the code contradicts.", "instructions": "Compare the supplied docs and code.", "snapshot": "repository", "tools": [] }
],
"capabilities": ["worker.custom"]
```

A custom role gets the base worker rules followed by up to 2,000 characters of its own instructions. Set `snapshot` to `repository`, `diff`, or `check`. To let a repository role request more lines or literal search, set `tools` to `["read_file", "search_workspace"]` and add `worker.read` to the plugin capabilities. The parent must name the files when it calls `run_worker` and have workspace read access. The worker can make up to three total read and search requests against captured file contents. A changed source blocks extra access and marks its advice stale. Each file contributes up to 240 lines or 12,000 characters to the capture. Each read returns up to 40 lines or 1,800 characters. Approval pins the role and tools with the rest of the plugin.

Place each declared skill at `skills/<name>/SKILL.md`. Put text resources in the skill's `references/` or `assets/` folder. Capabilities must match the declared components. A connector reference names an existing read connector. Add `connector.read` to the capabilities and enable that connector separately. Each connector call still needs exact approval. The manifest supplies the publisher label.

Enable up to three plugins. The combined limit is three skills and 24,000 skill-body characters across direct selection and plugins. Each plugin allows at most 64 files and 128,000 bytes. The content digest pins the manifest, text files, and declared executable sources. The host checks the approved pin at run start, tool dispatch, worker completion, and apply.

Workers use the parent's selected model. Each run allows two concurrent workers and four worker calls in total, including parent retries. The default worker deadline is 60 seconds. Use **AgentExtension: Worker Timeout Seconds** to set it from 30 to 300. A report worker can return up to 8,000 characters. The first snapshot is capped at 16,000 characters before the digest. Repository research gets up to six excerpts. Diff review gets up to eight hunks. Failed-check snapshots can include one level of local imports. An invalid reply or a tool call outside the role can get one retry within the same deadline. The retry uses the original snapshot with an empty tool list.

Workers receive the task and selected snapshot. Extra reads require the role's tool and current parent scope. Cancellation stops active worker sessions and closes their reads. The extension checks citations against supplied lines. The parent assesses the findings and uses the normal review flow.

### Isolated skill scripts

Set `agentextension.scriptNodeExecutable` in VS Code user settings to the absolute path of an installed Node.js 22.13 or later executable. Use desktop VS Code on macOS or Linux with bubblewrap and unprivileged user namespaces. [Runtime requirements](#local-mcp-over-stdio)

Add a `scripts` list to the skill's YAML frontmatter. For example, `scripts: [format]` declares `scripts/format.cjs` in the skill folder. Declare up to four scripts per skill. For a plugin skill, include `skill.script` in the plugin's capabilities as well as `skill.read`.

Each file must be self-contained CommonJS and at most 8,000 bytes. Read one JSON object from standard input. Its `input` field contains the text approved in the editor, at most 8,000 bytes. Write the result to standard output.

```js
const { readFileSync } = require('node:fs');
const { input } = JSON.parse(readFileSync(0, 'utf8'));
console.log(input.trim());
```

Select or load the skill in an interactive run. Each call shows the script path, content digest, runtime, and exact input for approval. The agent receives the script's output as data.

### Built-in plugin hooks

Add the hook IDs to the manifest's `hooks` array and include `hook.run` in `capabilities`. **Tools → Plugins** shows each hook and its event before approval.

- `reject-conflict-markers` runs before **Apply**. It scans accepted hunk text only. It blocks apply if it finds possible conflict markers or exceeds 64 accepted hunks or 64,000 characters.
- `record-check-result` runs after an isolated check returns. It records the outcome and draft revision in the saved run report.

Each built-in hook has a 100 ms deadline and uses only event data supplied by the editor.

### Custom plugin hooks

Use `customHooks` to declare up to two custom hooks per plugin. Include `hook.run` in `capabilities`.

```json
"customHooks": [
  { "name": "validate-docs", "event": "before-apply" }
]
```

Put the script at `hooks/validate-docs.cjs`. Configure the same Node.js runtime as for skill scripts. The plugin approval lists the hook files and their events. A new package or changed source requires a new enablement approval.

- A `before-apply` hook receives `{ event, hunks }` on standard input. The `hunks` array contains only the accepted replacement text. It can hold up to 64 hunks and 64,000 characters. A failed hook stops apply and keeps the reviewed draft. Select **Cancel validation** to stop a running hook and keep the draft.
- An `after-check` hook receives `{ event, exitCode, revision }`. Its status appears in the saved report. A failed hook leaves the command outcome in the report.

Write one JSON object such as `{"ok":true,"message":"Validation passed."}` to standard output. Use `ok: false` to report failure. The message can contain up to 500 characters on one line. An explicit ask or deny policy skips the hook.

Skill scripts and custom hooks run in a temporary folder with a read-only copy of the script and bounded JSON on standard input. The runner blocks host network access, workspace and home file reads, file writes, and subprocesses. Each process has a five-second deadline and a combined 16,000-byte limit for standard output and standard error. Cancellation or a limit violation stops the process and removes its temporary files. These capabilities are available only in interactive editor runs.

## Read connector setup

Add a connector to `agentextension.readConnectors` in your user settings. A read tool accepts one top-level string argument that identifies the target. The connector uses Streamable HTTP.

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

Replace the example endpoint and tool contract with your server's values. The account is your local label for the credential. With a bearer token, the server controls the credential's actual account and access. Use a trusted server and review each tool before listing it under `tools`. The extension checks the configured tool, target, and arguments. Server annotations cannot widen that scope.

Use HTTPS for remote servers. You can use loopback HTTP for local servers. Store tokens from **Connector credential**. VS Code SecretStorage holds the credentials, and the extension redacts the access token if a tool echoes it. The HTTP client rejects redirects.

### Local MCP over stdio

Use a trusted, self-contained CommonJS server file with a `.cjs` extension. It can contain bundled dependencies and data. The file must be at most 2 MiB. Use an installed Node.js 22.13 or later executable that can run with system libraries alone. Local MCP runs in desktop VS Code on macOS or on Linux with bubblewrap and unprivileged user namespaces. [Node.js permissions](https://nodejs.org/download/release/latest-v22.x/docs/api/permissions.html) · [Bubblewrap requirements](https://github.com/containers/bubblewrap#bubblewrap)

Run `shasum -a 256 /absolute/path/server.cjs` on macOS or `sha256sum /absolute/path/server.cjs` on Linux. Copy the hash into your VS Code user settings and replace the example paths and tool contract.

```json
"agentextension.localReadConnectors": [
  {
    "id": "local-docs",
    "node": "/usr/local/bin/node",
    "entryPoint": "/absolute/path/server.cjs",
    "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
    "tools": [
      { "name": "read_document", "targetArgument": "document_id", "targets": ["project-guide"] }
    ]
  }
]
```

In a trusted workspace, open **Connectors** in the Agent panel and select the local connector. Use a different ID for each local or HTTP connector. Each call needs fresh approval for the server file, hash, runtime, tool, and exact argument. When you update the server file, review it, update the hash, and select the connector again.

The extension stages a read-only copy of the server file and starts one process for the approved call. It sends only the configured tool name and its one listed string argument. The process runs without access to workspace files, home files, network, or connector credentials. The extension stops it on cancellation, excessive output, or after 15 seconds. Local tools are available only in interactive editor runs.

### OAuth accounts

Add an `oauth` object with the exact `issuer`, the registered `clientId`, and the requested `scopes`. Include `openid` and the scopes the MCP server requires. Register a public desktop client with PKCE and a loopback redirect at `http://127.0.0.1:<port>/oauth/callback`. The extension selects an available port. The MCP server must advertise protected-resource metadata. The issuer must publish its authorization endpoint, token endpoint, and signing keys on its own origin.

Open **Connector credential**, choose the connector, and select **Sign in with OAuth**. Choose an account in the browser and confirm the verified account and scopes in VS Code. Configure distinct connector IDs and account labels to keep multiple accounts available. Choose **Switch OAuth account** to change a profile or **Sign out** to clear its local credentials. Refresh keeps the same approvals when the account and scope stay the same. Switching the account requires new approvals, including for schedules that use it.

### Approved writes

List each write under `writeTools`. Give it a `name`, `targetArgument`, and `targets` in the same format as a read. Set `extraArguments` to the names of any additional fields the agent can pass. Each additional value must be a string, number, or boolean. Use an OAuth account or bearer token for writes. Set `tools` to `[]` if the connector has only writes.

In an interactive run, review the server, account, tool, target, and full argument payload before approving a write. Every approval applies to one exact call. Scheduled reports expose read tools only. If a write times out or loses its response after dispatch, check the target before you retry. Writes take effect on the server outside the editor's draft and undo flow.

## Architecture

TrueForge owns the agent loop, model calls, tool discovery, and approval pauses. The VS Code extension creates sessions, consumes the event stream, and displays a link to the session. A shared host permission broker authorizes dispatch. A short-lived loopback MCP connector exposes search, line-range reads, draft edits, review, command execution, selected skill resources, approved connector calls, and enabled worker roles. Each worker uses a separate TrueForge session. The editor connector uses a per-run token. Remote connector credentials remain in the VS Code host.

Run start grants workspace reads and in-memory draft proposals. Plans, reviews, commands, connector calls, apply, and undo use exact host-issued approvals. One-time grants bind the canonical workspace, run, policy, tool, normalized arguments, target, and scope. Commands also bind the draft revision and hunk selection. Grants expire after five minutes. Dispatch consumes them once. Denial and revocation take precedence. Retry clears pending approvals. Model summaries cannot restore them.

The context pass uses identifier-aware BM25 ranking with path and exact-symbol matches. It packs bounded declaration and line excerpts without overlapping windows. Explicit mentions come first. VS Code's language services can add document and workspace symbols, definitions, and references. Provider results stay within the approved workspace and the excerpt budget. Text retrieval remains available when a provider is missing or slow. Agent mode reserves candidates for implementation, tests, and documentation. The panel shows selected paths, line ranges, and reasons. Retrieved excerpts use at most 12,000 characters in agent mode and 4,000 in inline mode. A smaller declared model context reduces that budget. Token counts are estimates. The request and inline selection use separate space. Each file read returns up to 5,000 characters of exact source text. A worker ranks initial excerpts.

Workspace search reads current disk files and overlays unsaved buffers and staged drafts. It supports literal, word, path, glob-filtered, and keyword queries. Bounded regex search is available when a supported ripgrep executable is found. Search returns source digests, page cursors, and coverage limits. A changed result set invalidates its cursor. Related-file lookup returns separately labelled import, test-name, and documentation hints. Search hints do not grant edit access; line edits still need current read receipts.

A private, rebuildable index reuses unchanged disk text between runs. It reconciles the file inventory, file metadata, and Git revision on each snapshot. Dirty buffer text stays in memory. The context details show indexed and unindexed counts. Use **AgentExtension: Clear Source Index** to remove the cache before the next run. The agent can batch up to four known excerpts with `read_files`. A batch returns at most 12,000 source characters and a separate edit receipt for each returned excerpt. Private-path exclusions and repeated-read limits still apply. Semantic retrieval is an evaluation-only experiment and is disabled in normal search. TrueForge preloads the search, read, proposal, review, and command tools, plus `suggest_note` and enabled worker tools. It defers the remaining tool schemas and can compact long turn histories.

Proposals stage exact-text replacements or line ranges in memory. A line proposal must use a recent read of that range. It can target a unique source line from the excerpt. A change to the same file invalidates the read. Inline edits are restricted to the original selection. Plan-first runs require plan approval before draft edits or commands. A separate TrueForge approval opens hunk review. Only the current reviewed revision can be applied. The extension checks the original text again before it applies the edits.

Commands require approval for the exact executable, arguments, draft revision, and hunk selection. They run without a shell or network in a temporary workspace copy on macOS or on Linux with bubblewrap. Checks before review use all staged hunks. Checks after review use the accepted hunks. Installed runtimes and dependencies remain accessible for reads. Commands time out after 30 seconds.

On an eligible model error the extension clears editor drafts and tries the configured fallback once. Without a fallback it retries the original model once after one second. Approval of a browser or native-app action, or dispatch of a connector write, disables automatic retry. A failed or cancelled run does not apply editor drafts. It does not reverse external actions. For slower local models, increase **AgentExtension: Turn Timeout Seconds**. If the local endpoint needs more time to generate a tool call, increase TrueForge’s `MODEL_HTTP_HEADERS_TIMEOUT_MS` and `MODEL_HTTP_BODY_TIMEOUT_MS` when you start it. If a model template rejects compacted history, clear **AgentExtension: Compaction** or switch models.

## Verify

- `npm run check` checks JavaScript syntax, checks types for permissions, policy, draft edits, and apply, and lints for unhandled promises in those modules and the schedule controller. Run `npm run typecheck` or `npm run lint` to run either check on its own. GitHub Actions runs the checks, tests, and VSIX build on Node.js 22.
- `npm test` checks context, edit scoping, hunk offsets, workspace boundaries, plugin pins, worker limits, schedule time zones, offline catch-up, and schedule storage. Without a test server, integration cases are skipped.
- `npm run test:qwen` runs seven scenarios against a real model through a running TrueForge server. The scenarios are edit and check, a question, a suggested note, instructions with a path rule, the fix workers, budget and audit, and a scheduled report. By default, it uses `local-lm-studio/qwen` at `http://127.0.0.1:8790`. If that provider is missing, it registers it from `trueforge/model.example.json`. It uses the model ID LM Studio lists, or a served Qwen 9B if the example ID is missing. Set `AGENTEXTENSION_TEST_MODEL`, `AGENTEXTENSION_TEST_MODEL_ID`, and `AGENTEXTENSION_TEST_FORGE_URL` to use other values. On macOS, double-click `scripts/test-qwen.command` to start TrueForge if needed, run the scenarios, and stop it afterwards. Set `AGENTEXTENSION_TEST_RESULTS_DIR` to write results outside `test-results`. Use `-- --only fix-team-workers` to check the worker merge and hunk review separately. Task requirements are mandatory. Only a complete outcome passes. Coding tasks must reach review, apply in a disposable copy, and pass independent acceptance checks. Missing model connections are recorded as environment-unavailable and fail the command. Run `npm run test:scoring` to test the scorer without a model. [Scoring contract](test/model/README.md)
- Set `AGENTEXTENSION_TEST_BROWSER` to a Chrome or Chromium executable to run the real-browser tests with `AGENTEXTENSION_TEST_SURFACES=1`. On Linux, use Xvfb and a non-root user, because Chromium's sandbox does not run as root. The native-app test runs only on macOS.
- The `test/extension-*.test.js` files load the extension in a stubbed VS Code host from `test/helpers/host.cjs` and drive it through webview messages and scripted dialogs. Most need the test server.
- With the test server set, `test/extension-schedules.test.js` loads the extension in a stubbed VS Code host. It creates and approves a schedule through the real commands. It waits for the extension timer to run the schedule through TrueForge, then checks the saved report and history. It also checks reapproval after a credential change.
- With TrueForge running as above, use `AGENTEXTENSION_TEST_FORGE_URL=http://127.0.0.1:8790 npm test` to check real sessions and approval with a local scripted endpoint.
- Follow the [Flask rehearsal](docs/demo.md) to verify the three fixed tasks.
- `npm run test:ui` runs the actual panel in a separate VS Code profile with a temporary workspace and a scripted model. Set `AGENTEXTENSION_TEST_FORGE_URL` first. The test uses the installed `playwright-core` package. Set `AGENTEXTENSION_PLAYWRIGHT_MODULE` to use a different installation. Set `AGENTEXTENSION_VSCODE_EXECUTABLE` if VS Code is outside the default macOS location. The test prints its evidence folder.
- Set `AGENTEXTENSION_VSIX` to the package path to test an installed VSIX. The harness checks its activated version, plugin updates, worker sessions, cancellation, hunk review, shared project handoff, and schedule approval, run history, and report opening.
- Set `AGENTEXTENSION_TEST_SURFACES=1` with the test server variable to include real Chrome and macOS app tests in `npm test`. The UI harness also uses Chrome and a temporary native test app. Building that fixture needs Xcode Command Line Tools. The helper binary is not committed. Run `npm run build:native` on macOS before running the extension or the native tests from source. `npm run package:vsix` on macOS always compiles it from `native/desktop.swift` for Apple Silicon and Intel; packages built on other platforms omit it, so native app access is unavailable in them. Local execution was tested on Apple Silicon.
- On macOS or Linux with bubblewrap, run `AGENTEXTENSION_TEST_LOCAL_MCP=1 node --test test/connector-local.test.js` to check the local launcher and tool scope. Set the test server variable to include the editor approval flow through TrueForge.
- On the same platforms, run `AGENTEXTENSION_TEST_SCRIPTS=1 node --test test/script-runner.test.js` to check script and hook isolation. Set the test server variable to include the editor approval and hook events.

The post-implementation run used Node.js 24.18.0, VS Code 1.146.0, and TrueForge 0.184.2 on Apple silicon macOS. The integration suite uses real TrueForge sessions and a scripted model endpoint. The targeted Qwen runs report model behavior separately. [Verification record](docs/milestones.md#post-implementation-verification) · [Remaining work](docs/remaining-work.md)

Initial indexing covers up to 20,000 permitted paths and 256 MB of source, with a 4.5-second preparation deadline. Fresh search has a 2-second deadline, a 20,000-path limit, a 256 MB byte budget, and at most 1,024 matches before paging. Both paths report incomplete coverage when a limit is reached. Files over 256 KB, hidden/private paths, and binary content remain excluded. Command snapshots cover up to 100,000 permitted files and 2 GB, including lockfiles. Exceeding a quota stops the check with a reason. Isolated commands run on macOS or on Linux with bubblewrap. The optional [Docker environment and managed checks](docs/managed-checks.md) install dependencies and run service-backed checks in a private container.

The current capability upgrade is local and unreleased. See the [platform matrix](docs/agent-capability-upgrade/PLATFORM-MATRIX.md), [comparison status](docs/evaluations/2026-11-23-status.md), and [progress tracker](docs/agent-capability-upgrade/PROGRESS.md) for verified scope and open gates.

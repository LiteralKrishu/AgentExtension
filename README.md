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

Run `npm run package:vsix` to build the bundled VSIX. Pass an output path after `--` to choose where to save it.

## Use the extension

- **Inline edit.** Select code. Press **Cmd+Alt+I** on macOS or **Ctrl+Alt+I** on Windows or Linux. Enter an instruction. The first hunk opens in a native VS Code diff.
- **Agent mode.** Open **AgentExtension** in the activity bar. Describe the change. Use `@file:src/path.py` or `@symbol:my_function` to add context. Put a path with spaces in quotes. Select **Run agent** to begin.
- **Interrupted runs.** Select **Resume** to restore a saved draft in a new session. The extension preserves independent file edits. If edits overlap, select **Review conflicts** to preview the alternatives and choose which changes to stage. The plan, hunk review, commands, and connector reads need approval again. Applying or discarding the draft clears the checkpoint.
- **Questions.** The agent can pause to ask a question with up to five options. The panel shows it under **Question from the agent**. Choose an option, type an answer, or select **Skip question**. Answers are sent as your input and do not approve any action. A run can ask up to five questions. Answered questions do not count toward the run's limit of 12 approval pauses. If the agent ends a turn with a plain-text question and nothing is staged, the extension asks it once to use the question panel or continue. Scheduled reports cannot ask questions.
- **Plan first.** Select **Plan first** to review a goal, steps, and proposed checks. Select **Approve plan and start** to allow draft edits. To change the request before edits, cancel and update the prompt.
- **Review.** Select **Preview file** to see the full file diff. Open an individual hunk with **Preview**. Choose **Accept** or **Reject** for each hunk. Select **Continue with decisions** to resume TrueForge. When the run completes, select **Apply approved hunks**.
- **Check accepted changes.** After review, rerun a recorded command in an isolated copy with the accepted hunks. Review the command approval and check status beside **Apply approved hunks**. A changed source file invalidates the result of a check still in progress.
- **Fix from Problems.** Open Quick Fix for a diagnostic and select **Fix with AgentExtension**. The run starts with the diagnostic's source location and asks for plan approval. Review the resulting hunks before applying them.
- **Review working-tree changes.** Select up to six changed files to review against Git HEAD. The read-only worker reports findings in the panel. Changes to the selected files during review mark the findings stale.
- **Verification.** If the agent requests a check, the approval dialog shows the executable, arguments, and draft scope. Expand **Verification** to see the command, its result, and its output. Results show when they cover an earlier draft or a different hunk selection.
- **Save and undo.** Apply edits existing files in editor buffers. Use **Save All** if Auto Save is off. New files are created at apply time. **Undo last apply** reverts the last batch if the current text still matches it. Save reverted buffers if needed.
- **Cancel.** Select **Cancel** in the panel or click the TrueForge status item. The extension discards the run's drafts. Use **Discard** to clear a completed review before apply.
- **Permissions.** Expand **Permissions and decisions** to inspect the current workspace scope and recent decisions. Select **Revoke run access** to cancel the run and invalidate its grants. The **AgentExtension permissions** output channel keeps a local decision log with hashed targets. It does not log source text, command arguments, or connector credentials.
- **Skills.** Select **Choose skills** to enable up to three text-only workflows for this workspace. The extension includes `focused-change`. Add local skill folders in **AgentExtension: Skill Roots**. Each folder must contain `skill-name/SKILL.md` directories. Only selected bodies and requested text resources enter the run. Scripts and permission declarations in skill files cannot grant tool access. When **AgentExtension: Automatic Skills** is on, which is the default, a run also loads up to two skills from approved roots whose name and description match the request. Matching uses at least two distinct terms and favors terms in the name and less common terms. Matched skills fill the remaining slots, up to three skills in total. Their bodies are limited to 12,000 characters, and all skills together to 24,000 characters. Skills with `disable-model-invocation: true` or `allow_implicit_invocation: false` are only loaded when you select them. The panel marks matched skills, and **Context sources** shows the terms and score. A rule that denies `skill.read` keeps all skill bodies out of the run.
- **Context.** Expand **Context sources** to see the instruction, request, selection, skill, repository, memory, and tool-result sources sent during the run. Each entry shows its origin, trust label, reason, and character count. This is a bounded history of submitted sources. It is not a token meter or a view of the model's retained context after compaction.
- **Notes.** Select **Notes** to add a workspace note or a user preference. Review it and select **Save note**. Workspace notes enter future runs for that workspace. User preferences enter runs in every workspace. Select a note to edit it in place, remove it, or open the source file it cites. Notes persist locally in extension storage. Keep credentials out of notes.
- **Suggested notes.** During a run, the agent can call `suggest_note` to propose a workspace note or user preference. It can cite up to five workspace files. Suggestions are kept in a separate list and never sent to a model. The panel shows how many are waiting for review. Choose **Review suggested notes** to save, edit and save, or discard each one. A run can make at most three suggestions, and at most 20 can wait for review. A rule that denies `memory.suggest` removes the tool.
- **Read connectors.** Configure a server, account label, named read tool, and allowed targets as described below. Select **Choose connectors** to enable it for this workspace. Use **Connector credential** to store or remove its bearer token in VS Code SecretStorage. Every read requires approval for the exact server, account, tool, and target.
- **Plugins.** Select **Manage plugins** to enable the bundled `review-team` or a local plugin. Review its version, publisher label, capabilities, source, and content digest. Enablement is saved for this workspace. A changed version, file, or referenced connector configuration requires approval again. Clear its checkbox to disable it.
- **Subagents.** With `review-team` enabled, ask the agent to research relevant repository files or review its draft. Under **Research and review workers**, open a task to see its source ranges, findings, state, and TrueForge session link. Diff reports become stale when the draft or accepted hunk selection changes. Findings are advice. Apply still requires your hunk decisions.
- **Fix workers.** Enable the bundled `fix-team` plugin to add three workers. `diagnose_failure` explains the latest failed check from its output and the files it cites. `propose_worker_edits` drafts edits to named files in a separate draft. The agent must merge those edits with `merge_worker_edits`. A merge is refused if the draft changed after the worker started or if an edit overlaps a change the agent already staged. Merged edits appear in hunk review like any other change. The plugin also defines a custom `docs-check` reviewer.
- **Browser inspection.** Add exact origins in **AgentExtension: Browser Origins**. Select **Browser access**, choose the origins, then choose observation or requests for actions. The extension starts a separate Chrome profile. It can read a page, list controls, and capture a small screenshot. Each click, text fill, upload, and outgoing write request needs approval.
- **Computer use.** On macOS, select **Computer access**, choose one running app, and choose observation or requests for actions. The extension reads its first accessible window. It can request a press or text fill on an observed control. Each action needs approval. macOS accessibility access must be enabled for VS Code.
- **Stop external access.** Select **Stop browser and computer** to close the browser and revoke native-app access. Editor work can continue. **Cancel** and **Revoke run access** stop the full run. Stopping access cannot reverse an action that already reached an app or server.
- **Instructions.** Set **AgentExtension: User Instructions** to add standing preferences to every run. To use repository instructions, add `.agentextension/instructions.md`, `AGENTS.md`, or path rules in `.agentextension/rules/`. Then select **Instructions** and approve them. Any change to those files requires a new approval.
- **Permission rules.** Select **Permission rules** to see the administrator, user, and workspace rules that apply. Add or remove workspace rules there. When you approve a command, choose **Always allow in this workspace** to save an exact allow rule for that command.
- **Scheduled reports.** Select **Scheduled reports** in the panel or run **AgentExtension: Manage Scheduled Reports**. Name the report, describe what it should cover, and choose days, times, an IANA time zone, optional connectors, and a budget. Review the summary and select **Approve schedule**. Scheduled runs are read-only and run while VS Code has the workspace open. Select a schedule to run it now, pause it, approve it again, view its history, or delete it.
- **Usage and budget.** The panel shows the tokens, tool calls, and time a run has used. Tokens include worker sessions and context compaction. **AgentExtension: Run Budget** sets the limits. The defaults are 1,000,000 tokens, 30 minutes, and 200 tool calls. After a limit is reached, every tool except `review_changes` is refused, so staged work can still be reviewed. At 125% of the token or time limit, the run is cancelled.
- **Audit export.** Select **Export audit log** to save a redacted JSON export of this workspace's permission decisions and run summaries. You can export all events or only the last 7 or 30 days.
- **Saved reports.** Select **Open saved run report** to open the latest report. After a restart, choose a saved report for the workspace. Reports link to exact checked draft patches, worker sessions, and requested browser screenshots. They separate passed, failed, skipped, and stale checks. The extension retains the latest 20 report folders per workspace.

Direct skill and connector selections last for the current extension-host session. Select them again after a restart. Workspace notes, exact plugin approvals, and approved schedules persist. A restart restores no one-time tool approvals. Changing skill roots, plugin roots, connector settings, or connector credentials cancels an active run.

Browser and computer selections also last for the extension-host session. Each run starts a fresh browser profile. Native access binds the selected process, launch time, bundle ID, and app path. Restarting the native app requires a new selection. Changing browser settings cancels an active run.

## Browser and computer scope

Set browser origins in user settings. For example:

```json
"agentextension.browserOrigins": ["http://127.0.0.1:3000", "https://docs.example.com"]
```

An origin includes the scheme, hostname, and port. Wildcards, URL credentials, paths, and query strings are not accepted. HTTP is limited to loopback addresses. The default browser is installed Google Chrome. Set **AgentExtension: Browser Executable** to an absolute Chrome or Chromium executable path if needed. The extension does not use your normal browser profile, cookies, passwords, or open tabs.

The browser blocks redirects, extra windows, frames, downloads, WebSockets, service workers, and requests outside the selected origins. Its page policy also limits resources and forms to the current origin. Open a redirect destination explicitly if it is in scope. These limits can prevent some sites from working. Browser inspection allows GET and HEAD requests. A remote service can still attach side effects to a GET request; use trusted origins. This is an application-level request policy, not a separate virtual machine or network firewall. [Playwright request routing](https://playwright.dev/docs/api/class-browsercontext#browser-context-route)

The agent can call `browser_visit` to ask for one page outside the selected origins, such as documentation linked from an in-scope page. The approval dialog shows the exact URL and the agent's reason. After approval, the page and its resources from that origin can load with GET and HEAD. Access ends after five minutes or when the agent opens another page. Clicks, typing, uploads, and form submissions on that page are blocked, and redirects stay blocked. A run allows three visits. Rules for `browser.navigate` can allow or deny visits to matching URLs.

Interaction requires a current observation. The host rechecks the snapshot after approval and rejects a changed target. A browser upload accepts one text file from the current workspace, up to 64,000 bytes. The dialog binds the file digest. A form submission or other non-read HTTP request has its own approval for the exact method, URL, and body digest. Unsolicited write requests are blocked. Password controls are not exposed for editing. Arbitrary scripts, selectors, keyboard shortcuts, and global coordinates are not agent tools.

Native computer use is supported on macOS 13 or later. It uses a bundled accessibility helper and checks the selected app instance before each observation and action. It targets accessible elements directly, so another app receiving keyboard focus does not redirect input. Protected fields are excluded. Apps with no accessible window or controls are unsupported. The helper does not expose global screen capture, clipboard access, file browsing, or app launching. Native app actions can have effects beyond the editor workspace. Review each action before approval. [Apple accessibility actions](https://developer.apple.com/documentation/applicationservices/1462091-axuielementperformaction)

Each surface permits 30 operations per run. An operation stops after 90 seconds. Approval expires after 60 seconds. Browser observation returns up to 8,000 text characters and 60 controls. Native observation visits up to 100 nodes and 10 levels. A browser run permits 100 requests, 2 MB per response, and 16 MB of responses in total. Screenshots are limited to six per run and 250,000 bytes each. Workers do not inherit browser or native-app access.

Browser and native changes occur when approved. They do not wait for **Apply approved hunks**, and **Undo last apply** cannot reverse them. After any external action approval, a model failure ends the run without automatic retry or fallback. Reports keep hashed action targets and outcomes. They omit typed values, upload contents, credentials, and command output. Exact draft patches and optional screenshots can contain source or page data, so review these files before sharing them.

## Usage, budgets, and the audit log

TrueForge reports input and output tokens for each model call. For parent calls, it also splits input into harness, instructions, messages, skills, and tool definitions. The extension adds parent, worker, and compaction usage into one run total. The panel and run report show the total, the usage for each actor, the latest parent input breakdown, and the number of compactions. TrueForge reports when compaction happens and how many tokens it uses. It does not report which messages survive compaction.

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

Instructions are labeled in the prompt and in **Context sources**. They cannot grant tools or change approvals. **Context sources** totals characters for each kind of source and estimates tokens at four characters per token. TrueForge reports token use by broad category, which the usage line shows, but not by each source in this list. Run reports record the agent definition version, the user profile digest, the workspace file digests, each path rule and whether it was sent, and the permission policy digest. Scheduled reports do not use instruction profiles.

## Permission rules

Rules decide whether a protected action runs without a prompt, asks first, or is refused. Each rule names an effect, a target with `*` wildcards, and a decision of `allow`, `ask`, or `deny`. If no rule matches, the action asks first.

| Effect | Target the rule matches | Decisions |
| --- | --- | --- |
| `command.execute` | Executable and arguments separated by spaces, for example `npm test` or `npm run *` | allow, ask, deny |
| `connector.read` | `connector-id/tool/target`, for example `docs/read_doc/manual` | allow, ask, deny |
| `browser.write` | The request or page URL | allow, ask, deny |
| `browser.navigate` | The URL of a page outside the browser scope | allow, ask, deny |
| `computer.write` | The selected app's bundle ID | allow, ask, deny |
| `connector.catalog`, `browser.observe`, `computer.observe`, `worker.research`, `worker.review`, `worker.diagnose`, `worker.edit`, `worker.custom`, `skill.read`, `memory.suggest` | `*` turns the capability off. Other targets have no effect. | ask, deny |

Patterns such as `browser.*` and `*` can be used in ask and deny rules. An allow rule must name an exact effect from the first four rows and a target other than `*`. Rules cannot affect workspace reads, draft edits, hunk review, plan approval, or apply. Those actions always use the editor's own controls.

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

Administrator deny and ask rules are applied first. Then a deny from any source beats an ask, and an ask beats an allow. Set `userAllowRules` to `false` to ignore user and workspace allow rules. Their deny and ask rules still apply. If an administrator file cannot be read or is invalid, runs and scheduled reports are blocked until it is fixed. The policy files are read when a run starts and when rules change. Rule changes apply to the next decision in an active run.

The decision log shows the rule that allowed or denied each action. An allowed action is still checked against the exact draft revision and hunk scope. A scheduled report cannot satisfy an explicit ask rule because nobody is present, so it records that read as denied.

## Scheduled reports

A scheduled report is a recurring read-only run. It can search and read workspace files. It can also read the exact targets of any connectors you selected for the schedule. Scheduled runs have no tools for draft edits, review, commands, browser or native-app access, skills, or subagents. TrueForge rejects calls to tools outside this set, and the report records each rejected write-tool request. To make a change, start an interactive run. Each change in that run requires its normal approval.

Approving a schedule pre-approves each connector read to a listed target, up to the run's read limit. The approval pins the canonical workspace, request, days, times, time zone, budget, catch-up window, connector configurations, credential digests, model, fallback model, and server URL. If any of these change, the next occurrence is blocked and recorded, and the schedule pauses. Select **Review and resume** to see the current scope and approve it again. **Run now** also requires a current approval. Approved workspace notes are included as reference data. Editing a note does not require a new schedule approval.

Times are local wall-clock times in the schedule's IANA time zone. A day runs at most four times. Weekdays are evaluated in that time zone. If a clock change skips a scheduled time, the report runs when local time resumes. For example, 02:30 runs at 03:30. If a clock change repeats a time, the report runs only at its first occurrence. History records the local time, zone, and UTC instant.

| Budget preset | Run time | Tool calls | Connector reads | Model tokens | Catch-up window |
| --- | --- | --- | --- | --- | --- |
| Small | 2 minutes | 8 | 2 | 25,000 | 1 hour |
| Standard | 5 minutes | 20 | 5 | 100,000 | 6 hours |
| Large | 10 minutes | 40 | 10 | 250,000 | 24 hours |
| Standard, never catch up | 5 minutes | 20 | 5 | 100,000 | Only on-time runs |

After a run reaches its tool-call or connector-read limit, later calls fail and the model can still finish the report. The extension stops the run at its time limit or when TrueForge reports usage at or above its token limit. A model response can cross the limit before its usage arrives. The report shows the tokens reported by the provider, or **Unreported** if none arrived. Existing schedules use a 100,000-token limit and keep their approval. A workspace supports up to eight schedules.

Schedules run only inside the VS Code extension host. The host checks schedules every 30 seconds while a trusted window has the workspace open. Turn off **AgentExtension: Scheduled Reports** to stop all schedules on this machine.

| Condition | Result |
| --- | --- |
| VS Code was closed, the device was asleep, or the workspace was not open | When the workspace opens again, only the latest missed occurrence runs. It must still be inside its catch-up window. Earlier occurrences are recorded as one **missed** entry with a count. |
| The catch-up window has passed | The occurrence is recorded as **missed** and does not run. |
| An interactive run or review is in progress | The occurrence waits until the editor is free. It must start inside its catch-up window, or it is recorded as missed. |
| TrueForge or the model endpoint is unreachable | The run is recorded as **offline**. A model failure can use the normal retry or fallback during the run. The scheduler does not retry the occurrence. |
| The workspace path or approved scope changed | The run is recorded as **blocked**, and the schedule pauses until you approve it again. |
| Two windows have the same workspace open | A claim file in extension storage lets only one window run each occurrence. |

Each run saves a report with the other run reports. The report shows the schedule, the local and UTC scheduled times, the trigger, the outcome, the approved scope, and budget use. It also shows refused write-tool requests, the TrueForge session link, the fenced model output, and permission decisions with hashed targets. History keeps the latest 50 entries for each schedule. Select an entry to open its report. Schedules, history, and claim files are stored in private files in the extension's global storage. Credentials are stored only as part of a SHA-256 approval digest.

TrueForge also has a server-side scheduler. AgentExtension does not use it. The editor connector and connector credentials exist only while the VS Code host runs.

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

Built-in worker roles are `repository-research`, `diff-review`, `test-diagnosis`, and `edit-proposal`. A plugin can also define up to three custom read-only roles:

```json
"roles": [
  { "name": "docs-check", "description": "Find documentation the code contradicts.", "instructions": "Compare the supplied docs and code.", "snapshot": "repository", "tools": [] }
],
"capabilities": ["worker.custom"]
```

A custom role gets the base worker rules followed by its own instructions, up to 2,000 characters. `snapshot` is `repository`, `diff`, or `check` and sets what the worker receives. `tools` must be an empty list because workers cannot call tools. The agent calls custom roles through `run_worker`. Approval pins the role definitions with the rest of the plugin.

Place each declared skill at `skills/<name>/SKILL.md`. Text references and assets can sit below that skill. Capabilities must match the declared components. Unknown fields, scripts, hooks, symlinks, and undeclared skills are rejected. A connector reference names an existing read connector. Add `connector.read` to its capabilities and enable that connector separately. Each connector call still needs exact approval. A publisher label is not a verified signature.

Enable up to three plugins. The combined limit is three skills and 24,000 skill-body characters across direct selection and plugins. Each plugin allows at most 64 files and 128,000 bytes. The full content digest pins the manifest and all permitted text files. The host checks the approved pin at run start, tool dispatch, worker completion, and apply.

Workers share the parent's selected model and can add model usage. Each run allows two concurrent workers and four worker calls in total, including parent retries. Each child has a 60-second deadline by default, one model iteration, and a requested output limit of 2,000 tokens. **AgentExtension: Worker Timeout Seconds** sets the deadline from 30 to 300 seconds; local models such as Qwen 3.5 9B need about 180. A child that calls a tool or returns output that fails validation gets one retry within the same deadline. Findings that cite lines outside the snapshot are dropped and counted. A failed-check snapshot also includes the local modules the cited files import, one level deep. The host also rejects output above 8,000 characters. Research gets up to six source excerpts. Diff review gets up to eight hunks from the current draft or accepted subset. Inputs are capped at 16,000 characters before the digest. Truncation and omitted hunks are shown.

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

The context pass ranks overlapping code windows with prompt keywords, rare terms, and path matches. Explicit mentions come first. VS Code's language services can add definitions and references for explicit symbols, the active editor symbol when it matches the request, and a selected diagnostic. Provider results stay within the approved workspace and the same excerpt budget. Keyword search supplies context when a provider returns no results. Agent mode reserves candidates for implementation, tests, and documentation. The panel shows selected paths, line ranges, and reasons. Retrieved excerpts have a 12,000-character budget in agent mode and a 4,000-character budget in inline mode. The request and the inline selection are separate from that budget. Each file read returns up to 5,000 characters of exact source text. A worker ranks excerpts and handles workspace searches. TrueForge preloads the search, read, proposal, review, and command tools, plus `suggest_note` and enabled worker tools. It defers the remaining tool schemas and can compact long turn histories.

Proposals stage exact-text replacements or line ranges in memory. A line proposal must use a recent read of that range. It can target a unique source line from the excerpt. A change to the same file invalidates the read. Inline edits are restricted to the original selection. Plan-first runs require plan approval before draft edits or commands. A separate TrueForge approval opens hunk review. Only the current reviewed revision can be applied. The extension checks the original text again before it applies the edits.

Commands require approval for the exact executable, arguments, draft revision, and hunk selection. They run without a shell or network in a temporary workspace copy on macOS or on Linux with bubblewrap. Checks before review use all staged hunks. Checks after review use the accepted hunks. Installed runtimes and dependencies remain accessible for reads. Commands time out after 30 seconds.

On a model error the extension clears editor drafts, then tries the configured fallback once if no external action was approved. Without a fallback it retries the original model once after one second. Approved browser or native-app actions disable this automatic retry. A failed or cancelled run does not apply editor drafts. It does not reverse external actions. For slower local models, increase **AgentExtension: Turn Timeout Seconds**. If the local endpoint needs more time to generate a tool call, increase TrueForge’s `MODEL_HTTP_HEADERS_TIMEOUT_MS` and `MODEL_HTTP_BODY_TIMEOUT_MS` when you start it. If a model template rejects compacted history, clear **AgentExtension: Compaction** or switch models.

## Verify

- `npm run check` checks JavaScript syntax, checks types for permissions, policy, draft edits, and apply, and lints for unhandled promises in those modules and the schedule controller. Run `npm run typecheck` or `npm run lint` to run either check on its own. GitHub Actions runs the checks, tests, and VSIX build on Node.js 22.
- `npm test` checks context, edit scoping, hunk offsets, workspace boundaries, plugin pins, worker limits, schedule time zones, offline catch-up, and schedule storage. Without a test server, integration cases are skipped.
- `npm run test:qwen` runs seven scenarios against a real model through a running TrueForge server. The scenarios are edit and check, a question, a suggested note, instructions with a path rule, the fix workers, budget and audit, and a scheduled report. By default, it uses `local-lm-studio/qwen` at `http://127.0.0.1:8790`. If that provider is missing, it registers it from `trueforge/model.example.json`. It uses the model ID LM Studio lists, or a served Qwen 9B if the example ID is missing. Set `AGENTEXTENSION_TEST_MODEL`, `AGENTEXTENSION_TEST_MODEL_ID`, and `AGENTEXTENSION_TEST_FORGE_URL` to use other values. On macOS, double-click `scripts/test-qwen.command` to start TrueForge if needed, run the scenarios, and stop it afterwards. Results are written to `test-results/model-latest.md` and a dated JSON file with transcripts. Each scenario reports required and optional checks. A miss reports how the model behaved and does not by itself mean the extension has a defect.
- Set `AGENTEXTENSION_TEST_BROWSER` to a Chrome or Chromium executable to run the real-browser tests with `AGENTEXTENSION_TEST_SURFACES=1`. On Linux, use Xvfb and a non-root user, because Chromium's sandbox does not run as root. The native-app test runs only on macOS.
- The `test/extension-*.test.js` files load the extension in a stubbed VS Code host from `test/helpers/host.cjs` and drive it through webview messages and scripted dialogs. Most need the test server.
- With the test server set, `test/extension-schedules.test.js` loads the extension in a stubbed VS Code host. It creates and approves a schedule through the real commands. It waits for the extension timer to run the schedule through TrueForge, then checks the saved report and history. It also checks reapproval after a credential change.
- With TrueForge running as above, use `AGENTEXTENSION_TEST_FORGE_URL=http://127.0.0.1:8790 npm test` to check real sessions and approval with a local scripted endpoint.
- Follow the [Flask rehearsal](docs/demo.md) to verify the three fixed tasks.
- `npm run test:ui` runs the actual panel in a separate VS Code profile with a temporary workspace and a scripted model. Set `AGENTEXTENSION_TEST_FORGE_URL` first. The test uses the installed `playwright-core` package. Set `AGENTEXTENSION_PLAYWRIGHT_MODULE` to use a different installation. Set `AGENTEXTENSION_VSCODE_EXECUTABLE` if VS Code is outside the default macOS location. The test prints its evidence folder.
- Set `AGENTEXTENSION_VSIX` to the package path to test an installed VSIX. The harness checks its activated version, plugin updates, worker sessions, cancellation, and the full review flow.
- Set `AGENTEXTENSION_TEST_SURFACES=1` with the test server variable to include real Chrome and macOS app tests in `npm test`. The UI harness also uses Chrome and a temporary native test app. Building that fixture needs Xcode Command Line Tools. Run `npm run build:native` on macOS when changing the bundled helper. The package includes the helper for Apple Silicon and Intel; local execution was tested on Apple Silicon.

See [milestone results and limits](docs/milestones.md) for the release verification record. The integration suite uses real TrueForge sessions and a deterministic model endpoint. It verifies orchestration and permissions. It does not establish task quality for a general coding model. The earlier live-model Flask Task B result remains unresolved.

The extension caps each keyword index pass at 12,000 candidate paths and 32 million characters. The same limits affect initial retrieval and search. Isolated commands run on macOS or on Linux with bubblewrap.

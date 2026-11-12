# Milestone implementation and verification

## Scope

Version 0.6.1 makes the redesigned sidebar the default. Version 0.6.0 added six editor and scheduling features. Version 0.5.0 added scoped browser inspection, native computer use on macOS, and saved run reports.

## Sidebar redesign in 0.6.1

The prompt stays at the bottom while the run and review scroll above it. Press **Enter** to run or **Shift+Enter** to add a line. Use **Plan first** to request a plan, **@ Context** to choose a workspace file or enter a symbol, and the model link to open settings.

Open **Workspace** to manage skills, notes, instructions, connectors, plugins, browser and computer access, permission rules, and reports. Expand **Run details** to see context sources, permission decisions, tool activity, check results, and worker findings.

The panel brings pending questions, plans, and proposed changes into view. The review shows how many changes need a decision and opens diffs in the editor. Cancel, revoke, and stop controls stay near the prompt while available. Apply still uses the approved changes, and Undo reverses the last apply when the editor contents match.

## Verification record for the sidebar redesign

The redesigned panel passed `npm run check` and all **128 regression tests**, with zero failures and zero skips. The suite used local TrueForge 0.184.2 with a scripted model, Chrome, and a temporary macOS test app.

The installed VSIX test checked the pinned prompt, keyboard submission, multiline input, file and symbol references, and context details. It also checked plan approval, native diff preview, rejection of a change, checks on the accepted draft, apply and undo, plugin approval, worker cancellation, and scoped browser and computer actions.

Install `AgentExtension-0.6.1.vsix` with **Extensions: Install from VSIX**. Run `npm run package:vsix` to build the package from source.

## First milestone

The broker now checks editor tools at dispatch. Exact approvals bind the run, workspace, tool, arguments, target, and draft scope. A grant expires after five minutes and is consumed once. Revocation, cancellation, and retry invalidate pending approvals. The host keeps decisions outside model context. The local permission log contains decisions and hashed targets. It excludes tool arguments and source content.

The skill registry indexes approved roots. Users select up to three workflows. Only selected bodies enter the prompt. A tool can read text resources from those selected skills. Symlinks, traversal, scripts, invalid metadata, and oversized files are rejected. Skill metadata cannot grant a capability.

The context panel shows the source type, origin, trust label, selection reason, and character count. It records sources submitted during a run. It does not claim to show the model's exact retained context after compaction.

On 9 November 2026, the first milestone passed 25 automated tests through TrueForge 0.184.2 with a scripted local model. A separate VS Code window passed skill selection, context display, plan approval, native file preview, accepted-hunk command checks, partial apply, undo, and revocation at the plan boundary. The UI test found a hunk object identity issue. Approval now compares complete hunk content, and a regression test covers it.

## Workspace memory and read connectors

Users can review and save notes for one canonical workspace. The store allows up to 20 notes, 2,000 characters per note, and 8,000 characters in total. The agent has no memory-write tool. Notes are reference data. They cannot grant permissions. Users can remove a note from the panel.

Users explicitly enable named MCP read tools for each workspace session. The configured server, account label, tool, and exact target define the read scope. The first version accepts one top-level string target argument. Extra arguments fail before authentication. Every call requires approval. A token change invalidates the approved action. The host checks scope before authentication, before each request, and after the result.

Bearer tokens use VS Code SecretStorage. They never enter the TrueForge connector manifest or model prompt. The client redacts a token echoed by the test server. Decision logs contain hashed targets and no payloads. Connector responses have a 512,000-byte transport limit and a 12,000-character text limit. Reads have a 30-second deadline. Redirects and OAuth discovery are disabled. Remote resource links are not followed.

The account field is a user-supplied label. The remote server determines the token's real account and privileges. The extension enforces the named tool and argument scope. It cannot prove that a remote tool has no side effects. Use a trusted service and a credential limited to reads.

## Verification record for 0.3.0

All 36 automated checks passed. The suite uses Node.js 24, TrueForge 0.184.2, the pinned SDK 0.184.1, and Playwright 1.62.1 for the panel test. The local model endpoint produces deterministic tool calls. It does not use a hosted model or private account data.

| Check | Result |
| --- | --- |
| Exact, expired, consumed, denied, revoked, and cross-workspace grants | Passed |
| Retry, model failure, fallback, stream cancellation, and review cancellation through TrueForge | Passed |
| Plan approval, partial hunk acceptance, file preview, accepted-hunk command, apply, and undo in VS Code | Passed |
| Selected skill body and requested reference through TrueForge | Passed |
| Skill metadata, path, symlink, size, disabled-state, and instruction-authority boundaries | Passed |
| Context panel sources for skills, notes, repository text, and tool results | Passed |
| Workspace memory persistence, separation, removal, and size limits | Passed |
| Credential storage, exact connector approval, and authenticated MCP read in VS Code | Passed |
| Revocation after authentication, credential rotation, and unlisted tool/target rejection | Passed |
| Credential echo redaction before model context and audit output | Passed |
| Full panel flow in a fresh VS Code profile | Passed |
| Installed 0.3.0 VSIX in a separate profile, including version and packaged source checks | Passed |

The UI harness is in `test/ui/run.cjs`. It creates its own profile, workspace, local provider, and authenticated MCP fixture. It writes a screenshot and `results.json` to the evidence folder printed by the test. Set `AGENTEXTENSION_VSIX` to test an installed package instead of the source checkout. The harness checks the activated extension version. It closes its test window and deletes its temporary provider when finished. Local evidence files remain for inspection.

These checks verified extension behavior in 0.3.0. Plugins and bounded workers were added in the next release below.

## Versioned plugins and bounded subagents

The plugin registry accepts a local `plugin.json` and declared text skills. The manifest records its schema version, ID, publisher label, version, components, and capabilities. It can reference existing read connectors and either of two fixed worker roles. It cannot define executable code, custom worker instructions, hooks, or new effects.

Install and enable are separate operations. The user selects a plugin in **Manage plugins** and reviews its scope. Approval binds the canonical source path, ID, publisher label, version, full content digest, capabilities, and referenced connector configuration digests. These pins persist per canonical workspace. The publisher label is not a signature. An update needs new approval even if it keeps the same version string. Connector references need separate enablement and exact approval for each call.

The host verifies pins at run start, before tool dispatch and approval, after each worker result, and before apply. Plugin skill resources come from the approved snapshot. A changed package stops dispatch. The context panel records each approved plugin version and digest. Disablement removes its worker tools from the next run. No automatic package downloads or archive imports are included.

The bundled `review-team` plugin provides the `review-workflow` skill and two read-only roles:

| Role | Input | Output |
| --- | --- | --- |
| Repository research | A focused question and up to six source excerpts from named files or workspace search | A summary and findings with source locations |
| Diff review | A question and up to eight hunks from the current staged draft or accepted subset | A summary and findings tied to the draft revision and hunk selection |

Each child uses a separate TrueForge session with the parent's current model. It receives only the question and snapshot. The host does not copy parent messages, saved notes, credentials, grants, selected skills, editor tools, or connector access into the child. The parent supplies the question, so this is an inheritance boundary, not a content redaction system. Source excerpts and questions still go to the configured model provider.

Each parent run permits two concurrent children and four calls in total. Retries do not reset that total. Each child has a 60-second deadline, one iteration, and a requested output limit of 2,000 tokens. Input JSON is limited to 16,000 characters before the digest. Output is limited to 8,000 characters, a 1,200-character summary, and eight findings. Truncated excerpts and omitted hunks are visible. Responses must match the report schema and cite a supplied source range.

TrueForge 0.184.2 exposes its built-in `get_current_datetime` tool even when the child has no configured MCP servers. Inspection of the pinned runtime showed that it returns the UTC time. The extension rejects a worker report if the child attempts any tool call, including this clock. The child has no editor, command, connector, memory, or recursive-worker capability. This boundary does not claim that the server exposes zero tool schemas.

The host cancels children when the parent is cancelled, retried, or fails. It waits for child cleanup at run end. A changed draft or accepted selection marks a completed diff report stale. Reports cannot merge changes, approve hunks, or write files. Conflicting advice leaves the parent draft and workspace intact. The existing parent review and apply gate remains in control.

## Verification record for 0.4.0

On 9 November 2026, syntax checks and all **51 automated tests** passed, with zero failures and zero skips. The suite used Node.js 24, TrueForge 0.184.2, and SDK 0.184.1. A separate VS Code profile passed the full interface flow using Playwright 1.62.1. The interface test found and fixed a local name collision in run setup.

| Check | Result |
| --- | --- |
| Existing permission, memory, skill, connector, draft, fallback, and cancellation checks | Passed |
| Plugin installation without enablement and workspace-specific persisted pins | Passed |
| Version and content changes invalidate old pins | Passed |
| Plugin update that adds diff review requires new approval in VS Code | Passed |
| Connector references require separate enablement and pin configuration changes | Passed |
| Invalid fields, effects, scripts, symlinks, paths, duplicate IDs, and changed resources | Rejected as expected |
| Child context excludes parent notes, credentials, skills, and MCP servers | Passed |
| Child tool-call attempt and excessive live output | Rejected as expected |
| Two concurrent workers, four-call budget across retries, and deadline cancellation | Passed |
| Real repository research and diff-review child sessions from the panel | Passed |
| Full-draft report becomes stale; new review covers only accepted hunks | Passed |
| Parent revocation stops two active child model calls; server turns are cancelled | Passed |
| Conflicting child advice cannot mutate the draft, approve it, or change disk | Passed |
| Native diff, partial acceptance, isolated command, apply, undo, and workspace note removal | Passed |
| Disabling a plugin removes worker tools from the next real model request | Passed |
| Installed 0.4.0 VSIX in a fresh profile, including activated version and packaged runtime comparison | Passed |

The panel flow made six real child model calls and two approved MCP reads. Its model endpoint was scripted. The test waited for both cancellation targets to reach that endpoint before revoking access. The live worker suite separately checked the cancelled state of both child turns on the TrueForge server. Test profiles and providers were isolated from the user's normal configuration.

The source run and installed-package run both passed. The installed run used evidence folder `agentextension-ui-VgZ7KQ`. The release includes `AgentExtension-0.4.0-results.json` and `AgentExtension-0.4.0-verified.png`. All 25 runtime, UI, skill, plugin, and agent-definition files matched the tested installation byte for byte. The package manifest also matched after excluding VS Code's installation metadata. The final package includes this updated verification record.

These results verify execution, limits, permissions, and the review flow. They do not establish general-model reasoning quality or prove that a reported finding is correct. No hosted model was configured for this milestone. The earlier live-model Flask Task B result remains unresolved. Browser control, schedules, plugin marketplaces, executable hooks, and write-capable subagents remain outside this release.

## Browser inspection, computer use, and durable reports

Version 0.5.0 adds the next browser and reporting milestone. It also adds the explicitly requested native computer control. Browser and native access are separate, opt-in capabilities. Plugin manifests and workers cannot grant or inherit either capability.

The user selects exact browser origins and an observation-only or interactive mode. A new run gets a separate Chrome profile. The host routes browser HTTP requests through an origin check and a bounded fetch. It blocks redirects, extra windows, frames, downloads, service workers, WebSockets, and requests outside scope. A page policy also restricts resources and forms to the current origin. These restrictions can prevent some sites from working. They implement an application request policy, not an operating-system network firewall.

Observation permits GET and HEAD requests. A service can attach side effects to a GET, so this mode is not proof that a remote service is read-only. Page text and screenshots remain untrusted data. A page cannot add an origin or grant a permission. Browser inspection returns bounded text and observed control IDs. A screenshot is optional. It is saved as evidence and can enter model context.

Each click, text fill, or workspace text-file upload needs approval. The approval binds the page URL, snapshot, target, action, arguments, and upload digest where applicable. The host checks the page and file again before dispatch. A resulting non-read HTTP request needs another approval for its method, URL, and body digest. A background write without an approved action is blocked. Protected fields and arbitrary scripts, selectors, or global input are not exposed as tools.

Native access binds one running app by process ID, kernel process-start time, bundle ID, and canonical app path. The bundled helper uses macOS accessibility APIs. It reads the first accessible window and targets its controls directly. It does not use global mouse or keyboard input. App identity and the complete observed snapshot are checked before approval and again before the action. A changed target fails closed. Protected controls are excluded. Apps without accessible controls are unsupported.

The helper is built for Apple Silicon and Intel Macs. Execution was verified on Apple Silicon. Native access requires macOS 13 or later and accessibility permission for VS Code. The helper does not expose app launching, clipboard access, file browsing, or global screen capture. Native actions can still cause the selected app to change files or remote data. The user must assess the exact requested action.

The visible **Stop browser and computer** control revokes these capabilities and closes the dedicated browser. Full cancellation also stops workers and editor activity. Neither operation reverses an external action that has already been dispatched. Once an external action is approved, model failure does not trigger automatic retry or fallback. This prevents automatic replay of an action that could already have succeeded.

| Bound | Value |
| --- | --- |
| Surface operations | 30 per surface per run; retries do not reset the count |
| Operation deadline | 90 seconds |
| Approval deadline | 60 seconds |
| Browser observation | 8,000 text characters and 60 controls |
| Native observation | Up to 100 visited nodes and 10 levels |
| Browser HTTP requests | 100 per run |
| Response budget | 2 MB per response and 16 MB per run |
| Workspace text upload | 64,000 bytes |
| Outgoing request body | 128,000 bytes |
| Screenshots | Six per run, at most 250,000 bytes each |

Run reports are stored locally under the extension's global storage, separated by canonical workspace identity. The extension retains 20 report folders per workspace. A report includes the final draft patch and full before/after contents of changed files. Each command check has its own exact patch, changed-file snapshot, revision, hunk scope, and content digest. Report freshness compares content as well as revision and hunk selection. A reused revision after a retry cannot make an old check appear current.

Reports distinguish passed, failed, skipped, and stale checks. They link to TrueForge sessions and optional browser evidence. They record hashed surface targets and operation outcomes. They omit typed values, upload bodies, credentials, and command output from the activity log. The source snapshots and screenshots can contain private workspace or page data. They need review before sharing. Apply and undo update the report's editor outcome. Saved reports can be reopened after an extension restart.

## Verification record for 0.5.0

On 9 November 2026, all **61 automated tests** passed with zero failures and zero skips. The suite used real TrueForge 0.184.2 sessions, SDK 0.184.1, Playwright Core 1.62.1, installed Chrome, and a temporary native macOS test app. The model endpoint was scripted. No hosted model or private service account was used.

| Check | Result |
| --- | --- |
| Existing permissions, connectors, skills, memory, plugins, workers, review, fallback, and undo tests | Passed |
| Wildcard, credential-bearing, path-scoped, remote HTTP, and unsupported browser URLs | Rejected |
| Page-injected background writes, external frames, WebSockets, and redirects | Blocked before reaching the fixture endpoint |
| Real browser text inspection and bounded screenshot | Passed |
| Exact approval for text fill, click, form POST, and workspace text-file upload | Passed |
| Denied or stale browser actions | No write reached the fixture server |
| Real native observation, protected fields, approved fill and press | Passed |
| App-instance mismatch, stale native target, denial, and cancellation | Rejected or stopped as expected |
| Permission change or revocation while approval is pending | No action dispatched |
| Model failure after external approval | No automatic retry or fallback |
| Durable reports with exact checked patches and full changed-file snapshots | Passed |
| Passed, failed, skipped, stale, and reused-revision report outcomes | Passed |
| Complete VS Code flow with browser-origin and native-app selection | Passed |
| Five separate interface approvals for browser fill, click, POST, native fill, and native press | Passed |
| Stop during browser navigation, blocked native read after stop, and disabled tools on the next run | Passed |
| Installed 0.5.0 VSIX, bundled native helper, activated version, and runtime-file comparison | Passed |

The source interface run used evidence folder `agentextension-ui-ow4euA`. It verified one approved browser write, zero outside-scope requests, two native actions, six worker calls, and two approved MCP reads. It also checked plan approval, native diff, accepted-hunk command checks, apply, undo, report opening, plugin reapproval, worker cancellation, and note removal. Only temporary browser profiles and the fixture app received test actions.

The installed-package run repeated the same flow in a fresh profile and passed. Its evidence folder is `agentextension-ui-FHbdzw`. All 31 runtime, UI, skill, plugin, agent-definition, and native-helper files matched the tested installation byte for byte. The manifest matched after excluding VS Code's installation metadata. The release includes `AgentExtension-0.5.0-results.json`, editor and surface screenshots, and copies of the checked-draft and scoped-access reports. The final package includes this verification record.

The tests found a browser navigation timing issue and a native snapshot change caused by empty window-layout nodes. Navigation now waits for completion. Empty, non-actionable layout groups are omitted from the semantic result. The native identity check uses the kernel process-start value, including for apps whose launch metadata is unavailable.

These checks verify the extension's execution and permission boundaries. They do not establish general-model task quality, native support for every application, or compatibility with every website. The earlier live-model Flask Task B result remains unresolved. Scheduling, remote control, arbitrary desktop coordinates, general file uploads, browser downloads, and executable plugin hooks are outside this release.

## Scheduled read-only reports

This milestone introduced recurring read-only runs after 0.5.0. It ships in 0.6.0.

A user creates a schedule from **Scheduled reports** in the panel. The schedule includes a name, request, days, up to four daily times, an IANA time zone, optional read connectors, and a budget preset. A modal shows the workspace, cadence, next run, data sent to the model, budget, offline behavior, and the reads available to unattended runs. Approval stores a SHA-256 pin of the canonical workspace, the normalized schedule, the selected connector configurations, credential digests, model, fallback model, and server URL. Up to eight schedules can be stored for each workspace.

Before each run, the extension computes the pin again. If the pin changed, the extension records the occurrence as **blocked** and pauses the schedule. **Review and resume** shows the current scope and requires a new approval. **Run now** also requires the current pin. Approved workspace notes enter scheduled runs as reference data. They are not part of the pin.

Each scheduled run creates a new permission broker. It has the `workspace.read` scope and, when connectors are selected, the `connector.catalog` scope. The schedule approval is the only approval in force. It covers `connector_read` for targets already listed in the approved connector configuration, up to the run's read limit. The broker records each grant as a standing schedule approval. TrueForge receives only `search_workspace`, `read_file`, `list_connector_tools`, and `connector_read`. The editor bridge registers only those tools for the run. It rejects any call that is not read-only before dispatch. The run has no draft edit, review, command, plan, skill, worker, browser, or native-app tools. TrueForge still exposes its deferred `call_tool` helper. That helper rejects tools outside the run's allowlist. The report counts each rejected write-tool request. Any change must be made in a separate interactive run with its usual approvals.

| Bound | Value |
| --- | --- |
| Schedules per workspace | 8 |
| Times per day | 4 |
| Run time | 1 to 10 minutes |
| Tool calls | 1 to 40 per run, counted at the editor bridge |
| Connector reads | 0 to 10 per run, checked at approval and dispatch |
| TrueForge turns | Connector-read limit plus 3 |
| Catch-up window | 0 to 1,440 minutes. The minimum is two minutes so an on-time evaluation is not missed. |
| History | 50 entries per schedule |

Occurrences are computed in the schedule's time zone. The time conversion uses the `compatible` rule. If a clock change skips a wall time, the report runs after the gap. If a clock change repeats a wall time, the report runs only at the earlier instant. The scheduler checks schedules every 30 seconds while a trusted window has the workspace open. It advances the schedule cursor before a run starts, so a restart cannot repeat that occurrence. After downtime, only the latest occurrence inside the catch-up window runs. Earlier occurrences are recorded as one **missed** entry with a count. If downtime exceeds 35 days, only the last 35 days are counted, and the entry marks the count as a minimum. An interactive run delays the occurrence within the catch-up window. A claim file created with an exclusive open lets only one window run an occurrence. An unreachable server or model endpoint is recorded as **offline**. The scheduler does not retry the occurrence.

Each run saves its report with the other run reports for the workspace. The report records the local and UTC scheduled times, trigger, outcome, approved scope, and approval digest. It also records budget use, refused write-tool requests, the TrueForge session, and permission decisions with hashed targets. Model output is placed in a fence longer than any tilde sequence it contains. Schedules, history, and claims use files with mode 0600 in global storage. They store no credentials.

TrueForge 0.184.2 starts its own schedule dispatcher. AgentExtension keeps scheduling in the VS Code host because the editor connector, connector credentials, and permission broker exist only there.

## Verification record for scheduled reports

On 11 November 2026, `npm run check` passed. Two consecutive full runs of `AGENTEXTENSION_TEST_FORGE_URL=http://127.0.0.1:8790 npm test` passed **74 of 78 tests**, with no failures. The four skipped tests are the existing Chrome and macOS surface tests, which need `AGENTEXTENSION_TEST_SURFACES=1` on a Mac. This milestone added 17 tests. The run used a Linux cloud workspace with Node.js 22.23.4, `@truefoundry/trueforge@0.184.2` from npm, SDK 0.184.1, and a scripted model endpoint. The 57 existing non-surface tests also passed on this baseline before the change.

| Check | Result |
| --- | --- |
| IANA conversion for Asia/Kolkata, New York, London, and Lord Howe, including skipped, repeated, and half-hour clock changes | Passed |
| Days evaluated in the schedule zone, including a Monday 00:30 IST run that is Sunday in UTC | Passed |
| One run on the New York spring-forward and fall-back nights | Passed |
| Input limits, unknown fields, invalid zones, and approval pin changes for each pinned input | Passed |
| Private store files, workspace separation, eight-schedule limit, history trimming, and tamper filtering | Passed |
| On-time run, no repeat after restart, missed-occurrence catch-up, expired window, busy editor, and two-window claim | Passed |
| Changed scope recorded as blocked and paused; offline occurrence not retried; paused schedule not run | Passed |
| Read-only approval refusal for plans, reviews, commands, and writes; tool and read budgets | Passed |
| Read-only editor bridge exposes only read tools and enforces the tool budget | Passed |
| Real TrueForge scheduled run with search, file read, standing connector read, and credential redaction | Passed |
| Deferred `propose_write` and `run_command` calls rejected by TrueForge, counted in the report, and kept off disk | Passed |
| Tool budget, connector-read budget of zero, and unlisted connector target stopped without a connector call | Passed |
| Widened connector targets blocked the next run; unreachable TrueForge recorded as offline | Passed |
| Extension commands in a stubbed VS Code host: create, approve, timer run, report, notification, credential rotation refusal, reapproval, manual run, history, and setting off | Passed |

The extension test loads `src/extension.js` with a stub of the `vscode` module. It answers quick picks and modal dialogs with scripted responses. It then creates a schedule for the next UTC minute. The extension's own 30-second timer runs that schedule through real TrueForge sessions, the loopback editor bridge, the MCP read fixture, and report storage.

The Playwright interface harness in `test/ui/run.cjs` was not run for this milestone, and it does not cover the scheduled-report controls. It needs VS Code, Chrome, and the macOS app fixture. VS Code could not be downloaded in the cloud workspace. The new panel button, summary line, and webview rendering have not been tested in a real VS Code window. These checks cover orchestration, scope, and timing behavior. They do not establish the quality of reports from a general model.

## Permission rules

This milestone adds allow, ask, and deny rules on top of the permission broker. `src/policy.js` validates rules and loads administrator policy files. It then decides each governed action. The broker uses its `allowScope` method to turn off capabilities that a deny rule covers for every target. The approval paths for commands, connector reads, browser actions, and native-app actions call `decide` before showing a dialog. An allow decision grants the exact action and records the matching rule. A deny decision records the rule and returns no approval. An ask decision shows the existing dialog. It also reports when a rule required the prompt.

Precedence is fixed: administrator deny, administrator ask, any deny, any ask, then allow. Administrator files are read from a fixed machine path. An optional environment variable can add another file, but it never removes the machine file. An invalid administrator file blocks runs. User rules use an application-scoped setting. Workspace rules are stored in extension global state, keyed by the canonical workspace. A cloned repository therefore cannot add rules through `.vscode/settings.json`. Allow rules are limited to command, connector-read, browser-write, and computer-write actions with a specific target. Rules cannot replace workspace reads, draft edits, hunk review, plan approval, or apply.

## Automatic skill matching

`SkillRegistry.match` compares the request with each eligible skill's name and description. It does not read skill bodies for matching. Terms are lowercased and lightly stemmed, and common words are removed. A term in the name has three times the weight of a term in the description. Each weight is multiplied by an inverse-frequency factor across the catalog. A skill needs a score of at least 2.5 and two distinct matching terms. `addMatched` loads matches after manual and plugin skills. It loads at most two matches and 12,000 matched body characters. The existing limit of three skills and 24,000 characters still applies. A skill that changed after discovery is skipped. Explicit-only skills are never matched. **Context sources** labels matched skills as `matched workflow` and shows the terms and score. `agentextension.automaticSkills` turns matching off. A `skill.read` deny rule removes manual, plugin, and matched skill bodies.

## Instruction profiles and path rules

`src/instructions.js` adds three optional instruction sources. The user profile comes from an application-scoped setting. The workspace profile comes from `.agentextension/instructions.md` and `AGENTS.md`. Path rules come from `.agentextension/rules/*.md` and require a `paths` frontmatter list. Workspace files are used only after the user approves the digest of the complete set. Any change to that set marks the instructions as pending, and the run omits them. The host reads these files with `O_NOFOLLOW` and refuses symlinks. The workspace file tools still exclude hidden folders. Path rules that match the initial context are added to the prompt. Other matching rules are added to the first `read_file`, `propose_write`, `propose_lines`, or `create_file` result for a matching path. Each rule is delivered once per run.

`ContextManifest.totals` groups submitted characters by source kind. The panel shows each total with a token estimate of four characters per token. Run reports now include an **Instructions** section and the permission-policy digest. Showing what survives compaction remains open, because TrueForge does not report it.

## Notes, preferences, and suggested notes

`src/memory.js` uses a shared `NoteStore` for approved notes. Notes can be edited in place, and each note keeps its ID and a `source` record. There are two approved stores: workspace notes keyed by the canonical workspace, with up to 20 notes and 8,000 characters, and user preferences shared across workspaces, with up to 10 notes and 4,000 characters. Agent suggestions use a third store, `SuggestedNotes`. Suggestions in that store are never sent to a model. The `suggest_note` editor tool adds a suggestion, which the user can then approve. It requires the `memory.suggest` scope. Each run can make three suggestions. Each suggestion can cite up to five references, and `safePath` and a workspace read validate each one. Approval moves the text, either as suggested or after an edit, into the selected store. The source record includes the run ID and references. The prompt labels user preferences and workspace memory separately and includes cited sources. **Context sources** shows whether each note was added by the user or suggested by the agent.

## Diagnosis, edit-proposal, and custom workers

`src/workers.js` now has four built-in roles. `test-diagnosis` receives the latest failed check, including the last 4,000 characters of its output. It also gets up to six excerpts from files the parent names or the output cites. Command output now shows workspace-relative paths instead of the temporary snapshot folder. `edit-proposal` receives the current draft text of up to six named files, each up to 6,000 characters. It returns `{summary, edits[]}`. Each `old_text` must occur exactly once in a supplied file. The host applies the edits to a separate `Draft` and returns the hunks. `merge_worker_edits` is the only path into the parent draft. It requires the same draft revision and file digests as the snapshot. It rejects any edit whose range overlaps a staged parent hunk. It applies all edits to a trial copy before it changes the parent draft. A proposal becomes stale when the parent draft changes. Merged hunks go through normal user review.

Plugins can declare custom roles with a name, description, instructions, a `repository`, `diff`, or `check` snapshot, and an empty `tools` list. They require the `worker.custom` capability. The worker session adds the role instructions after the fixed worker rules. The bundled `fix-team` plugin enables `test-diagnosis`, `edit-proposal`, a `docs-check` custom role, and a `fix-workflow` skill. The existing limits still apply: two concurrent workers, four calls per run, a 60-second deadline, and one model iteration per worker.

## One approved visit outside the browser scope

`ScopedBrowser.visitOnce`, exposed as the `browser_visit` tool, asks for one visit to an exact HTTPS or loopback URL outside the selected origins. The approval uses the `browser.navigate` effect, so permission rules can allow or deny matching URLs. After approval, `allowed()` accepts that origin only for GET and HEAD requests. Access lasts up to five minutes or until the next `browser_open` call. `act()` refuses any page on a visited origin, and non-GET routing checks the origin with `write: true`. Redirects, frames, extra windows, and the request and response limits are unchanged. A run allows three visits.

The real-browser tests now accept `AGENTEXTENSION_TEST_BROWSER` as a Chrome or Chromium executable path. They ran on Linux with Playwright's Chromium, Xvfb, and the Chromium sandbox enabled. Chromium's sandbox does not run as root, so the tests ran as a non-root user. The native-app test is skipped on platforms other than macOS.

## Run budget and audit export

`src/usage.js` tracks tokens, tool calls, and time across a run. Parent usage comes from merged `model.message` events. Worker usage comes from each worker session's messages. Compaction usage comes from `thread.context_compaction_finished` events. The bridge calls `usage.tool()` before each editor tool, and `review_changes` remains available after a limit is reached. Reaching 125% of the token or time limit cancels the run through the existing cancel path. The limits come from `agentextension.runBudget`, an application-scoped setting.

`src/audit.js` appends broker decisions and a run summary for each run to a hash-chained JSONL file for each workspace. The log keeps one archive after rotation. `AuditLog.verify` checks each record's hash, `prev` link, and sequence. `export` filters by date, redacts rule targets in reasons, and reports the verification result. The output channel still receives each decision.

This replaces the earlier note that the runtime could not report tokens. TrueForge 0.184.2 reports usage on model messages and compaction events. It still does not report which messages survive compaction.

## Questions during a run

Interactive runs enable TrueForge's built-in `ask_user_question` client tool by setting `askUserQuestions.enabled`. Scheduled runs keep it off. When the model asks, the turn ends with a `tool.response_required` action. `runForge` handles that action separately from `tool.approval_required`. It calls `ui.question` and resumes with a `user.tool_response` that contains `{answered, option?, text?}`. Any other client tool ends the run. Questions are limited to 500 characters and five options of 160 characters each. Answers are limited to 2,000 characters, and each run can ask five questions. A skip or the limit returns a note that tells the agent to proceed on a stated assumption. The panel uses a separate `question` phase. Cancel resolves a waiting question. Each question is logged with a hashed target and an `answer` or `skip` decision. Answers appear in **Context sources** as `user answer`.

## Run checkpoints and recovery

`src/checkpoint.js` stores one checkpoint for each workspace in extension storage, with mode 0600 and an atomic rename. A checkpoint records the request, the plan-first flag, the approved plan, the draft revision, and each staged file's base, base digest, and text. It also records command checks without output, the review state, the last 2,000 characters of agent text, and the phase. It holds no grants. The run saves a checkpoint at start, on each tool call, draft change, and review, and while a question waits. A reviewed result is kept as a `ready` checkpoint until the user applies or discards it. A run that ends normally clears its checkpoint, and so does a user cancel. A run that stops for any other reason keeps the last saved checkpoint with phase `interrupted`. The runtime resets the draft after a failed attempt, so the last saved checkpoint is used. Inline edits are not saved, and checkpoints expire after seven days.

The initial recovery flow required the original bytes of every staged file. Version 0.6.0 preserves independent edits and lets the user resolve overlaps before resuming. A resumed run gets a new run ID and permission broker. It restores the draft into a fresh `Draft`, and does so again after a model retry. It adds a `RESUMED RUN` section to the prompt. If a plan was approved before, the resumed run starts in plan-first mode and needs a new plan approval. The old editor connector address and token expire with the old extension host, so recovery starts a new TrueForge session.

## Verification record for the 11 November milestones

On 11 November 2026, `npm run check` passed. The full suite ran with a local TrueForge server, real Chromium, and isolated commands:

```
AGENTEXTENSION_TEST_FORGE_URL=http://127.0.0.1:8790 AGENTEXTENSION_TEST_SURFACES=1 \
AGENTEXTENSION_TEST_BROWSER=/path/to/chromium xvfb-run -a npm test
```

It passed **116 of 117 tests**. The one skipped test is the native app test, which needs macOS. The run used a Linux cloud workspace with Node.js 22.23.4, `@truefoundry/trueforge@0.184.2`, and Playwright's Chromium with its sandbox enabled. Commands ran under bubblewrap 0.9.0. The model was a scripted OpenAI-compatible endpoint that also reports token usage. Before these milestones, the suite had 61 tests.

| Milestone | Tests added | End-to-end check |
| --- | --- | --- |
| Scheduled read-only reports | 17 | Extension timer runs a schedule through TrueForge |
| Permission rules | 11 | Panel rule editing; **Always allow in this workspace**; administrator deny; invalid policy blocks runs |
| Automatic skill matching | 2 | Bundled skill matched in a panel run; the setting and a deny rule keep it out |
| Instruction profiles and path rules | 7 | Approval by digest; path rule delivered with the first matching read; a changed file is held back |
| Notes and suggested notes | 3 | Agent suggestions reviewed in the panel; approved notes and sources reach the next run |
| Diagnosis, edit-proposal, and custom workers | 6 | Failed `node --test`, diagnosis, separate draft, merge, and a passing rerun |
| Browser visit outside the scope | 1 | Real Chromium visit, read-only, expiry, rule allow and deny |
| Run budget and audit export | 4 | Provider token counts match the run total; tool limit; verified redacted export |
| Questions during a run | 2 | TrueForge question tool, answer, skip, and cancel |
| Checkpoints and recovery | 3 | Second extension host resumes after a simulated restart; conflict detection; failure keeps the checkpoint |

The extension tests load `src/extension.js` with a stub of the `vscode` module in `test/helpers/host.cjs`. They send real webview messages and answer quick picks, inputs, and dialogs with scripted responses. They do not render the webview. Neither the Playwright interface harness in `test/ui/run.cjs` nor the macOS native-app test ran. Neither covers the new panel controls. No general-purpose model was used. These checks show that the controls, limits, and data flow work. They do not measure how well a real model uses them.

Earlier skill and worker tests cited a lack of token reporting. TrueForge 0.184.2 does report token usage on model messages and compaction events, and the run budget now uses it.

## Real-model verification with Qwen 3.5 9B

On 11 November 2026, `npm run test:qwen` ran seven times on a MacBook Air (Apple silicon). It used `qwen/qwen3.5-9b` in LM Studio at `http://127.0.0.1:1234/v1` and TrueForge 0.184.2 on `127.0.0.1:8790`. `scripts/test-qwen.command` started TrueForge for each run. Each run covered all seven scenarios. Between runs, the defects each run exposed were fixed and covered by new tests.

| Run | Change before the run | Scenarios passed | What the model did on a miss |
| --- | --- | --- | --- |
| 1 | None | 5 of 7 | `suggest_note` was deferred, so Qwen wrote a `TESTING.md` draft instead. A nested `call_tool` request was garbled (`read_file>\n<parameter=input>…`). TrueForge rejected it, and Qwen treated the rejection as a denial. |
| 2 | `run_command`, `suggest_note`, and worker tools are preloaded. Blank-line runs are trimmed from streamed text. | 7 of 7 | The diagnosis worker cited `calc.js`, which was not in its snapshot. The edit worker called a tool. |
| 3 | Failed-check snapshots add the local modules the test imports. Out-of-snapshot findings are dropped. Workers get one retry. | 5 of 7 | Qwen ended two runs with a plain-text question. The diagnosis worker timed out at 60 seconds. |
| 4 | None reached the Mac. A sync error wrote older copies, so this run used the run 3 code. | 6 of 7 | Qwen asked three questions on its own, and the run hit the 12-pause limit after review. |
| 5 | One nudge toward the question panel. Answered questions do not count toward the pause limit. | 6 of 7 | After review, Qwen read `calc.js` about 30 times in one turn until the 12-minute scenario limit. Its first `propose_lines` call inserted a copy of the line instead of replacing it. |
| 6 | Repeated identical reads get a note after two and are refused after six. `propose_lines` explains `delete_count` and warns about a probable duplicate. | **7 of 7** | The model called `diagnose_failure` before running the test, so the worker had no failed check. The edit worker's retry recovered from a tool call. |
| 7 | The worker timeout files from run 4 reached the Mac. The harness gives workers 180 seconds. | **7 of 7** | The diagnosis worker completed for the first time. The edit worker called a tool and then returned invalid JSON on its retry, so the agent staged the fix with `propose_write` itself. |

Results for each run are kept in `test-results/model-run<N>-*.md` with the matching JSON transcripts. Model behaviour varies between runs. One clean run does not prove that every scenario will pass every time. The misses in runs 3 to 5 came from code paths that the earlier runs had not reached.

After these changes, `npm run check` passed and the suite passed 117 of 122 tests against a local TrueForge server. The five skipped tests need a real browser or macOS app. They were not re-run in this round, and these changes do not touch their code.

## Editor and scheduling features in 0.6.0

| Feature | What changed | Verification |
| --- | --- | --- |
| Check accepted changes | Rerun a recorded command from the review panel. The broker checks the command and selected hunks before the isolated run. The result appears beside Apply and in the run report. | The installed panel reran a check on accepted hunks, left rejected hunks out of the snapshot, and kept the workspace intact until Apply. |
| Symbol-aware context | VS Code definitions and references add workspace excerpts within the existing budget. Keyword search supplies context when language providers return no results. | Provider fixtures returned definitions and references. The test excluded an outside-workspace result and checked the excerpt budget. |
| Fix from Problems | **Fix with AgentExtension** starts a plan from a selected diagnostic and stages the fix for review. | The host test rejected an outdated diagnostic and sent a current one through plan approval and hunk review. |
| Review working-tree changes | Select up to six text files and compare their current contents with Git HEAD. The read-only worker reports findings for the selected snapshot. | A real Git fixture and TrueForge worker received only the selected changes. A file change during review marked the findings stale. |
| Checkpoint conflict recovery | Restore independent edits and preview overlapping changes. Choose which version to stage in each affected file. Earlier checks require a rerun after recovery changes the draft. | A restarted host preserved the developer's independent edit, staged the chosen conflict resolution, and asked for fresh review. |
| Scheduled token limits | Stop scheduled runs when reported model usage reaches the approved limit. Existing schedules use a 100,000-token default. | TrueForge reported 1,250 tokens against a 1,000-token limit. The run stopped and recorded both values in its report. |

Scheduled token enforcement uses the usage events sent by TrueForge. A model response can cross the limit before the usage arrives. Reports show **Unreported** when the provider supplies no usage.

## Verification record for 0.6.0

On 12 November 2026, `npm run check` passed. The full suite passed **128 of 128 tests**, with zero failures and zero skips. It ran on Apple Silicon with Node.js 24.18.0, TrueForge 0.184.2, Chrome, and a temporary native macOS test app. The model endpoint returned scripted responses for reproducible checks.

The installed VSIX passed in a fresh VS Code profile. The interface test approved a plan, rejected a hunk, ran the accepted-hunk check twice, then applied and undid the approved changes. It also covered plugin approval, workers, scoped browser and app actions, cancellation, and saved evidence.

The integration tests cover language-provider results and diagnostic Quick Fix through fixtures. The earlier Qwen scenarios provide separate evidence for live-model behavior. The original live-model Flask Task B remains open.

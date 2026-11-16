# AgentExtension backlog implementation plan

## Overview

This plan starts with Phase 2 and uses AgentExtension 0.6.1 as its baseline. The work builds on the existing editor, permission broker, and report system. The hosted work needs separate infrastructure and a pilot that uses two devices. [Remaining work](../remaining-work.md) · [Current features](../features.md) · [Integration research](../claude-cowork-research.md#7-integration-plan)

## Prerequisites

- Use the versions of VS Code, Node.js, and TrueForge documented for the repository. Run `npm run check` and `npm test` to record a baseline for each implementation branch. [Setup](../../README.md#set-up) · [Verification commands](../../README.md#verify)
- Use a separate VS Code profile, temporary workspaces, and the scripted TrueForge endpoint for integration tests. Record the runtime versions and test results. [UI harness](../../test/ui/run.cjs)
- For a phase that depends on TrueForge or a platform API, prove the needed operation with the versions that AgentExtension supports. Record the version and result before committing to a design. [TrueForge session integration](../../src/forge.js) · [TrueForge agent API](https://github.com/truefoundry/trueforge/blob/main/docs/api/use-agent.mdx)

## Phase summary

The local work can proceed when its own dependencies are ready. Hosted collaboration can start with an architecture review while those phases are in progress.

| Phase | Deliverable | Dependency |
| --- | --- | --- |
| 2 | Inline checkpoint recovery and session reattachment | Verified with TrueForge 0.184.2 |
| 3 | Note search and summaries, reported cost, and compaction status | TrueForge 0.184.2 reports turn cost when available. Retained-source display requires a runtime API that identifies sources. |
| 4 | Connector sign-in, account selection, approved writes, and local process evaluation | Verified against OAuth, HTTP MCP, and local process fixtures |
| 5 | Plugin import, distribution, and workflow commands | Existing plugin approval and content validation |
| 6 | Skill selection during runs, read-only worker tools, built-in hooks, and runner evaluation | Phase 5 for imported plugin declarations |
| 7 | Scheduled skills, instructions, workers, and deferred questions | Existing schedule approval. Phase 6 for workers that call tools |
| 8 | Closed-editor schedules and external notifications | Existing schedule integration coverage. Phase 7 for expanded scope |
| 9 | Managed policy and central audit collection | Supported policy delivery and a collector for the pilot |
| 10 | Reviewed text downloads and one-step macOS slider actions | Verified in Chrome and a packaged VS Code build on macOS |
| 11 | Shared project text and assigned draft handoff | Phase 9 organization service. The two-device fixture supports local verification. |

## Phase 2 — Recover inline edits and reconnect to sessions

**Objective.** Restore selection-scoped edits after an interruption and reconnect to an existing TrueForge session where the server supports safe reattachment.

- [x] Add the workspace-relative document, selection range, and original selection text to inline checkpoints. Keep existing checkpoints readable. Use the current conflict preview when the underlying text has changed.
- [x] Verify that TrueForge 0.184.2 can replace a closed editor connection and continue a completed turn in the original session. Start a fresh turn so pending actions require fresh approval. Use new-session recovery when the original session is active, unavailable, or changed.
- [x] Restore through a fresh permission broker. Require fresh protected-action approvals and clear stale check results when the recovered draft differs from the checked draft.

**Success criteria.** Restart recovery preserves independent edits, shows overlapping changes for review, and confines inline edits to the recovered selection. A reattached session resumes without duplicate tool effects. An expired or unavailable session follows the current new-session recovery flow.

**Verification.** Checkpoint tests cover the legacy format, shifted selections, and conflict previews. The TrueForge integration test closes the first editor host, restores an inline draft in the same session, rejects an edit outside the recovered selection, and opens a fresh review. Another test verifies new-session recovery while the original editor connection is still active. [Checkpoint store](../../src/checkpoint.js) · [Checkpoint tests](../../test/checkpoint.test.js) · [TrueForge integration](../../src/forge.js) · [Recovery tests](../../test/extension-checkpoint.test.js)

## Phase 3 — Improve local notes and run evidence

**Objective.** Make saved notes easier to find and show cost and retained-context details where the runtimes supply them.

- [x] Search full notes by text, scope, and cited file. Replace selected entries in one store with a shorter user-reviewed summary to free space.
- [x] Report estimated cost in USD in the panel and in saved reports. Sum per-turn estimates across the parent session and separate worker sessions. Use the turn estimate that already includes compaction. Mark missing and partial estimates.
- [x] Verify the compaction contract. TrueForge 0.184.2 and 0.185.1 report compaction events with trigger, timing, and usage. The panel and reports show when the extension recorded sources relative to the latest completed main-thread compaction. Listing retained sources requires a public runtime API that identifies them. [Verification record](../remaining-work.md#verification-completed)

**Success criteria.** Users can locate notes from the correct store. Usage tests cover reported and unavailable cost. The context view distinguishes submitted sources from retained sources when the runtime reports both.

**Verification.** Picker tests cover search inputs, approval, and scope. The TrueForge worker test verifies the cost from parent and separate worker turns. Report tests cover missing cost and compaction status. [Note tests](../../test/extension-memory.test.js) · [Worker tests](../../test/extension-workers.test.js) · [Usage tests](../../test/usage.test.js) · [TrueForge turn metrics](https://github.com/truefoundry/trueforge/blob/main/docs/api/use-agent.mdx)

## Phase 4 — Add connector accounts and approved writes

**Objective.** Build sign-in and account selection before exposing tools that can modify external data.

- [x] Keep bearer-token connectors working. Add OAuth for compatible HTTP connectors with the MCP SDK and signed OpenID Connect identity. Store credentials and the verified account binding in VS Code SecretStorage. Refresh can keep the same approval for the same account and scopes. Verify account switching, cancellation, and sign-out. [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) · [OpenID Connect](https://openid.net/specs/openid-connect-core-1_0.html)
- [x] Add separately approved writes. Show the connector, account, tool, target, and full arguments. Bind and consume an exact approval, recheck policy at dispatch, and stop when a sent write has an uncertain outcome.
- [x] Evaluate local MCP processes with a separate fixture. The SDK forwards the specified executable, arguments, and working directory and closes the child on cancellation. The transport exposes all server tools and inherits part of the host environment. Enable local processes after an isolated launcher and an approved tool scope are available.

**Success criteria.** Existing read connectors work after upgrade. OAuth credentials stay out of prompts and audit output. Changed accounts, targets, or arguments require a current approval. Scheduled runs expose only authorized read tools. An ambiguous write outcome is reported for review before a retry.

**Verification.** Local tests exercise signed account verification, refresh without losing a grant, changed accounts and scopes, cancellation, sign-out, and an exact write approval through TrueForge. They also cover ambiguous responses and the local process boundary. [OAuth tests](../../test/connector-oauth.test.js) · [HTTP connector tests](../../test/connectors.test.js) · [Local process evaluation](../../test/connector-local.test.js)

## Phase 5 — Import and distribute plugins

**Objective.** Let users install reviewed plugin packages and invoke their workflows by name.

- [x] Import into a temporary location and validate the package type, manifest, paths, size limits, and declared capabilities with the existing loader. Publish a validated version atomically. Reuse the workspace approval flow for enablement and upgrades.
- [x] Add named commands under each plugin ID and route them through the normal prompt and approval flow. Use JSON package files in shared folders for the distribution pilot. Display publisher, version, and content digest before enablement.

**Success criteria.** A valid package becomes available for review. Invalid or interrupted imports leave the previous usable version available. An upgraded plugin requires workspace approval before its changed content or capabilities enter a run.

**Verification.** On Node.js 24.18.0, package tests cover import and export, invalid and oversized files, cancelled or interrupted imports, and approval after upgrades. The editor integration test uses a simulated VS Code host, TrueForge 0.184.2, and a scripted model to verify prompt editing and plan approval. The full suite passed 150 tests and skipped five optional browser and macOS tests. The VSIX build passed. [Package tests](../../test/plugin-packages.test.js) · [Editor integration tests](../../test/extension-plugins.test.js)

**Implementation.** [Package storage and validation](../../src/plugin-packages.js) · [Plugin registry](../../src/plugins.js) · [Plugin controls](../../src/extension.js) · [User guide](../../README.md#plugin-packages-and-workflows)

## Phase 6 — Extend skills, workers, and hooks

**Objective.** Add approved capabilities in three independently testable slices.

- [x] **Skill selection.** Expose eligible skill metadata during a run. Let the model request a workflow through the existing registry. Enforce the text budget, workspace policy, and explicit-only skill settings.
- [x] **Worker tools.** Allow `read_file` for approved custom repository roles. Use the parent's read scope and the files named in the request. Limit each worker's input, time, and calls. End worker access when the parent cancels or the worker ends.
- [x] **Built-in hooks.** Check accepted hunks for conflict markers before apply. Record the outcome after an isolated check. Review the fixed hook IDs and their events as part of plugin approval. Each hook receives bounded event data and has no file or network access.
- [x] **Runner evaluation.** The command runner stages a workspace copy. The separate script runner stages only the approved script and supplies bounded input over standard input. The macOS and Linux checks covered file and network restrictions, the deadline, output limits, and cancellation. [Verification record](../remaining-work.md#verification-completed) · [Script runner](../../src/script-runner.js)

**Success criteria.** A run can select an eligible skill within its limits. A worker can use one approved read tool and receives a denial for a tool outside its role. An approved hook runs on its documented event and reports its result within its limits.

**Verification.** On macOS arm64, the suite passed 156 tests with Node.js 24.18.0 and local TrueForge 0.184.2. Five optional browser and native-app tests were skipped. The editor tests use a simulated VS Code host and a scripted model. Tests verify skill eligibility and budgets, named-file reads and denial outside the role, hook reporting, blocked apply, and cancellation. [Skill tests](../../test/extension-skills.test.js) · [Worker tests](../../test/worker-live.test.js) · [Hook tests](../../test/plugin-hooks.test.js)

**Implementation.** [Skills](../../src/skills.js) · [Plugin declarations](../../src/plugins.js) · [Workers](../../src/workers.js) · [Built-in hooks](../../src/plugin-hooks.js) · [Plugin setup](../../README.md#local-plugin-setup)

## Phase 7 — Extend the scope of scheduled reports

**Objective.** Give a scheduled report the approved context it needs and let the user resolve questions later.

- [x] Add opt-in user and workspace instruction profiles, selected skill bodies, and read-only repository workers to schedule approval. Record the selected input and capability versions. Pause for review when a selection changes.
- [x] Save at most one question in the report and its history. Finish the occurrence within its budget. Let the user answer in a fresh interactive run or dismiss the question. Resolve each saved question once across editor windows.

**Success criteria.** A scheduled run uses the selected versions and pauses when their approval is stale. Its tools stay read-only. Each deferred question appears once and can be answered or dismissed from an interactive session.

**Verification.** The integration tests use TrueForge 0.184.2 with a simulated VS Code host and a scripted model. They cover selected context, read-only worker use, stale versions, reapproval, and question follow-up and dismissal. A store test checks concurrent resolution from two instances. On Node.js 24.18.0, the suite passed 158 tests and skipped five optional browser and macOS tests. Static checks and the VSIX build passed. [Schedule integration tests](../../test/extension-schedules.test.js) · [Schedule store tests](../../test/schedules.test.js) · [TrueForge question events](https://github.com/truefoundry/trueforge/blob/main/docs/api/use-agent.mdx#agent-questions)

**Implementation.** [Schedule storage and approval](../../src/schedules.js) · [Schedule controls](../../src/schedule-controller.js) · [Scheduled runs](../../src/scheduled-run.js) · [Schedule setup](../../README.md#scheduled-reports)

## Phase 8 — Run schedules with VS Code closed

**Objective.** Run the same approved read-only workload from a background process and deliver an opt-in notification outside VS Code.

- [x] Package a local runner and document its start, stop, and login-service setup. Compare local execution with a TrueForge-managed workspace connector. The connector fixture checks a scoped workspace read, an invalid credential, and revocation.
- [x] Share scope checks, budgets, and scheduled execution between the editor and runner. The approved timer owner uses a shared occurrence claim. Both owners write the same history. The runner supports pause and revoke while VS Code is closed.
- [x] Add an opt-in webhook. Show its destination and example payload in the approval. Save the report before delivery and record delivery status separately.

**Success criteria.** An approved schedule completes with VS Code closed and appears in history when the editor opens. Opening the editor during an occurrence produces a single report. Revocation prevents future runs. A notification outage preserves the report and records the delivery failure.

**Decision.** Use the local runner for this pilot. TrueForge could read the fixture through a configured remote connector while an authenticated bridge was running. Wrong credentials, revocation, and closing the bridge removed that access. TrueForge's scheduler would still need a resident workspace connector and a separate credential and revocation lifecycle. The local runner supplies the bridge per run. It uses saved workspace files and accepts separately provisioned bearer tokens or tokenless connectors under the local login. [TrueForge connector documentation](https://github.com/truefoundry/trueforge/blob/main/docs/mcp-servers.mdx) · [Runner setup](../../README.md#run-reports-with-vs-code-closed)

**Verification.** On macOS arm64 with Node.js 24.18.0 and TrueForge 0.184.2, a standalone process completed a scheduled run with a simulated editor closed. Reopening the editor during the run produced one history entry. Tests verified token matching, revocation, and a webhook failure that preserved the report. Both background tests passed again with the VSIX runner. The full suite passed 160 tests and skipped five optional browser and macOS tests. Static checks, the VSIX build, and validation of the example LaunchAgent property list passed. [Background integration tests](../../test/background-live.test.js)

**Implementation.** [Background runner](../../src/background-runner.js) · [Shared scope checks](../../src/schedule-scope.js) · [Occurrence claims and history](../../src/schedules.js) · [Webhook delivery](../../src/schedule-notifications.js)

## Phase 9 — Add managed policy and central audit

**Objective.** Apply administrator policy from a managed source and deliver redacted audit records to an approved organization collector.

- [x] Check VS Code product policy mappings and use an organization service for enrolled workspaces. Reuse the administrator rule parser and precedence. Refresh before protected actions and block on malformed, offline, or unauthorized policy.
- [x] Add a workspace-scoped collector with bearer authentication, read and write permissions, retention, and retry deduplication. Sync the existing redacted export from the editor. Preserve the local hashes, verify the redacted payload, and show the last sync result locally.

**Success criteria.** Administrator rules apply in a managed test install. A policy change takes effect at the next protected action. Collector retries preserve one copy of each event and report verification failures. Exports retain their chain verification and redaction.

**Decision.** VS Code 1.146.0 arm64 on macOS has no AgentExtension entry in its product policy mapping. Microsoft documents that extension policies require a product mapping. Use an administrator-deployed enrollment file and the organization service. Audit sync is an explicit editor command. [VS Code enterprise policies](https://code.visualstudio.com/docs/enterprise/policies) · [Microsoft extension policy guidance](https://github.com/microsoft/vscode/blob/main/.github/skills/policy-and-managed-settings/extension-policy.md)

**Verification.** A VSIX installed in a separate VS Code 1.146.0 profile on macOS loaded a managed deny rule and refused the next access request when the organization policy became invalid. The TrueForge fixture changed policy during a run and verified denial at the next command. Collector tests verified a lost receipt, deduplication, workspace access, retention, hash preservation, and verification failures. On Node.js 24.18.0 with TrueForge 0.184.2, the suite passed 163 tests and skipped five optional browser and macOS tests. Static checks and the VSIX build passed. [Integration tests](../../test/organization.test.js)

**Implementation.** [Organization setup](../../README.md#organization-policy-and-audit) · [Managed client](../../src/organization.js) · [Collector](../../src/organization-service.js) · [Integration tests](../../test/organization.test.js)

## Phase 10 — Evaluate browser transfers and macOS controls

**Objective.** Verify which additional actions can fit the existing browser and native-app scopes.

- [x] Add direct, same-origin UTF-8 attachments from observed links in the dedicated browser. Playwright's native download uses temporary files tied to the browser context. The host keeps that path disabled. It streams the approved URL with a 64,000-byte limit and stages the text at the approved new workspace path for hunk review. [Playwright downloads](https://playwright.dev/docs/downloads) · [Browser implementation](../../src/browser.js)
- [x] Add one increment on an enabled macOS slider that exposes the Accessibility increment action and has a valid value and range. The helper retains the observed window and control identities for the run and checks them before dispatch. Screen-based input remains a research item because the current implementation cannot verify window and target identity for coordinate actions. [Apple accessibility API](https://developer.apple.com/documentation/applicationservices/axuielement_h) · [Native helper](../../native/desktop.swift)

**Verification.** The Chrome fixture covered approval, denial, same-origin scope, a replaced link, a new workspace path, redirects, file type, invalid UTF-8, and the size cap. Cancelling or revoking a stalled transfer closed its connection without staging a file. The macOS fixture covered denial, cancellation, revocation, and a replacement window with the same snapshot. A fresh observation let the slider move from 2 to 3. [Surface tests](../../test/surface-live.test.js)

The installed VSIX test confirmed one downloaded file and three native actions. The file appeared on disk only after hunk review and apply. The run used VS Code 1.146.0, TrueForge 0.184.2, Chrome 157, Playwright 1.62.1, and macOS 27.2 on Apple silicon. [Installed extension test](../../test/ui/run.cjs) · [Browser and computer setup](../../README.md#browser-and-computer-scope)

## Phase 11 — Pilot hosted collaboration

**Objective.** Share a project across two approved devices and continue a prepared run with explicit access controls.

- [x] Bind each project membership to an organization, project, device credential, user ID, workspace key, and viewer or editor role. Use the existing organization policy and audit access settings. Collaboration can reach only the enrolled service and exposes no execution tools.
- [x] Store versioned project notes and instructions. Refuse a stale edit and show the published text next to the local edit. Allow an editor to publish empty text to clear a section. Keep connector credentials and local permissions on the device. [Concurrent requests and conditional updates](https://www.rfc-editor.org/rfc/rfc9110.html#name-if-match)
- [x] Send a saved draft to an approved editor device. Check the destination Git commit and file bases before recovery. Open received drafts in local hunk review and recheck access before Apply. Stop an open review when the service denies access or becomes unreachable. Participants can remove the shared payload.

**Success criteria.** Two approved devices can share permitted project data and hand off a fixture draft. Concurrent edits have a visible resolution path. An unauthorized role or revoked device cannot read the project or accept an assignment. Audit records identify the user and device that acted.

**Verification.** Two separate Git checkouts and device credentials shared notes and instructions through a loopback organization service. Tests covered concurrent edits, audience restrictions, stale Git and file revisions, device revocation, offline requests, and user and device audit attribution. A hosted HTTPS deployment and testing across physical devices remain open. [Collaboration tests](../../test/collaboration.test.js) · [Pilot setup](../../README.md#shared-project-pilot)

An installed VSIX in VS Code 1.146.0 showed the notes conflict and published the chosen version as revision 3. The recipient reviewed and applied the assigned file in the editor. [Installed extension test](../../test/ui/run.cjs)

## Post-implementation

- [x] Update the user guide, feature inventory, and remaining-work list. Record supported and verified versions and remaining platform dependencies. [User guide](../../README.md#verify) · [Feature inventory](../features.md) · [Remaining work](../remaining-work.md)
- [x] Run the static checks, regression suite, installed VSIX suite, packaged background tests, and targeted Qwen checks. Record the results and the acceptance checks that remain open. [Verification record](../milestones.md#post-implementation-verification)
- [x] Record evidence for file, time, and tool limits. Replay existing connector and policy settings, schedule approval and history, plugin pins, and checkpoint data from the 0.6.1 baseline. [Limits and upgrade behavior](../milestones.md#limits-and-upgrade-behavior)

## Notes

- Editable office artifacts, a managed cloud runner, computer-use teaching and recording, and automatic action screening remain research items. [Research backlog](../remaining-work.md#research-without-a-release-commitment)

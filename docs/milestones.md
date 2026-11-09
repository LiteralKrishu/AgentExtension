# Milestone implementation and verification

## Scope

Version 0.5.0 adds scoped browser inspection, native computer use on macOS, and durable run reports.
It retains versioned plugins, bounded workers, the permission broker, skills, context sources, approved notes, and read-only MCP connectors.
Scheduling and remote device control remain later stages.

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

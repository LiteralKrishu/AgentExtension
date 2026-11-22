# Agent Capability Upgrade Research

Date: 20 November 2026. Source baseline: commit 5c5fe67, AgentExtension 0.7.1.

Status: Historical research baseline. Implementation results and open gates are recorded in [PROGRESS.md](PROGRESS.md).

## Overview

Improve reliable task completion and code retrieval first. Then improve verification environments, workers, background coding, remote work, and editor assistance. Keep the current VS Code extension and TrueForge integration. Preserve review before applying agent changes.

The goal is to close the specific gaps in the Cursor and Codex comparison. It is not a claim of full product parity. Completion quality depends on the model, context, tools, environment, and user interaction. Measure these factors separately.

The user selected the identifier agent-capability-upgrade and small phases with focused, testable tasks. The [implementation plan](IMPLEMENTATION.md) defines the work. The [progress record](PROGRESS.md) tracks completion.

## Problem Statement

The project has broad tool coverage. Its evidence for complete, independent coding tasks is less complete. Adding more tools will not by itself resolve failed tasks. The first work must produce strict outcome scoring, a reproducible task set, and traces that show where a run loses progress.

### Verified project evidence

| Observation | Evidence | Meaning and limit |
| --- | --- | --- |
| The current manifest identifies version 0.7.1. Some inventories still use the 0.6.1 baseline. | [Manifest](../../package.json), [feature inventory](../features.md) | Release documentation needs a common capability and support matrix. |
| The live harness can return pass with gaps. Several edit-and-check requirements are optional. Its command exit status also accepts pass with gaps. | [Live harness](../../test/model/run.cjs) | It is a useful foundation, but not a strict complete-task benchmark. |
| Flask Task B currently checks review and changed file locations in the live harness. Full CLI behavior is checked separately. | [Task B scenario](../../test/model/run.cjs), [rehearsal](../demo.md) | A staged patch is not evidence of a valid implementation. Apply and independent behavioral checks must join the scoring path. |
| A documented Qwen 3.5 9B run reached its 12-minute limit without a draft. Earlier live attempts also produced invalid patches. | [Open verification](../remaining-work.md#verification-still-open), [rehearsal](../demo.md) | This is evidence for those runs and settings. It does not prove that all models fail or identify the cause of the timeout. |
| Initial context uses weighted keyword matches in overlapping windows, with a default 12,000-character budget. | [Context assembly](../../src/context.js) | Exact identifiers work differently from conceptual queries. Retrieval quality needs its own test set. |
| The retrieval worker retains the file snapshot supplied during assembly. Later search operates on that snapshot. | [Retrieval worker](../../src/retrieval.js), [run setup](../../src/extension.js) | Search freshness and search coverage need explicit contracts. Later file reads already have separate checks. |
| Workspace enumeration stops at 12,000 paths. Indexed text is capped at 32,000,000 characters. Verification copies stop at 64,000,000 bytes. | [Workspace](../../src/workspace.js) | Increasing a constant will not fix repeated scans, memory use, or snapshot correctness. |
| Checks use a temporary copy. Hidden paths, lockfiles, and dependency folders are excluded by the current path filter. | [Workspace](../../src/workspace.js), [command tool](../../src/bridge.js) | Some normal dependency and build workflows need a separate execution input policy. Search exclusions and execution inputs must not become one broad allow list. |
| Worker sessions have limited snapshots, output, tool access, and lifetime. The pool allows two concurrent workers and four calls per run. | [Worker pool](../../src/workers.js), [worker sessions](../../src/worker-session.js) | Expansion must preserve aggregate budgets, scope, and deterministic merge checks. |
| Scheduled reports expose a read-only tool set. | [Scheduled runs](../../src/scheduled-run.js), [agent integration](../../src/forge.js) | Background coding requires a new mode and an isolated draft checkout. Existing schedules must stay read-only after migration. |
| Cross-device continuation starts a new local session. Physical two-device HTTPS acceptance remains open. | [Remaining work](../remaining-work.md), [pilot guide](../hosted-collaboration-https.md) | A copied checkpoint is not a transferred live runtime. A same-machine rehearsal is not a two-device result. |
| Selection editing and diagnostic fixes exist. No inline completion provider was found in the extension entry point. | [Extension](../../src/extension.js) | Automatic suggestions are a separate later capability, with separate latency and cost requirements. |
| Draft review, stale-file checks, undo, reports, policy, and audit already exist. | [Apply](../../src/apply.js), [reports](../../src/reports.js), [policy](../../src/policy.js), [audit](../../src/audit.js) | Reuse these capabilities. They are regression requirements for the upgrade. |

The earlier comparison passed source, type, and lint checks. This planning task does not add a live-model result. Existing scripted tests demonstrate integration behavior, not model problem-solving quality.

## User Stories / Use Cases

- A developer asks for a small bug fix. The agent stages a correct patch, checks the accepted patch, and reports the result without repeated guidance.
- A developer asks for an implementation, tests, and documentation in an unfamiliar repository. Search finds each relevant area within a bounded context budget.
- A developer changes an open file during a run. Search reflects the current buffer. An old read receipt cannot authorize an edit against changed text.
- A developer works in a large repository. The extension reports coverage and quotas instead of silently searching only an arbitrary prefix of paths.
- A project needs installed dependencies and a local service to run tests. Setup happens in a managed environment with an explicit access profile.
- A user schedules a coding task. It produces a checked draft in a separate checkout. The main workspace changes only after review.
- Two enrolled devices share a draft over HTTPS. The recipient verifies its base and reviews it locally. Revocation takes effect before further actions.

## Technical Research

### Approach Options

| Decision | Alternatives and trade-offs | Recommendation |
| --- | --- | --- |
| Establish reliability | More scripted tests are repeatable but cannot establish model quality. Live tasks are representative but slower, variable, and potentially paid. | Keep both. Run deterministic regression tests in normal CI. Run a versioned live evaluation separately. |
| Diagnose failed runs | Increase time and iteration limits, rewrite prompts, or instrument the current loop. Larger budgets can hide repeated work. | Capture progress and replay failure classes before tuning prompts or limits. |
| Exact search | Keep full in-memory scans; add a bounded native search adapter; or require a new service. | Add a ripgrep adapter with a bounded JavaScript fallback. Use the same scope rules and overlay unsaved buffers. Do not require a cloud service. |
| Ranking | Keep keyword windows; use BM25-style lexical ranking; add language relationships; add embeddings. | Start with exact matches, lexical ranking, and symbol relationships. Evaluate semantic retrieval as a separate optional experiment. |
| Index storage | Rebuild every run; use a sharded local cache; add SQLite or another native store. | Start with versioned, rebuildable local cache shards behind a storage interface. Adopt a database only if measured scale justifies its packaging cost. Do not couple retrieval to TrueForge's private database. |
| Structural context | Parse all languages with a new parser stack, or reuse VS Code providers with bounded fallback chunks. | Reuse document symbols, definitions, and references first. Provider failure must leave text search usable. |
| Verification checkout | Copy all eligible files for every check; reuse a content-addressed baseline; or use a Git worktree. | Introduce a snapshot interface. Prototype cached materialization and detached worktrees. Select by correctness and measured cost. Worktrees alone are not a security boundary. |
| Dependencies and services | Relax the existing host runner, or create managed setup and execution profiles. | Keep the current isolated mode. Add a separate managed environment, starting with Linux containers. Separate networked setup from verification. |
| Model support | Assume any tool-capable endpoint works, or publish observed capability profiles. | Test schema handling, context limits, compaction, cancellation, and fallback. Keep explicit user model choice. |
| Worker expansion | Raise fixed limits, or add bounded queues, role scopes, and per-role model profiles. | Add queue and budget accounting first. Increase limits only if completion or elapsed time improves. |
| Remote work | Treat collaboration as remote execution, or define a separate execution service. | Validate physical-device sharing first. Add a separate leased job protocol and executor later. |
| Editor completion | Reuse the full coding agent for each keystroke, or create a narrow completion path. | Use a cancellable, opt-in completion provider with its own model profile and budget. Keep cross-file suggestions in draft review. |

### Recommended Approach

Use four release stages:

1. **Core evidence and retrieval:** strict scoring, reproducible tasks, run diagnosis, bounded recovery, exact search, incremental indexing, better ranking, and a measured reliability gate.
2. **Execution and autonomy:** larger checkouts, dependencies, local services, bounded workers, and fewer repeated approvals for unchanged scope.
3. **Background and remote delivery:** scheduled drafts, Git handoff, physical-device acceptance, and a separate remote executor.
4. **Editor and release quality:** completion suggestions, plugin compatibility, packaged platform checks, and an independent comparison.

These are planning stages. Each contains small implementation phases. Complete the core stage before starting broader execution work. Record unsupported or unproven capabilities rather than claiming parity.

Primary documentation supports the mechanisms, not a prediction of project performance:

- ripgrep supports bounded integration without a search service. Its ignore behavior differs from the project's scope policy. Revalidate each returned path and overlay changed buffers. [ripgrep guide](https://github.com/BurntSushi/ripgrep/blob/master/GUIDE.md)
- VS Code exposes symbols, definitions, references, inline completion, and file events. Watcher exclusions and path casing require reconciliation on restart and branch changes. [Language features](https://code.visualstudio.com/api/language-extensions/programmatic-language-features), [API reference](https://code.visualstudio.com/api/references/vscode-api)
- Reciprocal rank fusion combines ranked candidate lists without requiring directly comparable raw scores. Treat its use here as an experiment. [Original RRF paper](https://cormack.uwaterloo.ca/cormack/cormacksigir09-rrf.pdf)
- Git worktrees support separate working trees. They still share repository metadata and need controlled creation, cleanup, and access. [Git worktree documentation](https://git-scm.com/docs/git-worktree)

### Required Technologies

Keep the current Node.js, VS Code, TrueForge SDK, MCP bridge, and test framework for the core stage. Add a packaged or verified ripgrep executable with a fallback. Use VS Code language providers where available.

Choose an embedding provider and container backend only in their named phases. Check runtime APIs against installed types and packaged integration tests before selecting a version. The repository pins TrueForge server 0.184.2 and SDK 0.184.1. The existing verification record reports an approval-pause failure with server 0.185.1. Do not assume a newer version resolves it. [Server package](../../trueforge/server/package.json), [verification record](../remaining-work.md)

### Data Requirements

| Record | Required fields and rules |
| --- | --- |
| Evaluation task | ID, version, repository revision, prompt, expected behavior, required checks, budget, fixture setup, split, and permitted interaction script. Keep hidden acceptance tests out of agent context. |
| Evaluation run | Task and product versions, model/provider/settings, hardware, runtime, repetitions, permissions, terminal outcome, patch hash, checks, active time, user wait time, tokens, cost availability, and failure class. |
| Search hit | Workspace identity, relative path, range, content hash, document version if open, retrieval source, rank, and coverage state. A hit is a hint until an authoritative read. |
| Local index | Schema version, workspace identity, content and configuration hashes, paths, chunks, term statistics, relationships, last reconciliation, and explicit exclusions. Keep dirty buffers in an in-memory overlay. |
| Run progress | Task state, tool status, draft revision, check evidence, pending user action, last meaningful progress, bounded recovery count, and missing requirements. Persist only approved context for recovery. |
| Execution profile | Checkout identity, input manifest, environment and dependency digest, network destinations, lifecycle-script policy, toolchain, quotas, process leases, and cleanup state. |
| Remote job | Job ID, project/user/device identity, approved scope digest, source base, lease epoch, expiry, state sequence, artifact hashes, and result acknowledgement. Do not transfer local grants or credentials. |

Keep source-bearing caches in extension storage with restrictive access and a clear reset command. Redacted audit records must not grow into transcripts. Delete derived data when the user clears it. Recheck scope after policy changes, not only when a cache was built.

## UI/UX Considerations

Show useful states: searching, editing, checking, waiting for an answer, waiting for approval, and stopped with a reason. Show incomplete search coverage. Distinguish a proposed patch, a checked patch, and an applied patch.

Keep current review behavior as the default. Add optional, bounded grants for repeated operations with unchanged scope. Show an expiry and a revoke control. Never treat a progress timeout as user input or approval.

For background tasks, show a review inbox with the patch, check result, source base, and any unresolved question. For inline suggestions, use explicit acceptance and normal editor undo. A suggestion must not start a background agent or apply changes to other files.

## Integration Points

| Workstream | Existing entry points |
| --- | --- |
| Evaluation and diagnosis | [Live harness](../../test/model/run.cjs), [host fixture](../../test/helpers/host.cjs), [usage](../../src/usage.js), [reports](../../src/reports.js) |
| Agent loop and recovery | [Forge](../../src/forge.js), [bridge](../../src/bridge.js), [checkpoint](../../src/checkpoint.js), [agent definition](../../trueforge/agent.json) |
| Retrieval | [Context](../../src/context.js), [retrieval worker](../../src/retrieval.js), [editor context](../../src/editor-context.js), [workspace](../../src/workspace.js), [prompt](../../src/prompt.js) |
| Execution and permissions | [Workspace](../../src/workspace.js), [permissions](../../src/permissions.js), [policy](../../src/policy.js), [surface access](../../src/surface-access.js) |
| Workers and schedules | [Workers](../../src/workers.js), [worker session](../../src/worker-session.js), [schedules](../../src/schedules.js), [runner](../../src/background-runner.js) |
| Collaboration | [Client](../../src/collaboration.js), [service](../../src/collaboration-service.js), [workspace sync](../../src/workspace-sync.js), [organization](../../src/organization-service.js) |
| Product surface | [Extension](../../src/extension.js), [panel](../../media/panel.js), [manifest](../../package.json), [package build](../../scripts/package-vsix.cjs) |

## Risks and Challenges

- The Flask failure has no proven single cause. Trace it before attributing it to retrieval, model size, or timeout settings.
- Better search can add irrelevant context. Measure recall, ranking, context size, and final task outcomes together.
- Watcher events can be missing or delayed. Reconcile inventory and verify content at read and edit time.
- Cached snapshots can become stale. Bind each check to the source base, environment digest, draft revision, and accepted hunk set.
- A networked dependency install can run project scripts. Declare this policy separately and contain setup within the managed environment.
- Workers can increase cost or create conflicting proposals. Keep aggregate budgets, stale-result rejection, and parent-owned merge decisions.
- Retained source IDs after compaction are not exposed by the current public runtime contract. Rehydrate required task facts through supported APIs. Do not label submitted sources as proven retained sources.
- A remote connection can fail after an action. Use job identity, leases, acknowledgements, and explicit reconciliation. Do not promise universal exactly-once external effects.
- Cross-platform packaging can fail even when source tests pass. Verify extracted installers on the stated operating system and architecture.

## Open Questions and Decision Gates

These decisions do not block writing the plan. Resolve each in its assigned phase before the dependent feature ships.

| Decision | Default for planning | Resolution point |
| --- | --- | --- |
| Evaluation models and spend ceiling | Keep local and hosted results separate. Use existing authorized endpoints. Do not spend on runs during planning. | Phase 2, before live execution |
| Retrieval storage | Rebuildable cache shards behind a storage interface | Phase 6, measured against a database prototype if needed |
| Embedding support | Off by default; local-first experiment | Phase 9, retain only if held-out queries improve |
| Core completion targets | Proposed thresholds in the implementation plan; not current measurements | Freeze in Phase 2 before tuning |
| Managed environment | Linux container prototype; explicit unsupported state elsewhere | Phases 12–13 |
| Remote deployment | Protocol and local service prototype; hosted deployment is a separate release operation | Phases 19–20 |
| Physical devices | Two actual devices and separate credentials | Phase 18; simulated tests cannot close this gate |
| Runtime upgrade | Keep pinned runtime until approval, cancellation, and recovery contract tests pass | Phase 23 |

## References

External sources were checked on 20 November 2026. Product behavior can differ by version, account, and surface.

- Cursor: [search](https://cursor.com/docs/agent/tools/search), [agent security](https://cursor.com/docs/agent/security), [subagents](https://cursor.com/docs/subagents), [automations](https://cursor.com/docs/cloud-agent/automations), [Tab](https://cursor.com/help/ai-features/tab).
- Codex: [CLI](https://learn.chatgpt.com/docs/codex/cli), [permissions](https://learn.chatgpt.com/docs/agent-approvals-security), [subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents), [scheduled tasks](https://learn.chatgpt.com/docs/automations), [worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees), [configurable inference endpoints](https://openai.com/index/unrolling-the-codex-agent-loop/).
- VS Code: [programmatic language features](https://code.visualstudio.com/api/language-extensions/programmatic-language-features), [API reference](https://code.visualstudio.com/api/references/vscode-api).
- Search and checkout mechanisms: [ripgrep guide](https://github.com/BurntSushi/ripgrep/blob/master/GUIDE.md), [RRF paper](https://cormack.uwaterloo.ca/cormack/cormacksigir09-rrf.pdf), [Git worktree](https://git-scm.com/docs/git-worktree).

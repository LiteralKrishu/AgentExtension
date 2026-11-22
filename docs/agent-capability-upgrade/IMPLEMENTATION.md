# Agent Capability Upgrade Implementation Plan

Date: 20 November 2026. Baseline: AgentExtension 0.7.1 at commit 5c5fe67.

Status: Phases 1–9 are implemented. Phase 10 is in progress. Gate A remains open because measured retrieval quality is below target. Physical-device acceptance in Phase 18 is blocked by device availability. See PROGRESS.md for verified results.

## Overview

Close the gaps in the Cursor and Codex comparison through measured improvements. Start with complete-task scoring and diagnosis. Improve retrieval before expanding autonomy. Keep reviewed edits, stale-file checks, policy, revocation, and run evidence throughout the work.

This plan follows the [research](RESEARCH.md). Track actual work in [PROGRESS.md](PROGRESS.md). The user selected small phases. Each phase has a narrow deliverable and an independent acceptance check. A phase is a unit of scope, not a promise of a fixed number of hours. Split a phase further if its experiment reveals more work.

Execution was authorized on 21 November 2026. Use local models only, with zero paid API spending. Keep deployment and external-write decisions within the scope of each later phase.

## Prerequisites

- Preserve the current test and packaged-installer baseline before changing behavior.
- Capture the source revision, VS Code version, Node.js version, SDK version, and server version for each result.
- Use disposable evaluation checkouts. Keep expected answers and hidden acceptance tests outside model context.
- Use authorized model endpoints and record evaluation budgets before live runs.
- Keep deterministic regression tests separate from live-model and physical-device acceptance.
- Use proposed new modules as boundaries, not instructions to refactor unrelated code.

## Scope and Rules

- Preserve default hunk review and explicit apply for agent drafts.
- Preserve inline selection limits, fresh read receipts, stale-check rejection, and undo checks.
- Preserve policy precedence and revocation checks at dispatch.
- Reuse TrueForge's public APIs. Do not read or modify its private database.
- Keep source text out of redacted audit records. Keep source-bearing reports and caches under their existing access model.
- Keep current schedules read-only. Introduce coding schedules as a separate opt-in type.
- Keep external writes separate from retryable local work. Reconcile an uncertain result before retrying it.
- Keep a working fallback when a language provider, index, optional executable, or embedding service is unavailable.
- A missing physical-device or live-model result remains open. A scripted fixture cannot substitute for it.
- Retain the VS Code extension as the product surface. A new editor, desktop app, mobile app, or foundation model is outside this roadmap.

## Coverage of the Comparison

| ID | Issue or recommendation | Resolution phases |
| --- | --- | --- |
| G01 | No strict, comparable task-completion evidence | 1, 2, 10, 24 |
| G02 | Failed or stalled complete tasks, including Flask Task B | 3, 4, 5–10 |
| G03 | Keyword retrieval and snapshot freshness | 5, 6, 7, 8, 9 |
| G04 | Path, index, and command-copy limits on larger repositories | 5, 6, 11 |
| G05 | Restricted dependency setup, build tools, and service tests | 11, 12, 13 |
| G06 | Model compatibility and quality vary; local support is not unique | 2, 10, 23 |
| G07 | Bounded workers have less execution and context flexibility | 8, 14 |
| G08 | Scheduled reports cannot produce coding changes | 16, 17 |
| G09 | Remote execution is absent; two-device acceptance is open | 18, 19, 20 |
| G10 | No automatic completion provider | 21 |
| G11 | Preserve review-before-apply, traceability, and control | 1, 3, 4, 11–24 |
| G12 | Improve extension interoperability and install experience | 22, 23 |
| G13 | Broader platform and release maturity needs evidence | 13, 18, 23, 24 |
| G14 | Repeated approvals and unclear progress can slow work | 3, 15 |
| G15 | Existing browser, connector, and native actions need reliable integration | 4, 13, 23 |

## Phase Summary and Dependencies

| Phase | Deliverable | Depends on |
| --- | --- | --- |
| 1 | Strict complete-task scoring | Current baseline |
| 2 | Versioned task and retrieval evaluation sets | 1 |
| 3 | Progress evidence and failure replay | 1, 2 |
| 4 | Bounded recovery and edit–check–fix behavior | 3 |
| 5 | Fresh exact search across the permitted workspace | 2 |
| 6 | Incremental local index and buffer overlays | 5 |
| 7 | Ranked lexical chunks and context packing | 6 |
| 8 | Symbol and relationship context | 7 |
| 9 | Measured optional semantic retrieval experiment | 7, 8 |
| 10 | Model profiles and core reliability gate | 1–9 |
| 11 | Scalable, reproducible verification snapshots | 10 |
| 12 | Managed dependency setup | 11 |
| 13 | Managed checks and local services | 12 |
| 14 | Budgeted worker queue and broader scoped research | 8, 10, 13 |
| 15 | Bounded grants and clearer review controls | 3, 10, 13 |
| 16 | Scheduled coding drafts | 11, 13, 15 |
| 17 | Git and pull-request handoff | 16 |
| 18 | Physical-device HTTPS acceptance | 10 |
| 19 | Remote execution protocol | 13, 18 |
| 20 | Leased remote executor prototype | 16, 19 |
| 21 | Opt-in inline suggestions | 8, 10 |
| 22 | Plugin, skill, and MCP compatibility fixtures | 10, 14, 15 |
| 23 | Packaged platform and runtime compatibility | All features selected for that release |
| 24 | Independent comparison and release evidence | 23 and release-specific gates |

Default execution order is the table order. This plan does not authorize parallel agents. A phase can move earlier only if its dependencies and the core release gate still hold.

## Measurement Contract

### What counts as a completed coding task

A run passes only if all task requirements pass. The patch must reach review, apply in a disposable checkout, and pass independent acceptance checks. The harness must verify prohibited changes and unchanged behavior as well as the requested feature. A missing required check, timeout, error, invalid patch, or unapproved action is a failure. An unavailable environment is reported separately and never counted as a pass.

For read-only tasks, require the expected findings and valid source references. For permission-denial tasks, a correct stop can be the expected pass condition. Do not mix those outcomes into coding completion rates.

Record first-attempt success separately from success after recovery. Record user interventions and approval wait time. Automated test approvals must follow a fixed script. They do not show that a task needed no human decisions.

Run the new strict evaluator against the original 0.7.1 baseline in a disposable checkout as well as the changed implementation. Do not compare an old pass-with-gaps score with a new complete-pass score. Once held-out failures inform a change, mark those tasks as exposed. Use a new held-out set for the next independent claim.

### Initial proposed targets

These are engineering targets, not measured results or Cursor/Codex scores. Freeze task versions, target hardware, budgets, and thresholds in Phase 2 before tuning. Later changes require a new evaluation version and a reason.

| Gate | Proposed acceptance target |
| --- | --- |
| Scorer integrity | Every seeded invalid result fails; zero false passes in the negative fixture set |
| Task corpus | 20 coding tasks: 12 development and 8 held-out tasks; cover JavaScript/TypeScript and Python, including Flask Task B; repeat each live task three times |
| Main model profile | At least 51 of 60 complete passes, including at least 20 of 24 held-out attempts; all three Flask Task B attempts pass |
| Local model profile | Publish separate results with the same task contract. Qualify it for the supported coding tier only if it meets that tier's gate. Otherwise label its measured limitations. |
| Time and cost | Compare within each task's frozen budget. Keep Flask Task B's original 12-minute wall-clock limit for the first rerun. Report median and tail wall-clock/active time, user wait, time to first valid patch, tokens, cost availability, and hardware. |
| Retrieval set | At least 40 labelled queries with known implementation, test, and documentation locations; 24 development and 16 held-out queries |
| Retrieval quality | At least 90% Recall@10 overall and 85% on held-out queries; at least 95% success on exact identifier/path queries; do not reduce fixed-budget task completion |
| Search performance | Initial reference fixture: 20,000 permitted text files and about 200 MB of source. Warm exact search p95 at or below 500 ms; warm ranked retrieval p95 at or below 1 second; first usable cold results within 5 seconds. Record CPU, disk, memory, and query mix. |
| Index freshness | Open-buffer edits are available to the next query. Normal saved changes appear within 1 second on the reference fixture. Reconciliation catches missed watcher events. |
| Review correctness | All apply, stale-input, partial-hunk, permission, cancel, and revocation acceptance cases pass |
| Bounded recovery | Repeated no-progress cases stop or recover within the declared retry budget. No duplicate external write is dispatched by automatic retry. |
| Completion suggestions | Cancel stale requests immediately; prototype suggestion p95 at or below 1.5 seconds on a declared model and hardware profile |

Define Recall@10 as the fraction of labelled relevant files found in the first ten distinct file results. Also report task-level implementation/test/documentation coverage. Define active-run time to include model and tool work but exclude measured user wait time. Report raw counts alongside percentages. Report uncertainty for repeated live results. Do not generalize a small corpus into a universal performance claim.

Measure wall-clock time from the submitted request to the terminal evaluation result, including user wait. Record independent acceptance-check time separately. Use the same timing boundary and approval script for baseline and changed runs.

## Phase 1: Make Complete-Task Scoring Strict

### Objective and Rationale

Make evaluation outcomes trustworthy before using them to guide changes.

### Tasks

- [x] Extract scenario evaluation from the live runner into a testable scorer. Require verification when the prompt asks for it.
- [x] Separate complete, incomplete, failed, timed out, cancelled, and environment-unavailable outcomes. Stop treating pass with gaps as release success.
- [x] Fail a run with terminal errors even if some patch checks pass. Reject an empty required-check list for a coding task.
- [x] Add an apply-and-verify path in a disposable checkout, separate from model-visible tools.

### Success Criteria

Seeded cases for a missing test, failed check, invalid patch, terminal error, unrelated edit, and false completion claim all fail. A correct reviewed, applied, independently checked patch passes. Test the scorer without a model server.

### Files Likely Affected

[Live runner](../../test/model/run.cjs), [host fixture](../../test/helpers/host.cjs); proposed test/model/evaluate.cjs and test/model-scoring.test.js.

## Phase 2: Freeze Representative Tasks and Retrieval Queries

### Objective and Rationale

Make improvement measurable on realistic tasks before changing the agent or search system.

### Tasks

- [x] Define 20 coding tasks and 40 retrieval queries with pinned inputs, expected behavior, permitted interaction scripts, and development/held-out splits.
- [x] Automate Flask Task B checks: valid JSON, all sensitive-key matches masked, ordinary values preserved, CLI help registration, regression tests, and documentation location.
- [x] Record per-task time, token, and cost limits. Record model settings, hardware, temperature or determinism controls when available, and product versions.
- [x] Add exports for active time, user wait, approvals, first patch, successful verification, cost availability, and failure class. Record a baseline only after the run actually occurs.
- [x] Audit all 120 retrieval relevance judgments against pinned source. Record line citations and hashes. Reject missing or changed witnesses during qualification.
- [x] Publish a new retrieval corpus version with reviewed test-path corrections and a source version that contains the selected cancellation test. Freeze a new held-out set independent of development selection before further tuning. Keep version 1 measurements unchanged. Version 2 has 16 fresh held-out queries. The same implementer reviewed the source; external independent comparison remains open.

### Success Criteria

Each task has executable acceptance criteria. Hidden checks do not enter prompts. A seeded wrong Flask implementation fails. Publish the corpus version and frozen limits before tuning. Every retrieval judgment has cited source evidence. Resolve the known label corrections in a new version before qualification. Live results remain pending until authorized environments are available and used. The [version 2 freeze](../../test/retrieval/corpora/v2/freeze.json) and [source manifest](../../test/retrieval/corpora/v2/source.json) identify the new retrieval inputs and their review limit.

### Files Likely Affected

[Live runner](../../test/model/run.cjs), [demo](../demo.md), [usage](../../src/usage.js); proposed test/model/tasks/, test/retrieval/queries.json, and test/model/README.md.

## Phase 3: Capture Progress and Replay Failure Classes

### Objective and Rationale

Identify why runs stall without assuming that a larger model or more time is the solution.

### Tasks

- [x] Record tool request/result times, progress state, repeated reads, schema failures, draft revisions, check results, compaction, and user-wait intervals.
- [x] Classify observed failures: missing context, irrelevant context, model/tool format, repeated exploration, edit conflict, environment failure, runtime transport, and missing review.
- [x] Reproduce the Flask stall on its recorded setup when available. Compare retrieval, model response, tool execution, and user-wait timelines.
- [x] Create deterministic replay fixtures for observed classes. Keep source-bearing replay data separate from redacted audit records.

### Success Criteria

A report distinguishes a slow but progressing model, a repeated-tool loop, a failed environment, and a run waiting for the user. Replay fixtures reproduce their terminal state. The report marks unknown causes instead of guessing.

### Files Likely Affected

[Forge](../../src/forge.js), [bridge](../../src/bridge.js), [usage](../../src/usage.js), [reports](../../src/reports.js), [panel](../../media/panel.js); proposed test/run-progress.test.js.

## Phase 4: Add Bounded Recovery to the Edit–Check–Fix Loop

### Objective and Rationale

Recover from known local failures while preserving user work and avoiding repeated external effects.

### Tasks

- [x] Define explicit run outcomes for coding and read-only requests. Track requested checks and unresolved requirements with evidence from actual tool results.
- [x] Add bounded handling for repeated identical reads, invalid edit anchors, and unchanged failing checks. Do not classify a legitimate read-only task as stalled because it has no patch.
- [x] Preserve a recoverable draft when safe. Re-read changed files and require current receipts before editing. Recheck the accepted hunk subset after a change in review decisions.
- [x] Rehydrate the approved task, constraints, file references, and check status after compaction or restart through supported runtime APIs. Keep external write retry restrictions.

### Success Criteria

Fixtures cover fix, failing check, repair, successful recheck, and review. A no-progress loop has a bounded end. Restart and compaction do not lose required constraints or reuse old approvals. Cancellation and ambiguous connector/browser/native writes do not trigger duplicate dispatch.

### Files Likely Affected

[Forge](../../src/forge.js), [bridge](../../src/bridge.js), [checkpoint](../../src/checkpoint.js), [prompt](../../src/prompt.js), [agent definition](../../trueforge/agent.json); existing recovery tests and proposed test/run-recovery.test.js.

## Phase 5: Add Fresh Exact Search Beyond the Initial Snapshot

### Objective and Rationale

Find exact paths, identifiers, and error strings across the permitted workspace without loading every file into the prompt snapshot.

### Tasks

- [x] Extend search with literal, word, path, glob, and bounded-regex modes, result pagination, cancellation, deadlines, and an explicit coverage indicator.
- [x] Add a ripgrep adapter with a bounded JavaScript fallback. Control arguments and configuration; do not execute a user query through a shell.
- [x] Reuse workspace scope checks for every hit. Keep hidden/private/binary exclusions. Overlay unsaved buffers and suppress replaced on-disk hits.
- [x] Return versioned source hints. Require authoritative read receipts for edits. Handle file changes and out-of-scope paths between search and read.

### Success Criteria

Find a labelled target beyond the old 12,000-path prefix. Literal metacharacters remain literal in literal mode. Regex searches time out cleanly. Unsaved edits appear in results. Policy denial, symlink replacement, binary content, and cancellation cannot expose disallowed text.

### Files Likely Affected

[Workspace](../../src/workspace.js), [retrieval](../../src/retrieval.js), [bridge](../../src/bridge.js), [extension](../../src/extension.js); proposed src/search.js and test/search.test.js.

## Phase 6: Build an Incremental Index with a Buffer Overlay

### Objective and Rationale

Avoid full rescans for each run while keeping search current and coverage visible.

### Tasks

- [x] Add a versioned inventory and content-hash chunk cache in extension storage. Separate repository identity, branch state, configuration, and index generation.
- [x] Apply create/change/delete and open-document events through a debounced queue. Keep dirty text in memory. Add restart and branch-change reconciliation.
- [x] Use bounded batches, cancellation, cache quotas, corrupt-cache rebuild, and explicit excluded/oversized/unindexed counts.
- [x] Expose first usable results before indexing finishes. Add index status and a clear/rebuild action. Benchmark sharded cache storage before adding a database dependency.

### Success Criteria

A warm run does not reread unchanged source bodies. A missed watcher event is corrected by reconciliation. Dirty buffers, rename/delete, branch switches, changed scope, and a corrupt cache return current results or an explicit incomplete state. Meet the frozen freshness and memory budgets.

### Files Likely Affected

[Retrieval](../../src/retrieval.js), [workspace](../../src/workspace.js), [extension](../../src/extension.js), [panel](../../media/panel.js); proposed src/repository-index.js and test/repository-index.test.js.

## Phase 7: Improve Lexical Ranking and Context Packing

### Objective and Rationale

Find the implementation, tests, and documentation without filling context with repeated or irrelevant windows.

### Tasks

- [x] Add identifier-aware tokenization and BM25-style lexical ranking. Keep exact paths and exact symbols ahead of approximate matches.
- [x] Use declaration boundaries when available and bounded line chunks otherwise. Preserve source offsets and content hashes.
- [x] Combine exact, lexical, path, and relationship candidate lists. Compare reciprocal rank fusion with the existing score. Deduplicate overlap and reserve useful category coverage.
- [x] Make context packing aware of the selected model's effective budget. Record omitted material and ranking reasons without claiming exact tokenizer counts where unavailable.

### Success Criteria

Use the frozen query split to report Recall@10, rank, implementation/test/documentation coverage, latency, and packed context size. Do not tune on held-out queries. Exact references remain resolvable within the context budget. Final task results do not regress.

### Files Likely Affected

[Context](../../src/context.js), [retrieval](../../src/retrieval.js), [prompt](../../src/prompt.js), [core tests](../../test/core.test.js); proposed test/retrieval/ranking.test.js.

## Phase 8: Follow Symbols and Code Relationships

### Objective and Rationale

Improve cross-file discovery through bounded language and import relationships.

### Tasks

- [x] Reuse VS Code document/workspace symbols, definitions, and references for query candidates and active locations.
- [x] Add bounded import and test relationships for JavaScript/TypeScript and Python. Mark inferred edges separately from language-provider results.
- [x] Cache results by document version and provider state. Bound fan-out, duration, and excerpt count. Keep language providers optional.
- [x] Expose provenance to the parent and eligible workers. Revalidate paths and current content before source reads enter a prompt.

### Success Criteria

Queries reach a definition, caller, relevant test, and documentation across separate files on labelled cases. A missing or slow provider falls back to text search. Unsupported languages remain usable. Dependency discovery stays within the declared workspace and budget.

### Files Likely Affected

[Editor context](../../src/editor-context.js), [context](../../src/context.js), [workers](../../src/workers.js), [extension](../../src/extension.js); proposed test/retrieval/relationships.test.js.

## Phase 9: Evaluate Optional Semantic Retrieval

### Objective and Rationale

Test whether conceptual search adds enough value to justify model, storage, and latency costs.

### Tasks

- [x] Add an experimental embedding-provider interface, off by default. Start with a local endpoint and a small labelled query subset.
- [x] Key vectors by provider/model/dimension, content hash, scope, and schema version. Rebuild on incompatible changes and remove excluded content.
- [x] Compare lexical-only, lexical-plus-relationships, and hybrid results at the same context budget. Include provider-unavailable and offline cases.
- [x] Record a retain-or-reject decision. Require held-out retrieval improvement and no complete-task regression. A measured rejection completes this experiment without shipping embeddings.

### Success Criteria

Publish the ablation results and resource cost. No code is sent to an embedding service without explicit setup for that destination. The normal search path works when embeddings are disabled or unavailable. Do not claim a semantic-search advantage without results.

### Files Likely Affected

[Retrieval](../../src/retrieval.js), [model setup](../../src/model-setup.js), [manifest](../../package.json); proposed src/embedding-provider.js and test/retrieval/semantic.test.js only if the experiment proceeds.

## Phase 10: Qualify Model Profiles and Pass the Core Gate

### Objective and Rationale

Prove that the combined reliability and retrieval changes complete real work before broader execution features begin.

### Tasks

- [x] Define observed profiles for context size, tool schema behavior, compaction, output limits, timeout, cancellation, and fallback. Keep explicit model selection. See [observed profiles](MODEL-PROFILES.md); no local profile is qualified.
- [ ] Test one declared main profile and at least one local profile when the required endpoints are available. Keep different model results separate.
- [ ] Run the frozen coding and retrieval sets with recorded repetitions. Compare baseline, recovery-only, retrieval-only, and combined changes where practical.
- [ ] Verify the three Flask Task B attempts through review, apply, behavior, tests, documentation, and unchanged-value checks. Publish all failed attempts.

### Success Criteria

Meet the core targets in the measurement contract for the qualified main profile. If a profile misses the target, keep the core stage open and record the observed failure. Do not silently raise budgets or change the default model to hide a regression. Local models that miss the gate remain available with an accurate capability label.

### Files Likely Affected

[Model setup](../../src/model-setup.js), [managed runtime](../../src/managed-forge.js), [Forge](../../src/forge.js), [live runner](../../test/model/run.cjs), [features](../features.md), [remaining work](../remaining-work.md); proposed evaluation result summaries.

## Phase 11: Scale Verification Snapshots

### Objective and Rationale

Check larger repositories without recopying an arbitrary capped set for every command.

### Tasks

- [x] Separate the search input policy from an explicit execution input manifest. Preserve mandatory private-path exclusions. List required build metadata and lockfiles by scope. Lockfiles are execution inputs only; dotfile metadata stays private.
- [x] Introduce a snapshot interface. Compare cached immutable materialization with a controlled detached Git worktree. Include approved untracked files and unsaved-buffer overlays. Chose copy-on-write materialization with a stat-keyed hash cache: a worktree omits untracked files and unsaved buffers and writes repository metadata. The worktree was compared by design, not measured.
- [x] Use private mutable copies for command inputs. Never hard-link writable verification files to the real workspace. Bound disk, time, and source bytes explicitly.
- [x] Bind each result to source hashes, environment digest, draft revision, and accepted hunks. Cancel, remove, or retain a failed environment through an explicit lifecycle. Every snapshot is removed after its check or on failure; retention is not offered.

### Success Criteria

The reference fixture exceeds the old 64 MB copy limit and includes a target beyond 12,000 paths. A check verifies the intended full scope or fails with an explicit quota reason. Checks cannot modify the original workspace. Cached runs reduce materialization work without stale results.

### Files Likely Affected

[Workspace](../../src/workspace.js), [bridge](../../src/bridge.js), [apply](../../src/apply.js), [checkpoint](../../src/checkpoint.js); proposed src/execution-snapshot.js and test/execution-snapshot.test.js.

## Phase 12: Prepare Dependencies in a Managed Environment

### Objective and Rationale

Support real builds without giving the existing check runner general host access.

### Tasks

- [x] Define a managed environment profile with image/toolchain identity, input manifest, quotas, credential scope, and a separate setup network policy. Images resolve to a repository digest; only setup has network.
- [x] Implement the first Linux-container adapter. Support a documented Node.js fixture and Python fixture with pinned dependency inputs. Real Docker fixtures passed on this Mac, including an empty Node project.
- [x] Make lifecycle scripts and package-registry destinations explicit. Reuse caches only when their environment and dependency digests match. Registries are named in each install command; destinations are not network-enforced.
- [x] Show the effective environment before use. Keep the existing isolated runner available. Reject unsupported adapters clearly.

### Success Criteria

Pinned Node.js and Python fixtures install in the managed environment. Changed dependency inputs invalidate the environment. Installation cannot read host credentials or private workspace paths. An unsupported platform or unavailable container engine does not fall back to unrestricted host execution.

### Files Likely Affected

[Workspace](../../src/workspace.js), [policy](../../src/policy.js), [permissions](../../src/permissions.js), [bridge](../../src/bridge.js), [manifest](../../package.json); proposed src/execution-environment.js and test/execution-environment.test.js.

## Phase 13: Run Managed Checks and Local Services

### Objective and Rationale

Verify projects that need a dev server, database fixture, or browser smoke test.

### Tasks

- [x] Add declared check commands, working directories, environment inputs, service dependencies, and service readiness checks to the managed profile.
- [x] Track process groups and leases. Bound service lifetime, output, ports, network destinations, and disk usage. The first backend keeps all services inside one job's loopback network, with no host ports or external network. Processes inside that job share its loopback; there is no per-process port firewall.
- [x] Run one service-backed integration test and one browser smoke test inside the managed environment. Keep the interactive browser's existing origin and action rules separate.
- [x] Record startup, check, and cleanup outcomes independently. Revoke access and stop child processes on cancel or expiry. Host-confirmed container removal is separate from process-reported service status.

### Success Criteria

A fixture starts its service, reaches readiness, passes its check, and leaves no child process after cleanup. Startup failure, occupied ports, service crash, blocked egress, cancellation, and stale draft changes produce accurate results. The main workspace stays unchanged.

### Files Likely Affected

[Workspace](../../src/workspace.js), [bridge](../../src/bridge.js), [reports](../../src/reports.js), [surface access](../../src/surface-access.js), [managed services](../../src/execution-services.js), [service tests](../../test/execution-services.test.js), and [usage guide](../managed-checks.md).

## Phase 14: Add a Budgeted Worker Queue

### Objective and Rationale

Improve useful parallel work before increasing the current worker limits.

### Tasks

- [x] Add queued, running, completed, stale, and cancelled states with one aggregate time, token, and tool budget. Keep current limits as defaults.
- [x] Let approved research roles use the scoped search and read interface. Bind access to the captured scope and current source versions. Add optional per-role model profiles.
- [x] Keep edit proposals in separate drafts. Rebase only non-overlapping proposals with verified source bases. Keep parent merge decisions and user hunk review.
- [ ] Compare one worker, current defaults, and a higher bounded profile on independent tasks. Record extra cost, conflicts, and elapsed time before changing defaults.

Queue mechanics were compared at one, two, and three active workers using four independent scripted tasks. Three workers did not improve this fixture over two. This does not measure local model quality or throughput. The release setting remains at most two. A real model comparison is pending. See [worker evidence](evidence/worker-queue-2026-11-23.json).

### Success Criteria

Independent research tasks can progress through the queue under the shared parent budget. Reported usage stops new and active work at its limit. A provider can report usage after an in-flight response has already spent tokens, so an exact token ceiling is not established. Cancellation stops queued and active work. A stale or overlapping proposal cannot merge. Higher concurrency ships only if the measured result justifies it. Nested delegation and inherited credentials remain unavailable by default.

### Files Likely Affected

[Workers](../../src/workers.js), [worker sessions](../../src/worker-session.js), [Forge](../../src/forge.js), [usage](../../src/usage.js), [plugins](../../src/plugins.js), [panel](../../media/panel.js); existing worker tests and proposed queue tests.

## Phase 15: Reduce Repeated Approval Friction

### Objective and Rationale

Reduce repeated decisions for unchanged scope while keeping clear control over changes and external effects.

### Tasks

- [x] Measure approval counts and wait time by action. Reuse the current exact-command workspace allow rules before adding another grant mechanism.
- [x] Add optional expiring grants for a declared run and execution profile. Bind grants to executable, arguments, target, source/environment identity, and policy version as applicable.
- [x] Present the active scope, expiry, recent actions, and one revoke control. Keep planning questions separate from approval requests.
- [x] Keep draft apply explicit. Keep external writes separately scoped. Do not add automatic action screening until deterministic grants have measured value.

### Success Criteria

A repeated unchanged check uses its valid grant. A changed command, target, environment, account, or policy triggers the correct new decision or denial. Expiry and revocation take effect before dispatch. Approval count falls on the fixed workflow without reducing required review or expanding access.

### Files Likely Affected

[Permissions](../../src/permissions.js), [policy](../../src/policy.js), [Forge](../../src/forge.js), [extension](../../src/extension.js), [panel](../../media/panel.js), [audit](../../src/audit.js); existing permission tests and proposed grant-lifecycle tests.

## Phase 16: Produce Scheduled Coding Drafts

### Objective and Rationale

Extend background work from reports to reviewable coding results after the core and execution gates pass.

### Tasks

- [x] Add a versioned coding-schedule type. Keep existing schedule migration read-only. Declare source base, permitted paths, commands, environment, budgets, and output policy.
- [x] Run coding schedules in a separate managed checkout. Store patch and verification evidence without applying to the user's active workspace.
- [x] Reuse occurrence claims, expiry, cancellation, and history. Add a review-inbox entry with the patch, base, check status, and unresolved questions.
- [x] Return questions as needs-input results. Resume through an interactive review with fresh protected-action decisions.

The runner uses a source-bound private copy and managed container checks. The standalone CLI can produce a draft while the editor is closed. The inbox imports a checkpoint with fresh review and permissions. Existing report stores stay read-only. See the [usage guide](../scheduled-coding.md) and [current evidence](EVIDENCE.md). The core release gate remains open.

### Success Criteria

A scheduled fixture produces a checked draft while the editor is closed. Opening the editor during the occurrence does not duplicate the job. A source-base mismatch blocks import. Existing reports remain read-only. Revocation stops future dispatch, and no scheduled draft is silently applied.

### Files Likely Affected

[Schedules](../../src/schedules.js), [scheduled runs](../../src/scheduled-run.js), [schedule scope](../../src/schedule-scope.js), [runner](../../src/background-runner.js), [controller](../../src/schedule-controller.js), [checkpoint](../../src/checkpoint.js); proposed scheduled-draft tests.

## Phase 17: Add Git and Pull-Request Handoff

### Objective and Rationale

Make a checked result easy to review and deliver without rebuilding source-control infrastructure.

### Tasks

- [x] Export a base-bound patch, check summary, and reviewer notes. Import them through the existing stale-base and hunk-review path.
- [x] Add an optional branch handoff in a managed checkout. Separate local branch creation, commit, push, and pull-request actions.
- [x] Use an existing configured Git provider connector for remote actions. Present the exact repository, branch, patch, and destination before an authorized write.
- [x] Handle dirty checkouts, wrong remotes, rejected pushes, and lost responses. Reconcile remote state before retrying uncertain writes.

### Success Criteria

A user can review and apply an exported patch without a Git provider connection. The connected fixture can prepare a draft pull request under its declared scope. No unrelated file or branch changes occur. Commits use the user's configured identity and add no Codex or OpenAI attribution.

### Files Likely Affected

[Git review](../../src/git-review.js), [connectors](../../src/connectors.js), [reports](../../src/reports.js), [extension](../../src/extension.js), [policy](../../src/policy.js); proposed src/git-handoff.js and test/git-handoff.test.js.

## Phase 18: Close Physical-Device HTTPS Acceptance

### Objective and Rationale

Resolve the existing collaboration evidence gap before adding remote execution.

### Tasks

- [ ] Run the existing HTTPS guide on two physical devices with separate credentials, profiles, and checkouts. Record device and package versions.
- [ ] Verify notes conflicts, workspace file sync, draft assignment, and continuation with a new local TrueForge session and fresh approvals.
- [ ] Test offline edits, clock differences, network loss, lost responses, expired credentials, revoked devices, and mismatched Git/file bases.
- [ ] Save redacted evidence and update the support matrix. Fix observed failures and rerun affected cases on both devices.

### Success Criteria

Both devices complete the positive and negative acceptance matrix over trusted HTTPS. The receiver reviews and applies the correct patch locally. Revoked or stale identities cannot continue or apply. Keep this phase open if a second physical device is unavailable. Do not relabel a same-machine simulation as completion.

### Files Likely Affected

[Pilot guide](../hosted-collaboration-https.md), [collaboration](../../src/collaboration.js), [service](../../src/collaboration-service.js), [workspace sync](../../src/workspace-sync.js), [continuation tests](../../test/session-continuation.test.js), [remaining work](../remaining-work.md).

## Phase 19: Define a Separate Remote Execution Protocol

### Objective and Rationale

Keep project sharing distinct from permission to execute a task on another machine.

### Tasks

- [ ] Define a versioned remote job with project/user/device binding, source base, declared paths and tools, environment digest, lease, expiry, budgets, and artifact hashes.
- [ ] Define state transitions for queued, claimed, running, needs-input, ready-for-review, failed, cancelled, expired, and uncertain outcomes.
- [ ] Add protocol fixtures for authorization, duplicate delivery, lease changes, cancellation races, reconnect, and result acknowledgement. Keep the existing sharing service free of implicit execution privileges.
- [ ] Specify continuation as a portable task checkpoint that starts a new runtime unless a tested public TrueForge API supports native transfer. Keep local credentials and approvals on their device.

### Success Criteria

Schema and state-machine tests reject a viewer, wrong project, stale lease, changed scope, expired job, and replayed result. The protocol shows how to reconcile uncertain completion. It makes no universal exactly-once claim for external effects.

### Files Likely Affected

[Collaboration](../../src/collaboration.js), [organization service](../../src/organization-service.js), [checkpoint](../../src/checkpoint.js), [policy](../../src/policy.js); proposed docs/agent-capability-upgrade/REMOTE-PROTOCOL.md and test/remote-protocol.test.js.

## Phase 20: Build a Leased Remote Executor Prototype

### Objective and Rationale

Run the declared task remotely and return evidence for local review.

### Tasks

- [ ] Add one Linux-container executor using the managed environment adapter. Claim jobs under the Phase 19 protocol and a short renewable lease.
- [ ] Run against an immutable source base plus approved inputs. Keep credentials scoped to the executor environment. Stream bounded status and redact shared logs.
- [ ] Upload a base-bound patch, check results, environment identity, and artifact digests. Verify them before local import and hunk review.
- [ ] Test worker crash, disconnect, duplicate assignment, lease expiry, revocation, and lost result acknowledgements. Keep a separately documented hosted deployment step.

### Success Criteria

Two approved devices submit and review a remotely produced fixture patch over HTTPS. A stale lease cannot start further tool effects. Crashed jobs recover or report an uncertain state without silently repeating external writes. Cleanup removes the job environment. Local apply still requires current review and source checks.

### Files Likely Affected

[Background runner](../../src/background-runner.js), [collaboration service](../../src/collaboration-service.js), [organization service](../../src/organization-service.js), [reports](../../src/reports.js); proposed src/remote-executor.js and test/remote-executor.test.js.

## Phase 21: Add Opt-In Inline Suggestions

### Objective and Rationale

Provide everyday editor assistance after the agent's completion and retrieval behavior is qualified.

### Tasks

- [x] Register a VS Code inline completion provider with a narrow generation path and a separate model/budget profile. Keep it off by default during evaluation.
- [x] Use bounded prefix/suffix and permitted related context. Debounce requests and cancel on document changes, cursor changes, disable, or budget exhaustion. Context is the current document only; related files are a later experiment.
- [x] Check document version and suggestion range before showing output. Support explicit acceptance, dismissal, per-language settings, and normal editor undo.
- [ ] Measure latency, acceptance, cancellation, and cost using opt-in aggregate data. Keep next-edit and cross-file changes as later experiments through draft review. In-window counters and p95 latency exist; cost and a measured profile do not, so suggestions stay manual-trigger-only.

### Success Criteria

Suggestions cannot apply without user acceptance. Stale results disappear and cannot overwrite newer text. The prototype meets its frozen latency target on a declared profile or remains manual-trigger-only. Completion requests cannot invoke broad agent tools or change another file.

### Files Likely Affected

[Extension](../../src/extension.js), [editor context](../../src/editor-context.js), [model setup](../../src/model-setup.js), [manifest](../../package.json); proposed src/inline-completion.js and test/inline-completion.test.js.

## Phase 22: Test Plugin, Skill, and MCP Interoperability

### Objective and Rationale

Improve reuse and setup without treating another product's configuration as trusted execution authority.

### Tasks

- [x] Build compatibility fixtures for supported SKILL.md metadata, references, named workflows, and MCP read/write tool schemas.
- [x] Add an import preview for supported portable inputs. Report unsupported model settings, hooks, or agent roles instead of silently dropping them.
- [x] Preserve publisher/version/content digests, explicit-only skill settings, script isolation, connector account scope, and fresh approval after changes.
- [x] Document supported subsets and migration examples. Keep a folder/package distribution path; do not make a public marketplace a prerequisite.

### Success Criteria

A supported portable skill works with the same content and declared limits. Unsupported fields are visible. Imported hooks or tool entries cannot bypass the local approval model. Package upgrades and changed connector configurations require the correct renewed decision.

### Files Likely Affected

[Skills](../../src/skills.js), [plugins](../../src/plugins.js), [packages](../../src/plugin-packages.js), [connectors](../../src/connectors.js), [skill tests](../../test/skills.test.js), [package tests](../../test/plugin-packages.test.js), [README](../../README.md).

The [compatibility guide](../interoperability.md) defines the supported import subset. Foreign model, hook, agent-role, and tool-permission settings are shown as unsupported. Four new portable import cases cover preview, content pins, scripts, and invalid inputs. Existing plugin workflow and MCP cases remain part of the regression.

## Phase 23: Verify Packaged Platforms and Runtime Versions

### Objective and Rationale

Make installation and support claims match tested packages, not source-only checks.

### Tasks

- [x] Publish a capability matrix for macOS arm64, macOS x64, Linux, Windows native, and WSL. Mark unverified or unsupported combinations explicitly.
- [ ] Test extracted platform packages with bundled runtime and optional search binaries. Verify first connection, credential restore, agent run, check, review, apply, undo, cancel, and restart.
- [ ] Add a server/SDK compatibility test matrix for approval pauses, streaming, questions, compaction, workers, and recovery. Keep current pins until a candidate passes.
- [ ] Reconcile package, README, features, remaining-work, and release versions. Test the current browser/connector flows and macOS helper on their supported platform. Record dependency licenses and package provenance.

### Success Criteria

Every claimed platform and architecture has an installer result and a capability matrix row. Native-app support remains explicitly macOS-specific unless implemented and tested elsewhere. An unsupported check environment fails clearly. A runtime candidate cannot ship after failing the approval or recovery contract.

### Files Likely Affected

[Packaging](../../scripts/package-vsix.cjs), [managed runtime](../../src/managed-forge.js), [server package](../../trueforge/server/package.json), [manifest](../../package.json), [CI](../../.github/workflows/check.yml), [README](../../README.md), [features](../features.md), [releases](../releases/v0.7.1.md); new platform acceptance records.

The [platform and runtime matrix](PLATFORM-MATRIX.md) records the current Mac fixture and unverified platforms. The final Mac package passed 27 automated cases. A Linux arm64 container package passed its connection fixture. Current package acceptance does not close the platform phase.

## Phase 24: Publish an Independent Comparison and Release Evidence

### Objective and Rationale

Show which gaps closed and which remain, using the same task contract across products.

### Tasks

- [ ] Run the frozen task set on the selected AgentExtension release, Cursor, and Codex versions where access is available. Use clean repositories and comparable interaction budgets.
- [ ] Match models and settings when products permit it. Otherwise publish separate product comparisons and same-model harness comparisons. Record restrictions and missing data.
- [ ] Report complete passes, first-attempt passes, user interventions, approval wait, active time, tokens/cost availability, failure classes, and task-by-task outcomes. Publish all attempts and task-set limits.
- [x] Update release notes, feature support, open verification, and rollback guidance. Remove a gap from the inventory only after its acceptance evidence is linked.

### Success Criteria

Every closed gap has a reproducible record. Missing competitor access is reported as unavailable, not as an inferred score. A release claim identifies product, model, runtime, platform, corpus, and date. The result does not claim full Cursor or Codex parity from this small task set.

### Files Likely Affected

[Live harness](../../test/model/run.cjs), [milestones](../milestones.md), [features](../features.md), [remaining work](../remaining-work.md), [README](../../README.md); proposed docs/evaluations/ and the selected release notes.

The [comparison status](../evaluations/2026-11-23-status.md) fixes the task contract and lists missing results. No new real coding-model or competitor run was performed. The [unreleased notes](../releases/capability-upgrade-unreleased.md) record scope and rollback.

## Release Gates and Stop Conditions

| Stage | Required evidence | Stop or rollback condition |
| --- | --- | --- |
| A: Core reliability and retrieval | Phases 1–10; strict task and query results; existing review/recovery tests | Completion below the frozen gate, false pass, stale edit, or unexplained repeatable regression |
| B: Managed execution | Stage A plus 11–13; dependency and service fixture evidence | Original workspace mutation, private-path exposure, leaked process, or stale verification result |
| C: Expanded autonomy | Stage B plus each selected worker/grant/schedule feature's acceptance | Budget bypass, duplicate job, lost revocation, or unintended apply |
| D: Remote work | Physical-device phase 18 plus 19–20 and applicable execution gates | Wrong identity/base, accepted stale lease, unverifiable artifact, or automatic retry of uncertain external effects |
| E: Editor and interoperability | Stage A plus 21–22 and applicable platform checks | Stale suggestion acceptance, broad tool execution from a completion, or imported permissions |
| Release | Phase 23 plus the stage gates for shipped features; Phase 24 comparison claims only when measured | A support claim without matching package/platform evidence |

Do not block a core release on optional remote or completion features. Keep those features absent or experimental until their gates pass. A semantic retrieval experiment can conclude that the simpler pipeline is better. Record that decision as evidence, not a missing feature.

## Test and Evidence Strategy

- Use deterministic tests for scorers, retrieval freshness, merge conflicts, policy, cancellation, job state, and cache invalidation.
- Use real language providers for selected JavaScript/TypeScript and Python context cases. Keep a provider-unavailable fixture.
- Use real model runs for task completion. Keep task acceptance independent of model-reported success.
- Use real containers and services for execution claims. Use actual supported operating systems for sandbox and installer claims.
- Use two physical devices for cross-device acceptance. Keep simulated multi-client tests for fast regressions.
- Record before/after results at the same frozen budgets. Report cold and warm search separately. Separate initial setup cost from steady-state execution.
- For changed runtime code, run the affected tests, then npm run check and npm test. Build and test the extracted VSIX for packaging, runtime, search-binary, or background-runner changes.
- Keep browser, native-app, live-model, and physical-device test skips visible. A skipped test does not satisfy a release gate.

## Rollout and Rollback

Add new retrieval and execution backends behind explicit settings. Migrate caches through a versioned rebuild path. Preserve existing instructions, notes, plugin selections, and read-only schedules. Do not migrate credentials into new environments automatically.

Retain the current search fallback, isolated checker, and reviewed apply path during the pilot. Disable a new backend on a compatibility failure and show the reason. Do not fall back by expanding permissions. Keep upgrade and downgrade behavior for stored schedules and checkpoints testable.

## Post-Implementation

- [ ] Reconcile all feature, setup, support, and release documents with measured behavior.
- [ ] Link each G01–G15 closure to tests and acceptance evidence.
- [ ] Record performance results on stated hardware and repository sizes.
- [ ] Review source-bearing cache/report retention and clear controls.
- [ ] Validate cancellation, expiry, and revocation across parent, workers, services, and remote jobs.
- [ ] Publish known limitations and rollback steps for each shipped stage.

## First Execution Step

Run /build phase 1 agent-capability-upgrade. Start with the scorer and deterministic negative fixtures. Do not start by raising timeouts, switching the default model, adding a vector database, or increasing worker limits.

# Agent Capability Upgrade Progress

## Status: Phase 10 open; Phase 11 implemented

The core components for Phases 1–9 are implemented, including a measured rejection of the optional embedding configuration. Phase 2's reopened retrieval-data work is complete. Version 2 resolves the six source findings and freezes 16 fresh held-out queries. Those queries remain unevaluated. Phase 10 is in progress. No local model profile qualifies. The core retrieval and completion gates remain open. Later phases retain their dependency and evidence gates. The user chose to keep improving the core gate. No complete-task benchmark or product-parity claim is made.

## Quick Reference

- Research: [RESEARCH.md](RESEARCH.md)
- Implementation and acceptance criteria: [IMPLEMENTATION.md](IMPLEMENTATION.md)
- Baseline: AgentExtension 0.7.1, source commit 5c5fe67
- Current work: /build phase 10 agent-capability-upgrade

## Phase Progress

Each phase row tracks its state, completed work, decision, and blocker. Use the implementation document for the task checklist. A phase stays open until its success criteria and required evidence pass.

| Phase | Deliverable | Status | Tasks completed / decisions / blockers |
| --- | --- | --- | --- |
| 1 | Strict complete-task scoring | Completed | Strict scorer, disposable verification, saved check-patch evidence, and negative fixtures / only complete passes / no implementation blocker |
| 2 | Versioned task and retrieval sets | Completed | Frozen 20-task set and retrieval version 2; all 120 judgments validated; five corrected test paths and a hashed cancellation-test overlay / keep version 1 unchanged / 16 fresh held-out queries remain unevaluated; same-implementer review limits independence |
| 3 | Progress evidence and replay | Completed | Host tool timing, source-free traces, check/error categories, waits, compaction, and deterministic replay fixtures / unknown causes stay unknown / Flask stall recorded |
| 4 | Bounded recovery | Completed | Preserved retry drafts, restored task constraints, fresh approvals, input-bound repeated-check limits, task evidence, and repair/recheck fixtures / no automatic retry after external writes / local runtime checks passed |
| 5 | Fresh exact search | Completed | Current disk/buffer/draft search, literal/word/path/glob/regex, pagination, deadlines, coverage, source hints / native hints revalidated through workspace reads / native and editor checks passed |
| 6 | Incremental index | Completed | Versioned sharded cache, coalesced watcher queue, reconciliation, buffer overlay, quotas, status, and clear action / cold 1.47 s; warm source reads 0; saved change 438 ms / measured on this computer only |
| 7 | Lexical ranking and packing | Completed | Identifier-aware BM25, bounded declarations, overlap removal, source versions, and model-budget estimate / weighted score selected on development labels / quality targets remain a Phase 10 gate |
| 8 | Symbol relationships | Completed | Document/workspace symbols, definitions/references, version/provider cache, explicit JS/TS/Python relationship lookup, and provenance / automatic relationship reranking rejected after measured regression / optional providers retain text fallback |
| 9 | Semantic retrieval experiment | Completed — rejected | Local Nomic 768-dimensional ablation, equal-budget packing, cache/offline checks, and resource report / held-out hybrid recall fell to 64.58% / keep normal lexical search |
| 10 | Model profiles and core gate | In Progress | Three observed local models and strict qualification checker; balanced category ranking adopted / version 2 held-out 87.50% and exact success 100% meet their targets; overall 85.00% misses 90% / no model qualifies; overall recall and full coding qualification remain open |
| 11 | Scalable verification snapshots | Implemented — macOS check pending | Execution manifest with lockfiles, copy-on-write snapshot, stat-keyed hash cache, file/byte/disk quotas, environment digest, shared by agent checks and the verifier / copy-on-write chosen over worktrees by design / started with Gate A open at the user's direction; macOS clone timing and runtime tests not yet run |
| 12 | Managed dependency setup | Implemented — Docker acceptance pending | Docker adapter, pinned image digest, dependency-digest volumes, setup-only network, hardened offline checks, no host fallback / user chose Docker Desktop / engine not installed yet; real fixtures not run; merged after the Phase 10 batch |
| 13 | Managed checks and services | Not Started | None / declared services and leases / depends on environment adapter |
| 14 | Worker queue | Not Started | None / keep current defaults until measured / depends on core and execution gates |
| 15 | Bounded grants and review controls | Not Started | None / reuse current exact allow rules / depends on approval measurements |
| 16 | Scheduled coding drafts | Not Started | None / existing schedules stay read-only / depends on execution gate |
| 17 | Git and pull-request handoff | Not Started | None / local patch path works without connector / provider access needed for connected acceptance |
| 18 | Physical-device HTTPS acceptance | Blocked | Not run / physical devices cannot be simulated for this gate / user confirmed only one computer is available |
| 19 | Remote protocol | Not Started | None / separate sharing and execution authority / depends on physical-device gate |
| 20 | Remote executor prototype | Not Started | None / leased managed environment / Phase 18 physical-device dependency is blocked |
| 21 | Inline suggestions | Implemented — manual trigger only | Off by default, tool-free 256-token turn, current document only, private files excluded, stale and cancelled results dropped, hourly cap, per-language settings / latency and cost unmeasured, so automatic mode stays unqualified / merged after the Phase 10 batch |
| 22 | Extension interoperability | Not Started | None / supported subsets and visible limitations / none identified |
| 23 | Packaged platform/runtime checks | Not Started | Core package connection evidence is available / claim only tested combinations / full platform acceptance depends on the core gate and additional environments |
| 24 | Independent comparison and release evidence | Not Started | None / publish all attempts and restrictions / competitor access not yet established |

Potential acceptance resources are recorded here for later phases. They do not block starting Phase 1 or imply that the resource is unavailable.

## Release Gate Progress

| Gate | State | Evidence |
| --- | --- | --- |
| A: Core reliability and retrieval | Open — unqualified | Version 2 with balanced ranking: overall Recall@10 85.00% (target 90%), held-out 87.50% (target 85%, now exposed), exact success 100%; small coding tasks passed, larger local trials remain unqualified |
| B: Managed execution | Not evaluated | No new results |
| C: Expanded autonomy | Not evaluated | No new results |
| D: Remote work | Not evaluated | Existing same-machine rehearsals are not physical-device acceptance |
| E: Editor and interoperability | Not evaluated | No new results |
| Release | Open | Local package built and connection test passed; core qualification, other platforms, and independent comparison remain open |

## Session Log

### 22 November 2026 — Phases 12 and 21 built beside the running batch

- The Phase 10 batch records source digests per attempt. To keep them consistent, Phases 12 and 21 were built in an ignored work copy (.phase-work) and merge after the batch ends.
- GPT-OSS 20B at 131,072 context: small task complete in 20 s; Flask failed after 676 s and 422,608 tokens. Its independent checks ran and failed on a syntax error: cli.py contained literal \n and escaped quotes. An earlier attempt the same evening was invalid because python was missing from PATH; the script now provisions a pinned Python environment readable by the check sandbox.
- Loading Qwen3 Coder 30B at 131,072 context crashed the 24 GiB computer. The script now caps it at 32,768 and Qwen 3.5 9B at 65,536.
- Phase 21: an opt-in inline completion provider using a tool-free 256-token worker turn. Five tests cover bounded context, stale and cancelled results, private files, disabled and manual modes, the hourly cap, failures, and statistics.
- Phase 12: a Docker execution environment. Images resolve to a repository digest. Dependencies install once per image, dependency files, registry, and script policy into a labelled volume; changed inputs create a new volume. Setup is the only networked step and runs with a read-only source. Checks run with no network, a read-only root, dropped capabilities, and CPU, memory, and process limits, and mount only the snapshot. A stopped engine fails the check rather than falling back to the host. Five unit tests pass; two real-engine fixtures wait for Docker Desktop.
- Work-copy suite: 386 tests, zero failures attributable to the changes. Four retrieval-corpus tests fail only in the copy because Git lists the copy's subfolder; they pass in the repository. Type and lint checks passed.

### 22 November 2026 — Phase 11 snapshots (Gate A still open)

- The user directed work to continue past Phase 10 with local models only, without Codex. Gate A stays open; no release or parity claim follows from later phases.
- This session's Linux sandbox cannot reach LM Studio, so no local coding trial ran. Raising context length needs a model loaded on the user's computer; TrueForge keeps a manually raised contextLength.
- Checks previously copied at most 12,000 paths, silently dropping the rest, and stopped at 64 MB. Workspace.snapshot now builds an execution manifest of every permitted file plus lockfiles, up to 100,000 files and 2 GB, checks free disk space first, and fails with an ESNAPSHOTQUOTA reason instead of checking a partial tree.
- Files are cloned with copy-on-write where the file system supports it, never hard-linked. A source that changes during preparation fails the snapshot. Hashes are cached by size, modification time, change time, and inode; editor overlays are always rehashed.
- Agent checks and the independent verifier now share the snapshot. The verifier keeps its applied-text and source-unchanged checks and reports quota failures as environment-unavailable. Command results add an environment digest.
- Six snapshot tests passed, including a 12,051-file, 65 MB fixture, quotas, lockfiles, private-file exclusion, isolation, cache freshness, overlays, and stale drafts. Full suite: 376 tests, zero failures; runtime-dependent tests skipped in the sandbox. Source, type, and lint checks passed.
- Linux sandbox measurement on the fixture: first snapshot 3.86 s, repeats 2.64–2.73 s. The sandbox lacks copy-on-write cloning, so macOS timing remains unmeasured. The evaluator digest changed with the verifier; keep new runs separate.

### 22 November 2026 — Balanced category ranking; version 2 held-out measured

- Development misses were mostly user-facing documentation and a few test files crowded out by implementation files and planning documents.
- Ranking now leads with a balanced top ten: explicit matches, up to three implementation, test, and documentation files each, then the strongest remaining files. Planning and history documents rank below other documentation. Window scores are unchanged, so search ordering and packing inputs keep their values.
- Rejected a test-support demotion: it lowered development recall because one labelled test is a support file.
- Version 2 development recall rose from 68.06% to 83.33%; exact success stayed 100%. Selection used development queries only.
- Froze the candidate and evaluated the 16 fresh held-out queries once: held-out 87.50%, overall 85.00%, exact success 100%. Held-out and exact targets pass; the 90% overall target does not. Remaining misses are concept queries without shared vocabulary and labels whose expected files do not contain the queried identifier. Version 2 held-out is now exposed; a later claim needs a new held-out set.
- Added a ranking regression test that fails without the change. Full suite: 370 tests, zero failures; runtime-dependent tests skipped in the Linux sandbox. Source, type, and lint checks passed. Evidence: test-results/retrieval-v2-balanced/retrieval-latest.json.
- Next: larger-context local profiles and the frozen coding batch must run on the user's computer; this sandbox cannot reach LM Studio.

### 22 November 2026 — Hosted main profile authorized for Phase 10

- The user authorized a hosted main profile (OpenRouter and Groq keys) for the Phase 10 gate only. Phases 11 onward return to local models. Keys stay out of the repository and results.
- Added an explicit --hosted-main opt-in to the live runner. It requires an HTTPS endpoint, a key, and a model ID from the environment, refuses the local example provider name, registers the provider in the local TrueForge, and records only the endpoint host. Corpus runs without the flag still enforce loopback endpoints and zero spend.
- Qualification now accepts either a local zero-spend profile or a declared hosted main profile with measured spend in USD. The issue name is now declared-model-cost-profile-required.
- Two registration tests and two new qualification cases passed. Full suite: 369 tests, 258 passed, 111 skipped, zero failures, run in a Linux sandbox without the local TrueForge runtime, so runtime-dependent tests skipped. Source, type, and lint checks passed.
- Not yet run: no hosted trial. This session's sandbox cannot reach openrouter.ai or api.groq.com. Phase 10 remains open until the hosted batch and held-out retrieval are measured on the user's computer.

### 22 November 2026 — Registration guidance and command verification

- Added bounded advisory notes for new registration arguments that have no other identifier occurrence in the draft. These are syntax hints, not compiler findings. Inline selections and Python wildcard imports suppress the notes.
- Fixed a scan that could take too long on blank lines before an unfinished registration. Both language stress cases now handle 120,000 blank lines within the five-second test limit. The full suite passed: 364 tests, 347 passed, 17 skipped, zero failures. Source, type, and lint checks passed.
- The frozen Coder smoke failed the small task after 150 seconds with 117,641 tokens and 18 host tools. A project test passed and review occurred, but repeated bare interpreter calls exhausted the 12 approval-pause limit. The final result had no eligible patch. Keep the failed outcome.
- Flask timed out after 721 seconds with 402,675 tokens and 27 budget-counted host tools. Its partial checkpoint contains CLI and test changes. Five checks ran, including two failed tests. No final review or independent acceptance passed. All completed parent tools matched host authorization records. No compaction event occurred. API spending stayed zero.
- A separate disposable diagnostic confirmed that default Python imports loaded installed Flask. An explicit src path loaded the staged copy on the same input digest. This does not prove the model's partial patch is correct; its app-runner test also differs from the global CLI interface.
- Reject empty and stdin-only known interpreter calls before command approval. Keep the current pause limit, budgets, and review controls. The isolated and root focused suites each passed 11 tests.
- Added Python source-path guidance to the command description and results. The host does not change imports automatically. A real isolated regression fails without the source path and passes with an explicit path on the same staged input. All 19 focused checks passed. Source, type, and lint checks passed. The full regression suite passed: 367 tests, 350 passed, 17 skipped, zero failures.
- Rejected development-only Porter stemming. Replacement recall reached 81.94%; augmentation reached 84.72%. The unstemmed adaptive candidate reached 86.11%. Shorter prototype excerpts improved file coverage, which does not establish useful source coverage or task completion. These variants remain disabled. The fresh held-out queries remain unevaluated.
- Added a development-only source-witness diagnostic. Normal packing covered 56.94% of expected files, with 32.42% mean cited-line coverage. The 1,100-character prototype covered 86.11% of files, but only 10.40% of cited lines. A complete cited passage appeared for 19.44% of normal judgments and 2.78% of prototype judgments. Complete citations are a conservative measure. Keep the shorter packing disabled. This diagnostic overlapped the next Coder smoke, so its timing does not isolate a performance effect.
- The repeat Coder smoke completed the small task in 64 seconds with 27,326 tokens and four host tools. One test command, review, disposable apply, and independent acceptance passed. Flask timed out in 721 seconds with 345,151 tokens and 27 budget-counted tools. One CLI edit survived the permitted retry. It ran no check and reached no review. The Python source guidance was not exercised. Keep the profile unqualified.
- All completed parent calls matched host authorization records. No compaction event occurred. The coding model was unloaded and the dedicated test server was stopped before packaging. API spending stayed zero. No later phase has started.
- Built /tmp/agentextension-command-source-upgrade.vsix. The extracted-package runtime and saved-connection fixture passed: one test, zero skips or failures. The first extraction lost executable permissions; the repeat used unzip and passed. Scope: macOS arm64 host fixture, without interactive editor or cross-platform acceptance.

### 22 November 2026 — Exact-anchor insertion and fresh keyword ordering

- Traced the previous Flask draft to one numeric insertion at line 606, between an if branch and its else. The source shows a misplaced registration. It does not prove whether the model miscounted or chose the wrong location.
- Added insert_after for an exact source anchor. A repeated anchor needs a matching line address. Conflicting addresses, deletion with after-insertion, stale receipts, and edits outside the receipt or inline selection are rejected. A final source line without a line ending needs an exact-text replacement.
- Fourteen format tests passed. Eleven local runtime checks passed, including a wrong numeric address followed by a checked after-anchor repair and hunk review. The first integration invocation could not connect to the stopped test runtime; it passed after restart.
- Full suite after the anchor change: 350 tests, 333 passed, 17 skipped, zero failures. Source, type, and lint checks passed.
- Found a separate fresh-search defect. Keyword matches lost their relevance order when results were sorted by source location. A two-file reproduction returned a weaker match first. Preserved keyword scores internally through collection and pagination. Exact search retains source-location order. The failed Flask run used literal search, so this is a separate defect.
- Keyword, native search, and core checks first passed 20 tests with three runtime cases skipped. The repeat enabled the runtime and passed all 23, including a stronger duplicate-location assertion. Source, type, and lint checks passed. The full suite after both changes passed: 352 tests, 335 passed, 17 skipped, zero failures.
- The frozen GPT-OSS smoke completed the small task in 24 seconds with 15,571 tokens and three host tools. Flask ended incomplete in 304 seconds with 264,739 tokens and 18 host tools. It staged no files, ran no checks, and reached no review or independent acceptance. Public session metadata records four keyword searches and seven requested after-anchor edits. None of those edits staged a change. Keep the profile unqualified.
- Prepared a bounded source-hint change in a separate copy during diagnosis. Applied it after the batch ended. A rejected anchor can return up to three complete source lines from its existing receipt. The host still requires a new exact-anchor proposal before staging. Each suggestion is at most 240 characters; no fuzzy edit is performed.
- Twenty-eight focused checks passed after correcting the scripted fixture to unpack the runtime's error envelope. The first isolated run lacked its copied agent definition. The first integration fixture incorrectly parsed the wrapped error. Both setup issues are corrected; source checks and acceptance criteria remain strict.
- Full suite for the hint change: 355 tests, 338 passed, 17 skipped, zero failures. Source, type, and lint checks passed. Preparing a separate local-model smoke with the same tasks and budgets. The fresh held-out retrieval set remains unevaluated. A development-only tool-description expansion did not improve recall and remains disabled. No later phase has started.
- The source-hint smoke completed the small task in 25 seconds with 12,774 tokens. Flask timed out after 721 seconds with 399,917 tokens, 29 host tools, and no check or review. One CLI registration remained in its interrupted checkpoint. Read-only AST analysis accepted its syntax but found no config_command definition. This diagnostic cannot count as acceptance.
- The allowed model retry started after the 600-second turn limit. The first and retry sessions contain 32 completed model messages in total, matching the host report. One exact after-anchor edit staged successfully. The source-suggestion fallback was not exercised. No compaction event occurred. API spending stayed zero. Unloaded the test model and stopped the dedicated server.
- Ran a new local Nomic experiment on all 141 version 2 source files and only the 24 development queries. It used 966 excerpts, 125 local requests, 2,019,701 embedded characters, 44.9 seconds of preparation, and a 15.72 MB cache. No held-out query was embedded or evaluated.
- Across 20 fixed fusion and category recipes, the best candidate recall was 86.11%, with 62.50% file coverage after uniform 12,000-character prototype packing. The same score came from the pure lexical adaptive recipe; semantic fusion did not improve it. Keep these candidate-only variants disabled. Normal development recall stays 68.06%. Unloaded the embedding model after the experiment.

### 22 November 2026 — Retrieval version 2 published; Phase 10 continued

- Closed Phase 2's reopened data work. Published a hash-checked source manifest, corrected labels, 120 source judgments, and a freeze record. The 140 original source files stay unchanged. One add-only test overlay supplies the missing cancellation evidence.
- Ran both cancellation cases against the pinned source with that overlay. Both passed. Four corpus tests also check source identity, overlay attacks, fresh held-out queries, and the explicit held-out evaluation guard.
- Version 2 contains 24 development queries and 16 fresh held-out queries. The latter were fixed before evaluation and remain unscored. The same implementer reviewed their source. This is not an external independent benchmark.
- Normal lexical retrieval reached 68.06% Recall@10 on development queries and resolved all 16 exact development identifiers. A development-only category experiment reached 84.72%. It remains disabled; packing and task-completion effects are not established.
- Added an optional literal line-array edit format. It preserves indentation and backslashes, rejects ambiguous inputs, and retains current source receipts and review controls. Ten format tests and ten local runtime/completion checks passed.
- Full sequential suite: 345 tests, 328 passed, 17 skipped, zero failures. Native search and prepared Flask acceptance were enabled. Source, type, and lint checks passed.
- Continued Phase 10 with the installed GPT-OSS 20B model and unchanged budgets, with compaction enabled. The small task completed in 21 seconds with 12,219 tokens. Flask failed after 437 seconds with 286,615 tokens and 24 host tool calls. Only the CLI file changed. Independent checks found an indentation error; tests, documentation, and an agent check were absent.
- Public session evidence confirms one accepted new_lines edit. The host also requested verification once. No compaction event occurred. The format was exercised, but this run does not demonstrate a completion-quality gain. All completed parent tools matched host authorization records.
- The qualification checker accepted version 2 source readiness and rejected the partial coding and retrieval batch. The fresh held-out set remains unevaluated. Unloaded the test model and stopped the dedicated test server. API spending stayed zero. No later phase has started.
- Built /tmp/agentextension-line-array-upgrade.vsix. Its extracted-package runtime and saved-connection fixture passed: one test, zero skips or failures. Scope: macOS arm64 host fixture. This does not establish interactive editor or cross-platform acceptance. All 222 roadmap local links resolve. Source digests stayed unchanged after the live batch and package build.

### 21 November 2026 — Implementation started

- User authorized execution of all 24 phases in dependency order.
- Started Phase 1 at source commit 5c5fe67 with Node.js 24.18.0.
- Source, type, and lint baseline passed. The restricted test run could not start local test servers; rerunning the suite with the required process access.
- No model server responded at the documented local TrueForge, LM Studio, or Ollama addresses. Live evaluation remains pending a usable endpoint.

### 20 November 2026 — Planning

- Applied the requested build workflow to research, implementation planning, and progress setup.
- Used the current repository and the preceding Cursor/Codex comparison as the baseline.
- Reviewed the live-model scorer, context assembly, retrieval worker, workspace snapshots, recovery loop, workers, schedules, packaging, and existing acceptance records.
- Checked primary documentation for search, language features, worktrees, and rank fusion. Reused the official product sources checked in the comparison.
- Recorded the user's identifier and preference for small, testable phases.
- Created a 24-phase plan with explicit dependencies and G01–G15 coverage.
- Kept task-completion and retrieval gates ahead of broader autonomy.
- Documentation checks passed for 179 local links, 24 phase sections and initial states, 15 gap mappings, and dependency order. The plan has 96 phase tasks plus six post-implementation checks. No model or product benchmark ran.

### 21 November 2026 — Phase 1 completed

- Added strict host-evidence scoring and six distinct terminal outcomes. Required checks default to mandatory.
- Added independent patch application and acceptance checks in an isolated disposable checkout.
- Bound final agent checks to their saved patch evidence, not the source-free panel summary.
- Scoring tests cover missing tests, failing tests, stale patches, unrelated edits, malformed evaluations, terminal errors, false completion claims, cancellation, and missing infrastructure.
- Source, type, and lint checks passed. Full sequential suite: 216 tests, 138 passed, 78 skipped, zero failures. The earlier concurrent run hit a Notes test timing race; its targeted rerun passed all five tests.
- Started the installed Qwen 3.5 9B model and a separate local TrueForge 0.184.2 server. No hosted model or paid API was used.
- First live edit-and-check run: 271 seconds, reviewed patch and independent tests passed, final outcome incomplete because the harness lacked saved agent check patches. Preserved the result in test-results/upgrade-phase1. The fresh repeat passed all complete-task criteria in 251 seconds using the corrected evidence collector. Results are in test-results/upgrade-phase1-evidence-fixed.
- Added a frozen 20-task corpus and 40 retrieval labels. Validating reference solutions before freezing Phase 2.
- Retrieval baseline on 140 files at 5c5fe67: Recall@10 60.83%, held-out Recall@10 77.08%, exact identifier success 56.25%. This is a small-repository quality baseline, not the large-repository latency gate.

### 21 November 2026 — Phase 2 completed and Phase 3 started

- Validated the 15 new reference fixtures and their original bugs across JavaScript, TypeScript, and Python. Corpus checks: 18 passed. Scorer checks now include 14 passing cases.
- Validated the real pinned Flask CLI acceptance: the working command passed, and a registered command with wrong JSON output failed. All 58 CLI regression cases pass in the reference copy.
- Fixed fixture setup without weakening checks: pinned compatible pytest 8.4.2, disabled an unrelated async plugin, and supplied two hashed public dotenv fixtures inside the disposable copy. Real workspace dotenv files remain excluded.
- Added --corpus, --list, --repetitions, frozen budgets, source digests, runtime/hardware fields, and loopback-only enforcement.
- Reproduced Flask Task B on local Qwen: timed out at 720 seconds with no draft or check. The log shows many source reads and repeated searches. It does not prove a single root cause.
- Added host-observed progress timing and source-free saved traces. Four unit tests and one real TrueForge/editor trace test passed. Six question/skill integration tests also passed with scripted local models.
- Fixed the existing Notes test race by explicitly awaiting finite message completion. Interactive run messages remain nonblocking. Five Notes tests passed afterward.
- Full source/type/lint check passed. Full sequential regression run before the final fixture extension: 240 tests, 161 passed, 79 skipped, zero failures. Final verification is pending.
- User confirmed only one computer is available. Phase 18 is blocked. Phases 19–20 keep that dependency; no two-device acceptance is claimed.

### 21 November 2026 — Phases 3–5 completed; Phase 6 started

- Progress reports separate active work, user wait, repeated input signals, check failures, environment errors, transport errors, and unknown causes. Source text stays out of progress traces and central audit records.
- The frozen Flask profile stopped after 593 seconds at its token budget. It made 26 completed model calls and 27 host tool calls, with no final review or check. The saved report predates the scorer fix for automatic budget stops and says cancelled; current scoring classifies that case as incomplete. Preserve the original result. The evidence does not show repeated identical read inputs.
- Recovery keeps staged text across one eligible model retry. It drops old approvals and checks. Compaction restores the host task, approved instructions, draft revision, and check state through public runtime input and tool results.
- Added bounded stops after six identical rejected edits or three failed checks on identical snapshot inputs. A staged draft remains in the private checkpoint. One model response can already be in flight when cancellation reaches the runtime; no further tool dispatch is authorized.
- Verified failed check, repair, successful recheck, review, partial-hunk command scope, restart, compaction, cancellation, and external-write retry restrictions: 21 local runtime checks passed.
- Fresh search uses a controlled read-only ripgrep process when available and a bounded JavaScript fallback. It checks current source before forwarding native hits. Search hints cannot substitute for edit receipts.
- Native/fallback search and bounded recovery checks: 10 passed, zero skipped. Editor search integration also passed. The beyond-prefix fixture validates path discovery after the old 12,000-path cutoff; the full reference-scale run is separate.
- Added a versioned sharded source cache with full metadata reconciliation on each snapshot. Dirty buffer text stays in memory. Cache corruption, branch changes, rename/delete, exclusions, quotas, cancellation, and restart fixtures passed. Large-fixture performance remains under measurement.
- Full regression run with local scripted models: 264 tests, 244 passed, 20 skipped, zero failures. Later focused additions passed separately. Source, type, and lint checks passed before the final index UI wiring; final verification is pending.

### 21 November 2026 — Phase 6 completed; Phase 7 validation

- Reference fixture: 20,000 visible files, 199,537,780 bytes, Apple M5, 10 cores, 24 GiB memory, macOS, Node.js 24.18.0. The report records filesystem and process memory data.
- Cold snapshot returned in 1,468 ms. Warm snapshot returned in 417 ms with zero source-body reads and 20,000 cache hits. One saved change appeared in 438 ms, with one source read. All files were covered.
- Twenty warm exact queries found all targets. The initial sample met the 500 ms p95 target. Keep the individual timings and sample size; this is not a claim about all repository layouts.
- Added identifier-aware BM25 ranking and compared two fusion methods on the 24 development labels. Weighted score Recall@10: 61.11%; RRF: 59.72%. Selected the weighted score before evaluating the held-out split.
- Frozen lexical evaluation: Recall@10 68.33%, held-out 79.17%, exact identifier success 93.75%. The unchanged input digest is e0fb47d71bffbb8c3bfbf699f46daf69667304ed5277845855751b5057d05b36. These results miss the core quality targets. Do not close Gate A.
- The same Qwen model completed the strict edit-and-check rerun after the retrieval and recovery changes. This is one task, not the repeated 20-task qualification.
- Raw local results: test-results/retrieval-scale-latest.json, test-results/upgrade-ranking, and test-results/upgrade-combined-retrieval. They are ignored by Git. A source-free evidence summary will be included with the roadmap.

### 21 November 2026 — Phases 7–8 implemented; Phase 9 started

- Strict Qwen edit-and-check after retrieval/recovery changes: complete in 37 seconds, 24,855 tokens, first draft at 27.6 seconds, independent verification passed. This is a single observed attempt; it does not isolate the cause of the time difference from the prior run.
- Ranked retrieval scale sample after tokenization reuse: cold ranking 954 ms, warm p95 25.5 ms. A later combined-path sample recorded cold snapshot 1,991 ms, cold ranking 1,220 ms, warm ranking p95 32.9 ms, and exact search p95 497.3 ms. An intermediate parallel test sample recorded exact p95 554.1 ms. Preserve all samples; the exact-search target has limited headroom.
- Added optional document-symbol lookup and cached provider hints by document version, source generation, and provider state. Definition/reference results remain bounded and are read again through workspace scope checks.
- Added explicit related search with JS/TS/Python imports, matching test names, and documentation links. Inferred provenance stays visible. Slow or missing language providers fall back to text retrieval.
- Automatic relationship reranking reduced Recall@10 to 49.17%, held-out Recall@10 to 47.92%, and exact success to 81.25%. Rejected that default behavior. Kept the lexical ranker and explicit relationship hints. The experimental reranker remains available only to the ablation runner.
- The frozen retrieval held-out set is now exposed for later tuning. A new independent held-out set is required before a release claim based on subsequent changes.
- Fourteen relationship, provider, editor, and scheduled-runtime checks passed. Additional related-search and semantic-cache checks are running. Source/type/lint check passed.
- Loaded the installed local Nomic embedding model for the optional experiment. It is not used by normal search. No hosted model or paid API was used.
- Started three Flask Task B attempts with the frozen 12-minute, 400,000-token, 48-tool budgets. Each attempt will be recorded even if it fails.

### 21 November 2026 — Phase 9 completed; core qualification remains open

- Ran the local Nomic embedding ablation against the same pinned 140-file tree and 40 queries. It used 768-dimensional vectors, 59 local requests, 586,649 characters, 42.1 seconds of preparation, and a 2.28 MB private vector cache. API spending was zero.
- Hybrid Recall@10: 63.33% overall and 64.58% held-out. The lexical baseline was 68.33% and 79.17%. Rejected this embedding configuration. The runtime search path never enables it. Actual equal-budget packing is recorded separately from file-candidate recall.
- Added qualification checks for the full 20-task, three-repetition corpus. They reject partial batches, mixed models, duplicate attempts, changed inputs or budgets, false complete labels, and summary-only retrieval claims. One complete smoke task cannot qualify a model.
- Recorded the observed Qwen 3.5 9B local profile: 32,768 declared context tokens, 2,600 maximum output tokens, 600-second turn timeout, one eligible automatic retry, no fallback, provider-default temperature, and compaction disabled in coding evaluations. Separate scripted fixtures exercise cancellation and compaction.
- The automatic approval service briefly refused to run a test because its usage-limit check failed. No action bypassed review. On continuation, review worked again. The local runtime had stopped and was restarted before testing.
- The earlier final suite had 257 passes, three failures, and 18 skips. Two tests raced OAuth sign-in, and one checked the panel before checkpoint publication. Fixed explicit test waits. Targeted rerun: seven passed. The subsequent full suite passed: 278 tests, 261 passed, 17 skipped, zero failures. Later qualification and packing tests passed separately.
- Built /tmp/agentextension-upgrade.vsix. Bundled the retrieval worker's dependency graph. The extracted package passed its local connection and bundled-runtime test. This is a macOS arm64 check, not cross-platform acceptance.
- The interrupted Flask batch logged one 720-second timeout before the session ended. No complete batch artifact exists for it. Added durable per-attempt JSON records and started a replacement batch of three frozen trials.
- Published the source-free [evidence summary](evidence/local-results.json). Full local artifacts remain in ignored test-results directories. Final Flask and regression evidence will be added after the current checks end.

### 21 November 2026 — Inline search and durable evaluation evidence

- Corrected an inline-only search overlay issue found during final review. It now searches the full drafted file, keeps text outside the selection, and returns original line offsets. Seventeen focused core/search tests passed. This does not change the workspace-draft path used by the running Flask trials.
- Added atomic per-attempt result files. Completed attempts survive a later interruption. Added task-source revision and public model-configuration metadata for future runs.
- Added a [readable evidence report](EVIDENCE.md). It records negative experiments, slow performance samples, observed limits, and the open core gate. It separates coding observations from qualification results.
- The standard concurrent test command is running with the new qualification, packing, and inline-search fixtures. The previous full sequential run was clean.

### 21 November 2026 — First frozen replacement trial and budget diagnosis

- The first replacement Flask trial ended incomplete after 602 seconds. It used 627,551 reported tokens across 32 model calls and 32 host tool calls. The configured token budget was 400,000. No draft reached review or independent verification.
- The trace shows varied reads, searches, and one proposal attempt. It records no repeated identical read inputs. Do not label this an identical-read loop.
- Found delayed usage accounting in interactive streamed turns. Read-only scheduled runs already count usage during the stream. Prepared the same accounting behavior for interactive runs in an isolated source copy. A local scripted model test passed: the token stop ended its loop before the autonomous turn finished, with no retry and no source write.
- The fix is not yet applied to the working runtime. The remaining frozen trials continue with the original behavior. Apply it after the batch ends, then rerun the stream-budget and recovery tests.
- A development-only category-diversity ablation reached at most 79.17% Recall@10. A different allocation reached 72.22% and 16/16 exact matches. No variant reached the overall target. Kept this experiment outside runtime ranking and did not use held-out queries for its selection.
- Latest standard concurrent suite: 282 tests, 265 passed, 17 skipped, zero failures. Source/type/lint checks passed after the inline-search correction.

### 21 November 2026 — Source identity and profile isolation

- New model attempts record an implementation digest for source files, the agent definition, and the package manifest. The qualification checker rejects mixed implementation digests. Historical smoke results remain valid observations but cannot qualify a new corpus profile.
- Both isolated budget candidate tests passed. One stops an unbounded interactive read loop. The other preserves a staged draft and clears review authority. Completed message usage is counted once.
- All 24 roadmap phases remain present. The documentation link check resolved 184 local links. Phases after the core gate retain their acceptance dependencies.

### 21 November 2026 — Second frozen Flask result

- The second replacement Flask trial timed out after 721 seconds. It reached the frozen 12-minute limit with no reviewed patch or independent verification. It dispatched no unapproved action.
- Two durable attempt records now exist. The third required attempt is running. These results cannot qualify the local profile even if the final attempt passes.
- Prepared an additional retry-context correction in the isolated candidate. It retains the previous approved plan as reference text while clearing its authority. A direct check passed. The candidate will be applied after the frozen batch.

### 21 November 2026 — Additional recovery checks

- The isolated candidate now has three passing local runtime tests: live token-budget cancellation, staged-draft preservation, and plan constraints retained as reference with fresh plan approval after retry.
- Qualification also rejects a complete label without measured wall time, token use, and tool-call use within the frozen task budget.
- Checked a development-only query-expansion experiment. Its best measured Recall@10 was 75%; it stayed outside runtime behavior. The failed retrieval targets remain visible.
- Checking the installed Qwen3 Coder memory estimate as a possible separate local model profile. This does not change the selected model or interrupt the running frozen trial.

### 21 November 2026 — Frozen Qwen batch completed; fixes applied

- Completed all three replacement Flask trials. Outcomes: incomplete after 602 seconds; timed out after 721 seconds; timed out after 720 seconds. Token totals: 627,551; 305,518; 256,526. Host tool calls: 32; 23; 27. No trial dispatched an unapproved action. None reached a reviewed and independently verified patch.
- All attempts and the batch summary are saved in test-results/upgrade-flask-three-fixed. The corpus qualification remains failed for this profile. Do not count the one earlier small-task pass as qualification.
- Applied streamed interactive usage accounting after the frozen batch ended. Existing soft limits, review allowance, and the 125% hard stop remain. The host now observes completed message usage during an autonomous turn.
- Applied previous-plan recovery as reference text. A model retry drops plan authority and requests fresh approval. The staged draft remains recoverable after budget cancellation.
- Focused budget, recovery, compaction, and scheduled-limit regression checks: 16 passed, zero skipped. Source/type/lint check passed. Full suite is running.
- Built /tmp/agentextension-upgrade-final.vsix with the latest source fixes. Its extracted-package check is next. No release or cross-platform acceptance is claimed.
- Unloaded the finished Qwen 3.5 test model. The installed Qwen3 Coder estimate is 14.41 GiB at 32,768 context tokens. Its resource guard passed after unloading the earlier model. Loading it for a separate local profile; the product's selected model is unchanged.

### 21 November 2026 — Final regression suite and separate coding profile

- Full standard suite after applied fixes: 286 tests, 269 passed, 17 skipped, zero failures. It includes the new streamed-budget, recovered-plan, qualifier, inline-search, and semantic-packing cases.
- Loaded the installed Qwen3 Coder 30B-A3B model with 32,768 context tokens and one parallel prediction. The load used 12.38 GiB. Its memory guard passed after the previous model was unloaded. No resource guard was bypassed.
- Registered local-upgrade-coder/main in the dedicated evaluation runtime. The extension's selected model was not changed. Started a separate frozen smoke batch: edit-and-check and Flask Task B, one repetition each. It cannot qualify the full corpus.

### 21 November 2026 — Coding-profile and editor-compatibility findings

- The first Qwen3 Coder smoke batch did not qualify. The small edit task staged a patch and passed its check, then timed out while the model requested review again. The Flask task failed after 64 seconds at the fixed 12-approval-pause limit. Preserve both failed outcomes in test-results/upgrade-coder-smoke.
- Public session events confirm that the first small-task review succeeded. The harness only handled one review per draft revision and waited on the repeated request. Added a review-request sequence for the harness.
- Added idempotent review reporting for the same revision and accepted subset. Rejected hunks remain rejected. Current permission checks still apply. A source change or new draft revision requires a new review.
- Found the installed VS Code binary at the newer @vscode/ripgrep-universal platform path. The native adapter now checks both old and new editor layouts. Nine native/fallback discovery and search tests passed against VS Code's actual bundled binary.
- The test host can explicitly use an installed editor application root. The earlier smoke batch used its JavaScript search fallback. New runs record that environment separately.
- Reloading the installed coding model after its idle unload. Fresh evaluation follows the review-flow regression checks. No paid model API is used.

### 21 November 2026 — Repeated review and command-evidence corrections

- Repeated review now reports the current accepted subset without reopening the same dialog. Rejected hunks remain rejected. The local runtime test verified the final accepted patch and unchanged workspace. The harness also tracks review request sequence instead of draft revision alone.
- The corrected local coding-profile edit-and-check run completed in 45 seconds. It passed review, project checks, disposable apply, and independent acceptance. The fresh Flask attempt is still running. Earlier failed smoke results remain recorded.
- Found repeated Python invocations with empty argument lists in the earlier Flask smoke. They returned zero without a supplied script because standard input is closed. Such runs are now labelled diagnostic only in the tool result, panel, saved report, progress trace, and task evidence.
- Strengthened requested-test scoring. Missing command metadata, a bare interpreter, an unrelated command, or a version probe cannot count as the requested project test. Generated Python tasks require a unittest entry point. Existing task prompts and input digests are unchanged.
- Command output now states that writes stay in the disposable copy and do not stage editor changes. A local fixture repaired a diagnostic-only command, ran the real test, and reached review.
- The focused evidence/scorer/corpus/recovery run passed 38 tests. Source/type/lint checks passed. Before the final diagnostic-evidence change, the full suite passed 288 tests: 271 passed, 17 skipped, zero failures. A final full run is pending.

### 21 November 2026 — Serial verification and edit-format recovery

- The full concurrent diagnostic suite had one compaction test fail to connect to the local runtime. The model trial and concurrent tests shared this computer. This is an observed transport failure; resource pressure is a possible explanation, not a proven cause.
- With the model trial finished, the full sequential suite passed: 291 tests, 274 passed, 17 skipped, zero failures. It includes the diagnostic-only command changes.
- The fresh native-search coding-profile smoke completed the small task in 45 seconds with 51,570 tokens. Flask timed out after 721 seconds, with 223,482 tokens and 25 host tool calls. It dispatched no unapproved action. Results remain in test-results/upgrade-coder-review-fixed.
- Public tool responses identified concrete format failures: a missing replacement line ending, a non-unique anchor, and multiline text in a single-line anchor field. Added narrow normalization for copied trailing anchor line endings and replacement line endings before following source. Multiline anchors receive an exact-text replacement hint.
- Updated agent guidance to prefer short exact-text replacements for blocks. Current receipts, excerpt bounds, inline restrictions, review, and apply checks remain enforced. Focused tests include stale source, CRLF, and end-of-file behavior.
- The first line-recovery test run hit two test-helper JSON parsing errors on plain-text tool failures. Corrected the helper and reran the cases; the implementation assertions did not fail. The passing rerun is recorded separately.
- Core-first sequencing remains in effect while the optional sequence question is unanswered. Later autonomy gates stay open.

### 21 November 2026 — Draft timing and fresh local trial

- The latest edit-format, progress, repeated-review, and first-draft timing checks passed: 12 tests, zero skipped, zero failures.
- Added a durable first nonempty draft timestamp. It survives bounded trace retention. New model results separate staged-draft time from first-review time. Corrected the historical evidence description; old firstPatchMs fields measured first review and remain unchanged in raw files.
- Started one fresh Flask trial on local-upgrade-coder/main after the format repairs. The frozen task, 12-minute limit, token and tool budgets, and independent acceptance checks remain unchanged. The model uses VS Code's installed native search backend.
- Kept runtime source fixed during the trial. Retrieval research uses only development labels. No later phase is marked complete from a prototype or a missing physical-device result.
- Published both [observed model profiles](MODEL-PROFILES.md), with their settings, tool failures, cancellation evidence, and limits. Completed the profile-definition task in Phase 10. Qualification remains open.

### 21 November 2026 — Core-first decision and measured repairs

- The user selected continued core-gate work. Keep later phases pending. Do not expand autonomy while this gate remains open.
- The format-recovery Flask trial staged a first draft at 249.3 seconds and reached review at 490.3 seconds. It still timed out. Its terminal record took 878 seconds, with 467,082 tokens, 27 host tool calls, and no independent acceptance. The long delay before cancellation has no proven cause.
- Compared all 30 public model-message usage records with the saved total. They match. The trial used the existing review allowance above its soft token limit. Strict task scoring still rejects it.
- The runner now records its longest poll gap and deadline overrun. It stops approval handling when a poll reaches the deadline. It captures a partial checkpoint before timeout cancellation. Wall time includes report collection, independent acceptance, and cleanup. Model-run and verification times remain separate.
- Invalid run_command and propose_plan inputs now get a specific repair reason before approval. An invalid executable string cannot run or open a command dialog. An ambiguous anchor offers a line number within its existing receipt bounds. Twelve focused command, line, and ranking checks passed.
- The agent now receives the run's host limits and at most four progress notices. Notices do not increase limits or grant tools. Twenty budget, prompt, line, and core checks passed. Forty focused recovery, scoring, and retrieval checks passed.
- Exact registered-tool declarations now outrank repeated call sites. On the same exposed 40-query tree, Recall@10 is 69.17%, held-out recall is 79.17%, and exact success is 16/16. Both recall targets remain missed. A separate development-only normalization experiment remains disabled.
- Added a local-only synthetic tool-text probe. Its first request format received HTTP 400. The corrected probe passed four of six exact comparisons. Both multiline cases lost one trailing newline. This does not isolate model generation from the serving parser. No returned function was executed.
- Source/type/lint checks passed. Full sequential suite: 304 tests, 284 passed, 20 skipped, zero failures. Available pinned Flask and native-search checks are running separately. Packaged acceptance remains pending for these latest changes.

### 21 November 2026 — Batched retrieval and stronger evidence

- The budget-guidance coding-profile small task completed in 255 seconds. It used 117,397 tokens and had no deadline overrun. The Flask task timed out after 721 seconds, with 498,388 tokens and 28 counted host tool calls. Its longest poll gap was 1,059 ms; deadline overrun was 476 ms.
- The Flask checkpoint preserved implementation, test, and documentation edits. Independent diagnosis failed with a duplicated function header and indentation error. Keep the original timeout outcome. No independent task pass is claimed.
- Added read_files for up to four known excerpts and 12,000 source characters per batch. Each excerpt keeps its own current receipt. Private exclusions, stale-source rejection, cancellation, and repeated-read bounds still apply. Twenty-four focused editor and read-only scope checks passed.
- The first batch-read checks found an incorrect test buffer adapter and two exact tool-list expectations. Corrected the adapter to use full editor paths and added the new read-only tool to the expected lists. The rerun passed. No private source was returned.
- Added bounded budget notices, budget context after retry or compaction, and review guidance that makes the user's later apply step clear. Eleven focused retry, review, and compaction checks passed.
- Replaced the live runner's assumed zero unapproved-action count with measured matches between completed parent tool calls and host allow records. Incomplete traces stay unknown. Added seeded unmatched-call and cross-run cases. The saved prior batch also passed this metadata cross-check. It does not replace dispatch-policy tests.
- Added an evaluator digest. The qualification checker now rejects mixed or missing evaluator provenance. Historical attempts remain recorded but do not satisfy the new provenance requirement.
- Ran full-source local embeddings as a separate experiment: 964 excerpts, 42.6 seconds of preparation, 127 requests, 2,016,619 characters, and a 15.69 MB cache. Selected equal-weight fusion on development data. Recall@10 was 75.83% overall and 81.25% on the exposed held-out set. Keep this configuration disabled; targets remain missed.
- Latest full sequential suite with available Flask and native dependencies: 315 tests, 298 passed, 17 skipped, zero failures. Source/type/lint checks passed. Package verification is pending for these latest changes.
- Unloaded the completed coding and embedding profiles. The installed GPT-OSS 20B resource estimate passed. Loaded it with one prediction, 32,768 context tokens, and a 30-minute idle limit. Registered a separate local evaluation provider. Started two frozen smoke tasks. The product's selected model is unchanged.

### 21 November 2026 — Third local profile completed

- GPT-OSS completed edit-and-check in 18 seconds. It used 11,492 tokens and three host tool calls. The patch passed review, project tests, disposable apply, and independent acceptance. The authorization collector matched all three completed calls.
- Its Flask run ended after 617 seconds with 344,551 tokens and 29 host tool calls. Only src/flask/cli.py changed. It reached review and disposable apply, but independent tests failed with a syntax error. Required tests and documentation were absent. Strict scoring reports failed.
- The synthetic GPT-OSS text probe passed three of six exact comparisons. Keep it separate from task completion. No completed parent tool call in the coding batch lacked a matching observed host authorization record.
- Recorded LM Studio 0.4.28+2 and VS Code 1.146.0. VS Code supplied native search; coding runs used the host fixture. No interactive editor UI acceptance is claimed.
- Unloaded the completed local model. Automatic permission review timed out on the first unload request. Its permitted single retry succeeded. No approval remains blocked.
- Built /tmp/agentextension-core-upgrade.vsix. Its extracted-package connection and bundled-runtime check passed: one test, zero skipped, zero failures. The source-free result summary records its byte count and SHA-256. This is a macOS arm64 host-fixture check. No release or cross-platform support claim is made.
- The qualification checker correctly rejected the two-attempt GPT-OSS smoke batch. It recorded one complete task, no complete Flask attempt, and both missed recall targets. No evaluator-provenance or authorization-evidence issue was found in that batch.
- Phase 10 remains open. All three installed local profiles remain unqualified. Both default and experimental retrieval recall remain below target. Later phases stay pending under the user's core-first decision.

### 21 November 2026 — Verification before finishing

- Continued the core-first work after the user's request. The previous GPT-OSS Flask result had no project check and ended with only the CLI patch. Its independent syntax failure stays recorded.
- Added one bounded verification follow-up when a staged draft ends without a current passing check. It restates the original task and asks for missing implementation, tests, documentation, and an appropriate check. It preserves command approval, user restrictions, budget limits, rejected hunks, and fresh review after changes.
- Review nudges now include current host task facts. The panel describes an unchecked draft as verification incomplete. It does not call that draft a completed task.
- Version and help probes are diagnostic only. A successful diagnostic cannot reset the unchanged-failing-check guard. The strict requested-test scorer retains its independent criteria.
- The new real-runtime fixture stages broken code, reaches review, gets the bounded follow-up, fails its check, repairs the draft, passes a recheck, and requests fresh review. A separate fixture honors an explicit no-command request and ends after one follow-up with the verification limit visible.
- Focused verification tests passed: 25 tests, zero failures. The first run found one old test that expected only one model summary. Updated it for the intentional bounded follow-up and reran. Full sequential suite: 319 tests, 302 passed, 17 skipped, zero failures. Source/type/lint checks passed.
- Loading the installed local GPT-OSS model for another frozen Flask trial. Keep the task, time, token, tool, and independent acceptance contracts unchanged. The product's selected model remains unchanged.

### 22 November 2026 — Draft feedback and explicit execution settings

- Recovered the saved results after the interrupted session. The verification-follow-up batch passed the small task in 20 seconds. Flask ended incomplete after 35 seconds with no draft or final answer. Public session evidence showed an empty final model message.
- Added one bounded continuation for an empty result. Repeated empty output stays visibly incomplete. A completed external write prevents automatic continuation. No command approval or apply rule changed.
- Added bounded edit previews with surrounding lines. They show current draft structure and indentation. They grant no read receipt. Inline previews remain within the selected text.
- The later Flask trial finished incomplete after 396 seconds. It used 516,424 tokens and 25 budget-counted host tools. Its saved draft contained one incorrectly indented CLI registration. It never reached review or project checks. The frozen token limit failed. Preserved the terminal result and partial checkpoint.
- Full sequential suite after these runtime changes: 325 tests, 308 passed, 17 skipped, zero failures. Source, type, and lint checks passed.
- Reviewed four development retrieval judgments against the pinned source. Several expected test paths do not directly assert the requested behavior. Recorded the findings in [LABEL-REVIEW.md](LABEL-REVIEW.md). Keep version 1 labels and scores unchanged. A new corpus needs cited source evidence and a new independent held-out set.
- Fixed category allocation reached 79.17% overall recall and 77.08% on the exposed held-out split. The latter regressed. The structural-field experiment also missed the target. Both remain disabled in normal search.
- Added an explicit --compaction evaluation option. The product already supports history summarization. Historical coding trials disabled it. New attempts record actual execution settings, and qualification rejects missing or mixed settings. Inputs and task budgets stay frozen.
- Focused execution-setting, strict-scoring, and real-runtime compaction checks: 23 passed, zero skipped, zero failures. The initial restricted run could not start isolated child checks; the required-access rerun passed.
- The first separate local GPT-OSS profile with compaction enabled passed the small task in 27 seconds. Flask ended incomplete after 354 seconds, with 279,127 tokens and 25 tools. It staged no files and returned a plan that promised future work. No compaction event occurred. Do not claim a benefit from enabling the setting alone.
- Added one bounded follow-up for a promise of implementation without a draft. It preserves planning-only and no-edit requests. External writes prevent the continuation. Repeated promises stop. The no-draft panel now says that the run ended and asks the user to review unfinished work; it makes no task-completion claim.
- Closed another diagnostic-check gap: a help probe with extra file arguments cannot count as a project test. Focused completion, approval, scoring, and profile checks: 39 passed, zero skipped, zero failures.
- The next frozen local smoke passed the small task in 22 seconds with 11,951 tokens. Flask failed after 635 seconds with 499,063 tokens and 30 budget-counted tools. It reached review with only the CLI file changed. Independent checks found literal backslash-n text causing a syntax error. Tests, documentation, and an agent check were missing. The token limit failed. No compaction event occurred. All completed parent calls matched observed authorization records.
- This live batch did not exercise the new promise continuation. Scripted runtime fixtures prove its bounded control flow, not a model-quality gain. The qualification checker rejected the partial batch and the missed completion and retrieval targets. No paid API was used. Phase 10 remains open.
- The final regression suite runs during this smoke batch. Its timings do not isolate the performance effect of the source change. Completion still uses the unchanged task budget and acceptance checks.
- The first full run had 330 tests: 310 passed, 19 skipped, and one failure. A skill-selection fixture still waited for the retired Run complete label. Updated its expected terminal wording. Both skill fixtures then passed. Two native-search fixtures need the trusted executable setting in the final rerun; they are available on this computer.
- Extended diagnostic evidence checks to short runtime version flags followed by a file name. A real Node probe confirms that the version flag exits without running that file. The command-evidence fixture uses this case before a real project test.
- Final full sequential regression: 330 tests, 313 passed, 17 skipped, zero failures. Native-search and prepared Flask acceptance fixtures were enabled. Source, type, and lint checks passed. All 210 roadmap file links resolved. The pinned Flask checkout stayed clean.
- Unloaded the local evaluation model and stopped the dedicated evaluation service before refreshing package dependencies. Built /tmp/agentextension-completion-upgrade.vsix. Its extracted-runtime connection check passed: one test, zero skipped, zero failures. It covers the bundled service, saved credentials, model connection, and authenticated health endpoint on macOS arm64 through the host fixture. The source-free summary records its size, SHA-256, and final source digests.
- The last live smoke predates only the final short-version diagnostic extension. The final full regression covers that extension. No additional live-model quality claim is made. Phase 10 remains open; later phases keep their dependencies, and the physical second-computer gate remains blocked.

### 22 November 2026 — Complete source audit and cancellation coverage

- Continued the core gate work. Audited all 40 retrieval queries and all 120 implementation, test, and documentation judgments against commit 5c5fe676a444d51a5163c89abdb39dec0860817e.
- Added a versioned citation manifest for 56 source files. It records exact line ranges, source and excerpt hashes, original labels, review reasons, and proposed replacements. The validator rejects changed source, changed labels, missing or duplicate judgments, invalid ranges, unsupported decisions, and uncited targets. Summary-only claims cannot pass qualification.
- Retained 114 judgments. Proposed five test-path corrections for query-01, query-04, query-09, query-18, and query-21. Query-20 has no direct cancellation-and-copy-cleanup assertion in the pinned tree. The original labels, candidate results, scores, and targets remain unchanged.
- Added current-code tests for cancellation during a real isolated command and cancellation before materialization. Both passed. The running-command case observed process termination, removal of the private copy, and unchanged workspace text. Its process-observation check is macOS-specific. The new file is absent from the pinned tree and cannot fill that older corpus's gap.
- Reopened Phase 2's retrieval-data work. A new source and corpus version must carry the reviewed corrections and chosen cancellation evidence. The exposed held-out set cannot become independent again through label correction.
- Qualification now validates raw review and pinned source data and blocks unresolved findings. Evaluator digests include the retrieval labels, manifest, validator, and source reader. The latest historical GPT-OSS smoke remains unqualified when checked with this stricter evaluator. Its original result files stay unchanged.
- Focused judgment and qualification tests: six passed. Native cancellation tests: two passed. Final full sequential regression: 336 tests, 319 passed, 17 skipped, zero failures. Native search and prepared Flask acceptance were enabled. Source, type, and lint checks passed. No real-model trial or paid API ran during this continuation.
- The runtime implementation digest still matches the previous tested package. The evaluator digest changed to cover the source-judgment gate and its inputs. Saved both in the source-free evidence summary. Stopped the dedicated local test service after verification.

## Files Changed

- [RESEARCH.md](RESEARCH.md): evidence, alternatives, decisions, and references.
- [IMPLEMENTATION.md](IMPLEMENTATION.md): phases, dependencies, targets, tests, rollout, and release gates.
- [PROGRESS.md](PROGRESS.md): initial phase and gate tracking.
- [EVIDENCE.md](EVIDENCE.md), [MODEL-PROFILES.md](MODEL-PROFILES.md), and [LABEL-REVIEW.md](LABEL-REVIEW.md): measurements, failed attempts, profile limits, and relevance-judgment findings.
- [Forge](../../src/forge.js), [recovery](../../src/recovery.js), [task state](../../src/task-state.js), and [progress](../../src/run-progress.js): bounded recovery, current task facts, verification follow-up, and metadata traces.
- [Editor tools](../../src/bridge.js), [workspace](../../src/workspace.js), and [panel](../../media/panel.js): current read receipts, batch reads, bounded draft previews, command evidence, and visible run state.
- [Search](../../src/search.js), [source index](../../src/repository-index.js), [lexical ranking](../../src/lexical-index.js), [relationships](../../src/relationships.js), and [embedding experiment](../../src/embedding-provider.js): fresh retrieval and measured optional paths.
- [Model runner](../../test/model/run.cjs), [strict scorer](../../test/model/evaluate.cjs), [verifier](../../test/model/verify.cjs), and [qualification](../../test/model/qualify.cjs): frozen tasks, independent acceptance, durable evidence, explicit execution settings, and negative fixtures.
- [Judgment manifest](../../test/retrieval/judgments.json), [citation validator](../../test/retrieval/judgments.cjs), and [cancellation regression](../../test/workspace-command-cancellation.test.js): source evidence for every retrieval judgment, a qualification readiness gate, and current-code command cleanup coverage.
- [Package builder](../../scripts/package-vsix.cjs): bundled retrieval worker dependencies and packaged runtime checks.
- [Remaining work](../remaining-work.md): link to this roadmap without replacing the existing inventory.

## Architectural Decisions

1. Keep the VS Code extension and public TrueForge APIs.
2. Treat strict completion evidence as the first deliverable.
3. Start retrieval with fresh exact search, incremental indexing, lexical ranking, and language relationships.
4. Make embeddings optional and subject to measured benefit.
5. Keep reviewed apply, stale-source checks, policy, revocation, and redacted audit as cross-phase requirements.
6. Separate managed dependency setup, verification, background coding, sharing, and remote execution scopes.
7. Do not claim parity or close an acceptance gap from scripted tests alone.

## Lessons Learned

- The existing live harness is useful, but pass with gaps is not a complete-task release gate.
- A documented timeout is evidence of failure under a specific setup, not proof of a single root cause.
- Retrieval coverage, search freshness, and context selection are separate requirements.
- Existing exact-command allow rules and collaboration functions should be extended, not rebuilt as duplicate systems.

## Update Rules

When a phase starts, record In Progress and the source baseline. Mark tasks in the implementation document as they complete. Link test commands, environment versions, and acceptance artifacts. Record failures and skipped checks. Mark Completed only when the success criteria pass. Then select the next phase whose dependencies are complete.

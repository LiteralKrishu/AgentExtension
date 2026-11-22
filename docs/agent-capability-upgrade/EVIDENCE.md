# Agent Capability Upgrade Evidence

Updated: 22 November 2026. Source baseline: 5c5fe67. This is a local implementation record. It does not establish parity with Cursor or Codex.

## Current decision

The core components for Phases 1–9 are implemented. The optional semantic configuration was rejected after measurement. Phase 2's reopened retrieval-data work is complete: version 2 resolves the source findings and freezes fresh held-out queries. The core qualification gate remains open. The fresh held-out set is unmeasured, and no local model profile qualifies. Only one physical computer is available. Phases 18–20 cannot pass physical-device acceptance in this environment.

The [source-free result summary](evidence/local-results.json) records the main measurements. Raw source-bearing reports remain under ignored test-results folders. The [progress tracker](PROGRESS.md) records each open phase.

## Validation

| Check | Observed result |
| --- | --- |
| Current command validation and Python source guidance | 367 tests: 350 passed, 17 skipped, zero failures; 19 focused tests passed |
| Current command/source package and bundled runtime | One passed, zero skipped or failed; macOS arm64 host fixture |
| Full suite after registration guidance and scan stress fix | 364 tests: 347 passed, 17 skipped, zero failures |
| Full suite after bounded source-anchor suggestions | 355 tests: 338 passed, 17 skipped, zero failures |
| Full suite after exact-anchor insertion and keyword ordering | 352 tests: 335 passed, 17 skipped, zero failures |
| Exact-anchor insertion before the keyword correction | 350 tests: 333 passed, 17 skipped, zero failures |
| Anchor hints, edit formats, runtime repair, and completion follow-up | 28 passed, zero skips or failures |
| Keyword order, pages, freshness, native search, and core behavior | 23 passed, zero skips or failures |
| Current full suite after version 2 and literal line arrays | 345 tests: 328 passed, 17 skipped, zero failures |
| Versioned source, overlay integrity, held-out guard, and pinned cancellation execution | Four passed, zero skips or failures |
| Versioned qualification provenance and citation controls | Seven passed, zero skips or failures |
| Literal line-array and edit-format checks | Ten passed, zero skips or failures |
| Line-array runtime and completion checks | Ten passed, zero skips or failures |
| Previous full suite after judgment validation and cancellation coverage | 336 tests: 319 passed, 17 skipped, zero failures |
| Previous full suite after completion and diagnostic fixes | 330 tests: 313 passed, 17 skipped, zero failures |
| Source judgments and qualification controls | Six passed, zero skipped, zero failures |
| Direct command cancellation and copy cleanup | Two passed, zero skipped, zero failures; running-process observation tested on macOS |
| Full local sequential regression suite | 278 tests: 261 passed, 17 skipped, zero failures |
| Latest standard concurrent suite after recovery fixes | 286 tests: 269 passed, 17 skipped, zero failures |
| Built package connection and bundled runtime | One passed |
| Current line-array package, extracted runtime and saved connection | One passed, zero skipped; macOS arm64 host fixture |
| Previous completion package, extracted runtime and saved connection | One passed, zero skipped; macOS arm64 host fixture |
| Later qualification and semantic-packing tests | Six passed |
| Serial suite after command-evidence changes | 291 tests: 274 passed, 17 skipped, zero failures |
| Edit-format, first-draft timing, progress, and repeated-review checks | 12 passed, zero skipped |
| Latest full suite with Flask and native-search dependencies | 315 tests: 298 passed, 17 skipped, zero failures |
| Full suite after verification follow-up, empty-result recovery, and edit previews | 325 tests: 308 passed, 17 skipped, zero failures |
| Execution settings, strict scoring, and runtime compaction | 23 passed, zero skipped, zero failures |
| Batch reads, current receipts, and read-only scope | 24 passed, zero skipped |
| Source, type, and lint checks | Passed |
| Roadmap local links before the current documentation update | 223 resolved |

The earlier final regression run failed three tests. Two tests advanced before OAuth sign-in finished. One test checked the panel before checkpoint publication. Explicit completion waits fixed those cases. The subsequent full run passed. Missing model or physical-device tests remain separate from deterministic fixtures.

The first completion-follow-up full run had one outdated status expectation. Its skill fixture waited for Run complete after the product changed to Run ended. Updated that assertion. The final full run passed all 313 enabled tests, including native search and prepared Flask acceptance. The 17 skipped cases remain unverified by that run. Source, type, and lint checks passed. The pinned Flask source checkout stayed clean.

The previous package is /tmp/agentextension-completion-upgrade.vsix. Its extracted-package fixture passed the bundled-runtime, saved-credential, model-connection, and authenticated-health checks. The source-free summary retains its SHA-256 and implementation digest. This is a macOS arm64 host-fixture check. The final short-version diagnostic extension was added after that package's last live smoke and passed its final full regression. No new live-model completion result is implied by that historical check.

The earlier source-judgment continuation changed evaluation code and tests. Its full suite passed 319 tests with 17 skipped. No real-model trial ran in that continuation. Its rechecked historical batch remained unqualified, with unresolved version 1 label findings as an additional blocker. The current version 2 and line-array continuation changes both runtime and evaluation code. Its full suite passed 328 tests with 17 skipped. The previous package does not contain the new edit format.

## Coding observations

The strict local Qwen edit-and-check attempt passed in 251 seconds after a harness evidence fix. A later combined retrieval/recovery attempt passed in 37 seconds, with a first reviewable patch at 27.6 seconds and 24,855 tokens. The same task passed review, disposable application, and independent checks. These are individual attempts. They do not isolate the cause of the time difference or establish a complete-task success rate.

Historical firstPatchMs values measured the first patch shown for review. New runs record firstPatchMs from the first nonempty staged draft. They also record firstReviewPatchMs. Neither timestamp proves that the patch is correct. Independent acceptance remains required. The original result files remain unchanged.

The original Flask Task B run timed out after 720 seconds without a reviewed patch. A later frozen-profile run stopped at its token budget. The interrupted three-attempt batch logged another 720-second timeout before the session ended. That batch has no complete JSON summary. The replacement first attempt stopped at its 400,000-token budget after 602 seconds. It had no final review or independent verification. The second attempt timed out after 721 seconds with no reviewed patch. The third attempt also timed out after 720 seconds. All three attempts lack a reviewed, independently verified patch. Each terminal attempt is saved separately.

## Retrieval quality

The historical variants below use the same pinned 140-file source tree. Its input digest is e0fb47d71bffbb8c3bfbf699f46daf69667304ed5277845855751b5057d05b36. Recall@10 measures labelled relevant files in the first ten distinct file candidates.

| Variant | Overall Recall@10 | Held-out Recall@10 | Exact identifier success | Decision |
| --- | --- | --- | --- | --- |
| Original lexical ranker | 60.83% | 77.08% | 56.25% | Historical baseline |
| Identifier-aware BM25 | 68.33% | 79.17% | 93.75% | Keep; below core targets |
| BM25 with exact registered tools | 69.17% | 79.17% | 100% | Current; overall recall remains below target |
| Automatic relationship reranking | 49.17% | 47.92% | 81.25% | Reject automatic reranking |
| Local Nomic hybrid | 63.33% | 64.58% | Not used for qualification | Reject this configuration |
| Full-source Nomic chunk hybrid | 75.83% | 81.25% | 100% | Research only; below recall targets |
| Fixed category allocation: 3 implementation, 3 tests, 4 documentation | 79.17% | 77.08% | 100% | Research only; exposed held-out recall regressed |

Weighted lexical scoring was selected over reciprocal rank fusion on the 24 development queries before the lexical held-out evaluation. The original held-out set is now exposed for subsequent tuning. A later release claim needs a new independent held-out set.

A [complete source review](LABEL-REVIEW.md) covers all 120 historical judgments across 40 queries. It retains 114 judgments, proposes five test-path corrections, and records one missing cancellation-and-cleanup test in the pinned tree. All citations match that source. Version 1 and these scores remain unchanged.

Retrieval version 2 resolves those findings. Its source contains the unchanged 140-file snapshot plus a hashed, add-only cancellation-test artifact. Both cancellation cases passed against that source. The input digest is f5295ef17c74321845461253a8f3c8c256d7c92266f0cf3bc7768e72ac93b849. All 120 current judgments pass citation and readiness validation. Source overlays cannot replace existing files; traversal, symlink, and hash failures are rejected.

The new version keeps 24 development queries and freezes 16 fresh held-out queries before evaluation. The held-out queries remain unscored and separate from development selection. The same implementer reviewed the source, so this is not an external independent benchmark. Default evaluation scores development queries only. An explicit flag is required to open held-out evaluation.

Normal lexical development Recall@10 is 68.06%, with 16 of 16 exact identifiers resolved. A development-only category experiment reached 84.72%. It remains disabled. No overall or fresh held-out score exists. Candidate recall alone does not show packing quality or coding completion.

A separate development experiment added incoming dependency support within each category. It used inverse graph degree to reduce the effect of files with many links. Across 18 settings, none improved the 84.72% category result; larger weights reduced recall. Keep that reranking disabled. The fresh held-out set was not evaluated.

The fixed category allocation was selected on development queries before this regression comparison. Its development recall was 80.56%. Its overall gain did not carry over to the exposed held-out split. No packing or task-completion claim follows from candidate recall. Keep it disabled in normal search.

Explicit relationship lookup remains available. It labels inferred import, test-name, and documentation links. Language-provider hints remain optional. Relationship content is read through workspace scope checks before it enters an agent response.

## Scale sample

The fixture has 20,000 visible source files and approximately 200 MB of UTF-8 text. The computer has an Apple M5, 10 CPU cores, and 24 GiB memory. It used macOS and Node.js 24.18.0.

A full cold snapshot returned in 1.47 seconds. A warm snapshot returned in 417 ms with zero unchanged source-body reads. A saved change appeared in 438 ms, with one source-body read. Cold ranking after tokenization reuse took 954 ms. Warm ranking p95 was 25.5 ms in that sample.

Exact-search p95 ranged from 479–554 ms across the recorded 20-query samples. A later sample after shared directory inspection recorded 497.3 ms. Competing local work and sample size limit the conclusion. Keep the slow sample. The search target has limited headroom. This synthetic tree does not represent every repository layout.

## Semantic experiment

The local Nomic experiment used 768-dimensional vectors. It made 59 local requests and embedded 586,649 characters. Preparation took 42.1 seconds. Its private vector cache used 2.28 MB. API spending was zero. Each file supplied one leading excerpt of at most 5,000 characters. Actual candidate packing uses the same 12,000-character limit, including metadata, for each variant. Candidate recall and packed category coverage are separate measures.

The model uses task prefixes for [documents and queries](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5). The experiment used those prefixes. It reduced held-out recall, so normal search does not enable it. No complete-task regression claim is needed to reject a configuration that already fails retrieval quality.

## Core gate

The qualification checker rejects partial batches, mixed models, duplicate attempts, changed task inputs or budgets, and false complete labels. It recomputes retrieval metrics from candidate paths and frozen labels. The observed local profile is not qualified. A passing smoke task does not replace the 20-task, three-repetition qualification set.

The core target is at least 51 complete attempts out of 60, including 20 of 24 held-out attempts and all three Flask attempts. Retrieval must reach 90% overall Recall@10, 85% held-out Recall@10, and 95% exact success. Current retrieval passes the exact-identifier target on the exposed set. It misses both recall targets. Later autonomy phases retain their dependency on this gate.

## Editor search compatibility

The installed VS Code uses the platform-specific ripgrep-universal layout. The adapter checks that layout and the earlier ripgrep layout. This matches the [upstream path-change report](https://github.com/microsoft/vscode/issues/318691). Native search was tested with the actual installed editor binary. The model host must explicitly name an editor root to exercise that backend; the fallback remains available.

The native-search coding-profile smoke completed edit-and-check in 45 seconds. Flask timed out after 721 seconds. This profile is not qualified. Its earlier failed smoke and the corrected rerun remain separate records.

## Later core diagnosis

The format-recovery Flask trial staged its first draft at 249.3 seconds and reached review at 490.3 seconds. It did not complete. The terminal record took 878 seconds and reported 467,082 tokens and 27 host tool calls. No independent acceptance ran. A long gap preceded the terminal cancellation. The cause of the deadline overrun is unproven. Future runner records include the longest poll gap and deadline overrun. They save a partial checkpoint before a timeout cancellation.

The public runtime's 30 completed model messages match the saved input and output token totals. This trial does not show a token-accounting mismatch. The existing review allowance permits use above the soft limit. Strict qualification still rejects attempts above the frozen task budget.

A six-case synthetic tool-text diagnostic passed four exact comparisons. Both multiline comparisons lost one trailing newline. Single-line and literal-backslash cases passed in streamed and buffered modes. No returned tool was executed. The diagnostic does not isolate model generation from the serving parser. LM Studio documents its [tool parsing flow](https://lmstudio.ai/docs/developer/openai-compat/tools). The first probe request used an unsupported tool-choice object and received HTTP 400. The corrected request used the server's supported required string.

A development-only normalization experiment did not reach the recall target. It remains outside runtime ranking. Exact registered-tool recognition was adopted separately after all 16 development identifier queries resolved their implementation. The full exposed set now resolves all 16 exact queries. This is a regression comparison, not a new independent held-out result.

The later budget-guidance batch completed the small task in 255 seconds. Flask timed out after 721 seconds. Its longest measured poll gap was 1,059 ms, and the deadline overrun was 476 ms. It staged all three requested files and reached review, but did not finish the required checks. Independent diagnosis of the saved draft failed with a Python indentation error from a duplicated function header. This diagnosis does not change the failed task outcome.

The second semantic configuration used 964 overlapping excerpts across the full pinned tree. Preparation took 42.6 seconds. It embedded 2,016,619 characters in 127 local requests and used a 15.69 MB private vector cache. The development set selected equal-weight rank fusion. Its Recall@10 improved to 75.83% overall and 81.25% on the exposed held-out set. Both targets remain missed. Normal retrieval keeps this configuration disabled.

New live runs measure authorization evidence instead of initializing a zero count. They match completed parent tool calls to observed host permission records. Missing or unfinished traces remain unknown. This evidence does not replace policy, revocation, or partial-effect tests. Cross-checks of the saved coding-profile batch found no unmatched completed calls. Future results also record an evaluator digest; qualification rejects mixed or missing evaluator versions.

The separate local GPT-OSS 20B profile completed the small task in 18 seconds, using 11,492 tokens and three host tool calls. Its Flask run failed after 617 seconds. It used 344,551 tokens and 29 host tool calls. The CLI patch reached review and applied in a disposable copy, but independent checks found a syntax error. Test and documentation changes were missing. All completed parent calls matched observed host authorization records. This profile remains unqualified.

The serving application was LM Studio 0.4.28+2. VS Code 1.146.0 supplied the native search binary. These coding runs used a host fixture. They do not establish interactive editor UI acceptance.

## Completion follow-up and draft previews

The first verification-follow-up batch completed the small task in 20 seconds. Flask ended incomplete after 35 seconds, with no draft or final answer. Its public session evidence showed an empty final model message. Added one bounded continuation for that case. A repeated empty result stays incomplete. External writes prevent the continuation.

Edit results now include bounded previews of the changed draft. Previews do not grant edit receipts. Inline previews stay within the selected text. Fixtures cover multiple edit offsets, preview truncation, current receipts, repair and recheck, skipped commands, and empty results after external effects.

The next frozen Flask attempt ended incomplete after 396 seconds. It reported 516,424 tokens, 34 model calls, and 25 budget-counted host tools. It staged one CLI registration with incorrect indentation, but never reached review or checks. The private checkpoint retained that partial draft. The 400,000-token task budget was exceeded; the existing host review allowance and the next reported model usage explain why the terminal total can be higher. No result above the task budget can qualify. This attempt does not isolate one cause of failure.

The runner can now test history summarization with --compaction. Its historical default remains disabled. Each attempt records its actual execution settings. Qualification rejects missing or mixed settings. The new experiment keeps the model, context limit, task inputs, and frozen budgets. Results from the two settings remain separate.

The first enabled experiment completed the small task in 27 seconds. Flask ended incomplete in 354 seconds with 279,127 tokens and 25 host tool calls. It returned a plan promising future edits, but staged no files. Neither attempt recorded a compaction event. This does not establish an effect from history summarization.

Added one bounded continuation for a response that promises future implementation without a draft. It restates the original request and preserves planning-only, no-edit, no-command, approval, budget, and external-effect limits. This text signal cannot prove task completion. A repeated promise ends without a success claim. Focused runtime, scoring, and profile tests passed: 39 tests, zero skips or failures. Help probes with additional test-file arguments also fail project-check scoring.

The next live smoke completed the small task in 22 seconds with 11,951 tokens. Flask failed after 635 seconds. It used 499,063 tokens and 30 budget-counted tools. It reached review and applied in the disposable verifier, but changed only the CLI file. Literal backslash-n text caused a syntax error. Test and documentation changes were missing. No agent check or compaction event was recorded. The bounded promise continuation was not exercised in this batch. Scripted fixtures demonstrate the control flow; this live result does not demonstrate a completion-quality gain. The qualification checker rejected the batch. The full regression suite overlapped it, so timing cannot isolate the source change's effect.

## Literal line-array edit trial

Whole-line edits now accept new_lines as an alternative to exact new_text. Each array item is one literal line with its original indentation and no line ending. The host joins the lines and supplies the final newline. It does not decode backslashes or infer indentation. Both formats together, embedded line endings, oversized arrays, and stale receipts are rejected. Exact text remains available for edits without a final newline. Review and workspace-write authority are unchanged.

Ten format tests and ten local runtime/completion fixtures passed. The full suite then passed 328 tests with 17 skipped and zero failures. It finished before the new real-model batch. The new implementation digest is 61ff5424671ac656a58ee76ee484dc5f195b8b2f8920234bcb2833d373ffe45a. Its evaluator digest is 12edfaa174cb07db715edf7a318c6c4d804ae5d95e818fcfc0ac7885e45907e6.

The local GPT-OSS smoke kept the same model settings, compaction setting, inputs, and budgets. The small task completed in 21 seconds with 12,219 tokens and three host tools. Flask failed after 437 seconds with 286,615 tokens and 24 host tools. It reached review and disposable apply, but changed only src/flask/cli.py. Both independent commands failed with an indentation error at line 607. Tests, documentation, and an agent check were missing. All completed parent tools matched host authorization records.

Public session results confirm one accepted new_lines edit. This is evidence that the live model exercised the format. It does not prove an improvement in task completion. The host issued one verification continuation, but no check followed. No compaction event occurred; the largest Flask model input was 16,327 tokens. The original Flask request does not explicitly require an agent-run check, so its frozen scorer requires independent verification and the requested implementation, test, and documentation changes. Those requirements failed. Keep that contract and all earlier outcomes unchanged.

The qualification checker accepts version 2 source readiness but rejects this partial coding and development-only retrieval batch. The fresh held-out set remains unmeasured. The model and dedicated evaluation server were stopped after evidence collection. API spending was zero.

Built /tmp/agentextension-line-array-upgrade.vsix after the trials. It contains 101,905,586 bytes. Its SHA-256 is a11d78a6c1fbc04b4eee81c3ebc46f6fbc60525eb8a822c390c78ecca67f58fd. The extracted-package runtime and saved-connection fixture passed in 4.2 seconds, with no skips or failures. Scope: macOS arm64 host fixture, without interactive editor or cross-platform acceptance. Runtime and evaluator digests stayed unchanged after the batch and package build.

## Exact anchors, fresh search, and bounded source suggestions

The previous draft inserted one registration at line 606, between an if branch and its else. That shows a misplaced edit. It does not prove whether the model miscounted lines or chose the wrong location. The tool now supports insertion after an exact source anchor. The old numeric before-line format remains available. A repeated anchor needs a matching line address. Conflicting addresses, stale source, out-of-scope edits, and deletion with after-insertion are rejected. An unterminated final source line needs an exact-text replacement.

Text-based edit targets also appear in [Aider's edit-format documentation](https://aider.chat/docs/more/edit-formats.html). This is a design reference. It does not establish that this project's local profiles will improve. Our decision depends on source-boundary tests and real-model results.

Fresh keyword search also discarded relevance order when it sorted collected results by file and line. A two-file reproduction returned a weaker alphabetical match first. Keyword search now keeps its relevance scores internally through collection and pagination. Literal, word, path, and regex modes retain source-location order. Tests cover stronger exact matches, duplicate locations, buffer and draft changes, stale cursors, exclusions, and native search. The previous Flask trial used literal search, so this is a separate defect. It does not change the frozen candidate-ranker recall measurement.

The full suite after these changes passed 335 tests with 17 skipped and zero failures. All 23 focused search checks passed with the runtime and native adapter enabled. The frozen small task then completed in 24 seconds with 15,571 tokens and three host tools. Flask ended incomplete after 304 seconds with 264,739 tokens and 18 host tools. It staged no patch, ran no check, and reached no review or independent acceptance. Public session metadata records seven after-anchor edit requests and four keyword searches. None of those edits staged a change. No compaction event occurred. The largest Flask model input was 15,650 tokens.

The batch used implementation c1e0fd42f39114299038c431c5b8a4ba20497760703f5e1b3f7873215dbe37bf and evaluator 12edfaa174cb07db715edf7a318c6c4d804ae5d95e818fcfc0ac7885e45907e6. Keep its failed result separate from later changes. The core qualification checker rejected the partial coding and development-only retrieval batch. API spending remained zero.

Prepared a source-hint change in a separate copy and applied it after the batch ended. An invalid or ambiguous anchor can return at most three complete source lines from its existing receipt. Each line is at most 240 characters. The host treats these suggestions as source data. It still requires a new exact-anchor proposal and validates current source and edit scope before staging. No near match is applied automatically. The [runtime recovery fixture](../../test/extension-anchor-insertion.test.js) exercises a rejected numeric address and a missing-indentation anchor, then copies a returned source line, runs the project check, and reaches review. Twenty-eight focused checks passed. The full suite passed 338 tests with 17 skipped and zero failures. A separate local-model result remains pending.

A development-only expansion experiment used bounded descriptions from source tool registrations. None of its 15 settings improved the 84.72% category-candidate result. Keep it disabled. The fresh held-out set remains unmeasured.

The source-hint smoke then completed the small task in 25 seconds with 12,774 tokens and three host tools. Flask timed out after 721 seconds with 399,917 tokens and 29 host tools. No project check, review, or independent acceptance ran. Its checkpoint retained one CLI registration. Read-only AST analysis accepted the syntax but found no config_command definition. A partial checkpoint and an AST check cannot qualify the task.

The permitted retry started after the 600-second turn deadline. The first and retry sessions together have 32 model messages, matching host usage accounting. Public results confirm one accepted exact after-anchor edit. No source-suggestion result or compaction event occurred. The largest model input was 19,669 tokens. The source-hint code has passing scripted recovery checks, but this live trial did not exercise that fallback. Keep the failed outcome. The source implementation was fe92e42d9ce83072ba64905366058ab0d282c0c125e0f6e9e901cb60fb11facb. The evaluator stayed unchanged. API spending was zero.

## Version 2 category and semantic development experiment

Rebuilt local Nomic vectors for the full 141-file version 2 source. The experiment embedded 966 overlapping excerpts and only the 24 development queries. It made 125 local requests for 2,019,701 characters. Preparation took 44.9 seconds. The private vector cache used 15,723,546 bytes. The coding model was unloaded before this experiment. The embedding model was unloaded afterward. API spending was zero.

Compared 20 fixed combinations of fusion weight and category allocation. A syntax-based adaptive recipe used one implementation, five test, and four documentation candidates for a single identifier. Other queries used three, three, and four. Its development Recall@10 was 86.11% with pure lexical ranking. A 25% semantic contribution tied that result. Larger semantic weights reduced it. All 16 development identifiers resolved.

Uniform prototype packing stayed within 12,000 characters, including metadata. The best recipe retained 62.50% of labelled files after packing. This prototype uses a separate packing method from normal context assembly. Candidate recall, packed file coverage, and coding completion are distinct measures. Keep all variants disabled. Normal development candidate recall stays 68.06%. The fresh held-out set was neither embedded nor evaluated. This experiment does not close the core gate.

## Registration and command-source diagnosis

New registration-reference notes flag a narrow syntax pattern. The added bare name appears only as a registration argument in the current draft. The notes ask the model to resolve its definition or import. They cannot prove a name is undefined. The scan skips inline selections and Python wildcard imports. A timed regression covers 120,000 blank lines before an unfinished registration. The full suite passed 347 tests with 17 skipped and zero failures.

The frozen Coder batch used implementation 6544be8f280f7ab2dbc5ea1e4fe312675a4e951c7783d64d7546201a683a9c0f and the unchanged evaluator. The small task failed after 150 seconds with 117,641 tokens. It ran a passing project test and requested review, then repeated bare interpreter calls until the 12 approval-pause limit. Its final patch was absent. Flask timed out after 721 seconds with 402,675 tokens, above its 400,000-token budget. Its checkpoint retained CLI and test edits. Five commands ran, but no reviewed and independently verified final patch exists. Keep both outcomes unqualified.

A disposable diagnostic added a unique marker to the staged Flask module. Default Python imports did not see it and resolved outside the copy. An explicit src import path saw the marker inside the copy. Both commands used the same input digest. The original source stayed unchanged. This confirms a source-selection gap for that command setup. It does not validate the partial model patch or explain every failed check. The model also used an app CLI runner to test a global CLI command.

The command preflight now rejects known interpreters with no program or stdin-only arguments before asking for approval. Script arguments and explicit version diagnostics retain their prior contracts. Python command descriptions and results explain src-layout imports. No environment variable or import path changes automatically. The isolated source-path regression fails without src and passes with an explicit path. The 19 focused tests passed. The full regression suite passed 350 tests, with 17 skipped and zero failures. Python's test import paths depend on its invocation and layout; see the [pytest import documentation](https://docs.pytest.org/en/stable/explanation/pythonpath.html).

The previous extracted package predates registration guidance and these command changes. It is historical validation. A fresh package is required before claiming current package coverage.

The current command/source smoke completed the small task in 64 seconds with 27,326 tokens and four host tools. Its one test command, review, disposable apply, and independent acceptance passed. Flask timed out after 721 seconds with 345,151 tokens and 27 budget-counted tools. One CLI edit remained in the checkpoint across the permitted retry. No check or review ran. Source-path guidance was not exercised by that live attempt. The strict qualification checker rejected the partial batch. No profile qualifies.

Built /tmp/agentextension-command-source-upgrade.vsix with implementation 92361f0925d22f7616938e20ce9d87c68727a87649751afbb065700d1ec33289. Its size is 101,925,899 bytes. SHA-256: 79c82186525f9c02d1155d01db0b1610cfe2ffb6ff6a41681d17e28fba91d079. The permission-preserving extracted-package fixture passed one test in 3.7 seconds. The first Python ZIP extraction lost executable permissions and its fixture failed; the original log remains available. Scope: macOS arm64 host fixture, without interactive editor or cross-platform acceptance.

## Development stemming rejection

Tested Porter replacement and augmentation on the same version 2 development source. The implementation matched all 42,374 applicable lowercase ASCII examples in the published test data. Its best replacement recall was 81.94%; augmentation reached 84.72%. The unstemmed adaptive recipe reached 86.11%. Keep stemming disabled. The [published Porter algorithm](https://snowballstem.org/algorithms/porter/stemmer.html) defines the transformation, not its usefulness for this repository.

Prototype excerpts of 1,100 characters retained all ten candidate files within the 12,000-character budget. That is file coverage, not evidence that the excerpts contain each relevant witness. No coding or fresh held-out evaluation ran for this prototype.

A separate development diagnostic checks the actual reviewed passages. Normal assembly covered 56.94% of expected files. Mean cited-line coverage was 32.42%; at least one complete citation appeared for 19.44% of judgments. The 1,100-character prototype covered 86.11% of expected files, but mean cited-line coverage fell to 10.40%, with complete citations for 2.78% of judgments. Full citations can include more text than a useful minimal witness. These are conservative diagnostic measures, not an exhaustive relevance judgment or task score. They support keeping shorter uniform packing disabled. This diagnostic overlapped the next Coder smoke; do not infer a performance effect from that smoke's elapsed time.

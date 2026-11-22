# Retrieval Label Review

Updated: 22 November 2026. The historical audit below covers commit 5c5fe676a444d51a5163c89abdb39dec0860817e and retrieval version 1. Its labels and reported scores remain unchanged. Retrieval version 2 resolves its six findings in a new source and label version.

## Current version 2 resolution

The [new labels](../../test/retrieval/corpora/v2/queries.json), [source review](../../test/retrieval/corpora/v2/judgments.json), [source manifest](../../test/retrieval/corpora/v2/source.json), and [freeze record](../../test/retrieval/corpora/v2/freeze.json) form one validated corpus. The five test-path corrections are adopted. The source is the original 140-file Git snapshot plus an add-only, hash-checked cancellation-test artifact. Both cancellation cases passed against that pinned source. The overlay cannot replace an existing source file. Hash, traversal, and symlink checks reject changed artifacts.

All 120 version 2 judgments have matching citations and no pending findings. The corpus contains 24 development queries and 16 fresh held-out queries. The latter remain unevaluated and did not enter development selection. The same implementer reviewed them. This limits independence; it does not replace the later external comparison gate.

Run node test/retrieval/judgments.cjs --require-ready for the current readiness check. Use --corpus 1 to reproduce the historical pending findings. Normal retrieval evaluation scores development queries only. Held-out evaluation requires --evaluate-held-out plus an explicit held-out or all split.

Development Recall@10 is 68.06%; all 16 exact development identifiers resolve. No overall or fresh held-out score exists yet. A development-only category experiment reached 84.72% recall but remains disabled. These results do not close the core gate.

## Historical version 1 audit

The [citation manifest](../../test/retrieval/judgments.json) records 56 source files, exact line ranges, content hashes, and a reason for each judgment. The [validator](../../test/retrieval/judgments.cjs) checks source identity and complete coverage. It retains 114 judgments, proposes five test-path replacements, and records one test-coverage gap. Hash checks do not prove semantic relevance or feature correctness. They make the source review reproducible.

## Findings

| Query | Frozen expected test | Source finding | Required correction before a new corpus version |
| --- | --- | --- | --- |
| query-01: propose_lines | test/core.test.js | This file tests draft replacements and hunks. It never calls propose_lines or checks its read receipts. | test/live.test.js lines 343–362 call the tool and assert range, newline, anchor, and stale-receipt behavior. |
| query-04: ContextManifest | test/core.test.js | This file does not import or exercise ContextManifest. It tests context ranking and other host functions. | Propose test/instructions.test.js lines 80–90, which constructs the manifest and asserts trust labels and totals. test/compaction.test.js also has direct timing assertions. |
| query-09: create_file | test/core.test.js | This file never creates a draft file. | test/vscode.cjs lines 18–27 create a draft file, check its absence before apply, and check its contents after apply. This covers the underlying creation flow, not a direct bridge call. |
| query-18: reject apply after source changes | test/hardening.test.js | This file tests process isolation, path access, and permission subjects. It does not call applyWorkspaceChanges. | test/vscode.cjs directly calls applyWorkspaceChanges with a mismatching source and expects changed-since-review rejection. Keep its editor-host environment requirement visible. |
| query-20: cancel verification and remove its copy | test/hardening.test.js | This file passes an active AbortSignal to isolated commands. It does not abort a running verification command or assert cleanup of its temporary copy. | The pinned tree has a coverage gap. The current workspace adds a direct regression. A revised corpus must pin a source version that includes its selected test. |
| query-21: run checks with blocked network access | test/permissions.test.js | This file checks broker grants and review approval. It does not run the network-isolation check. | test/hardening.test.js runs an isolated curl command and asserts a nonzero exit. Its macOS fixture also tests isolation configuration on both supported platforms. |

The file names in this table refer to the pinned source. Current workspace files can contain later changes. A matching path alone does not validate a relevance label.

Source checks at the pinned commit: test/instructions.test.js lines 86–90 assert manifest trust and totals. test/compaction.test.js lines 13–24 assert source timing and retention. test/vscode.cjs line 34 asserts stale-source rejection. test/hardening.test.js line 54 creates an active signal, and line 60 asserts a failed network request. These were the first reviewed locations. The full citation manifest now covers every judgment.

The complete manifest also records supporting modules where a feature crosses a file boundary. For query-35, the organization client loads managed policy and PolicyEngine decides precedence. For query-38, the worker-session bridge delegates to WorkerPool, which enforces the named-file scope. A retained file is relevant to the query; it need not contain the entire feature.

## Validation and current-code regression

Run node test/retrieval/judgments.cjs --corpus 1 to validate the historical citations against the pinned tree. Add --require-ready to require a review with no pending corrections. Version 1 fails readiness by design because five proposals and one coverage gap remain. Qualification runs the same validation against raw review and source data. A summary claiming that the audit passed is insufficient. New evaluator digests include the labels, citation manifests, validator, source reader, and version 2 freeze artifacts.

The current workspace now has a [direct cancellation regression](../../test/workspace-command-cancellation.test.js). On macOS, it observes a real isolated verification process, cancels it, checks that the process stopped, checks that its private copy was removed, and verifies that the workspace stayed unchanged. A second case checks cancellation before materialization. Both passed. This test does not exist at the pinned commit, so it cannot repair query-20's frozen label. A revised corpus must pin a source version that includes its chosen evidence.

## Effect on the historical gate

The frozen evaluation still reports 69.17% Recall@10, 79.17% held-out recall, and 100% exact identifier success. These numbers remain an honest calculation against version 1 labels. Some relevance judgments need correction. This limits the interpretation of the recall score. It does not establish that retrieval is good enough, and it does not turn a failed coding task into a pass.

Keep version 1 results unchanged. Before a new qualification claim, create a new corpus version with an assertion or source location for every relevance judgment. Review all implementation, test, and documentation judgments. Record which judgments changed and why. Do not select expected paths from the ranker's output.

All existing query labels have been exposed. A new independent held-out set needs different tasks and judgments fixed before evaluation. Correcting these findings cannot restore the independence of the old held-out set.

## Separate ranking experiment

A development-only experiment ranked extracted declarations, comments, error strings, test titles, and documentation headings. It used the same pinned source and no held-out labels. A 25% blend of structural fields reached 66.67% recall, compared with 62.50% for the current development baseline. The existing category allocation reached 80.56% without the added fields. No structural variant met the 90% target or improved that category result. Keep the structural experiment disabled. Its raw record remains under test-results/upgrade-structural-fields.

Field weighting is an established retrieval approach, but that alone does not prove it helps this repository. The [Microsoft TREC report](https://www.microsoft.com/en-us/research/wp-content/uploads/2004/01/Microsoft-Cambridge-at-TREC-2004-Web-and-HARD-track.pdf) describes field and feedback experiments. The decision here follows this project's measurements.

The fixed 3/3/4 category allocation was then compared against all 40 exposed queries. It reached 79.17% overall recall, 80.56% development recall, and 77.08% held-out recall. All 16 exact identifiers resolved. Held-out recall fell from the current 79.17%. Keep this candidate-only experiment disabled. Neither its gain on development labels nor a later label correction can establish independent retrieval quality.

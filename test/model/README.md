# Live Task Evaluation

## Scoring contract

Run npm run test:scoring to test scoring and independent patch verification without a model server. These tests also run under npm test.

The live runner uses these outcomes:

| Outcome | Meaning | Command succeeds |
| --- | --- | --- |
| complete | Every required task check and host evidence check passed | Yes |
| incomplete | The run ended but required evidence or behavior is missing | No |
| failed | A terminal error or independent acceptance check failed | No |
| timed-out | The run exceeded its deadline | No |
| cancelled | The run or verification was cancelled | No |
| environment-unavailable | Required model or execution infrastructure was unavailable | No |

Task assertions are mandatory unless the trusted task definition marks them as optional diagnostics. A coding task must have at least one mandatory assertion. An empty evaluation cannot pass.

A complete coding result requires:

1. A non-empty final patch reached hunk review.
2. The patch contains only permitted file changes and matches its source base.
3. The host applies that exact patch in a disposable copy.
4. Independent acceptance commands pass against the applied copy.
5. When the task asks the agent to run checks, its latest successful check targets the requested project tests and covers the final revision and patch. A version probe or interpreter without a script does not count.
6. No terminal error or unapproved action was dispatched.

The model's summary is not verification evidence. A reviewed patch alone is incomplete. A patch that passes only the model-visible tests can still fail the independent checks.

## Running a live evaluation

Use npm run test:qwen with a running local model server and TrueForge, as described in the repository README. The default model is local-lm-studio/qwen. Use -- --only edit-and-check for one scenario.

Local runs stay local, with zero paid API spending. Do not substitute a hosted model when a local connection is unavailable.

On 22 November 2026 the user authorized a hosted main profile for the Phase 10 gate only. Pass --hosted-main explicitly with AGENTEXTENSION_TEST_MODEL set to a non-example provider (for example hosted-main/main), AGENTEXTENSION_TEST_HOSTED_URL set to the HTTPS OpenAI-compatible base URL, AGENTEXTENSION_TEST_HOSTED_KEY set to the key, and AGENTEXTENSION_TEST_MODEL_ID set to the provider's model ID. The runner registers that provider in the local TrueForge and records only the endpoint host. Keep the key out of files and results. The qualification profile must declare hostedMain: true, localOnly: false, and the measured apiSpend in USD. Keep hosted and local results separate.

Missing model infrastructure is written to the normal JSON and Markdown result files as environment-unavailable. The command returns a failure status. The runner keeps coding, read-only, and control tasks labelled separately.

The runner saves each terminal attempt before it starts the next one. An interrupted batch keeps these attempt files. Its missing attempts remain untested. They cannot count as passes.

New attempts record a digest of the extension source, agent definition, and package manifest. This identifies dirty implementations that share a Git revision. Keep results from different digests separate when comparing variants.

They also record an evaluator digest for the runner, scorer, verifier, task definitions, and host fixture. Qualification rejects mixed or missing evaluator digests. Authorization counts now come from completed parent tool calls matched to the host's permission records. Missing or unfinished traces stay unknown. This measurement does not replace the separate permission and revocation tests. Historical initialized counters are not new measured evidence.

New evaluator digests also include the retrieval labels, citation manifests, citation validator, source reader, and frozen version 2 artifacts. Keep runs from the earlier digest separate. The coding tasks, budgets, and historical outcomes remain unchanged.

New runs separate first staged-draft time from first-review time. Neither timestamp proves correctness. Historical firstPatchMs values measured first review. The runner records modelRunMs, total wallMs, verificationMs, maxPollGapMs, and deadlineOverrunMs separately. Wall time ends after evidence collection and cleanup. A timeout captures its current private checkpoint before cancellation. That checkpoint is diagnostic evidence and cannot make a task pass.

## Independent checks and current limits

Acceptance command definitions stay outside the model's workspace and prompt. The verifier reuses the project's process isolation. Network access and access to the original workspace are blocked during these commands. The original source stays unchanged.

The verifier uses the same execution snapshot as agent checks, without editor overlays. It copies every permitted file and lockfile, up to 100,000 files and 2 GB, and needs enough free temporary disk space. Exceeding a quota reports an unavailable verification environment instead of checking a partial tree.

Flask Task B runs CLI regression tests and independent JSON, masking, ordinary-value, and help checks. Its Python toolchain and test dependencies must be available. The verifier does not copy an existing virtual environment or install dependencies. A dependency or setup failure is not a successful task result.

Model and physical-device acceptance results remain separate from deterministic test results. See the [upgrade progress record](../../docs/agent-capability-upgrade/PROGRESS.md).

## Frozen upgrade corpus

Use npm run test:qwen -- --corpus --list to inspect the task manifest without starting a model. Use --corpus --only TASK --repetitions 1 for a smoke run. A qualification run uses all 20 tasks and the default three repetitions. A subset is not a qualification result.

Coding evaluations keep their historical compaction-disabled default. Add --compaction to test TrueForge's existing history summarization. Use --no-compaction to state the baseline explicitly. The manifest and each attempt record the actual execution settings. A compaction-enabled run is a separate profile. It keeps the frozen tasks and budgets. Qualification rejects mixed or missing execution settings, even when the model name is the same. Compaction usage counts toward the token budget.

The corpus version is agent-capability-upgrade/1. It includes 12 development tasks and 8 held-out tasks across JavaScript, TypeScript, and Python. The pinned Flask task is a development task because its earlier failure is already known. Each generated fixture has a source digest. Acceptance commands and reference patches stay outside the workspace supplied to the model.

Use npm run test:corpus to validate the fixture contracts. The test applies every generated reference patch and checks that the original bug is rejected. The optional Flask acceptance test requires AGENTEXTENSION_TEST_FLASK_ROOT and a prepared Python toolchain. It tests both a working command and a registered command with wrong output.

Corpus runs enforce loopback model destinations and zero API spending. Default task budgets are six minutes, 200,000 model tokens, and 48 tool calls. The worker scenario and Flask task allow twelve minutes. Flask allows 400,000 tokens. Timing and environment fields are recorded with each run. The interaction time is the fixed harness script's wait time, not a measurement of a human reviewer.

The Flask reference check was verified with Python 3.14.6, Flask 3.1.3, pytest 8.4.2, Click 8.5.1, and python-dotenv 1.2.4. Its CLI suite disables the unrelated pytest-asyncio plugin. The verifier injects two hashed, public dotenv test fixtures from the pinned Flask commit into the disposable copy. It never reads real workspace dotenv files.

Use npm run test:retrieval to measure the 24 development queries in retrieval version 2. It reads the pinned Git tree at 5c5fe67 plus one hash-checked, add-only cancellation-test overlay. The resulting source contains 141 files. Labels and expected answers never enter the candidate snapshot. The runner writes retrieval-latest.json to test-results and records the source, input, implementation, and evaluator digests. This command records measurements; it does not assert that release thresholds passed.

Version 2 keeps the 24 development queries, corrects five test paths, supplies cited cancellation coverage, and freezes 16 fresh held-out queries. All 120 relevance judgments have validated source citations. The [freeze record](../retrieval/corpora/v2/freeze.json) states the source-review limit: the same implementer reviewed the queries. External independent comparison remains a later gate.

Held-out scoring requires both --split held-out or --split all and --evaluate-held-out. Keep this flag absent during development selection. Unmeasured held-out metrics are null. Run --corpus 1 --split all --evaluate-held-out to reproduce the exposed historical set. Its original 140-file input and measurements remain unchanged. The first version 1 baseline was 60.83% Recall@10, 77.08% held-out recall, and 56.25% exact success. Neither version establishes the separate large-repository latency requirement.

## Core qualification

Run node test/model/qualify.cjs BATCH_JSON RETRIEVAL_JSON PROFILE_JSON OUTPUT_JSON to check the frozen core gate. The observed profile must identify the installed model, local-only connection, zero API spend, declared context, timeout, and observed tool, cancellation, and compaction behavior.

Qualification requires all 20 task versions and their three repetitions. It rejects duplicate attempts, mixed models, changed budgets, missing host evidence, and partial batches. It recomputes retrieval recall from the frozen labels and candidate paths. Summary percentages alone cannot pass the gate. The required totals are 51 complete attempts, 20 held-out complete attempts, and all three Flask attempts. Retrieval must meet 90% overall recall, 85% held-out recall, and 95% exact success.

Qualification defaults to retrieval version 2. Coding keeps its separate agent-capability-upgrade/1 version. The checker validates the raw labels, source snapshot, and citation review. It also requires matching source and input digests, plus the same implementation and evaluator digests as the coding batch. A summary claiming a ready review is insufficient. Missing or changed citations fail. Pending corrections or coverage gaps block qualification.

Run node test/retrieval/judgments.cjs --require-ready to validate version 2. Use --corpus 1 to inspect the historical review, whose five corrections and one coverage gap remain recorded. Use --retrieval-corpus 1 with qualify.cjs only for historical reports. Keep version 1 and its scores unchanged. A current workspace test cannot serve as evidence for an older pinned tree without a separately versioned source overlay.

The original retrieval held-out set is now exposed by evaluation. Keep its measurements for comparison. Use a new independent held-out set for claims about later tuning.

## Local tool-text diagnostics

Use node test/model/tool-probe.cjs with AGENTEXTENSION_TEST_CHAT_ENDPOINT set to the local chat-completions endpoint and AGENTEXTENSION_TEST_MODEL_ID set to an installed model ID. The probe requires a loopback endpoint, refuses redirects, bounds responses and request time, and never executes returned functions. It sends six synthetic cases with a 512-token output limit. It compares single-line, multiline, and literal-backslash text in buffered and streamed responses.

The result is a format diagnostic. It does not count as a coding task, independent acceptance, or model qualification. It does not prove whether a changed string came from the model or the serving parser. The separate JSON record includes its request settings and available usage.

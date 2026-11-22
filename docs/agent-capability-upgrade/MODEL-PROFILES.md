# Observed Local Model Profiles

Updated: 22 November 2026. These profiles describe measured configurations of three installed models. None qualifies for the roadmap's supported coding tier. No main profile is qualified.

The user authorized local models only and zero paid API spending. All live requests used the installed LM Studio 0.4.28+2 service on this computer. VS Code 1.146.0 supplied the native search executable. Coding trials use an extension host fixture; they are not interactive editor UI acceptance. The product's selected model did not change. See the [source-free profile record](evidence/model-profiles.json) and [evidence report](EVIDENCE.md).

## Shared setup

| Property | Recorded value |
| --- | --- |
| Computer | Apple M5, 10 CPU cores, 24 GiB memory |
| Runtime | Node.js 24.18.0; TrueForge server 0.184.2; SDK 0.184.1 |
| Declared context | 32,768 tokens |
| Maximum model output | 2,600 tokens per response |
| Turn timeout | 600 seconds |
| Task limits | Frozen per task; Flask has 12 minutes, 400,000 tokens, and 48 host tool calls |
| Fallback | None |
| Automatic model retry | At most one eligible retry; no automatic retry after an external write |
| Temperature | Provider default; not exposed by the evaluated setup |
| Compaction | Disabled in the original coding profiles; enabled in a separate GPT-OSS experiment below |
| Cancellation | Scripted local stream, review, repeated-edit, and repeated-check fixtures passed |

The declared context is a configuration value. It is not proof that all context sizes work. Scripted fixtures test the host contract. They do not measure model quality after cancellation or compaction.

## Qwen 3.5 9B

The installed MLX model uses 4-bit weights. The evaluation provider is local-lm-studio/qwen. One corrected small coding trial completed in 251 seconds. A later small trial completed in 37 seconds. They used different implementations and remain separate observations.

The three frozen replacement Flask trials ended incomplete, timed out, and timed out. None produced a reviewed and independently verified patch. The first trial exceeded its token limit because interactive usage was recorded late. The host accounting fix was applied after that batch. Keep the failed outcome and its measured token total.

## Qwen3 Coder 30B-A3B

The installed model uses Q3_K_S weights. The evaluation provider is local-upgrade-coder/main. It uses one parallel prediction. Its memory guard passed before loading. No resource guard was bypassed.

The first small-task attempt timed out after repeated review exposed a harness defect. After the review repair, the small task completed in 45 seconds. It used 51,570 tokens and 10 host tool calls. Review, disposable apply, project checks, and independent acceptance passed.

The corresponding Flask attempt timed out after 721 seconds. It used 223,482 tokens and 25 host tool calls. Tool results showed anchor-format errors. Earlier attempts also ran bare Python commands with no script. The host now labels such commands diagnostic only.

The format-recovery trial staged a draft and reached review. It still timed out. Its terminal record took 878 seconds and used 467,082 tokens and 27 host tool calls. It had no final accepted patch or independent acceptance. The cause of the deadline overrun is unproven. Six separate synthetic tool-text comparisons passed four cases. Both multiline cases omitted a trailing newline. These observations do not isolate a model error from a serving-format error.

The registration-guidance trial failed the small task after 150 seconds with 117,641 tokens and 18 host tools. A project check passed and review occurred, but repeated empty interpreter calls reached the 12 approval-pause limit. Flask timed out after 721 seconds with 402,675 tokens and 27 budget-counted host tools. CLI and test edits remained in an unreviewed checkpoint. Five checks ran; no final independent acceptance ran. Both outcomes remain unqualified. No compaction event occurred. All completed parent calls matched host authorization records.

A separate diagnostic confirmed default Python imports used installed Flask instead of the staged src tree. This is a verification setup limitation, not proof that the checkpoint patch works. Command preflight and source-path guidance were added after this batch. They require a new measured trial.

The command/source-guidance repeat completed the small task in 64 seconds with 27,326 tokens and four host tools. It ran one real test command and passed review, disposable apply, and independent acceptance. Flask timed out after 721 seconds with 345,151 tokens and 27 budget-counted tools. Its single CLI edit survived one permitted retry, but no check or review ran. Source-path guidance was therefore not exercised in the live Flask attempt. The two linked Flask sessions contain 28 model messages. No compaction event occurred. All completed parent calls matched host authorization records. Keep the profile unqualified. Packing diagnostics overlapped this smoke, so elapsed time does not isolate a performance effect. The coding model was unloaded afterward.

## Qualification decision

Keep all profiles unqualified. Do not combine attempts from different model settings or implementation digests. The strict qualification checker requires all 60 task attempts, the frozen budgets, independent acceptance, and passing retrieval results. A small-task pass cannot satisfy that gate.

Future profile changes need new measured results. A different output limit, context size, or prompt format is a new configuration. Keep all prior failed attempts visible.

## GPT-OSS 20B

The installed model uses MXFP4 weights. Its separate evaluation provider is local-upgrade-gpt-oss/main. The resource guard passed. Loading used 11.28 GiB. The model used one prediction and the shared 32,768-token context setup.

The small coding task passed in 18 seconds with 11,492 tokens and three host tool calls. Review, project tests, disposable apply, and independent acceptance passed. All three completed tool calls matched observed host authorization records.

Flask ended after 617 seconds with 344,551 tokens and 29 host tool calls. It reached review and disposable apply. It changed only src/flask/cli.py. Independent tests failed with a syntax error. Required test and documentation changes were missing. The strict outcome is failed. No completed parent tool call lacked an observed matching authorization record.

The separate synthetic tool-text diagnostic passed three of six exact comparisons. Both multiline cases passed. The buffered single-line case added a newline. Both literal-backslash cases changed the expected text. These observations do not isolate the model from its serving parser. The model was unloaded after evaluation.

## GPT-OSS with compaction enabled

The runner now exposes --compaction as an explicit setting. It records the host's actual settings in each attempt. Qualification rejects missing or mixed settings, even when the model name is unchanged. The historical runner default remains disabled.

The first enabled experiment used the same model, declared context, output limit, task inputs, and budgets. The small task completed in 27 seconds with 12,121 tokens and three host tool calls. Flask ended incomplete after 354 seconds with 279,127 tokens and 25 tools. It returned a plan that promised to stage changes, but it produced no patch or check. All completed parent calls matched host authorization records.

Neither attempt recorded a compaction event. The public session API contains all 27 completed Flask model messages. Their largest reported input was 16,408 tokens. This does not identify the cause of the failure. Enabling the feature alone does not demonstrate its effect or model quality after history summarization. Keep this configuration unqualified. The source-free profile record separates it from the disabled profiles.

The next implementation completed the small task in 22 seconds with 11,951 tokens. Flask failed after 635 seconds with 499,063 tokens and 30 budget-counted tools. It reached review and disposable apply with only the CLI file changed. Independent checks found a syntax error from literal backslash-n text. Tests, documentation, and an agent check were absent. The task exceeded its 400,000-token budget. No compaction event occurred. The new promise continuation was not exercised by these responses. Keep this batch separate by its implementation and evaluator digests. The full regression suite overlapped the smoke, so timing does not isolate a performance effect.

The literal line-array implementation completed the small task in 21 seconds with 12,219 tokens and three tools. Flask failed after 437 seconds with 286,615 tokens and 24 tools. Its one new_lines request staged an edit. Independent checks found an indentation error at line 607. Only the CLI file changed; tests, documentation, and an agent check were absent. The host requested verification once. No compaction event occurred. The largest Flask input was 16,327 tokens. The full regression suite finished before this smoke. Keep the profile unqualified. Format adoption alone is not evidence of better completion. The test model was unloaded after the batch.

The after-anchor and keyword-order implementation completed the small task in 24 seconds with 15,571 tokens and three host tools. Flask ended incomplete after 304 seconds with 264,739 tokens and 18 host tools. Seven requested after-anchor edits produced no staged patch. The model also used four keyword searches. It ran no check and reached no review or independent acceptance. No compaction event occurred. Its largest input was 15,650 tokens. Keep this profile unqualified. Source-anchor suggestions are a later implementation and are not part of this batch's result.

The source-hint implementation completed the small task in 25 seconds with 12,774 tokens and three host tools. Flask timed out after 721 seconds with 399,917 tokens and 29 host tools. It preserved one CLI registration across the permitted retry after the 600-second turn limit. It ran no check and reached no review or independent acceptance. The first and retry sessions total 32 model messages. Its partial checkpoint parses as Python, but has no config_command definition. One after-anchor edit staged; the source-suggestion fallback was not exercised. No compaction event occurred. Its largest input was 19,669 tokens. Keep this profile unqualified. The test model was unloaded after the batch.

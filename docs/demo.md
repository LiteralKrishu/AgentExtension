# Flask rehearsal

Use a clean copy of Flask 3.1.3. Open that copy in the Extension Development Host and activate its Python environment in the terminal.

```sh
git clone --branch 3.1.3 https://github.com/pallets/flask.git flask-demo
cd flask-demo
git rev-parse --short=8 HEAD   # Expected: 22d92470
uv sync --locked --no-default-groups --group tests
source .venv/bin/activate
```

For the local Qwen 3.5 9B setup, load a 32,768-token context and clear **AgentExtension: Compaction**. The rehearsal used GPU offload, reasoning disabled at the local endpoint, and an output limit of 2,600 tokens. [LM Studio per-model settings](https://lmstudio.ai/docs/app/advanced/per-model)

## Verification on Flask 3.1.3

| Task | Result |
| --- | --- |
| A. Inline edit | The live local model produced two reviewed edits. The final docstring lists the unset case, the empty string, and all five false values. All 14 debug flag checks passed. |
| B. Agent mode | A scripted model fixture staged six hunks in the CLI, its tests, and its documentation through TrueForge. The VS Code rehearsal accepted, applied, saved, and undid the hunks. All 59 CLI tests passed. `flask --help` listed `config`, and the command masked all four test keys and kept `DEMO_LABEL` visible. |
| C. Model failure | The editor showed an endpoint error after one retry. The draft was discarded and the checkout stayed clean. |

## A. Inline edit

Open `src/flask/helpers.py`. Select the whole `get_debug_flag` function and invoke **AgentExtension: Edit Selection**.

> Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.

Show the native diff. Accept the intended hunks. Continue, apply, and save. Run this command.

```sh
FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
```

The expected output is `False`. Check that the docstring also lists the empty string and the unset case. Test `N` and `OFF` to check case-insensitive matching.

## B. Agent mode

The live local model reached review for the original prompt. Its generated patch failed code inspection. A run with insertion points also reached review, then failed the CLI tests. The fixture run verifies the editor and CLI behavior separately.

Send this request from the sidebar with no mentions.

> Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.

Open **Selected context** and show the ranked file ranges. Review the implementation, test, and documentation hunks. Apply the accepted hunks and save. Open **TrueForge session** and show its turns and tool calls.

```sh
python -m pytest tests/test_cli.py -q
flask --help
```

Run the command against an app with test values. Check that a key such as `DEMO_TOKEN` appears with the value `***` and a key such as `DEMO_LABEL` retains its value. Use **Undo last apply** to show that the edit can be reverted.

## C. Model failure

Start from a clean checkout at the same tag so the original inline task still applies. Configure a separate TrueForge model with an unreachable loopback endpoint. Select it as the primary model. Clear the fallback if you want to show the error path, or keep a working fallback to show automatic recovery.

Repeat Task A. Show the error or the model switch. Discard any fallback draft and run `git status --short`. The expected output is empty.

Record the tasks in order and include their checks. Fill in the scorecard timestamps from the final recording.

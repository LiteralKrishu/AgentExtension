# Audit follow-up

Updated: 23 November 2026. The preceding pass resolved the three “should fix” findings. The current pass fixes all four must-fix findings. See the [release-risk record](RELEASE-RISK-FIXES.md) for scope and evidence.

| Should-fix finding | Change | Evidence |
| --- | --- | --- |
| A denied command could pull a container image before approval | Check the command policy before environment inspection. A missing image requires a separate download decision. Command approval stays separate. | [Command grant tests](../../test/command-grants.test.js); deny and missing-image cases |
| Suggested note updates could overwrite another window's suggestions | Store each suggestion under its own key. Keep legacy array entries readable and use tombstones when discarding them. | [Memory tests](../../test/memory.test.js); independent cached-window updates and legacy removal |
| Index writers used the same temporary file | Give each atomic cache write a unique temporary path and remove it in a finally block. | [Index tests](../../test/repository-index.test.js); two independent index writers |

The final regression and package evidence is linked from [EVIDENCE.md](EVIDENCE.md). These changes reduce the observed races. They do not make VS Code's cached per-window suggestion count a strict cross-process quota.

## Must-fix findings resolved

| Finding | Resolution |
| --- | --- |
| macOS host-process signals | Checks can signal only processes in the same sandbox. A disposable host process remains protected. |
| Cross-window checkpoint loss | Shared write locks and revision ownership prevent stale overwrite, clear, and resurrection. Resume uses an exact comparison. |
| Nested Python requirement inputs | Cache identity includes the local requirements and constraints closure. Unsupported inputs fail explicitly. |
| Duplicate audit sequence numbers | Tail lookup, append, rotation, and export snapshots share a process-safe lock. Damaged tails are preserved. |

The [verification record](RELEASE-RISK-FIXES.md) links the tests and current installer scope. Historical damaged logs are not rewritten. Restart older extension windows and background runners before using the new storage protocol. Core model-quality and physical-device release gates remain open.

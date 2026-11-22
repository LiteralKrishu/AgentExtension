# Release-risk fixes

Updated: 23 November 2026. These changes remain local and unreleased.

## Scope

This pass fixes the four must-fix findings in the preceding audit. It does not close the model-quality, physical-device, or platform acceptance gates.

| Finding | Change | Acceptance evidence |
| --- | --- | --- |
| A macOS check could signal unrelated host processes | Deny signals outside the same sandbox. Allow signals within the check's sandbox so a command can stop its own child processes. | A real sandbox test blocks SIGUSR2 to a disposable host process and permits child termination. Existing cancellation tests pass. |
| A window could overwrite or clear another run's checkpoint | Serialize checkpoint operations across processes. Give each saved revision a new token. Resume must match the exact loaded revision. Stale saves and clears cannot replace newer work. A new task cannot silently replace existing recovery. | Independent writer processes, a two-window editor test, legacy recovery, stale cancellation, deleted-record resurrection, and real crash-lock recovery. |
| Python cache identity omitted included files | Hash the full local requirements and constraints closure. Include each file path and content hash. Reject unsupported or unavailable inputs before creating a cache. | Nested and quoted paths, line continuation, constraints, cycles, missing files, traversal, remote includes, environment variables, symlinks, and real Docker version changes. |
| Audit writers could assign duplicate sequence numbers | Use a shared lock for tail lookup, append, rotation, and read snapshots. Preserve a damaged tail and refuse to append from it. | Three independent writers, concurrent exports during rotation, contiguous sequence numbers, hash verification, and a damaged-tail case. |

## Storage behavior

The installed file-lock library is now a pinned production dependency. Its bundled license notices are in [storage-lock.txt](../licenses/storage-lock.txt). The lock heartbeat updates every two seconds. After a process dies, its abandoned lock can be claimed after ten seconds. Lock acquisition is bounded. Lock failures leave the task unstarted or stop its checkpoint writes.

A checkpoint reader gets a comparison token. Reading does not grant write ownership. A successful save replaces that token. Resume must compare the token before claiming the record. Apply and protected actions check the run's current checkpoint ownership. Normal cancellation and completion use the run's existing store. Discard compares the record shown in its confirmation.

Version 1 checkpoints remain readable when they have no inline selection. Version 2 inline checkpoints keep their existing validation. Unsupported or damaged records are preserved. A new task cannot overwrite them. Restore a compatible copy or back up the checkpoint file before repairing it. Valid checkpoints still expire after seven days.

The audit log keeps its existing format and retention policy. The fix prevents new concurrent-writer damage. It does not rewrite a previously broken audit history. Verification continues to report that damage. Preserve the affected log before investigating it.

Stop old background runners and restart all extension windows when installing this build. Older versions do not use these locks or ownership tokens. Do not mix old and new writers on one storage folder.

## Python dependency subset

Each include must be on its own line. Supported forms are `-r`, `--requirement`, `-c`, and `--constraint`, with a local path. Quoted paths and line continuations are supported. Relative parent references can resolve inside the snapshot. Inputs must be permitted regular UTF-8 files. The closure is limited to 64 files and 2 MB; one file can be at most 256,000 bytes.

Remote includes, environment-expanded include paths, editable or VCS installs, local package files, and find-links inputs are unsupported by this cache. They fail explicitly. Local project support needs source hashing before it can be enabled. Unrelated application source edits do not invalidate a Python cache. The cache schema changed, so older dependency volumes are not reused for these inputs.

## Verification record

The full regression passed 453 of 471 tests, with 18 skipped and zero failures. Nineteen final storage cases passed after adding preservation of unsupported recovery data and non-overwriting initial creation. The focused editor run passed 12 cases. The real Docker dependency run passed three cases. Source, type, and lint checks passed. The final Mac installer passed 29 cases. Linux passed 31 storage/cache cases and one installer connection fixture. Both extension bundles match. Archive integrity passed. See the [machine-readable record](evidence/release-risk-fixes-2026-11-23.json) and [EVIDENCE.md](EVIDENCE.md).

The evidence uses scripted local model responses. No paid model API, real-model qualification batch, or remote repository write ran.

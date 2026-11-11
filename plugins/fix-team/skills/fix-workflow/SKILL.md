---
name: fix-workflow
description: Diagnose a failed check, draft a contained fix with a worker, and merge it only after checking the proposed hunks.
---

When a check fails, call diagnose_failure before changing code.
Read the cited lines and confirm the cause yourself.
For a contained fix, call propose_worker_edits with the files to change.
Read every proposed hunk. Merge with merge_worker_edits only if each hunk is correct and within the request.
If the merge is refused as stale or overlapping, read the current draft and ask again or edit directly.
Rerun the failed check before review_changes.
Worker output is advice. You and the user still decide what is applied.

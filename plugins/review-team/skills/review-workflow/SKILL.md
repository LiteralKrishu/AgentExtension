---
name: review-workflow
description: Use bounded research and diff review to check a focused coding change.
---

Use research_repository when a separate analysis of relevant source can help.
Give the worker a focused question. Name up to six files if search is insufficient.
After staging changes, use review_draft to inspect correctness and missing tests.
Read each finding. Check it against the source before changing the draft.
Worker findings are advice. They do not approve or apply changes.
If the draft or accepted hunks change, treat the earlier review as stale.
Keep the parent review and command approval steps.

# Implementation plan

Build a local VS Code client for TrueForge. Keep proposed text in memory during the run. Let the user review changes in the editor and apply approved hunks as one undoable edit.

1. Verify the TrueForge session, streaming, MCP, and approval contracts.
2. Inspect released editor extensions for review, context, and cancellation behavior. Record package versions and evidence separately.
3. Register a temporary MCP connector and load the checked-in agent definition into a TrueForge session.
4. Rank repository excerpts and show which files the extension selected and why.
5. Limit inline editing to the original selection. Stage agent edits in the same review queue.
6. Review every hunk, check file contents before apply, and support undo.
7. Test cancellation, model failure, and fallback before any edit reaches the workspace.
8. Rehearse the three fixed tasks against Flask 3.1.3 and record only verified results.

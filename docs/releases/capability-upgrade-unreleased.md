# Capability upgrade — unreleased

Development version: 0.7.1. Date: 23 November 2026. These changes have not been pushed or published.

- Add approved local coding schedules that produce private, checked drafts for an inbox. Questions return for interactive input. Import needs fresh review and explicit apply.
- Add portable draft export and import. An optional managed Git clone separates branch preparation, local commit, push, and draft pull request.
- Add portable SKILL.md import with a preview of unsupported settings. Preserve supported content, explicit-only controls, package versions, and content digests.
- Resolve the three should-fix audit findings for image-download consent, suggested-note updates, and index temporary files.

The [evidence record](../agent-capability-upgrade/EVIDENCE.md) identifies tested source and package scope. The [platform matrix](../agent-capability-upgrade/PLATFORM-MATRIX.md) does not claim acceptance on untested platforms. The [comparison record](../evaluations/2026-11-23-status.md) contains no inferred Cursor or Codex scores.

The core completion and retrieval gate remains open. Physical second-device acceptance is unavailable. Automatic inline suggestions remain unqualified. All four [must-fix audit findings](../agent-capability-upgrade/RELEASE-RISK-FIXES.md) are fixed in this local build. Do not treat this development build as a qualified release.

Before installing, stop older background runners and restart all extension windows so all writers use the new storage protocol.

For rollback, stop the local background runner and revoke its coding schedules. Export useful drafts and back up extension storage. Restore the prior release installer and profile. Do not rewrite private stores with an older schema. Editor Undo affects the last local apply; it does not reverse external effects.

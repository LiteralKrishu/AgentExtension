# Platform and runtime acceptance

Updated: 23 November 2026. Development version: 0.7.1. These changes are local and unreleased.

| Platform | Current package evidence | Command checks | Native apps | Current acceptance |
| --- | --- | --- | --- | --- |
| macOS arm64 | Local extracted VSIX, bundled Node and TrueForge | Private-copy runner and Linux arm64 Docker fixtures | macOS helper builds; no new interactive native-app test | Automated host fixtures only; core qualification and interactive acceptance remain open |
| macOS x64 | No current installer run | Implementation exists; unverified on this architecture | Unverified | Unverified |
| Linux | Current Debian 12 arm64 container passed 31 storage/cache checks; extracted package passed connection and saved-credential restore; Node 22.23.5 | Requires working bubblewrap, or configured Docker | Unsupported | Connection fixture only; current Linux commands and interactive desktop remain unverified; do not infer x64 coverage |
| Windows native | No current installer run | Built-in isolated command runner unsupported; Docker adapter unverified | Unsupported | Unverified; no unrestricted host fallback |
| WSL | No current installer run | Linux environment requirements apply; unverified | Unsupported | Unverified; do not infer Windows or Linux installer coverage |

The source suite uses a VS Code host stub and scripted local model responses. It does not establish real coding-model quality or interactive editor behavior. Container tests run Linux arm64 jobs on Docker Desktop 29.6.2 on this Mac. A container is not a second physical computer.

## Runtime contract

| Server / SDK | Evidence | Decision |
| --- | --- | --- |
| TrueForge 0.184.2 / SDK 0.184.1 | Current source fixtures cover tool approval, streaming usage, questions, forced compaction, workers, cancellation, recovery, and scheduled drafts. The extracted-package run repeats selected contracts. | Keep current pins. |
| TrueForge 0.185.1 / newer SDK | Historical 17 November approval-pause failure in local review and continuation tests. Not rerun on this source. | Candidate rejected; do not upgrade from the historical partial result. |
| Other versions | No current contract run. | Unverified. |

The package test covers first connection, saved-credential restore, the bundled runtime, and its authenticated loopback endpoint. A separate packaged workflow fixture covers a scripted agent, a real isolated check, review, managed branch preparation and local commit without inherited filters, apply, undo, and cancel in a disposable host. Selected checkpoint, question, compaction, and worker tests run against the extracted extension bundle. None of these replaces an interactive installation on each platform.

Package provenance records the VSIX hash, size, build platform, Node version, source and evaluator digests, lockfile hashes, and dependency license inventory. The [dependency inventory](evidence/package-licenses-2026-11-23.json) records 368 package license labels, with none missing. The installer carries the Node license. A missing license label is recorded as missing; it is not treated as license approval.

See the [current evidence](EVIDENCE.md), [package fixture](../../test/managed-vsix.test.js), [workflow fixture](../../test/packaged-workflow.test.js), and [historical platform notes](../remaining-work.md).

The [release-risk pass](RELEASE-RISK-FIXES.md) adds the current 29-case Mac package result and Linux storage/cache evidence. Close older extension windows and background runners before installing the new storage protocol.

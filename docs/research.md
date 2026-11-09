# Released extension checks

The inspection covered two public VS Code releases. It used the shipped manifests and focused static analysis of methods from each JavaScript bundle. The findings below describe those releases.

| Release | Observed behavior in the shipped code | REA evidence |
| --- | --- | --- |
| [Cline 3.19.7](https://github.com/cline/cline/releases/tag/v3.19.7) | The multi-file review builds a native changes view from checkpoint diffs. The save and revert handlers operate on the active diff document. Cancellation calls the task abort path and bounds its wait for streaming to stop. | `ev_873aa7b47bc7aa77e50f422b1a243be55f23f59cf174315e10571a58da5174aa` |
| [Roo Code 3.54.0](https://github.com/RooCodeInc/Roo-Code/releases/tag/v3.54.0) | The shipped editor code invokes the native diff command. The save and revert handlers manage the diff document and remove newly created files on revert. Cancellation stops the current request and checks its task instance before restoring history. | `ev_d93fa28935dbdea24bc2c5e5f6ac33d22f5095141b0f97f490a65207db9a48a3` |

The full host bundles exceeded the static worker's memory limit. The focused analysis covered the save, revert, and cancellation methods in both releases and the multi-file review method in Cline. Call paths outside those slices, retrieval ranking, and runtime behavior remain unverified.

## Installed editor builds

| Build | Observed in the shipped code | Documented behavior |
| --- | --- | --- |
| Google Antigravity IDE 2.6.0 | The workbench distinguishes plan, task, and walkthrough artifacts. A separate artifact review state subscribes to a review topic and sends state updates. | Users can review an implementation plan before proceeding. A walkthrough can report verification results. [Implementation plan](https://www.antigravity.google/docs/ide-implementation-plan) · [Walkthrough](https://antigravity.google/docs/walkthrough) |
| Cursor 3.23.23 | The workbench has a separate review service declaration. Focused checkpoint methods read file content from snapshots and queue updates to the conversation checkpoint with a cancellation guard. | Users can preview the full diff and review files and individual changes. [Diffs and review](https://docs.cursor.com/en/agent/review) |

The installed artifacts were inspected as static files. REA retained selected package sources and the two workbench excerpts per build. The full workbench bundles and server-side agent behavior are outside this evidence.

| Build | Selected package evidence | Focused excerpt evidence |
| --- | --- | --- |
| Antigravity IDE | `ev_0a7ac2f2a57ed76e1d6ee43f76d6f6ccc77a54aa59ea69501ad9210eebea4c52` | `ev_5edd9da406715e701564c7fee3aafd16bfa5ee246134628caeeb286a68a054a4` |
| Cursor | `ev_d4712542b1039c2bbee400502dc07c7abea1056c586f128ce5d6484b1348ae8c` | `ev_b2a2ca22ddae75899098e6bda37462ce12c145a071046b1f1def972ad8382aef` |

The focused excerpts came from `out/vs/workbench/workbench.desktop.main.js`. Byte ranges are zero-based and end-exclusive.

| Build | Workbench SHA-256 | Byte ranges |
| --- | --- | --- |
| Antigravity IDE | `0a7127d6df014109a4bd7921fdd0e2548601c0cdb9193ae14ed860c8439eb647` | 11495103–11495619 and 17031998–17032339 |
| Cursor | `444498c2672d6172416654b60d267bff8457277441de0049b7a2147468528ad8` | 18057665–18058191 and 18058836–18059658 |

The Cursor excerpt parser used a synthetic class wrapper for each method. The wrapper is outside the recorded byte ranges. The focused graph retains static facts and unknowns. Runtime sequencing, storage lifetime, and the full review implementation remain unverified.

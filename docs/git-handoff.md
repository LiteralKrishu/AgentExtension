# Draft handoff

Open **More actions → Draft handoff**, or run **AgentExtension: Draft Handoff**.

Review and accept a draft first. **Export reviewed draft** writes a JSON file with its exact patch, Git base, source digest, check summary, and reviewer notes. Save the file outside the source checkout. The file contains source code. Review it before sharing it. A check is marked unverified if its recorded patch differs from the exported changes.

**Import draft handoff** works without a Git provider. It previews the diff and checks the current source base. It refuses to replace a recovery checkpoint. Import starts a new interactive run. Check grants and hunk decisions do not transfer. Review and apply the draft through the normal panel.

**Prepare local branch** requires a clean source checkout and an exact match with its origin URL. The extension creates a separate local clone and a `main/` branch at the reviewed commit. It copies only the draft changes. Git hooks and configured filter commands are disabled for these operations. Your active checkout and branch stay unchanged. New files require an existing parent folder.

**Commit managed draft** is a separate action. Review the path, branch, and configured Git author. The commit adds no generated attribution. The managed checkout stays available until you select **Remove managed checkout**. Keep its path if you close the editor. The current window does not restore the handoff controls after a restart; you can use Git on the saved checkout.

Push and draft pull request are separate actions. They need an existing configured MCP connector with a matching repository URL and the following supported contract:

- The read tool accepts only its configured repository target. It returns JSON `null`, an empty array, or records with `branch` and a full `commit` hash. An optional `kind` is `push` or `pull-request`.
- The write tool accepts its configured repository target plus `branch`, `commit`, `base`, and `patch`. A pull request also uses `title`, `body`, and `draft: true`. Declare these names in the connector's `extraArguments`.
- The write tool returns JSON with the same `branch` and `commit`. Its implementation must publish that exact commit. This is an adapter contract, not support for every Git provider tool schema.
- Existing connector account, policy, and fresh approval checks apply. The prompt shows the repository, branch, commit, account, tool, target, and patch arguments. The existing 4,000-character connector write limit applies; larger handoffs fail without truncation.

The extension reads destination state before a write. A matching result needs no repeated write. A conflicting result blocks the action. After a lost response, it reads the destination again. If that read cannot confirm the result, it reports uncertainty and does not retry automatically.

The acceptance tests use local Git repositories, a scripted connector adapter, and a loopback MCP fixture. They perform no real remote push or pull request. They do not prove a provider's authorization or commit-import behavior.

Implementation references: [Git local clone options](https://git-scm.com/docs/git-clone), [Git configuration](https://git-scm.com/docs/git-config), [handoff tests](../test/git-handoff.test.js).

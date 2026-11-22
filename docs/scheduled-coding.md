# Scheduled coding drafts

Open **More actions → Scheduled coding drafts**, or run **AgentExtension: Scheduled Coding Drafts** from the Command Palette.

Use an existing local TrueForge server. The editor's temporary bundled connection cannot stay available after the editor closes. Configure managed container checks first. This feature copies no model credentials into the runner.

Choose the task, up to eight files, up to four checks on one container profile, and a daily time. Review the source base, image digest, files, model, checks, and budgets. Approval lasts seven days. It covers five minutes, 100,000 reported tokens, and 30 tool calls per occurrence. Dependency setup can contact the profile registry. Lifecycle scripts stay off. An absent image needs a separate download decision.

Start the existing local background runner to evaluate schedules while the editor is closed:

```sh
node <extension>/src/background-cli.cjs serve <extension-storage>
```

Use background-cli.js when running from source. The runner also supports status, run-now, pause, and revoke. Reports and coding jobs have separate stores. Existing report schedules stay read-only.

When an editor opens, it checks the approved model, policy, and managed-check settings. Changed settings pause the schedule and require a new approval. The standalone runner uses its approved settings snapshot. It cannot watch closed-editor settings files. Use CLI revoke before changing those settings while the editor is closed. Administrator policy and explicit revocation are checked during each run.

Each coding job checks its approved Git commit and permitted source contents. It copies saved source into a private directory. The model can stage changes only in the named files. It cannot use connectors, browser actions, native apps, workers, commits, or pushes. Every declared check runs against the final draft in a managed container. A changed source base, revoked scope, missing check, failed check, or cancellation prevents a ready result. One shared occurrence claim prevents editor and background copies from repeating the same timed job.

Open **Review coding drafts** for the patch, original source base, check outcomes, and saved questions. The inbox keeps at most 50 results per workspace. A question returns a needs-input result. Answer it when importing the draft into a new interactive run.

Import checks the source base again. It refuses to replace an existing recovery draft. The interactive run starts with fresh permissions and hunk review. Old check grants and review decisions are not restored. Applying changes remains explicit.

The current acceptance evidence uses scripted local models and real Linux arm64 containers on this Mac. It verifies execution and review controls. It does not qualify the local coding models or close the roadmap's core quality gate.

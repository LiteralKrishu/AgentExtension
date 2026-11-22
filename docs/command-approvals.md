# Command approvals

The editor first checks the current permission rules. An exact workspace allow rule can avoid a prompt. A deny rule blocks dispatch. A rule that requires approval still prompts for each call.

For a managed container check, the prompt also offers **Allow unchanged checks for 5 minutes**. This option applies only to the current run. It binds the executable, arguments, workspace, draft revision, selected hunks, source contents, container image digest, service declaration, and permission epoch. It expires after five minutes at most.

A different source, lockfile, open buffer, command, draft selection, image, service declaration, or policy needs a new matching decision. The host checks the private snapshot before dispatch. It also checks expiry and revocation after preparation. A source change while the check runs makes the result stale.

The Access details show the active grant scope, expiry, recent actions, prompt count, wait time, rule use, and grant reuse. Select **Revoke access** to end access for the run. Retry and run end clear grants. A model summary cannot create or restore a grant. Restart starts with no grants.

Reusable grants apply only to managed command checks. Host-isolated checks keep exact approvals. Connector writes, browser writes, native actions, and applying draft hunks keep their separate controls. An administrator can disable reusable approvals with the existing allow-rule restriction.

The saved run report includes approval counts and wait time by action. It omits command arguments from the central permission log. The source identity uses the same permitted file scope as command snapshots. Private and excluded files do not enter that identity.

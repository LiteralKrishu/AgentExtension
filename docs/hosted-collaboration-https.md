# Run the shared-project HTTPS pilot

Use two computers. **Device A** runs the organization service and sends a draft. **Device B** receives the draft. Both computers run AgentExtension in separate test profiles. These steps use a scratch Git repository with one text file.

## 1. Connect the two computers

Install Git, VS Code, Node.js 22.14 or later, and Tailscale on both devices. Join both to the same private Tailscale network. Enable MagicDNS and HTTPS certificates in that network. If you use a managed network, ask its administrator to allow Device B to reach Device A. Tailscale Serve will give the service an HTTPS address that both computers can reach. [Tailscale installation](https://tailscale.com/docs/install) · [Enable HTTPS certificates](https://tailscale.com/docs/how-to/set-up-https-certificates) · [Private Serve setup](https://tailscale.com/docs/use-cases/application-testing/share-local-dev-server-with-team)

On macOS, install the `code` command from the VS Code Command Palette if the terminal cannot find it. Use **Shell Command: Install ‘code’ command in PATH**. For Tailscale’s standalone macOS app, enable its CLI integration in the app settings. [VS Code CLI](https://code.visualstudio.com/docs/configure/command-line) · [Tailscale CLI on macOS](https://tailscale.com/docs/reference/tailscale-cli?tab=macos)

The terminal examples use Bash or zsh. On Windows, use Git Bash for the preparation steps and PowerShell to launch VS Code.

## 2. Put the same test workspace on both devices

On **Device A**, open a terminal in the AgentExtension repository and run these commands.

```sh
PILOT=$(mktemp -d "$HOME/agentextension-pilot.XXXXXX")
printf 'Pilot folder: %s\n' "$PILOT"
npm ci
npm run package:vsix -- "$PILOT/agentextension.vsix"

git init -b main "$PILOT/workspace"
printf 'Original pilot text\n' > "$PILOT/workspace/pilot.txt"
git -C "$PILOT/workspace" add pilot.txt
git -C "$PILOT/workspace" -c user.name="Pilot Fixture" -c user.email="fixture@example.com" \
  -c commit.gpgsign=false commit -m "Create pilot fixture"
git -C "$PILOT/workspace" bundle create "$PILOT/fixture.bundle" --all
```

On **Device B**, create its pilot folder. Copy `agentextension.vsix` and `fixture.bundle` from A into that folder by USB or another approved file transfer.

```sh
PILOT=$(mktemp -d "$HOME/agentextension-pilot.XXXXXX")
printf 'Pilot folder: %s\n' "$PILOT"
```

On B, open the copied Git bundle. Run the last command on both computers to confirm they show the same commit.

```sh
# Run clone on Device B only.
git clone -c core.autocrlf=false "$PILOT/fixture.bundle" "$PILOT/workspace"
git -C "$PILOT/workspace" rev-parse HEAD
```

Keep the terminals open for the remaining steps. In a new terminal, set `PILOT` to that device's printed folder path.

## 3. Give each device its own credential

Run this once on **each device**. It creates a private `device.token` file and prints the workspace key and token hash. Give A the two printed values from B. Keep each `device.token` file on the computer that created it. On Windows, keep the pilot folder in your private user profile and restrict the token file to your account. [Organization credential setup](../README.md#organization-policy-and-audit)

```sh
node - "$PILOT" <<'JS'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const pilot = process.argv[2];
const root = fs.realpathSync(path.join(pilot, 'workspace'));
const token = crypto.randomBytes(32).toString('hex');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
fs.writeFileSync(path.join(pilot, 'device.token'), token, { flag: 'wx', mode: 0o600 });
console.log('Workspace key:', hash(JSON.stringify(root)).slice(0, 16));
console.log('Token hash:', hash(token));
JS
```

## 4. Start the service on Device A

Replace `B_WORKSPACE_KEY` and `B_TOKEN_HASH` in the first line with B’s printed values. Run the block on A in the AgentExtension repository.

```sh
node - "$PILOT" B_WORKSPACE_KEY B_TOKEN_HASH <<'JS'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [pilot, bWorkspace, bHash] = process.argv.slice(2);
if (!/^[a-f0-9]{16}$/.test(bWorkspace) || !/^[a-f0-9]{64}$/.test(bHash)) {
  throw new Error('Replace both placeholders with the values printed on Device B.');
}
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const aRoot = fs.realpathSync(path.join(pilot, 'workspace'));
const aWorkspace = sha(JSON.stringify(aRoot)).slice(0, 16);
const aHash = sha(fs.readFileSync(path.join(pilot, 'device.token'), 'utf8').trim());
const clients = [
  { id: 'device-a', workspaces: [aWorkspace], tokenHash: aHash, readAudit: true },
  { id: 'device-b', workspaces: [bWorkspace], tokenHash: bHash },
];
const policies = Object.fromEntries(
  [aWorkspace, bWorkspace].map(key => [key, { version: 1, rules: [] }])
);
const members = [
  { user: 'sender', device: 'device-a', workspace: aWorkspace, role: 'editor' },
  { user: 'recipient', device: 'device-b', workspace: bWorkspace, role: 'editor' },
];
const collaboration = { organization: 'pilot-org', projects: [{ id: 'https-test', handoffs: true, members }] };
fs.writeFileSync(path.join(pilot, 'service.json'), JSON.stringify({ clients, policies, collaboration }, null, 2),
  { flag: 'wx', mode: 0o600 });
JS
node src/organization-service.js "$PILOT/service.json" "$PILOT/service-storage" 18788
```

Keep that terminal running. In a second terminal on A, check that the Serve port is free and start the private HTTPS proxy.

```sh
tailscale serve status
tailscale serve --https=8443 http://127.0.0.1:18788
```

Keep this terminal running too. Copy the full `https://…` origin printed by Serve, including its port. On both devices, open that origin with `/v1/project` appended in a browser. The expected response is `A workspace key is required.` The response shows that the browser reached the organization service over HTTPS. [Serve CLI reference](https://tailscale.com/docs/reference/tailscale-cli/serve)

## 5. Open the two VS Code test profiles

On each device, replace `https://REPLACE-WITH-SERVE-ORIGIN:8443` with the exact origin from the previous step. Run the block to generate the policy file.

```sh
node - "$PILOT" 'https://REPLACE-WITH-SERVE-ORIGIN:8443' <<'JS'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [pilot, address] = process.argv.slice(2);
const url = new URL(address);
if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash ||
    url.username || url.password || url.hostname.includes('replace-with')) {
  throw new Error('Use the HTTPS origin shown by Serve, including its port.');
}
const root = fs.realpathSync(path.join(pilot, 'workspace'));
const workspace = crypto.createHash('sha256').update(JSON.stringify(root)).digest('hex').slice(0, 16);
const policy = {
  version: 1,
  organization: {
    url: url.origin,
    tokenFile: path.resolve(pilot, 'device.token'),
    workspaces: [workspace],
    projects: { [workspace]: { organization: 'pilot-org', project: 'https-test' } },
  },
};
fs.writeFileSync(path.join(pilot, 'policy.json'), JSON.stringify(policy, null, 2), { flag: 'wx', mode: 0o600 });
console.log('Policy file:', path.resolve(pilot, 'policy.json'));
JS
```

If a device already has an AgentExtension administrator enrollment, ask its administrator to add the pilot binding.

On macOS or Linux, install the package and launch the isolated editor.

```sh
code --user-data-dir "$PILOT/vscode-user" --extensions-dir "$PILOT/vscode-extensions" \
  --install-extension "$PILOT/agentextension.vsix"
AGENTEXTENSION_POLICY_FILE="$PILOT/policy.json" \
  code --user-data-dir "$PILOT/vscode-user" --extensions-dir "$PILOT/vscode-extensions" "$PILOT/workspace"
```

On Windows, set `$Pilot` to the Windows path of the folder printed in step 2.

```powershell
$Pilot = 'C:\Users\you\agentextension-pilot.abc123'
code --user-data-dir "$Pilot\vscode-user" --extensions-dir "$Pilot\vscode-extensions" --install-extension "$Pilot\agentextension.vsix"
$env:AGENTEXTENSION_POLICY_FILE = "$Pilot\policy.json"
code --user-data-dir "$Pilot\vscode-user" --extensions-dir "$Pilot\vscode-extensions" "$Pilot\workspace"
```

Trust your scratch workspace when VS Code asks. Open **AgentExtension: Open Shared Project** on both devices. A should show `sender · device-a · editor`. B should show `recipient · device-b · editor`. [VS Code isolated instances](https://code.visualstudio.com/docs/configure/command-line#_advanced-cli-options) · [Shared-project commands](../README.md#shared-project-pilot)

## 6. Run the checks

1. **Conflict.** On both devices, choose **Edit shared notes** before either device publishes. Enter different text. Publish on A. Publish on B. B should show both versions and ask which to keep. Publish B's edit and verify A can view it.
2. **Seed a draft.** On A, run the block below in the AgentExtension repository. It prepares a saved draft in the test profile. This check can run without a model.

   ```sh
   node - "$PILOT" <<'JS'
   const fs = require('node:fs');
   const path = require('node:path');
   const { randomUUID } = require('node:crypto');
   const { CheckpointStore } = require('./src/checkpoint');
   const { digest } = require('./src/permissions');
   const pilot = process.argv[2];
   const workspace = fs.realpathSync(path.join(pilot, 'workspace'));
   const storage = path.join(pilot, 'vscode-user', 'User', 'globalStorage', 'literalkrishu.agentextension');
   const file = 'pilot.txt';
   const base = fs.readFileSync(path.join(workspace, file), 'utf8');
   new CheckpointStore(storage, workspace).save({
     runId: randomUUID(), request: 'HTTPS pilot draft', phase: 'interrupted', revision: 1, planFirst: false,
     files: [{ file, base, baseDigest: digest(base), text: 'Updated by HTTPS pilot\n' }],
   }).catch(error => { console.error(error.message); process.exitCode = 1; });
   JS
   ```

3. **Assignment and offline behavior.** On A, choose **Share a saved draft**, select B, and approve sharing `pilot.txt`. On B, open the assignment and choose **Review on this device**. Disconnect B from Tailscale while review is open. The review should close and `pilot.txt` should stay unchanged. Reconnect B and reopen the assignment.
4. **Revocation and roles.** While B is reviewing the draft, remove the `device-b` member from the project. On A, first save a copy of `service.json` in the pilot folder. Edit a second copy. Replace `service.json` with the edited copy using `mv` within that folder. The service reads the current file without a restart. Confirm B's review closes and its next attempt to open the project is denied. Repeat with B’s role set to `viewer`. B should be able to read shared notes, and the draft should be absent from its picker. Restore the original configuration using the same replace procedure.
5. **Local apply.** On B, reopen the assignment and inspect `pilot.txt` in hunk review. Before Apply, the file should still contain `Original pilot text`. Accept the hunk and apply it. Run `git -C "$PILOT/workspace" diff -- pilot.txt` to check the resulting line.
6. **Audit.** On A, choose **View project audit**. Look for the draft send attributed to `sender / device-a` and the draft acceptance attributed to `recipient / device-b`.

Record the results in [remaining-work.md](remaining-work.md#verification-still-open). Include the two device operating systems, VS Code versions, and results for HTTPS reachability, conflict, assignment, offline review, revocation, Apply, and audit. Keep credential files out of the results.

### Check session continuation

1. Reset the scratch file on B to its original Git version. Set `sessionContinuations` to `true` in the pilot project and give both editor memberships the same `user` ID. Keep their separate device credentials. Configure local TrueForge and a model on B.
2. Reuse the saved checkpoint on A from step 2. Share a session continuation with B and review the contents. On B, import it. Check that the editor shows a checkpoint and waits for you to select **Resume**.
3. Select **Resume** on B. Check that a local TrueForge session starts and reads the staged text. Review any protected actions in B's editor. Revoke B's membership before Apply and confirm that the file stays unchanged. Record the two TrueForge versions and results with the HTTPS pilot. [Continuation setup](../README.md#continue-a-trueforge-session-on-another-device)

When you finish, press **Ctrl+C** in the Serve terminal on A, then in the organization-service terminal. Close the two test profiles.

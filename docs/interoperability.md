# Portable skills and plugin compatibility

Use **Configure tools → Import plugin package**. Select an AgentExtension package or a local file named `SKILL.md`. Review the publisher label, version, content digest, capabilities, and import warnings. Import installs content. Enable it separately for the workspace.

| Input | Supported subset | Limits |
| --- | --- | --- |
| Agent Skills folder | Required name and description; Markdown body; text references and assets | Name must match its folder. Source is copied unchanged. Per-file and package quotas apply. |
| Invocation controls | Boolean `allow_implicit_invocation: false` and `disable-model-invocation: true` | Explicit-only skills cannot be selected automatically. A disabled skill is rejected. |
| Provenance | `metadata.author` and a three-part `metadata.version` | Labels are not verified publisher identities. Missing labels use “Unspecified local author” and version 0.0.0. Original metadata stays in SKILL.md. |
| Skill scripts | Up to four declared standalone CommonJS scripts | Each call needs normal script approval and the existing isolated runtime. Import runs no script. Shell and Python scripts are not converted. |
| Named workflows | AgentExtension `plugin.json` workflow entries | Prompt editing, planning, version pins, and ordinary action approvals still apply. Foreign workflow or role formats are not converted. |
| MCP tools | Existing configured read tools and separately declared write tools | Exact targets, scalar arguments, account scope, size limits, policy, and fresh action approval apply. MCP annotations grant no local authority. |

The preview lists unsupported metadata such as `model`, `agent`, `hooks`, `context`, and `allowed-tools`. It also lists files that will not be imported. These fields cannot add a model connection, hook, role, command permission, or connector credential. Supported text references are loaded only when requested from an active skill. Symlinks, invalid metadata, and oversized inputs fail before publication.

An imported package uses an immutable content version. Reimporting changed content creates a new digest and invalidates old workspace approval. The old installed version remains usable if an import is rejected or declined. Export an installed plugin as an `.agentextension-plugin.json` file to share its exact supported content and digest. A local folder is also a supported distribution path. No marketplace is required.

This is a supported subset. It does not run arbitrary Cursor, Claude, or Codex configurations. In particular, tool pre-approval from another product does not become local permission. See the [Agent Skills specification](https://agentskills.io/specification), [Claude skill fields](https://code.claude.com/docs/en/skills), and [MCP tool specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) for the source formats. [Compatibility tests](../test/portable-skill.test.js) verify this subset.

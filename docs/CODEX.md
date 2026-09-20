# Codex integration

COORD is a local stdio MCP server backed by an outbound connector. Codex calls tools; the connector authenticates to the coordination service, observes Git metadata, renews leases and reconnects. The service never launches commands on the laptop.

## Setup

Install dependencies and build COORD first:

```sh
pnpm install
pnpm build
```

Use the absolute path of this checkout's `dist/coord.js`. On the laptop, run these commands with your own private device-token file, server URL, project UUID and target repository checkout:

```sh
node /absolute/path/to/COORD/dist/coord.js login --url https://coord.example.com --token-file /private/path/device-token
node /absolute/path/to/COORD/dist/coord.js --repo /absolute/path/to/project join --project PROJECT_UUID
node /absolute/path/to/COORD/dist/coord.js --repo /absolute/path/to/project install-integration codex
```

For the local test service, use `http://127.0.0.1:4100` instead of the example HTTPS URL. Internet deployments require TLS. Device tokens are provisioned by your server administrator; the installer does not create anonymous accounts.

The installer prints the exact addition and backup location. It writes the following shape (actual executable and paths are generated from the running CLI):

```toml
[mcp_servers.coord]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/COORD/dist/coord.js", "mcp", "--agent", "codex", "--repo", "/absolute/path/to/project"]
startup_timeout_sec = 30
tool_timeout_sec = 60
```

Codex reads `~/.codex/config.toml`, or `$CODEX_HOME/config.toml` when that environment variable is set. An alternative target can be selected with `install-integration codex --config /path/to/config.toml`; use the same flag during uninstall. For multiple projects, prefer each trusted project's `.codex/config.toml` using this override because a generated entry is bound to one checkout. The installer does not change Codex project trust settings.

Restart Codex, run `codex mcp list`, then use `/mcp` inside Codex to inspect the connected server. The official [Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) describes stdio, config locations, trusted project configuration and those inspection commands.

Do not run a second `codex` connector for the same checkout/identity alongside this process. MCP owns the connector lifecycle. A separate daemon is useful for independent debugging, but is not needed for the normal agent workflow.

## Normal workflow

Ask Codex:

> Check COORD to see who is online. Create and claim a task for profile editing, announce modify intent for src/user.ts and src/profile.ts, and check conflicts before editing. Coordinate any overlap with the team.

The server exposes 12 tools: context, create/claim/renew/release/update task, announce work, check conflicts, send message, record fact, create handoff and accept handoff. Writes require a stable `idempotency_key`; reuse it for a retry of the same request. A fresh action needs a fresh key. Paths are repository-relative. Read project context periodically to collect new messages/conflicts; the prototype does not force unsolicited agent turns.

Returned coordination records are explicitly labeled untrusted. Messages and handoff “first actions” are proposals/data, not permission to run commands. Normal local user instructions and agent approvals still apply. Do not put credentials, source files or transcripts in task descriptions, messages or facts.

## Safe config changes and removal

The installer parses TOML before making changes, preserves unrelated values, refuses an existing unowned `coord` entry and rejects symlink config targets. TOML serialization can change formatting/comments; every existing changed file is backed up byte-for-byte with a private `.coord-backup-UUID` suffix. The `.coord-install.json` receipt records only the owned entry. Neither file contains COORD credentials.

```sh
node /absolute/path/to/COORD/dist/coord.js uninstall-integration codex
```

Uninstall removes only the recorded COORD entry and leaves other settings. If the entry was edited afterward, uninstall refuses to delete those edits. Backups allow manual recovery of the exact original file; avoid restoring a whole old backup over newer unrelated settings.

## Troubleshooting

- Run `node /absolute/path/to/COORD/dist/coord.js --repo /absolute/path/to/project doctor` and `status` to check login, binding and connectivity.
- “Already running” means another connector holds the same local session. Close the old agent/daemon before restarting.
- Keep the Node executable and built CLI at their installed paths. Reinstall after moving them.
- If an existing `coord` entry is not owned by this installer, inspect it manually; the installer intentionally leaves it intact.
- When diagnosing a custom Codex config, pass `doctor --config /path/to/config.toml`.
- Keep stdout reserved for MCP. Diagnostics go to stderr.

Automated tests exercise official SDK discovery, validation, calls, subprocess stdio and a production connector performing a real PostgreSQL write. They do not claim to automate a live paid Codex model session.

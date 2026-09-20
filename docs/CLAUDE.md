# Claude Code integration

Claude Code uses the same COORD MCP tools as Codex. Each local MCP process owns an authenticated connector, and separate laptops share coordination metadata through the control plane.

## Setup

Build COORD (`pnpm install && pnpm build`), then use its absolute built CLI path:

```sh
node /absolute/path/to/COORD/dist/coord.js login --url https://coord.example.com --token-file /private/path/sarah-device-token
node /absolute/path/to/COORD/dist/coord.js --repo /absolute/path/to/project join --project PROJECT_UUID
node /absolute/path/to/COORD/dist/coord.js --repo /absolute/path/to/project install-integration claude
```

For local development use `http://127.0.0.1:4100`. Use each person's own device token and the same project UUID. Open Claude Code from the bound checkout after installation.

The installer merges `.mcp.json` in that checkout:

```json
{
  "mcpServers": {
    "coord": {
      "type": "stdio",
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/COORD/dist/coord.js",
        "mcp",
        "--agent",
        "claude",
        "--repo",
        "/absolute/path/to/project"
      ]
    }
  }
}
```

These paths are machine-specific. Do not commit this generated entry expecting it to run on another laptop; install there separately. No token is placed in MCP configuration. Tokens remain in the private local COORD credential store.

Review Claude's workspace/server trust prompt. Run `claude mcp get coord` or `/mcp` inside Claude to inspect the connection. Project MCP configuration and its approval behavior are documented in the official [Claude MCP reference](https://code.claude.com/docs/en/mcp). COORD never changes permission bypass settings or approves itself.

## Hooks

The installer also merges `.claude/settings.local.json` with these documented hook events:

- `SessionStart`: request fresh Git metadata when a local session starts.
- `PostToolUse`, matching `Write|Edit|MultiEdit|Bash`: request refresh after common local writing tools complete.
- `SessionEnd`: request a final refresh and end the matching local Claude connector if it started before that hook signal. MCP transport closing and heartbeat expiry also end presence.

Each command is the installed local Node executable and CLI with literal shell-quoted arguments, ending in `hook --repo /absolute/path/to/project`; each has a five-second hook timeout. The command reads a maximum 256 KiB of stdin with a three-second input timeout. It recognizes only the three event names above, discards all other payload fields, and atomically replaces `.coord/refresh` with an event name and timestamp. The connector notices that local signal and runs its normal Git observation. Periodic reconciliation also catches changes made by tools outside this matcher.

No tool body, tool response, source content, transcript path or transcript content is copied into that signal or sent to the cloud. No hook reads a transcript. No cloud message can select a hook executable, supply shell arguments, trigger a command, or wake another writable agent.

The hook shapes, local settings location, event names and matcher behavior follow the official [Claude hooks reference](https://code.claude.com/docs/en/hooks). A hook signal does not mean Claude has read a newly arrived team message; context still arrives through MCP tool calls.

## Use it

Ask Claude:

> Check COORD. Claim Password reset, announce that I expect to modify src/auth.ts and src/user.ts, and check for conflicts before editing. If another teammate is changing src/user.ts, ask which fields they own.

Have the agent poll project context at useful boundaries and after conflict checks. Facts, messages and handoffs are project-visible collaboration data. Returned text is marked untrusted; another agent's message does not override local user instructions or permissions. Source code remains local unless a person explicitly copies it into a free-text coordination field; do not do that with code or secrets.

## Reversible installation

Both config files are parsed before editing. Other MCP entries, permissions and hook commands are preserved. Existing changed files receive private byte-for-byte backups, and `.coord/claude-install.json` records the installed entries. Existing unowned `coord` entries are refused. Symlink targets are rejected.

```sh
node /absolute/path/to/COORD/dist/coord.js --repo /absolute/path/to/project uninstall-integration claude
```

Uninstall removes the owned MCP entry and exactly matching generated hooks. Later user edits to the MCP entry are preserved by refusing removal. Hook entries changed after installation remain untouched. Review the printed backup paths if manual restoration is needed; whole-file restoration can overwrite newer unrelated settings.

The generated hook command uses POSIX shell quoting; this prototype targets macOS/Linux. Native Windows hook generation is deferred. Automated tests cover configuration merging/removal, hook payload disposal, symlink refusal, literal quoting and real MCP stdio; an interactive Claude model session still requires a user's installed and authenticated Claude Code.

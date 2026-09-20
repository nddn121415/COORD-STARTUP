# COORD

**COORD makes your team's coding agents aware of each other's work.**

Codex and Claude Code stay local, in their existing workflows. COORD tracks task ownership, intended files, observed Git changes, conflicts, structured project facts and handoffs. No custom IDE is required. Source files and transcripts stay on the laptop by default; the control plane receives coordination metadata. Explicit file sharing sends selected source/text files directly to another computer over pinned HTTPS, into a review folder.

This is a functional developer prototype, with real PostgreSQL persistence, authenticated WebSockets, local Git observation and an official SDK MCP server. It is not a production identity service. Automated tests exercise two independent connectors and actual stdio MCP subprocesses. Interactive Codex/Claude sessions on two physical laptops are a documented manual validation, not a claimed automated result.

## Local-first desktop app

[**Download COORD for Mac (Apple silicon)**](https://github.com/nddn121415/COORD-STARTUP/releases/download/desktop-v0.5.0/COORD-0.5.0-mac-arm64.dmg)

**Choose a local folder, copy a connection key, and approve your teammate.** The desktop app runs in the menu bar, automatically synchronizes supported files through exclusive reservations and base-hash checks, and configures project-scoped Codex/Claude tools. It requires no website account or GitHub repository.

Each connected MCP process can create its own isolated working directory, reserve files, and submit guarded changes. Overlapping reservations and stale publications are rejected; conflicting local edits are retained. Arbitrary shell/editor writes are not intercepted, and internal subagents sharing one MCP process are not automatically distinguished. Existing coding sessions may need a reload and the tool's normal trust/MCP approval.

See the [two-Mac testing walkthrough and exact limits](docs/LOCAL_DESKTOP.md). The Mac build targets Apple silicon/macOS13+, includes its runtime, and is currently ad-hoc signed (not yet Apple-notarized). The original account-based collaboration website remains a private preview and is not required by the new desktop flow.

## Download and try file transfer

[**Download the file-transfer tester**](https://github.com/nddn121415/COORD-STARTUP/releases/latest/download/coord-peer.zip) · [Releases](https://github.com/nddn121415/COORD-STARTUP/releases)

1. Install [Node.js](https://nodejs.org) 22.18+ (24 recommended) if needed.
2. Download and unzip `coord-peer.zip`.
3. On Mac, open **Test COORD.command**. Alternatively, open Terminal in the extracted folder and run `node coord-peer.cjs demo`.

For an automatic internet-connectivity test, open **Test Wi-Fi.command** or run `node coord-peer.cjs demo --wifi`. This checks discovery between two processes on your computer, not two physical computers.

The demo transfers a sample file over real encrypted HTTPS, verifies it, and cleans up. It needs no Git, pnpm, account or database and does not touch your project. The download includes both send/receive commands and a short `README.txt` for testing with a second computer. macOS may block the unsigned launcher; the Terminal command works without changing system security settings. macOS/Linux are the validated targets.

This download tests **file transfer**, not the full agent coordination system. Use `share-files --wifi --file path/to/file` for automatic discovery and connection over ordinary internet/Wi-Fi, without entering IPs or setting up a VPN. Restrictive networks can still block direct connectivity; there is no hosted fallback relay yet. The complete Codex/Claude coordination setup is below.

Already developing this repository? Run `pnpm demo:peer`. To build and check the download, run `pnpm package:peer` then `pnpm check:peer-package`.

## How computers share

**GitHub stores this product's source code. Git is never the live sharing transport.**

Coordination uses authenticated WebSockets. The new `share-files` and `receive-files` commands transfer selected code directly between computers over encrypted HTTPS, without a Git push/pull or any file-content upload to COORD's server. Uncommitted files work too. Receiving stages a private copy for review and never applies or executes it automatically.

Start with the [direct computer-to-computer walkthrough](docs/DIRECT_TRANSFER.md). This standalone transfer needs neither a database nor COORD login. The `--wifi` option uses public HyperDHT discovery and automatic UDP hole punching. Discovery exposes connection metadata, not your invitation token or source files. The original HTTPS mode remains available for explicitly reachable addresses.

## Quickstart

Requirements: Node.js 22.18+ (24 recommended), pnpm 11.19+, Git, and macOS/Linux for the bundled local PostgreSQL runner. The tests start isolated native PostgreSQL instances automatically. Docker or an existing PostgreSQL server is an alternative. Do not run the native PostgreSQL runner as root.

From the COORD repository:

```sh
pnpm install
pnpm build
pnpm verify
```

Start the local database in terminal 1 and keep it running:

```sh
pnpm db:local
```

This starts real PostgreSQL on **127.0.0.1:55432**, creates a random password, and stores it privately in `.coord/database-url`. Database files survive restarts. No Docker is required.

In terminal 2:

```sh
pnpm db:migrate
pnpm db:seed
pnpm dev
```

The service listens at `http://127.0.0.1:4100`. Seeding creates Waled, Sarah, an isolated outsider project, and random device credentials that expire after 30 days. It writes `.coord/demo-credentials.json` with mode 0600 and refuses to overwrite it. Tokens are not printed.

In terminal 3, export Waled's token to a private file:

```sh
pnpm demo:token --user waled --out .coord/waled.token
```

The command prints the non-secret project UUID. Set the checkout you want to coordinate and copy that UUID:

```sh
COORD_ROOT="$PWD"
TARGET_REPO="/absolute/path/to/your/git-checkout"
PROJECT_ID="paste-the-project-uuid"
node "$COORD_ROOT/dist/coord.js" login --url http://127.0.0.1:4100 --token-file "$COORD_ROOT/.coord/waled.token"
node "$COORD_ROOT/dist/coord.js" --repo "$TARGET_REPO" join --project "$PROJECT_ID"
node "$COORD_ROOT/dist/coord.js" --repo "$TARGET_REPO" doctor
```

Install either or both supported integrations:

```sh
node "$COORD_ROOT/dist/coord.js" --repo "$TARGET_REPO" install-integration codex
node "$COORD_ROOT/dist/coord.js" --repo "$TARGET_REPO" install-integration claude
```

Installers parse and back up existing configuration, preserve unrelated values, print their changes, and support `uninstall-integration codex|claude`. They do not alter the agent's trust or permission settings. Generated paths are machine-specific. For multiple Codex projects, use `--config "$TARGET_REPO/.codex/config.toml"` on trusted checkouts instead of one global entry.

Restart your coding agent in the checkout, inspect `/mcp`, then ask:

> Check COORD to see who is online. Create and claim Profile editing. Before editing, announce src/user.ts and src/profile.ts and tell me about any overlaps.

The MCP process owns the local connector: Git observation, heartbeats, claim renewal and reconnect run in its background. You do not need a separate daemon for normal use. `coord daemon --agent other` is available for diagnosis or service-manager use.

## Two laptops and tests

Follow [the exact two-laptop walkthrough](docs/DEMO.md). A shared internet service must use HTTPS/WSS with each laptop's own credential; localhost only connects processes on the same computer. The control plane never dials into laptops.

```sh
pnpm test:unit
pnpm test:integration
pnpm test:e2e
pnpm verify
```

`verify` checks formatting, ESLint, strict TypeScript, bundled builds, unit tests, real database integration tests and the full two-connector scenario. See [development](docs/DEVELOPMENT.md) for Docker/existing PostgreSQL, CI and test isolation.

## What is included

- Exclusive task leases, renewal, release, expiry and optimistic task versions.
- Work intents with expiry; deterministic conflict checks against intent **plus** Git changes.
- Presence, durable project event sequences, reconnect/replay and idempotent writes.
- Project-visible addressed messages, structured facts with provenance, transactional handoffs.
- Authentication, project membership checks, path/symlink filtering, payload caps and abuse limits.
- Codex MCP configuration and Claude MCP plus local observability hooks.

Start with [architecture](docs/ARCHITECTURE.md), [protocol](docs/PROTOCOL.md), [security boundaries](docs/SECURITY.md), [Codex](docs/CODEX.md), or [Claude](docs/CLAUDE.md).

## Troubleshooting

- **Not logged in / wrong project:** run `login`, then `join` with a project in your membership. Same folder names do not imply the same project.
- **Connection refused:** keep `pnpm db:local` and `pnpm dev` running; check the configured URL and `coord doctor`.
- **Already running:** close the old MCP/daemon using that checkout and agent identity. One active process owns its persisted session.
- **Lost connection:** retry an uncertain mutation with its original `idempotency_key`. A new key means a new action. Remote messages are data, never executable instructions.
- **Local native database unavailable:** provide `COORD_TEST_DATABASE_URL` for tests, or use Docker as described in development docs.
- **Seed file already exists:** reuse its credentials. Do not reseed a populated demo accidentally; use a fresh database and a separate COORD checkout for a fresh environment.

Limits and intentionally deferred work are documented in [the engineering report](docs/ENGINEERING_REPORT.md).

# Two-laptop demonstration

This runbook proves the intended Codex/Claude workflow with separate Git checkouts. Automated `pnpm test:e2e` already simulates the sequence against real PostgreSQL, real WebSockets and local Git repositories. The physical-laptop steps below require your authenticated Codex/Claude installations and an accessible server; those external sessions were not run by the automated test suite.

## 1. Run one shared control plane

On a macOS/Linux server or development machine reachable by both laptops, obtain this COORD checkout and run:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm db:local
```

Keep that terminal open. In a second terminal in the same COORD directory:

```sh
pnpm db:migrate
pnpm db:seed
pnpm dev
```

In a third terminal, create separate private credential files:

```sh
pnpm demo:token --user waled --out .coord/waled.token
pnpm demo:token --user sarah --out .coord/sarah.token
```

Both commands print the same **project UUID**. Record it; it is not a secret. Each generated token is for one developer/device. Transfer only the corresponding token to each laptop via your secure file-transfer channel; do not distribute `.coord/demo-credentials.json`, which contains every demo credential.

The server defaults to loopback. For a real public endpoint, terminate TLS at an authenticated operator-managed host/proxy and use `https://your-coord-host` on both laptops. Configure WebSocket upgrades to the service on port 4100. Do not expose PostgreSQL.

A concrete alternative for the initial two-laptop proof is an encrypted SSH tunnel. On **each** laptop, keep this running in a separate terminal (replace the operator/host values):

```sh
ssh -N -L 4100:127.0.0.1:4100 operator@your-coord-server
```

Both laptops can then use `http://127.0.0.1:4100`; each tunnel reaches the same remote control plane securely. This is operator-run deployment networking, not a COORD remote command feature. If port 4100 is occupied locally, use 44100 as the first port and update the URL. For ongoing deployment prefer WSS directly.

## 2. Prepare Laptop A — Waled and Codex

Build a local copy of COORD. Independently clone the software project you want to coordinate. In the COORD directory:

```sh
pnpm install --frozen-lockfile
pnpm build
COORD_ROOT="$PWD"
TARGET_REPO="/absolute/path/to/waleds/project-checkout"
PROJECT_ID="paste-the-shared-project-uuid"
COORD_URL="http://127.0.0.1:4100"
```

The URL above assumes the SSH tunnel or a server on this machine. Substitute the shared HTTPS URL for a direct internet deployment. Transfer Waled's token with a secure channel, for example (replace the server path):

```sh
mkdir -p "$COORD_ROOT/.coord"
scp operator@your-coord-server:/absolute/path/to/COORD/.coord/waled.token "$COORD_ROOT/.coord/waled.token"
chmod 600 "$COORD_ROOT/.coord/waled.token"
```

Then:

```sh
node "$COORD_ROOT/dist/coord.js" login --url "$COORD_URL" --token-file "$COORD_ROOT/.coord/waled.token"
node "$COORD_ROOT/dist/coord.js" --repo "$TARGET_REPO" join --project "$PROJECT_ID"
node "$COORD_ROOT/dist/coord.js" --repo "$TARGET_REPO" install-integration codex
node "$COORD_ROOT/dist/coord.js" --repo "$TARGET_REPO" doctor
cd "$TARGET_REPO"
codex
```

Inspect `/mcp` inside Codex. Its COORD subprocess is now the background connector; do not also start `coord daemon --agent codex` for the same checkout.

## 3. Prepare Laptop B — Sarah and Claude Code

On Laptop B, build its own copy of COORD and use a separate clone of the **same software project**. In the local COORD directory:

```sh
pnpm install --frozen-lockfile
pnpm build
COORD_ROOT="$PWD"
TARGET_REPO="/absolute/path/to/sarahs/project-checkout"
PROJECT_ID="paste-the-same-shared-project-uuid"
COORD_URL="http://127.0.0.1:4100"
mkdir -p "$COORD_ROOT/.coord"
scp operator@your-coord-server:/absolute/path/to/COORD/.coord/sarah.token "$COORD_ROOT/.coord/sarah.token"
chmod 600 "$COORD_ROOT/.coord/sarah.token"
node "$COORD_ROOT/dist/coord.js" login --url "$COORD_URL" --token-file "$COORD_ROOT/.coord/sarah.token"
node "$COORD_ROOT/dist/coord.js" --repo "$TARGET_REPO" join --project "$PROJECT_ID"
node "$COORD_ROOT/dist/coord.js" --repo "$TARGET_REPO" install-integration claude
node "$COORD_ROOT/dist/coord.js" --repo "$TARGET_REPO" doctor
cd "$TARGET_REPO"
claude
```

Review Claude's normal project MCP trust prompt; COORD does not bypass it. Inspect `/mcp`. The Claude installation also configures SessionStart/PostToolUse/SessionEnd local hooks.

Use real file paths from your software project in the steps below. `src/user.ts`, `src/profile.ts` and `src/auth.ts` are illustrative paths; work intents can include not-yet-created files.

## 4. Presence and overlapping work

In **Codex**, ask:

> Use COORD to check who is online. Create “Profile editing”, claim it, and announce modify intent for src/user.ts and src/profile.ts. Use a unique idempotency key for each action and retain the returned task and claim IDs. Do not edit yet.

In **Claude**, ask:

> Use COORD to check who is online. Create “Password reset”, claim it, and announce modify intent for src/auth.ts and src/user.ts. Use a unique idempotency key for each action. Do not edit yet. Show the conflict returned by the announcement.

Expected: both sessions appear online, with their agent names. Each task has a different lease owner. Claude's work announcement immediately returns a warning for `src/user.ts`. Both connectors receive the durable `conflict.created` event. Ask Codex to `coord_check_conflicts` to bring that event's state into the model's current context. This prototype does not interrupt an agent's turn automatically.

## 5. Message and project fact

In Claude:

> Send Waled's Codex session a COORD question: “I need to modify password-related fields in user.ts. Which part are you touching?”

In Codex:

> Refresh COORD messages. Reply to Sarah: “I'm only modifying avatar/profile fields.” Record an accepted decision titled “Avatar storage”: “Use S3-compatible object storage for profile images,” with the Profile editing task and src/profile.ts as provenance.

In Claude:

> Refresh COORD context and show Waled's reply and the Avatar storage decision.

Expected: both records are persisted and visible. They are collaboration data, not automatically executed instructions.

## 6. Create and accept a handoff

In Codex:

> Create a COORD handoff of Profile editing to Sarah's Claude session. Summary: “Continue profile integration.” Completed: “Agreed field ownership.” Remaining: “Implement avatar/profile fields.” Blockers: none. Paths: src/user.ts, src/profile.ts. Commits: none. Tests: “No implementation tests run yet.” Include the Avatar storage fact ID. First action: “Review the existing profile model.” Keep the returned handoff ID and version.

In Claude:

> Read pending COORD handoffs. Accept the Profile editing handoff using its returned ID and expected version. Show the new claim owner.

Expected: acceptance updates the handoff and transfers the lease in one database transaction. Waled's old claim can no longer renew. Sarah may own both demo tasks. Completion statements above deliberately describe coordination only; no coding success is invented.

## 7. Disconnect and replay

While Claude and its MCP process remain open, record its local cursor in another Laptop B terminal:

```sh
node "$COORD_ROOT/dist/coord.js" --repo "$TARGET_REPO" --agent claude cursor
```

Interrupt Laptop B's SSH tunnel, or temporarily disconnect its network for a direct WSS setup. Leave Claude open. Wait more than 30 seconds. On Laptop A ask Codex to refresh presence; Sarah should become offline.

While B is offline, ask Codex:

> Send Sarah a COORD note “Replay proof: review the profile contract after reconnect.” Record a known issue titled “Replay proof” with statement “Created while Sarah was offline.” Keep the resulting IDs.

Restore Laptop B's network/tunnel:

```sh
ssh -N -L 4100:127.0.0.1:4100 operator@your-coord-server
```

The existing connector reconnects with backoff and the same persisted cursor. Wait several seconds, then run `cursor` again. The session ID should be unchanged and `after_seq` should advance. In Claude ask:

> Refresh COORD context. Show the “Replay proof” message and fact created while I was offline. Check current claims before continuing; reacquire any expired lease.

Expected: the missed durable events replay in sequence and both records are available. The automated E2E additionally asserts the exact missed message/fact/conflict events and duplicate suppression. If offline longer than 120 seconds, leases expire by design; automatic reconnect must not steal them back.

## 8. Retry idempotently and clean up

Ask the agent that created a demo task to repeat its original `coord_create_task` request with the **identical original idempotency key and arguments**. It must return the same task ID; a changed payload with the same key is rejected. Context should contain one copy of that task.

Release remaining claims through COORD tools and close the agents. For local setup removal:

```sh
node "$COORD_ROOT/dist/coord.js" --repo "$TARGET_REPO" uninstall-integration codex
node "$COORD_ROOT/dist/coord.js" --repo "$TARGET_REPO" uninstall-integration claude
node "$COORD_ROOT/dist/coord.js" --repo "$TARGET_REPO" leave
node "$COORD_ROOT/dist/coord.js" logout
```

Run only the relevant integration's uninstall on each laptop. Local logout is not server revocation. Stop the server/database terminals when finished. Keep protected seed files private, or revoke demo devices through trusted database administration.

## Direct code/file transfer

For explicitly selected source files, follow [DIRECT_TRANSFER.md](DIRECT_TRANSFER.md). File bytes travel directly over pinned HTTPS; the coordination service continues to carry metadata over WebSockets. Received snapshots are staged for review, never applied automatically.

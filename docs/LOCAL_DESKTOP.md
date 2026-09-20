# Local-first COORD desktop (0.5.0)

COORD now starts from a local folder and a peer invitation. The account website is optional and remains private. GitHub hosts the product source/download; it never carries live workspace changes.

## Try it on two Macs

1. Download/open COORD on two Apple-silicon Macs running macOS 13 or newer.
2. On the first Mac choose **Share a folder** and select a small project (use a disposable copy for the first test).
3. Copy its connection key and send it privately to your teammate using your usual messaging app. Keys expire after ten minutes. COORD does not send messages for you.
4. On the second Mac paste the key, click **Join**, and choose an empty folder. The first Mac sees a connection request; check the device name/fingerprint and approve it.
5. Safe text files appear in the second folder. Edit a test file and save: approved changes synchronize automatically. The first Mac is the project authority and must remain online. Closing COORD's window keeps its menu-bar process running; **Quit COORD** stops it. Startup at login is optional.
6. Start a new Codex/Claude session in the selected folder and ask: **“Use COORD to see who is working, create your isolated workspace, reserve hello.ts, edit it there, submit, and release.”** Project configurations are installed automatically. The coding tool may still require project trust/MCP approval; already-running sessions may need a reload.
7. While the first agent holds the reservation, ask another connected agent to reserve the same file. COORD rejects the second reservation. That agent can choose other files or wait. **Never use a real secret in the test.**

The current Mac build is ad-hoc signed, not Apple Developer ID signed/notarized. It is an early-access build; a frictionless public installer still requires production Apple signing. Do not disable macOS security globally.

## What is enforced

The host maintains a private canonical copy outside the selected folder. Every publication goes through its serialized file guard: exclusive expiring reservation, expected previous SHA-256, path/content checks, aggregate limits, then a checked write. A disconnected peer cannot become a second authority or publish offline. Other devices reconnect with the same cryptographic identity after approval; the host can revoke them.

Each MCP process receives a fresh session ID and can create a separate local working directory under `.coord/agents/<session>`. Agents reserve files before edits and submit that workspace's diff. Separate processes cannot overwrite each other's working copies, and competing/stale submissions cannot overwrite the accepted shared revision. A workspace can be refreshed by calling `coord_workspace` again: clean files update, divergent edits remain for reconciliation.

Ordinary saves in the selected folder are also published using the same guard. If a file is reserved by an agent or its shared revision has changed, the local edit remains in place and appears as a conflict. Automatic synchronization never silently resolves overlapping edits. To resolve a conflict, compare the canonical version with your local draft, reconcile explicitly, and publish against its current base hash using the agent tools. COORD does not automatically discard drafts.

**This is not an operating-system write sandbox.** An arbitrary editor/shell can still write to the user's ordinary folder. Supported agents are instructed to use isolated workspaces and guarded publication. Internal subagents sharing one MCP process share its identity; COORD does not introspect all private agent conversations or independently detect every internal subagent. Activity comes from connected MCP sessions, heartbeats, reservations, and observed folder changes.

## Transport and privacy

- HyperDHT discovers peers and opens encrypted, public-key-pinned Noise streams. No account, IP address, VPN, Git push/pull, or website login is needed.
- The connection key contains a host public key, project ID, random 256-bit capability, and expiry. New peers require explicit host approval before any project content is sent. Approval rotates the invite; approved device identities persist. Removing a peer stops future access (it cannot erase already received files).
- Discovery uses public HyperDHT infrastructure. Network metadata can be visible there; workspace data is end-to-end encrypted. Restrictive networks can prevent this connection; the local-first mode does not depend on or claim a hosted HTTPS fallback.
- Packaged desktop identity/pairing state is protected with the operating-system keychain via Electron safeStorage; local IPC is private and capability-authenticated. Project snapshots themselves live in owner-private local storage and are not separately encrypted at rest.
- Only the selected project is shared, up to 500 UTF-8 files, 1 MiB/file and 16 MiB total. Binary files, symlinks, build/dependency directories, agent configurations, `.git`, `.coord`, common secret paths, and common credential literals are excluded. These checks are conservative heuristics, not a guarantee that arbitrary secrets can be recognized. A source file that becomes excluded is preserved locally and is never misinterpreted as a deletion.
- No remote-shell API, transcript scraping, automatic command execution, or trust-setting bypass exists.

## Developer verification

`pnpm verify` checks the full repository. Focused checks:

```sh
pnpm exec vitest run --project unit apps/desktop/peer-session.test.ts apps/desktop/workspace-guard.test.ts apps/desktop/local-agent.test.ts
pnpm --dir apps/desktop build
pnpm --dir apps/desktop package
```

Tests use real encrypted HyperDHT connections between separate controller instances, real filesystem copies, approval/revocation/restart flows, race reservations, stale bases, isolated agent submission, protected-content preservation, and a project-switch race. MCP tests launch two real SDK processes. These tests are not a claim of a completed physical two-Mac test or universal network reachability.

Official integration and transport references: [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Claude MCP](https://code.claude.com/docs/en/mcp), [HyperDHT](https://github.com/holepunchto/hyperdht).

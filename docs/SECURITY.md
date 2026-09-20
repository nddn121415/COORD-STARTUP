# Security boundaries

## What the prototype enforces

The normal coordination connector initiates outbound WebSocket connections and exposes no inbound coordination service. An explicitly started `share-files` operation adds a short-lived authenticated HTTPS listener, loopback by default; external binding requires the sender to select an interface. MCP uses local stdio. The server has no remote command, terminal, file-content, agent wake or tool-execution endpoint. A message containing a shell command is stored and returned as inert untrusted data. Agent responses explicitly label coordination content as untrusted.

Device credentials are random 256-bit opaque tokens, stored as SHA-256 hashes on the server with expiry and revocation fields. Requests derive user/device identity from the token, then validate project membership and session ownership. Device validity and membership are rechecked for requests and event delivery, so revocation stops an existing socket's access. Cross-project object references are rejected for task dependencies, facts, messages, conflicts and handoffs. Concurrent session registration cannot steal another device's session ID.

Exclusive leases and handoff transfer occur under a database transaction and project row lock. Forged claim IDs, claims held by another session, expired claims, unauthorized handoff acceptance and stale versions are rejected. Idempotency records bind key, operation and canonical payload to project/session. Important committed operations produce safe identifier-only audit records.

Remote URLs must use TLS (`https`/`wss`); plaintext is accepted only on loopback. Credentials are sent only in an Authorization header. HTTP bodies and WebSocket frames are bounded. Server rate limits and queue bounds mitigate basic abuse. Event payloads are checked before commit, and large snapshots are truncated explicitly, preventing replay loops caused by oversized records. Deploy behind a TLS proxy with connection/request limits for internet use.

## Local privacy

Git observation collects metadata, never file contents. Repository root and worktree filesystem locations remain local. The service receives explicit repository ID, opaque worktree ID, branch, commit and changed paths. Environment variables, `.env` contents, transcripts and Git remote credentials are not transmitted. Git remote URL inference is deliberately unnecessary: users explicitly bind a checkout to an authorized server project.

Path validation rejects traversal, absolute/drive paths, backslashes, ambiguous encoded separators and control characters. Sensitive names such as `.env*`, private-key extensions, `.ssh`, `.aws`, credentials/secrets files, `.git` and `.coord` are filtered. Local realpath checks reject symlink escapes, dangling symlinks and aliases into sensitive targets, including new paths under unsafe ancestors. The cloud repeats lexical path checks without access to the laptop filesystem.

Task text, message bodies and facts can be written by people/agents. Common credential literals (private key blocks, common access token patterns, AWS keys and bearer strings) are rejected. This is a heuristic, not comprehensive data-loss prevention: a user can still manually type source text or an unrecognized secret into a metadata field. Do not do so. The default observation flow never uploads source files.

The development credential store uses private local files (0600, directories 0700), not a production OS keychain. `.coord` and generated credentials are ignored by Git; project binding also adds a local Git exclude. Config installers never embed device tokens. Their backups can contain pre-existing user settings: retain their private permissions and do not commit them. TOML values are preserved but formatting/comments can change; exact original bytes are in the backup.

## Operator responsibilities

Use TLS termination and a firewall so the loopback-default control plane and PostgreSQL are not exposed directly. Set a strong database password. Device tokens are bearer credentials: possession grants that device's project access. Seed credentials expire in 30 days and can be revoked in the `devices` table by a trusted operator. There is no public signup, invitation, password reset, SSO, refresh-token flow or role administration UI yet.

`logout` removes the local credential. It does not revoke a token or stop an already-running MCP process: stop the agent/connector and revoke the device to invalidate it server-side. Project members share all coordination records, including addressed messages; recipient routing is organizational context, not private messaging.

The control plane enforces authorization in its service layer; this prototype does not additionally use PostgreSQL row-level security. Database administrators and the host operator remain trusted. Membership management is trusted provisioning/SQL rather than a user-facing API. Retention, encrypted backups, organization roles, key rotation and production deployment hardening are deferred.

## Review and tests

Security regressions exercise cross-project access, foreign references, forged and racing session IDs, stolen/expired claims, unauthorized/stale handoffs, changed-payload idempotency, revoked tokens, path traversal, absolute paths, sensitive paths, symlink escape, oversized requests/events/snapshots, replay deduplication and malicious message text. Real PostgreSQL tests prove one concurrent claim winner. Process execution call sites are limited to local fixed Git inspection, development PostgreSQL lifecycle, and explicit test harnesses; no server-supplied message reaches a command runner.

File-level overlap is advisory. It cannot establish code correctness, guarantee absence of conflicts, or prevent an agent from ignoring an announcement request. No automatic merge or writable-agent wake feature is present.

## Explicit direct file-transfer boundary

A local sender must select files and start sharing; a local recipient must explicitly accept a private invitation. No cloud event starts a transfer. Source/text bytes go directly to the receiver and never enter the control plane or GitHub. The invitation is a short-lived bearer capability containing a pinned certificate and endpoint; keep it in private files and deliver it through an authenticated channel. Anyone holding it can retrieve the selected snapshot until expiry or shutdown. It is not a user-identity-bound invitation.

Files are read into a bounded snapshot and scanned before the sender listens. TLS trust and certificate pin verification precede the request's capability header. The receiver repeats path/content validation, verifies hashes, refuses ambiguous paths, and uses a new private staging directory with no executable permissions. It never overwrites project files or runs any received content. Secret detection is heuristic and does not make arbitrary source disclosure safe; send only files you intend the recipient to see. Direct transfer policy and current limits are detailed in [DIRECT_TRANSFER.md](DIRECT_TRANSFER.md).

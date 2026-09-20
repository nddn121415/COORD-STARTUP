# Prototype engineering report

## Delivered

COORD is a working metadata coordination service and local connector for Codex and Claude Code. It includes authenticated presence, durable tasks, exclusive leased claims, versioned task updates, intent/Git file conflicts, addressed messages, structured facts, transactional handoffs, reconnect/replay and idempotent writes. Normal interaction uses 12 official SDK MCP tools; CLI commands handle setup and diagnosis. Explicitly selected code/text snapshots can also travel directly between computers over pinned HTTPS, without Git or the control plane.

Architecture and the directory tree are in [ARCHITECTURE.md](ARCHITECTURE.md). Exact local setup is in [README](../README.md). The [two-laptop runbook](DEMO.md) covers authenticated shared-server connectivity, overlapping tasks, messages, facts, handoffs and reconnect. [CODEX.md](CODEX.md) and [CLAUDE.md](CLAUDE.md) document reversible integration setup and the verified official interfaces.

## Implementation details

Git observation uses native read-only Git commands and NUL-separated status, with debounced filesystem hints and periodic reconciliation. The coordination connector uploads no source files or transcripts. Separate, explicit `share-files` / `receive-files` commands transfer selected source files directly to a peer. Paths are validated lexically and against local symlinks, including aliases to sensitive files.

Conflict detection deterministically compares declared intent plus Git-observed paths among active sessions. Rename source and destination both participate. Read/write is informational; modify/modify warns; create/create, delete/write and rename/write are high severity. Conflicts and their resolution are durable events.

Task claims use database time, a unique task constraint and transactional project locking. The default lease is 120 seconds, renewed approximately every 40 seconds while tracked by a running connector. Expired owners cannot renew or release another owner's claim. Handoff acceptance checks recipient/version and transfers the claim atomically.

Reconnect preserves the session and last processed sequence, retries pending requests with stable identity, and replays durable project events. Duplicate delivery is ignored by sequence. A graceful exit ends the session; restart then uses a fresh session. Project writes and their event sequence/idempotency record commit together.

Authentication is random expiring device tokens with hashed server storage and project membership. The control plane has no generic remote shell, command endpoint, writable-agent wake, source upload or transcript capture. The separate peer listener serves only a selected immutable snapshot behind a short-lived capability and certificate pin. Metadata path/secret heuristics, wire-size caps, bounded queues, rate limiting and adversarial regression tests enforce the prototype boundaries described in [SECURITY.md](SECURITY.md).

## Validation and known boundaries

The final verification record is maintained below after the integrated run. Automated coverage includes real PostgreSQL migrations, concurrent claims, authorization/revocation, durable replay, Git fixtures, official SDK MCP calls/subprocesses and two simultaneous local connectors. Git fixtures cover staged/unstaged/untracked/deleted/renamed files, detached/unborn HEAD, worktrees, absent remotes, sensitive files and symlinks.

Automated tests are not a claim that two physical laptops, a public TLS deployment, or live authenticated model-driven Codex/Claude sessions were operated here. Those exact manual steps are documented. Docker Compose is supplied as an alternative; native PostgreSQL is used for this environment's executed tests.

Known prototype limitations:

- Direct file transfers support automatic public discovery and UDP hole punching with `--wifi`, support UTF-8 text only, and stage snapshots for manual review. Restrictive networks may fail because a hosted relay fallback is not included. Continuous editing, automatic merge and named-user-bound invitations are not implemented. See [DIRECT_TRANSFER.md](DIRECT_TRANSFER.md).
- Metadata is project-visible, including addressed messages. There are no private DMs or organization roles beyond membership.
- Device provisioning is a trusted seed/admin operation. Production OAuth/SSO, refresh tokens, invitations and keychain storage are deferred. Tokens currently expire after 30 days.
- Conflict checks are advisory and exact-path based. No symbol/hunk/semantic analysis or automatic merge is implemented.
- MCP tools expose team updates when called; incoming events do not force an agent to read them or start a new turn.
- The outbound queue and renewal tracking are in memory. A connector process crash loses uncommitted queued requests and tracked renewals; committed state survives and claims expire safely.
- The control plane serializes writes per project and polls events. Retention, compaction, historical context pagination and large-project performance work are deferred. Large context sections report truncation.
- One persistent connector per checkout/project/agent is enforced. Multiple same-agent sessions should use separate worktrees.
- Generated hooks target POSIX shells; Windows development uses an external PostgreSQL test database and needs further integration validation.
- The sensitive-value filter catches common patterns, not every possible secret. Free-text fields must not be used to manually paste code or credentials.

## Recommended next five features

1. Production device enrollment, invitations, revocation UI and OS keychain credentials.
2. Crash-durable outbound request journal, richer reconnect diagnostics and restoration of valid renewal tracking.
3. Agent-friendly subscriptions/notifications with explicit local consent and no automatic writable-agent wake.
4. Symbol/hunk overlap as a new deterministic analyzer, with evidence and measured false-positive rates.
5. Operational hardening: retention and pagination, indexed event fanout, deployment packaging, load tests and backup/restore validation.

## Final verification record

Verified on macOS arm64 with Node.js 24.18.0, pnpm 11.19.0 and real PostgreSQL 18 binaries:

- `pnpm install --frozen-lockfile`: passed.
- `pnpm verify`: passed formatting, ESLint, strict TypeScript, bundled build, **105 tests across 20 files** (90 unit, 13 database/security/integration, 2 E2E).
- Automatic networking: isolated DHT transfer and credential/pin/expiry rejection tests passed. Public discovery and sample transfer also passed from an extracted download on this Mac, using two local peers; this is not a physical cross-network test.
- Built peer CLI in two separate temporary ordinary folders: exact-byte HTTPS transfer, verified hashes, no Git/control plane, no checkout overwrite and no token output: passed.
- Independent peer security tests cover malformed manifests, oversized responses, substituted certificates, redirects, expiry, symlinks and staged file permissions. Invitation FIFO blocking and unbounded reads were fixed; the public-permissions test explicitly sets its fixture mode independently of process umask.
- Fresh local cluster: `pnpm db:local`, `pnpm db:migrate`, `pnpm db:seed`, and `pnpm demo:token`: passed.
- Built `dist/control-plane.js`: started and served database health and authenticated operations.
- Built CLI from a separate temporary Git checkout: login, join, Codex/Claude config install, doctor, cursor, MCP discovery/call, uninstall, leave and logout: passed. Actual user agent configuration was not changed.
- Generated built Codex MCP command: official client discovered all 12 tools and read real project context.
- Negative test-runner check: database cleanup preserved an intentionally nonzero exit status, preventing a false-green verification.
- Independent adversarial review led to regression-tested fixes for oversized durable replay events, a concurrent session-binding race, symlink metadata escapes and credential-bearing parse diagnostics.

The smoke-test server/database and private credentials were removed after validation so the documented first-run seed flow remains usable. CI is configured to run the same verify command; the hosted CI workflow itself was not executed here.

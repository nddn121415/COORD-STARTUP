# Development and verification

## Install and build

Use Node.js 22.18+ and pnpm 11.19+:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm verify
```

The workspace pins the official MCP SDK and locks transitive dependencies. Bundles in `dist/` use installed external Node dependencies; keep the COORD checkout and `node_modules` available. The CLI generated integration paths are absolute.

Root scripts: `build`, `typecheck`, `lint`, `format`, `format:check`, `test`, `test:unit`, `test:integration`, `test:e2e`, `verify`, `dev`, `coord`, `db:local`, `db:migrate`, `db:seed`, `demo:token`.

## Database choices

Simplest: keep `pnpm db:local` running, then `pnpm db:migrate`, `pnpm db:seed`, `pnpm dev` in another terminal. The native PostgreSQL runner creates a private persistent cluster under `.coord/postgres` with a random password. `COORD_PG_PORT` controls the port when the cluster config is first created. No local system users or system-wide services are installed. The runner uses packaged PostgreSQL binaries with explicit owned start/stop; it deliberately avoids a dependency's exit hook that would mask failing test exit codes.

Docker alternative:

```sh
cp .env.example .env
```

Edit `.env` to set `POSTGRES_PASSWORD` to a generated local password and `DATABASE_URL` to `postgresql://coord:YOUR_PASSWORD@127.0.0.1:5432/coord` (URL-encode reserved characters). Then:

```sh
docker compose up -d postgres
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Docker is infrastructure only. It publishes PostgreSQL on loopback. The compose definition is provided but the automated run in this environment uses native PostgreSQL, not Docker. Migrations and server entrypoints use `DATABASE_URL`, then the private `.coord/database-url`, then a legacy loopback development URL. Avoid relying on the fallback; use explicit credentials.

Existing PostgreSQL is also supported through `DATABASE_URL`. Run migrations before starting the server. Migration execution is transactional and guarded by an advisory lock and `schema_migrations` version. Repeat migration is safe. For subsequent releases add a new migration rather than editing applied SQL.

## Tests

`pnpm verify` includes every test category and fails if any stage fails. Tests are not skipped when PostgreSQL is absent. By default each integration/E2E test project starts its own real native PostgreSQL instance on an ephemeral loopback port. Each test receives a fresh unique schema, applies migrations from zero, seeds random credentials, and drops that schema afterward. Fixtures stop sockets, child processes and databases.

To use your own dedicated test database instead:

```sh
COORD_TEST_DATABASE_URL='postgresql://USER:PASSWORD@127.0.0.1:5432/coord_test' pnpm verify
```

The test user needs permission to create/drop schemas. Tests create unique `test_<uuid>` schemas and never intentionally alter the public schema. Use a dedicated test database anyway. Running as root, Windows or an unsupported native platform requires this option (or Docker). Tests use real sockets; an execution sandbox may need local networking permission.

Unit tests include real temporary Git repositories and local fake WebSocket peers, explicitly testing parsers/client behavior. Database, security and scenario tests use real PostgreSQL/control-plane processes. MCP tests use the official SDK client and actual stdio subprocesses. The two-connector scenario clones a Git fixture into separate checkout directories. Interactive hosted Codex/Claude model sessions are manual, as are real WAN/TLS deployment and physical two-laptop testing.

## Configuration and process lifecycle

Server: `COORD_HOST` defaults to `127.0.0.1`; `PORT` defaults to 4100. For internet deployments retain loopback binding behind a TLS reverse proxy. Local credentials default to `~/.coord`; use `COORD_HOME` for independent test identities. Agent MCP config paths use standard Codex/Claude locations. No tests alter your real agent configuration.

`coord daemon` runs in the foreground and can be put under a user service manager. Normal MCP owns its own connector; do not start a duplicate for the same checkout/agent. Sessions use a private PID lock. After a crash, a dead PID lock is recovered; if the PID was reused, inspect the recorded process before manually removing that one stale lock.

A graceful MCP/daemon stop releases claims, expires work intent and ends presence. A temporary transport loss reconnects with backoff/jitter, using the same session and durable cursor. Short offline queues are in-memory, not crash-durable. The server is authoritative for all successfully committed writes.

## Contribution boundaries

Shared protocol schemas live in `packages/protocol`; change consumers and tests together. Pure conflict analysis is isolated from the database. Backend transactions own authorization, reference validation, idempotency, sequence allocation and audit. Native Git helpers are local-only and never consume remote command arguments.

The design serializes project writes and polls the event log; this is appropriate for the prototype but not a scaling claim. A broker, semantic analyzers, repository source uploads and a custom editor are intentionally absent.

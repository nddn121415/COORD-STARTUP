# Protocol v1

The authoritative runtime schemas are `packages/protocol/src/index.ts`. External HTTP/WebSocket input is validated strictly; unknown fields are rejected. MCP uses the official TypeScript SDK's standard `tools/list` and `tools/call` over stdio, not invented MCP methods.

## Authentication and binding

`GET /v1/me`, `GET /v1/projects`, `POST /v1/projects`, and WebSocket `/v1/connect` require `Authorization: Bearer <device-token>`. `GET /health` performs a database readiness query without credentials. Tokens never appear in URLs. `POST /v1/projects` accepts `{name, repository_id}` and grants the creator membership; it is a setup endpoint, not automatically retried. Device provisioning is a trusted server-side operation, initially `db:seed`.

The first WebSocket frame explicitly selects the project and local session:

```json
{
  "type": "hello",
  "protocol_version": 1,
  "project_id": "project-uuid",
  "session_id": "device-owned-session-uuid",
  "agent": "codex",
  "device_name": "laptop-a",
  "repository_id": "explicit-server-repository-identity",
  "after_seq": 194
}
```

UUID examples above are descriptive placeholders. The server checks membership, repository binding, cursor bounds and session/device ownership. A reused session cannot switch device/project. Its welcome precedes ordered replay:

```json
{"type":"welcome","session_id":"session-uuid","project_id":"project-uuid","latest_seq":197}
{"type":"event","event":{"event_id":"event-uuid","project_id":"project-uuid","seq":195,"type":"message.created","timestamp":"2026-09-20T00:00:00.000Z","payload":{"message":{}}}}
```

The connector acknowledges locally by persisting only a successfully processed sequence. Duplicate event sequences are ignored. A gap forces reconnect/replay. No separate server ACK frame is needed for this durable-log design.

## Operations

Requests are `{type:"request", request_id: UUID, operation: NAME, input: OBJECT}`. Responses are `{type:"response", request_id, ok:true, result}` or `{type:"response", request_id, ok:false, error:{code,message}}`. Handshake errors use `{type:"error",error:{code,message}}` and close the socket.

Agent tools:

- `coord_get_project_context`: optional `project_id`, `include` subsets (`agents`, `tasks`, `claims`, `intents`, `conflicts`, `messages`, `facts`, `handoffs`), `limit` 1–200 (default 50).
- `coord_create_task`: `title`, optional `detail`, `definition_of_done`, `depends_on` task UUIDs.
- `coord_claim_task`: `task_id`, optional `lease_seconds` 5–600 (default 120); returns task, `claim_id`, `lease_expires_at`.
- `coord_renew_task`: `task_id`, `claim_id`, optional lease duration.
- `coord_release_task`: `task_id`, `claim_id`, optional `reason`.
- `coord_update_task`: `task_id`, `expected_version`, `status` (`todo`, `doing`, `blocked`, `done`, `cancelled`). A claim moves a task into `doing`; this prototype does not use a separate `claimed` state.
- `coord_announce_work`: `summary`, `paths`, optional `task_id`, `base_commit`, `ttl_seconds` 5–600. Replaces this session's declared intent and returns conflicts immediately.
- `coord_check_conflicts`: optional `project_id`, `intent_id`.
- `coord_send_message`: `recipient:{type,id?}`, `kind`, `body`, optional `refs`. Recipient type is `project`, `user`, `session` or `task`. Kind is `note`, `question`, `answer` or `warning`.
- `coord_record_fact`: `type`, `title`, `statement`, optional `structured`, `status`, `provenance`. Types are decision, constraint, api_contract, schema_change, known_issue, convention and environment_note. Provenance supports task, commit and paths; author session is server-derived.
- `coord_create_handoff`: `task_id`, `to` containing exactly one of `user_id`/`session_id`, `summary`, optional completed/remaining/blockers/commits/paths/tests/fact_ids arrays and `first_action`. Requires the creator's active task lease.
- `coord_accept_handoff`: `handoff_id`, `expected_version`; validates recipient and transfers the claim in the same transaction.

Every mutating tool requires `idempotency_key`, a nonempty string up to 128 characters. The key is scoped to project/session. The same key and canonical parsed input return the original result. Changed input or operation with the same key is rejected. Keep the same key across an uncertain retry; use a new key for a genuinely new action. Read tools need no key. An optional project ID must match the connected project.

Internal connector operations are `coord_heartbeat {}`, `coord_observe_git {observation,idempotency_key}` and `coord_end_session {idempotency_key}`. They are not exposed as agent MCP tools. The Git schema permits branch, HEAD, opaque worktree ID and categorized paths; it does not accept source contents or environment variables.

## File intents

```json
{
  "summary": "Move profile model",
  "paths": [
    { "path": "src/profile.ts", "from_path": "src/user.ts", "mode": "rename" },
    { "path": "src/auth.ts", "mode": "read" }
  ],
  "ttl_seconds": 120,
  "idempotency_key": "unique-action-id"
}
```

Modes are read, create, modify, delete, rename. Rename requires a distinct `from_path`. Paths are POSIX repository-relative, with traversal, absolute paths, control characters, sensitive names and symlink escapes rejected. The connector performs filesystem containment checks; the server independently validates path syntax and sensitive names.

## Delivery, limits and errors

Frames are capped at 256 KiB. Durable events are byte-checked before commit, preventing a large record from poisoning replay. Context arrays may be trimmed to the response budget, with `truncated_sections` reported; request narrower subsets or a lower limit. The prototype has no historical context pagination API; durable event replay remains complete. Text fields, arrays and the offline pending queue have additional bounds. Pending requests time out and are removed from the queue; an already-sent timed-out mutation may have committed, so retry with the original key.

Errors include UNAUTHORIZED, FORBIDDEN, NOT_FOUND, CLAIM_NOT_OWNED, TASK_ALREADY_CLAIMED, STALE_VERSION, IDEMPOTENCY_CONFLICT, INVALID_INPUT, PAYLOAD_TOO_LARGE and rate-limit errors. Returned errors omit tokens and raw database messages. Lease expiry, offline state, intent expiry and conflict resolution are durable events, not local guesses.

Messages and all returned user-authored text are untrusted project-visible data. No protocol frame can request local command execution. MCP wraps results with `trust: "untrusted_coordination_data"` and an explicit warning to preserve the local user's authority.

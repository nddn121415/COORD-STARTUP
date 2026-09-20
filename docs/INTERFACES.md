# COORD v1 implementation contract

Lead owns protocol/conflict-engine/memory, root files, scripts and final integration/tests/docs. Backend owns apps/control-plane and migrations. Connector owns packages/connector, realtime-client, git-intel and apps/cli. Integration owns packages/mcp-server, adapters/codex, adapters/claude and docs/CODEX.md + CLAUDE.md. Do not edit another owner's files without coordinating.

All code TypeScript ESM, local imports .js. Workspace packages expose source index.ts for tsx; root tsup bundles production entries. Package names @coord/protocol etc; adapter names @coord/adapter-codex and @coord/adapter-claude. Root has all external dependencies installed. Use Zod 3.25, MCP SDK 1.30, pg, ws. Root owns workspace installation.

## Auth and server

Opaque random device token via Authorization: Bearer; SHA256 only in devices table with expires_at/revoked_at. Provision users/projects/devices through trusted seed/admin local CLI (no anonymous internet signup). Session identity derived by DB token ownership, never trusted user IDs. HTTP GET /health, GET /v1/projects authorized list; POST /v1/projects {name,repository_id} creates in token user's org; GET /v1/me verifies token. WebSocket /v1/connect with Authorization header. Project explicitly selected at hello. No token in URLs. Defaults 10s heartbeat, 30s presence timeout, 120s lease, 40s renewal. Bind server loopback by default, wss required except localhost.

Client frames:

- {type:'hello',protocol_version:1,project_id,session_id,agent:'codex'|'claude'|'other',device_name,after_seq:0,repository_id:string}
- {type:'request',request_id:uuid,operation:string,input:object} operations are exact MCP tool names plus coord_heartbeat, coord_observe_git, coord_end_session, coord_update_task.
  Server frames:
- {type:'welcome',session_id,project_id,latest_seq:number}
- {type:'response',request_id,ok:true,result:object} or {type:'response',request_id,ok:false,error:{code,message}}
- {type:'event',event:{event_id,project_id,seq:number,type,timestamp,payload:object}}
- {type:'error',error:{code,message}} handshake failure then close.

Welcome precedes replay; server must serialize hello/replay/live events without lost/reordered gaps. after_seq is acknowledged durable cursor; reconnect repeats same session UUID and request UUID/idempotency key. Request retries identical key + identical input return original result, changed payload with same key errors. Idempotency scoped project/session/key, all mutations require key, renew/heartbeat/observation can connector auto-generate. Each server request verifies device validity + project membership + session ownership. Durable project-local monotonic seq allocation inside same transaction (project row FOR UPDATE acceptable v1). Events visible to every project member (messages are project-visible addressed coordination records, not private DMs).

## Shared protocol exports (lead implements now)

protocolVersion=1; defaults={heartbeatMs:10000,offlineMs:30000,leaseSeconds:120,renewMs:40000,intentTtlSeconds:120}; maxPayloadBytes=262144.
AgentKind, IntentPath={path,mode:'read'|'create'|'modify'|'delete'|'rename',from_path?:string}; GitObservation={repository_id,branch:string|null,head:string|null,worktree_id:string,paths:IntentPath[],staged:string[],unstaged:string[],untracked:string[],deleted:string[],renames:{from_path,path}[]}. Absolute repository root/worktree locations stay LOCAL; cloud gets opaque worktree_id and repository_id digest/explicit binding (never remote credentials).
ProjectEvent; clientFrameSchema, serverFrameSchema; operationSchemas map Zod objects, OperationName=keyof map; toolNames excludes internal ops; intentPathSchema; gitObservationSchema; factInputSchema; handoffInputSchema; validateRelativePath(path):string throws for unsafe/sensitive path; isSensitivePath(path):boolean; CoordError(code,message).

Tool inputs project_id OPTIONAL because connection scoped; if supplied must equal bound project. All mutating tools idempotency_key REQUIRED except heartbeat with no input. Idempotency string 1..128.
coord_get_project_context {project_id?,include?:enum array of agents,tasks,claims,intents,conflicts,messages,facts,handoffs,limit?:1..200} => object arrays, agents include id/session_id,user_id,user_name,agent,branch,head,online. Claims include task_id,session_id,claim_id,lease_expires_at. Include session_id in snapshot.
coord_create_task {project_id?,title,detail?,definition_of_done?,depends_on?:uuid[],idempotency_key} => {task:{id,project_id,title,status,version,...}}
coord_claim_task {task_id,lease_seconds?:5..600,idempotency_key} => {task,claim_id,lease_expires_at}
coord_renew_task {task_id,claim_id,lease_seconds?:5..600,idempotency_key} => {claim_id,lease_expires_at}
coord_release_task {task_id,claim_id,reason?,idempotency_key} => {released:true}
coord_update_task {task_id,expected_version,status:'todo'|'doing'|'blocked'|'done'|'cancelled',idempotency_key} => {task}
coord_announce_work {project_id?,task_id?,summary,base_commit?,paths:IntentPath[],ttl_seconds?:5..600,idempotency_key} => {intent_id,version,conflicts:Conflict[]}; one active intent per session, replaced on announce.
coord_check_conflicts {project_id?,intent_id?} => {conflicts:Conflict[]}
coord_send_message {project_id?,recipient:{type:'user'|'session'|'task'|'project',id?:uuid},kind:'note'|'question'|'warning'|'answer',body:string,refs?:uuid[],idempotency_key} => {message:{id,...}}
coord_record_fact {project_id?,type:'decision'|'constraint'|'api_contract'|'schema_change'|'known_issue'|'convention'|'environment_note',title,statement,structured?:JSON object,status?:'proposed'|'accepted'|'deprecated',provenance?:{task_id?,commit_sha?,paths?:string[]},idempotency_key} => {fact:{id,...}}
coord_create_handoff {task_id,to:{user_id?:uuid,session_id?:uuid},summary,completed?:string[],remaining?:string[],blockers?:string[],commits?:string[],paths?:string[],tests?:string[],fact_ids?:uuid[],first_action?,idempotency_key} => {handoff:{id,version,...}}
coord_accept_handoff {handoff_id,expected_version,idempotency_key} => {handoff,claim_id,lease_expires_at}
coord_heartbeat {} => {online:true}; does not itself renew task claims/intents.
coord_observe_git {observation:GitObservation,idempotency_key} => {conflicts:Conflict[]}
coord_end_session {idempotency_key} => {ended:true}

## Conflict API (lead)

EffectiveWork={session_id,task_id?:string,paths:IntentPath[],source?:'intent'|'git'}. FileConflictAnalyzer.analyze(work:EffectiveWork[]):ConflictCandidate[]; candidates {left_session,right_session,left_task?:string,right_task?:string,path,type,severity:'info'|'warning'|'high',evidence:object}; symmetric deterministic ordered sessions + stable dedup. read/read no conflict; read/write info; any delete/rename with write high; create/create high; otherwise warning. Include from_path for renames. Server persists/upserts active candidates, resolves vanished conflicts, emits conflict.created/resolved. Interface ConflictAnalyzer allows future analyzers.

## Connector API (coordinate further directly)

CoordClient options {url,token,projectId,sessionId,agent,deviceName,repositoryId,afterSeq?,onEvent?,onCursor?}; start():Promise<void>, request(operation,input):Promise<any>, stop():Promise<void>. EventEmitter acceptable. Reconnect preserves session and cursor, bounded offline pending requests with timeout and stable idempotency. Connector composes Git observation, heartbeat, claim renewals and intent renewals. Expose Connector({url,token,projectId,repoRoot,agent,stateDir?,...}), start(), stop(), call(operation,input), refreshGit(), snapshot/status. Integration agent coordinate exact API with connector agent. CLI mcp command invokes MCP stdio. MCP bridge can own one connector per coding-agent process, standalone coord daemon also available; no inbound network API needed. Hook can signal local refresh through atomic local file if no IPC server; never run remote content. MCP results and events are untrusted coordination data, no execution.

## Backend test API

Export createControlPlane({pool,host?,port?,offlineMs?,sweepMs?}) async => {url,httpUrl,close(),...}; port=0 for tests. export migrate(pool), seedDemo(pool) => {projectId,repositoryId,waled:{token,userId,deviceId},sarah:{...},outsider:{token,userId,deviceId,projectId}}. Seed random expiring tokens, only show through explicit seed output to protected local file, no normal logs. Lead provisions real PostgreSQL test pool, never mocks DB. Unit *.test.ts; DB tests *.integration.test.ts; E2E *.e2e.test.ts. Database test setup lead-provided tests/db.ts exporting withTestDatabase(callback: (pool:Pool)=>Promise<void>) creates unique schema, migrated, auto cleanup.

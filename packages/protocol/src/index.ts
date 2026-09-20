import { z } from 'zod';
import { containsSecret, validateRelativePath } from './paths.js';
export { containsSecret, isSensitivePath, validateRelativePath } from './paths.js';
export const protocolVersion = 1 as const;
export const maxPayloadBytes = 262_144;
export const defaults = {
  heartbeatMs: 10_000,
  offlineMs: 30_000,
  leaseSeconds: 120,
  renewMs: 40_000,
  intentTtlSeconds: 120,
} as const;
export class CoordError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CoordError';
  }
}
export const uuidSchema = z.string().uuid();
export const safeText = (max = 4000, min = 0) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine((v) => !containsSecret(v), 'Credential-like content is not allowed in metadata');
export const relativePathSchema = z.string().superRefine((value, ctx) => {
  try {
    validateRelativePath(value);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Unsafe or sensitive repository-relative path',
    });
  }
});
export const intentPathSchema = z
  .object({
    path: relativePathSchema,
    mode: z.enum(['read', 'create', 'modify', 'delete', 'rename']),
    from_path: relativePathSchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.mode === 'rename' && (!v.from_path || v.from_path === v.path))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Rename requires a distinct from_path',
      });
    if (v.mode !== 'rename' && v.from_path)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'from_path is only valid for rename' });
  });
export type IntentPath = z.infer<typeof intentPathSchema>;
export const agentKindSchema = z.enum(['codex', 'claude', 'other']);
export type AgentKind = z.infer<typeof agentKindSchema>;
export const gitObservationSchema = z
  .object({
    repository_id: safeText(200, 1),
    branch: safeText(256).nullable(),
    head: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/)
      .nullable(),
    worktree_id: safeText(200, 1),
    paths: z.array(intentPathSchema).max(2000),
    staged: z.array(relativePathSchema).max(2000),
    unstaged: z.array(relativePathSchema).max(2000),
    untracked: z.array(relativePathSchema).max(2000),
    deleted: z.array(relativePathSchema).max(2000),
    renames: z
      .array(z.object({ from_path: relativePathSchema, path: relativePathSchema }).strict())
      .max(2000),
  })
  .strict();
export type GitObservation = z.infer<typeof gitObservationSchema>;
const project = { project_id: uuidSchema.optional() };
const write = { idempotency_key: z.string().min(1).max(128) };
const task = { task_id: uuidSchema };
const claim = { ...task, claim_id: uuidSchema };
const lineList = z.array(safeText(2000)).max(100).default([]);
const paths = z.array(relativePathSchema).max(2000).default([]);
const factTypes = [
  'decision',
  'constraint',
  'api_contract',
  'schema_change',
  'known_issue',
  'convention',
  'environment_note',
] as const;
export const factInputSchema = z
  .object({
    ...project,
    ...write,
    type: z.enum(factTypes),
    title: safeText(300, 1),
    statement: safeText(8000, 1),
    structured: z
      .record(z.unknown())
      .refine(
        (v) => JSON.stringify(v).length <= 16_000 && !containsSecret(v),
        'Structured metadata is too large or contains credential-like content',
      )
      .optional(),
    status: z.enum(['proposed', 'accepted', 'deprecated']).default('proposed'),
    provenance: z
      .object({
        task_id: uuidSchema.optional(),
        commit_sha: z
          .string()
          .regex(/^[a-f0-9]{7,64}$/)
          .optional(),
        paths: z.array(relativePathSchema).max(2000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const handoffInputSchema = z
  .object({
    ...write,
    ...task,
    to: z
      .object({ user_id: uuidSchema.optional(), session_id: uuidSchema.optional() })
      .strict()
      .refine(
        (v) => Number(Boolean(v.user_id)) + Number(Boolean(v.session_id)) === 1,
        'Choose exactly one recipient',
      ),
    summary: safeText(4000, 1),
    completed: lineList,
    remaining: lineList,
    blockers: lineList,
    commits: z
      .array(z.string().regex(/^[a-f0-9]{7,64}$/))
      .max(100)
      .default([]),
    paths,
    tests: lineList,
    fact_ids: z.array(uuidSchema).max(100).default([]),
    first_action: safeText(2000).optional(),
  })
  .strict();
export const contextSections = [
  'agents',
  'tasks',
  'claims',
  'intents',
  'conflicts',
  'messages',
  'facts',
  'handoffs',
] as const;
export const operationSchemas = {
  coord_get_project_context: z
    .object({
      ...project,
      include: z.array(z.enum(contextSections)).max(8).optional(),
      limit: z.number().int().min(1).max(200).default(50),
    })
    .strict(),
  coord_create_task: z
    .object({
      ...project,
      ...write,
      title: safeText(300, 1),
      detail: safeText(8000).optional(),
      definition_of_done: safeText(8000).optional(),
      depends_on: z.array(uuidSchema).max(100).default([]),
    })
    .strict(),
  coord_claim_task: z
    .object({ ...task, ...write, lease_seconds: z.number().int().min(5).max(600).default(120) })
    .strict(),
  coord_renew_task: z
    .object({ ...claim, ...write, lease_seconds: z.number().int().min(5).max(600).default(120) })
    .strict(),
  coord_release_task: z.object({ ...claim, ...write, reason: safeText(2000).optional() }).strict(),
  coord_update_task: z
    .object({
      ...task,
      ...write,
      expected_version: z.number().int().positive(),
      status: z.enum(['todo', 'doing', 'blocked', 'done', 'cancelled']),
    })
    .strict(),
  coord_announce_work: z
    .object({
      ...project,
      ...write,
      task_id: uuidSchema.optional(),
      summary: safeText(4000, 1),
      base_commit: z
        .string()
        .regex(/^[a-f0-9]{7,64}$/)
        .optional(),
      paths: z.array(intentPathSchema).max(2000),
      ttl_seconds: z.number().int().min(5).max(600).default(120),
    })
    .strict(),
  coord_check_conflicts: z.object({ ...project, intent_id: uuidSchema.optional() }).strict(),
  coord_send_message: z
    .object({
      ...project,
      ...write,
      recipient: z
        .object({ type: z.enum(['user', 'session', 'task', 'project']), id: uuidSchema.optional() })
        .strict()
        .refine((v) => v.type === 'project' || Boolean(v.id), 'Recipient id required'),
      kind: z.enum(['note', 'question', 'warning', 'answer']).default('note'),
      body: safeText(8000, 1),
      refs: z.array(uuidSchema).max(100).default([]),
    })
    .strict(),
  coord_record_fact: factInputSchema,
  coord_create_handoff: handoffInputSchema,
  coord_accept_handoff: z
    .object({ ...write, handoff_id: uuidSchema, expected_version: z.number().int().positive() })
    .strict(),
  coord_heartbeat: z.object({}).strict(),
  coord_observe_git: z.object({ ...write, observation: gitObservationSchema }).strict(),
  coord_end_session: z.object({ ...write }).strict(),
} as const;
export type OperationName = keyof typeof operationSchemas;
export type OperationInput<T extends OperationName> = z.input<(typeof operationSchemas)[T]>;
export const toolNames = Object.keys(operationSchemas).filter(
  (name) => !['coord_heartbeat', 'coord_observe_git', 'coord_end_session'].includes(name),
) as OperationName[];
export const projectEventSchema = z
  .object({
    event_id: uuidSchema,
    project_id: uuidSchema,
    seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    type: z.string().min(1).max(100),
    timestamp: z.string(),
    payload: z.record(z.unknown()),
  })
  .strict();
export type ProjectEvent = z.infer<typeof projectEventSchema>;
export const clientFrameSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('hello'),
      protocol_version: z.literal(protocolVersion),
      project_id: uuidSchema,
      session_id: uuidSchema,
      agent: agentKindSchema,
      device_name: safeText(200, 1),
      after_seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      repository_id: safeText(200, 1),
    })
    .strict(),
  z
    .object({
      type: z.literal('request'),
      request_id: uuidSchema,
      operation: z.enum(Object.keys(operationSchemas) as [OperationName, ...OperationName[]]),
      input: z.record(z.unknown()),
    })
    .strict(),
]);
export type ClientFrame = z.infer<typeof clientFrameSchema>;
const wireError = z.object({ code: z.string(), message: z.string() }).strict();
export const serverFrameSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('welcome'),
      session_id: uuidSchema,
      project_id: uuidSchema,
      latest_seq: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal('response'),
      request_id: uuidSchema,
      ok: z.boolean(),
      result: z.unknown().optional(),
      error: wireError.optional(),
    })
    .strict(),
  z.object({ type: z.literal('event'), event: projectEventSchema }).strict(),
  z.object({ type: z.literal('error'), error: wireError }).strict(),
]);
export type ServerFrame = z.infer<typeof serverFrameSchema>;

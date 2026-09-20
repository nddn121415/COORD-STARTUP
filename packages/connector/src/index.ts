import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { readFile, open, unlink } from 'node:fs/promises';
import { CoordClient, type CoordClientOptions } from '@coord/realtime-client';
import {
  assertSafeLocalPath,
  discoverRepository,
  observeGit,
  watchRepository,
} from '@coord/git-intel';
import {
  defaults,
  operationSchemas,
  CoordError,
  type AgentKind,
  type GitObservation,
  type OperationName,
  type ProjectEvent,
} from '@coord/protocol';
import { coordHome, writePrivateJson, privateDirectory, sessionStatePath } from './config.js';
export * from './config.js';
export interface ConnectorOptions {
  url: string;
  token: string;
  projectId: string;
  repositoryId: string;
  repoRoot: string;
  agent: AgentKind;
  stateDir?: string;
  sessionId?: string;
  deviceName?: string;
  heartbeatMs?: number;
  renewMs?: number;
  reconcileMs?: number;
  onEvent?: (event: ProjectEvent) => void | Promise<void>;
  clientOptions?: Partial<
    Pick<
      CoordClientOptions,
      'requestTimeoutMs' | 'connectTimeoutMs' | 'reconnectMinMs' | 'reconnectMaxMs' | 'maxPending'
    >
  >;
}
interface SessionState {
  sessionId: string;
  afterSeq: number;
}
export class Connector extends EventEmitter {
  client?: CoordClient;
  sessionId = '';
  private stateFile = '';
  private lockFile = '';
  private stopWatch?: () => void;
  private timers: ReturnType<typeof setInterval>[] = [];
  private renewing = false;
  private refreshPromise?: Promise<GitObservation>;
  private observation?: GitObservation;
  private claims = new Map<string, { claimId: string; leaseSeconds: number; renewAt: number }>();
  private intent?: Record<string, unknown>;
  private intentRenewAt = 0;
  private lastObservation = '';
  private running = false;
  constructor(readonly options: ConnectorOptions) {
    super();
  }
  async start() {
    if (this.running) return;
    const repository = await discoverRepository(this.options.repoRoot);
    this.options.repoRoot = repository.root;
    const dir = this.options.stateDir ?? join(coordHome(), 'sessions');
    await privateDirectory(dir);
    this.stateFile = sessionStatePath({
      ...this.options,
      repoRoot: repository.root,
      stateDir: dir,
    });
    this.lockFile = this.stateFile.replace(/\.json$/, '.lock');
    await this.acquireLock();
    try {
      let state: SessionState;
      try {
        state = JSON.parse(await readFile(this.stateFile, 'utf8'));
        if (
          !/^[a-f0-9-]{36}$/i.test(state.sessionId) ||
          !Number.isSafeInteger(state.afterSeq) ||
          state.afterSeq < 0
        )
          throw new Error('Invalid session state');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        state = { sessionId: this.options.sessionId ?? randomUUID(), afterSeq: 0 };
      }
      this.sessionId = state.sessionId;
      await writePrivateJson(this.stateFile, state);
      this.client = new CoordClient({
        ...this.options.clientOptions,
        url: this.options.url,
        token: this.options.token,
        projectId: this.options.projectId,
        repositoryId: this.options.repositoryId,
        sessionId: this.sessionId,
        agent: this.options.agent,
        deviceName: this.options.deviceName ?? hostname(),
        afterSeq: state.afterSeq,
        onEvent: async (event) => {
          if (event.type === 'handoff.accepted') {
            const handoff = event.payload.handoff as
              { task_id?: string; from_session_id?: string } | undefined;
            if (handoff?.from_session_id === this.sessionId && handoff.task_id) {
              this.claims.delete(handoff.task_id);
              if (this.intent?.task_id === handoff.task_id) this.intent = undefined;
            }
          }
          if (event.type === 'claim.expired' && event.payload.session_id === this.sessionId)
            this.claims.delete(String(event.payload.task_id));
          await this.options.onEvent?.(event);
          this.emit('event', event);
        },
        onCursor: (seq) =>
          writePrivateJson(this.stateFile, { sessionId: this.sessionId, afterSeq: seq }),
      });
      this.client.on('diagnostic', (message) => this.emit('diagnostic', message));
      await this.client.start();
      this.running = true;
      await this.refreshGit();
      this.stopWatch = await watchRepository(
        repository.root,
        async () => {
          await this.refreshGit();
        },
        { reconcileMs: this.options.reconcileMs, onError: (error) => this.report(error) },
      );
      this.timers.push(
        setInterval(() => {
          if (this.client?.connected)
            void this.call('coord_heartbeat', {}).catch((error) => this.report(error));
        }, this.options.heartbeatMs ?? defaults.heartbeatMs),
      );
      this.timers.push(
        setInterval(
          () => void this.renew(),
          Math.min(1000, this.options.renewMs ?? defaults.renewMs),
        ),
      );
    } catch (error) {
      await this.stop(false);
      throw error;
    }
  }
  private async acquireLock(): Promise<void> {
    try {
      const file = await open(this.lockFile, 'wx', 0o600);
      await file.writeFile(String(process.pid));
      await file.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(await readFile(this.lockFile, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0)
        throw new Error('Invalid connector lock; inspect private state directory');
      try {
        process.kill(pid, 0);
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code === 'ESRCH') {
          await unlink(this.lockFile);
          return this.acquireLock();
        }
      }
      throw new Error(
        'A connector for this checkout and agent is already running. Stop it before starting another.',
      );
    }
  }
  status() {
    return {
      sessionId: this.sessionId,
      projectId: this.options.projectId,
      connected: this.client?.connected ?? false,
      afterSeq: this.client?.afterSeq ?? 0,
      observation: this.observation,
    };
  }
  async call(
    operation: string,
    input: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const schema = operationSchemas[operation as OperationName];
    if (!schema) throw new CoordError('UNKNOWN_OPERATION', 'Unknown coordination operation');
    const value = schema.parse(input) as Record<string, unknown>;
    if (value.project_id && value.project_id !== this.options.projectId)
      throw new CoordError('FORBIDDEN', 'Operation project does not match checkout binding');
    // Resolve every declared path locally, including not-yet-created children of symlinks.
    const declared: string[] = [];
    if (Array.isArray(value.paths))
      for (const path of value.paths) {
        if (typeof path === 'string') declared.push(path);
        else {
          declared.push(path.path);
          if (path.from_path) declared.push(path.from_path);
        }
      }
    const provenance = value.provenance as { paths?: string[] } | undefined;
    declared.push(...(provenance?.paths ?? []));
    if (value.observation) {
      const obs = value.observation as GitObservation;
      declared.push(...obs.staged, ...obs.unstaged, ...obs.untracked, ...obs.deleted);
      for (const path of [...obs.paths, ...obs.renames]) {
        declared.push(path.path);
        if (path.from_path) declared.push(path.from_path);
      }
    }
    for (const path of declared) await assertSafeLocalPath(this.options.repoRoot, path);
    if (!this.client) throw new CoordError('STOPPED', 'Connector has not started');
    const result = await this.client.request(operation, value);
    if (operation === 'coord_claim_task' || operation === 'coord_accept_handoff') {
      const taskId = (value.task_id ??
        (result.handoff as { task_id?: string } | undefined)?.task_id ??
        (result.task as { id?: string } | undefined)?.id) as string;
      if (taskId && typeof result.claim_id === 'string')
        this.claims.set(taskId, {
          claimId: result.claim_id,
          leaseSeconds: Number(value.lease_seconds ?? defaults.leaseSeconds),
          renewAt:
            Date.now() +
            Math.min(
              this.options.renewMs ?? defaults.renewMs,
              (Number(value.lease_seconds ?? defaults.leaseSeconds) * 1000) / 3,
            ),
        });
    } else if (operation === 'coord_release_task') this.claims.delete(value.task_id as string);
    else if (operation === 'coord_announce_work') {
      this.intent = value;
      this.intentRenewAt =
        Date.now() +
        Math.min(
          this.options.renewMs ?? defaults.renewMs,
          (Number(value.ttl_seconds ?? defaults.intentTtlSeconds) * 1000) / 3,
        );
    }
    return result;
  }
  refreshGit(): Promise<GitObservation> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      const observation = await observeGit(this.options.repoRoot, this.options.repositoryId);
      const fingerprint = JSON.stringify(observation);
      if (fingerprint !== this.lastObservation) {
        await this.call('coord_observe_git', { observation, idempotency_key: randomUUID() });
        this.lastObservation = fingerprint;
      }
      this.observation = observation;
      return observation;
    })().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }
  private report(error: unknown) {
    this.emit('diagnostic', {
      code: error instanceof CoordError ? error.code : 'LOCAL_ERROR',
      message: error instanceof Error ? error.message : 'Local operation failed',
    });
  }
  private async renew() {
    if (this.renewing || !this.client?.connected || !this.running) return;
    this.renewing = true;
    try {
      for (const [taskId, claim] of this.claims) {
        if (Date.now() < claim.renewAt) continue;
        try {
          await this.call('coord_renew_task', {
            task_id: taskId,
            claim_id: claim.claimId,
            lease_seconds: claim.leaseSeconds,
            idempotency_key: randomUUID(),
          });
          claim.renewAt =
            Date.now() +
            Math.min(this.options.renewMs ?? defaults.renewMs, (claim.leaseSeconds * 1000) / 3);
        } catch (error) {
          if (
            error instanceof CoordError &&
            !['REQUEST_TIMEOUT', 'CONNECTION_ERROR'].includes(error.code)
          )
            this.claims.delete(taskId);
          this.report(error);
        }
      }
      if (this.intent && Date.now() >= this.intentRenewAt)
        await this.call('coord_announce_work', { ...this.intent, idempotency_key: randomUUID() });
    } catch (error) {
      this.report(error);
    } finally {
      this.renewing = false;
    }
  }
  /** graceful=false simulates abrupt network loss; stable cursor/session survive. */
  async stop(graceful = true) {
    this.running = false;
    this.stopWatch?.();
    this.stopWatch = undefined;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    let ended = false;
    if (graceful && this.client?.connected) {
      try {
        await this.call('coord_end_session', { idempotency_key: randomUUID() });
        ended = true;
      } catch (error) {
        this.report(error);
      }
    }
    await this.client?.stop();
    if (ended) {
      await writePrivateJson(this.stateFile, {
        sessionId: randomUUID(),
        afterSeq: this.client?.afterSeq ?? 0,
      });
      this.claims.clear();
      this.intent = undefined;
    }
    this.client = undefined;
    this.lastObservation = '';
    if (this.lockFile) {
      await unlink(this.lockFile).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
      this.lockFile = '';
    }
  }
}

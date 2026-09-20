import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  serverFrameSchema,
  protocolVersion,
  maxPayloadBytes,
  CoordError,
  type AgentKind,
  type ProjectEvent,
} from '@coord/protocol';
export interface CoordClientOptions {
  url: string;
  token: string;
  projectId: string;
  sessionId: string;
  agent: AgentKind;
  deviceName: string;
  repositoryId: string;
  afterSeq?: number;
  onEvent?: (event: ProjectEvent) => void | Promise<void>;
  onCursor?: (seq: number) => void | Promise<void>;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  maxPending?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
}
export function validateServerUrl(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash)
    throw new Error('Server URL must not contain credentials, query parameters, or a fragment');
  if (!['ws:', 'wss:', 'http:', 'https:'].includes(url.protocol))
    throw new Error('Use an HTTPS/WSS server URL');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!local && !['wss:', 'https:'].includes(url.protocol))
    throw new Error('Remote COORD connections require TLS (https:// or wss://)');
  return url;
}
type Pending = {
  frame: string;
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
export class CoordClient extends EventEmitter {
  private socket?: WebSocket;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private handshakeTimer?: ReturnType<typeof setTimeout>;
  private pending = new Map<string, Pending>();
  private closed = true;
  private ready = false;
  private attempts = 0;
  private cursor: number;
  private processing: Promise<void> = Promise.resolve();
  constructor(readonly options: CoordClientOptions) {
    super();
    validateServerUrl(options.url);
    this.cursor = options.afterSeq ?? 0;
  }
  get connected() {
    return this.ready;
  }
  get afterSeq() {
    return this.cursor;
  }
  async start(): Promise<void> {
    if (this.ready) return;
    this.closed = false;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(
          new CoordError(
            'CONNECT_TIMEOUT',
            'Could not connect to COORD. Check the server URL, network, and device login.',
          ),
        );
      }, this.options.connectTimeoutMs ?? 10000);
      const connected = () => {
        cleanup();
        resolve();
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        clearTimeout(timeout);
        this.off('connected', connected);
        this.off('fatal', failed);
      };
      this.on('connected', connected);
      this.on('fatal', failed);
      this.connect();
    });
  }
  private connect() {
    if (this.closed) return;
    const url = validateServerUrl(this.options.url);
    url.protocol = ['wss:', 'https:'].includes(url.protocol) ? 'wss:' : 'ws:';
    url.pathname = '/v1/connect';
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.options.token}` },
      maxPayload: maxPayloadBytes,
      handshakeTimeout: this.options.connectTimeoutMs ?? 10000,
    });
    this.socket = socket;
    this.handshakeTimer = setTimeout(
      () => socket.terminate(),
      this.options.connectTimeoutMs ?? 10000,
    );
    socket.on('open', () =>
      socket.send(
        JSON.stringify({
          type: 'hello',
          protocol_version: protocolVersion,
          project_id: this.options.projectId,
          session_id: this.options.sessionId,
          agent: this.options.agent,
          device_name: this.options.deviceName,
          repository_id: this.options.repositoryId,
          after_seq: this.cursor,
        }),
      ),
    );
    socket.on('message', (raw) => {
      this.processing = this.processing
        .then(async () => {
          if (this.socket !== socket || this.closed) return;
          const frame = serverFrameSchema.parse(JSON.parse(raw.toString()));
          if (frame.type === 'welcome') {
            clearTimeout(this.handshakeTimer);
            this.ready = true;
            this.attempts = 0;
            for (const item of this.pending.values()) socket.send(item.frame);
            this.emit('connected');
          } else if (frame.type === 'response') {
            const item = this.pending.get(frame.request_id);
            if (!item) return;
            clearTimeout(item.timer);
            this.pending.delete(frame.request_id);
            if (frame.ok) {
              if (!frame.result || typeof frame.result !== 'object' || Array.isArray(frame.result))
                item.reject(new CoordError('PROTOCOL_ERROR', 'Invalid response result'));
              else item.resolve(frame.result as Record<string, unknown>);
            } else
              item.reject(
                new CoordError(
                  frame.error?.code ?? 'SERVER_ERROR',
                  frame.error?.message ?? 'Server request failed',
                ),
              );
          } else if (frame.type === 'event') {
            if (frame.event.project_id !== this.options.projectId)
              throw new Error('Unexpected event project');
            if (frame.event.seq <= this.cursor) return;
            if (frame.event.seq !== this.cursor + 1)
              throw new Error('Event sequence gap; replay required');
            await this.options.onEvent?.(frame.event);
            // Acknowledge only after durable persistence succeeds. Duplicate replay is harmless.
            await this.options.onCursor?.(frame.event.seq);
            this.cursor = frame.event.seq;
            this.emit('event', frame.event);
          } else if (frame.type === 'error') {
            const error = new CoordError(frame.error.code, frame.error.message);
            this.emit('fatal', error);
            this.closed = true;
            socket.close();
            this.rejectPending(error);
          }
        })
        .catch((error) => {
          this.emit('diagnostic', {
            code: 'PROTOCOL_ERROR',
            message: error instanceof Error ? error.message : 'Invalid server frame',
          });
          socket.terminate();
        });
    });
    socket.on('error', () =>
      this.emit('diagnostic', {
        code: 'CONNECTION_ERROR',
        message: 'Connection failed; retrying with backoff',
      }),
    );
    socket.on('close', () => {
      if (this.socket !== socket) return;
      clearTimeout(this.handshakeTimer);
      this.ready = false;
      this.emit('disconnected');
      if (!this.closed) {
        const delay = Math.min(
          this.options.reconnectMaxMs ?? 30000,
          (this.options.reconnectMinMs ?? 250) * 2 ** Math.min(this.attempts++, 10),
        );
        this.reconnectTimer = setTimeout(
          () => this.connect(),
          Math.floor(delay * (0.8 + Math.random() * 0.4)),
        );
      }
    });
  }
  request(operation: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new CoordError('STOPPED', 'Connector is stopped'));
    if (this.pending.size >= (this.options.maxPending ?? 128))
      return Promise.reject(
        new CoordError('QUEUE_FULL', 'Offline request queue is full; wait for reconnection'),
      );
    const requestId = randomUUID();
    const frame = JSON.stringify({ type: 'request', request_id: requestId, operation, input });
    if (Buffer.byteLength(frame) > maxPayloadBytes)
      return Promise.reject(
        new CoordError('PAYLOAD_TOO_LARGE', 'Request exceeds maximum payload size'),
      );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new CoordError(
            'REQUEST_TIMEOUT',
            'COORD request timed out. Retry mutations with the same idempotency_key.',
          ),
        );
      }, this.options.requestTimeoutMs ?? 30000);
      this.pending.set(requestId, { frame, resolve, reject, timer });
      if (this.ready && this.socket?.readyState === WebSocket.OPEN) this.socket.send(frame);
    });
  }
  private rejectPending(error: Error) {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
  }
  async stop(): Promise<void> {
    this.closed = true;
    this.ready = false;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.handshakeTimer);
    this.rejectPending(new CoordError('STOPPED', 'Connector stopped'));
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState !== WebSocket.CLOSED)
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          socket.terminate();
          resolve();
        }, 1000);
        socket.once('close', () => {
          clearTimeout(timeout);
          resolve();
        });
        socket.close();
      });
    await this.processing;
  }
}

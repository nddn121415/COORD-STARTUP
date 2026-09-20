import { createServer, type IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { Pool } from 'pg';
import { z } from 'zod';
import { clientFrameSchema, CoordError, maxPayloadBytes, safeText } from '@coord/protocol';
import { ControlPlaneService, type SessionContext } from './service.js';
import { transaction, tokenHash } from './database.js';
import { RateLimiter } from './rate-limit.js';

function bearer(req: IncomingMessage): string {
  const value = req.headers.authorization;
  if (!value?.startsWith('Bearer ') || value.length > 1024)
    throw new CoordError('UNAUTHORIZED', 'Authorization: Bearer device token required.');
  return value.slice(7);
}
export function publicError(error: unknown): { code: string; message: string } {
  if (error instanceof CoordError) return { code: error.code, message: error.message };
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return {
      code: 'INVALID_INPUT',
      message: 'Invalid request format or metadata. Check the operation schema.',
    };
  return {
    code: 'INTERNAL_ERROR',
    message: 'Coordination request failed. Try again with the same idempotency key.',
  };
}
async function body(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maxPayloadBytes)
      throw new CoordError('PAYLOAD_TOO_LARGE', 'Request exceeds maximum payload size.');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function createControlPlane(options: {
  pool: Pool;
  host?: string;
  port?: number;
  offlineMs?: number;
  sweepMs?: number;
}) {
  const service = new ControlPlaneService(options.pool, options.offlineMs);
  let closed = false;
  const remoteLimit = new RateLimiter(600);
  const deviceLimit = new RateLimiter(300);
  const drains = new Set<() => Promise<void>>();
  const server = createServer((req, res) => {
    void (async () => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      remoteLimit.take(req.socket.remoteAddress ?? 'unknown');
      if (req.method === 'GET' && req.url === '/health') {
        await options.pool.query('SELECT 1');
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      const token = bearer(req);
      const identity = await service.authenticate(options.pool, token);
      deviceLimit.take(identity.device_id);
      if (req.method === 'GET' && req.url === '/v1/me') {
        res.end(JSON.stringify(identity));
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/projects') {
        const projects = (
          await options.pool.query(
            'SELECT p.id,p.name,p.repository_id FROM projects p JOIN project_memberships m ON m.project_id=p.id WHERE m.user_id=$1 ORDER BY p.name',
            [identity.user_id],
          )
        ).rows;
        res.end(JSON.stringify({ projects }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/projects') {
        const input = z
          .object({
            name: safeText(200).refine((value) => value.length > 0),
            repository_id: safeText(200).refine((value) => value.length > 0),
          })
          .strict()
          .parse(await body(req));
        const project = await transaction(options.pool, async (db) => {
          const fresh = await service.authenticate(db, token);
          const row = (
            await db.query(
              'INSERT INTO projects(id,organization_id,name,repository_id) VALUES($1,$2,$3,$4) RETURNING id,name,repository_id',
              [randomUUID(), fresh.organization_id, input.name, input.repository_id],
            )
          ).rows[0];
          await db.query('INSERT INTO project_memberships(project_id,user_id) VALUES($1,$2)', [
            row.id,
            fresh.user_id,
          ]);
          await db.query(
            'INSERT INTO audit_events(id,project_id,user_id,device_id,operation) VALUES($1,$2,$3,$4,$5)',
            [randomUUID(), row.id, fresh.user_id, fresh.device_id, 'project.create'],
          );
          return row;
        });
        res.statusCode = 201;
        res.end(JSON.stringify({ project }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Unknown endpoint.' } }));
    })().catch((error) => {
      const detail = publicError(error);
      res.statusCode =
        detail.code === 'RATE_LIMITED'
          ? 429
          : detail.code === 'UNAUTHORIZED'
            ? 401
            : detail.code === 'FORBIDDEN'
              ? 403
              : detail.code === 'PAYLOAD_TOO_LARGE'
                ? 413
                : detail.code === 'INVALID_INPUT'
                  ? 400
                  : 500;
      res.end(JSON.stringify({ error: detail }));
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: maxPayloadBytes,
    perMessageDeflate: false,
  });
  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      remoteLimit.take(req.socket.remoteAddress ?? 'unknown');
      if (req.url !== '/v1/connect')
        throw new CoordError('NOT_FOUND', 'Unknown websocket endpoint.');
      await service.authenticate(options.pool, bearer(req));
      if (closed) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    })().catch(() => {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
    });
  });
  const pumps = new Set<() => void>();
  wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
    const token = bearer(req);
    let context: SessionContext | undefined,
      cursor = 0,
      chain = Promise.resolve(),
      pending = 0,
      pumpQueued = false;
    const send = (frame: unknown) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > maxPayloadBytes * 8) {
        socket.close(1013, 'Client is too slow; reconnect to resume.');
        return;
      }
      const encoded = JSON.stringify(frame);
      if (Buffer.byteLength(encoded) > maxPayloadBytes) {
        socket.send(
          JSON.stringify({
            type: 'error',
            error: { code: 'PAYLOAD_TOO_LARGE', message: 'Outbound data exceeds the wire limit.' },
          }),
        );
        socket.close(1009);
        return;
      }
      socket.send(encoded);
    };
    const timeout = setTimeout(() => {
      send({
        type: 'error',
        error: { code: 'HELLO_TIMEOUT', message: 'Send hello within 10 seconds.' },
      });
      socket.close(1008);
    }, 10_000);
    timeout.unref();
    function enqueue(fn: () => Promise<void>) {
      if (++pending > 128) {
        socket.close(1013, 'Too many queued requests.');
        pending--;
        return;
      }
      chain = chain
        .then(async () => {
          if (socket.readyState === WebSocket.OPEN) await fn();
        })
        .catch((error) => {
          send({ type: 'error', error: publicError(error) });
          socket.close(1008);
        })
        .finally(() => {
          pending--;
        });
    }
    async function replay() {
      if (!context) return;
      await service.authorize(options.pool, token, context.projectId, context.sessionId);
      // Fetch from committed durable log, never from in-memory broadcasts. This also
      // observes writes from other control-plane instances and preserves seq order.
      let count = 0;
      do {
        const events = (
          await options.pool.query(
            'SELECT * FROM project_events WHERE project_id=$1 AND seq>$2 ORDER BY seq LIMIT 200',
            [context.projectId, cursor],
          )
        ).rows;
        count = events.length;
        for (const event of events) {
          if (socket.readyState !== WebSocket.OPEN) return;
          const seq = Number(event.seq);
          if (seq !== cursor + 1)
            throw new CoordError('EVENT_GAP', 'Durable event history contains a gap.');
          send({
            type: 'event',
            event: { ...event, seq, timestamp: event.timestamp.toISOString() },
          });
          cursor = seq;
        }
      } while (count === 200 && socket.readyState === WebSocket.OPEN);
    }
    const pump = () => {
      if (!context || pumpQueued || socket.readyState !== WebSocket.OPEN) return;
      pumpQueued = true;
      enqueue(async () => {
        try {
          await replay();
        } finally {
          pumpQueued = false;
        }
      });
    };
    pumps.add(pump);
    const drain = () => chain;
    drains.add(drain);
    socket.on('message', (data, isBinary) => {
      enqueue(async () => {
        deviceLimit.take(tokenHash(token));
        let frame;
        try {
          if (isBinary)
            throw new CoordError('INVALID_INPUT', 'Only JSON text frames are supported.');
          frame = clientFrameSchema.parse(JSON.parse(data.toString()));
        } catch (error) {
          send({ type: 'error', error: publicError(error) });
          socket.close(1008);
          return;
        }
        if (!context) {
          if (frame.type !== 'hello')
            throw new CoordError(
              'HELLO_REQUIRED',
              'First frame must select a project and session.',
            );
          const welcome = await service.hello(token, frame);
          context = { token, projectId: frame.project_id, sessionId: frame.session_id };
          cursor = frame.after_seq;
          clearTimeout(timeout);
          send({ type: 'welcome', ...welcome });
          await replay();
          for (const wake of pumps) wake();
          return;
        }
        if (frame.type !== 'request')
          throw new CoordError('ALREADY_CONNECTED', 'Hello already received.');
        try {
          const result = await service.request(context, frame.operation, frame.input);
          send({ type: 'response', request_id: frame.request_id, ok: true, result });
          if (frame.operation === 'coord_end_session') {
            socket.close(1000, 'Session ended.');
            return;
          }
          for (const wake of pumps) wake();
        } catch (error) {
          const detail = publicError(error);
          send({ type: 'response', request_id: frame.request_id, ok: false, error: detail });
          if (detail.code === 'UNAUTHORIZED' || detail.code === 'FORBIDDEN') {
            try {
              await service.authorize(options.pool, token, context.projectId, context.sessionId);
            } catch {
              socket.close(1008);
            }
          }
        }
      });
    });
    socket.on('error', () => {
      /* Transport failures are recovered through durable replay. */
    });
    socket.on('close', () => {
      clearTimeout(timeout);
      pumps.delete(pump);
      void chain.finally(() => drains.delete(drain));
    });
  });
  let sweeping = false;
  let sweepPromise = Promise.resolve();
  let lastSweepError = 0;
  const interval = setInterval(() => {
    for (const pump of pumps) pump();
    if (!sweeping) {
      sweeping = true;
      sweepPromise = service
        .sweep()
        .catch(() => {
          if (Date.now() - lastSweepError > 60_000) {
            console.error(
              JSON.stringify({
                level: 'error',
                event: 'presence_sweep_failed',
                message: 'Database sweep failed; check database availability.',
              }),
            );
            lastSweepError = Date.now();
          }
        })
        .finally(() => {
          sweeping = false;
        });
    }
  }, options.sweepMs ?? 500);
  interval.unref();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4100, options.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
  const host =
    options.host === '::1'
      ? '[::1]'
      : options.host && options.host !== '0.0.0.0'
        ? options.host
        : '127.0.0.1';
  return {
    url: `ws://${host}:${address.port}/v1/connect`,
    httpUrl: `http://${host}:${address.port}`,
    service,
    server,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(interval);
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await Promise.all([...drains].map((drain) => drain()));
      await sweepPromise;
    },
  };
}

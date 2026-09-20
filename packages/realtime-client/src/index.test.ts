import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { CoordClient, validateServerUrl } from './index.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(
  options: { reply?: boolean; afterSeq?: number; onEvent?: (seq: number) => void } = {},
) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  );
  const projectId = randomUUID(),
    sessionId = randomUUID();
  const hellos: Record<string, unknown>[] = [],
    requests: Record<string, unknown>[] = [];
  let latest: WebSocket;
  server.on('connection', (socket, request) => {
    expect(request.headers.authorization).toBe('Bearer private-token');
    expect(request.url).not.toContain('private-token');
    latest = socket;
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === 'hello') {
        hellos.push(frame);
        socket.send(
          JSON.stringify({
            type: 'welcome',
            session_id: sessionId,
            project_id: projectId,
            latest_seq: 0,
          }),
        );
      } else {
        requests.push(frame);
        if (options.reply !== false)
          socket.send(
            JSON.stringify({
              type: 'response',
              request_id: frame.request_id,
              ok: true,
              result: { accepted: true },
            }),
          );
      }
    });
  });
  const client = new CoordClient({
    url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`,
    token: 'private-token',
    projectId,
    sessionId,
    agent: 'codex',
    deviceName: 'fixture',
    repositoryId: 'repo',
    reconnectMinMs: 10,
    reconnectMaxMs: 20,
    requestTimeoutMs: 150,
    afterSeq: options.afterSeq,
    onEvent: (event) => options.onEvent?.(event.seq),
  });
  cleanup.push(() => client.stop());
  await client.start();
  return {
    client,
    projectId,
    sessionId,
    requests,
    hellos,
    socket: () => latest!,
    sendEvent: (seq: number) =>
      latest!.send(
        JSON.stringify({
          type: 'event',
          event: {
            event_id: randomUUID(),
            project_id: projectId,
            seq,
            type: 'fixture',
            timestamp: new Date().toISOString(),
            payload: {},
          },
        }),
      ),
  };
}
async function until(condition: () => boolean) {
  const end = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > end) throw new Error('Condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
describe('authenticated outbound WebSocket', () => {
  it('authenticates by header and resolves request responses', async () => {
    const { client } = await fixture();
    expect(await client.request('coord_heartbeat', {})).toEqual({ accepted: true });
  });
  it('deduplicates replay and reconnects from last processed event', async () => {
    const events: number[] = [];
    const f = await fixture({
      onEvent: (seq) => {
        events.push(seq);
      },
    });
    f.sendEvent(1);
    f.sendEvent(1);
    f.sendEvent(2);
    await until(() => f.client.afterSeq === 2);
    f.socket().terminate();
    await until(() => f.hellos.length === 2);
    expect(f.hellos[1].after_seq).toBe(2);
    expect(f.hellos[1].session_id).toBe(f.sessionId);
    expect(events).toEqual([1, 2]);
  });
  it('retries pending requests with stable identity and removes timed-out requests', async () => {
    const f = await fixture({ reply: false });
    const pending = f.client.request('coord_create_task', { idempotency_key: 'stable' });
    const rejected = expect(pending).rejects.toThrow('timed out');
    await until(() => f.requests.length === 1);
    f.socket().terminate();
    await until(() => f.requests.length === 2);
    expect(f.requests[1]).toEqual(f.requests[0]);
    await rejected;
    f.socket().terminate();
    await until(() => f.hellos.length === 3);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(f.requests).toHaveLength(2);
  });
});
it('requires TLS except loopback and rejects token-bearing URLs', () => {
  expect(() => validateServerUrl('ws://example.com')).toThrow('TLS');
  expect(() => validateServerUrl('wss://u:token@example.com')).toThrow();
  expect(() => validateServerUrl('wss://example.com?token=secret')).toThrow();
  expect(validateServerUrl('wss://example.com').protocol).toBe('wss:');
});

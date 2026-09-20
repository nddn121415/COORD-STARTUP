import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { callAgentBridge } from './agent-bridge.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDesktopController,
  createDeviceKeys,
  encryptInvitation,
  decryptInvitation,
} from './service.js';
vi.mock('../cli/src/peer-network.js', () => ({
  prepareNetworkTransfer: vi.fn(async () => {
    throw new Error('DHT unavailable');
  }),
  receiveNetworkTransfer: vi.fn(async () => {
    throw new Error('Direct connection unavailable');
  }),
}));
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup.length = 0;
});
describe('desktop device service', () => {
  it('encrypts invitations for exactly the selected device and detects tampering', () => {
    const keys = createDeviceKeys(),
      wrong = createDeviceKeys();
    const sealed = encryptInvitation({ token: 'private invitation' }, keys.publicKey);
    expect(JSON.stringify(sealed)).not.toContain('private invitation');
    expect(decryptInvitation(sealed, keys.privateKey)).toEqual({ token: 'private invitation' });
    expect(() => decryptInvitation(sealed, wrong.privateKey)).toThrow();
    expect(() =>
      decryptInvitation(
        { ...sealed, ciphertext: Buffer.from('modified').toString('base64') },
        keys.privateKey,
      ),
    ).toThrow();
  });
  it('pairs a real device protocol, stores secrets through OS adapter and never exposes them in state', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'coord-desktop-')));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const requests: { path: string; authorization: string | null; body: unknown }[] = [];
    let saved = '';
    const deviceCode = 'private-device-code-at-least-32-chars';
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      requests.push({
        path,
        authorization: new Headers(init?.headers).get('authorization'),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      let value: unknown = { ok: true };
      if (path === '/api/device/start')
        value = {
          deviceCode,
          userCode: 'ABC123',
          verificationUrl: 'https://coord.example/pair',
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        };
      if (path === '/api/device/poll')
        value = {
          status: 'approved',
          deviceId: 'device-1',
          user: { id: 'u1', email: 'one@example.com', name: 'One' },
        };
      if (path === '/api/desktop/state')
        value = {
          user: { id: 'u1', email: 'one@example.com', name: 'One' },
          projects: [{ id: 'p1', name: 'Project' }],
          devices: [],
          transfers: [],
        };
      return new Response(JSON.stringify(value), { status: 200 });
    }) as typeof fetch;
    const controller = await createDesktopController({
      portalUrl: 'https://coord.example',
      stateDirectory: root,
      fetch: fetcher,
      protect: {
        encryptString(value) {
          saved = value;
          return Buffer.from('OS-PROTECTED');
        },
        decryptString() {
          return saved;
        },
      },
    });
    cleanup.push(controller.dispose);
    expect((await controller.beginPairing()).url).toBe('https://coord.example/pair');
    await controller.refresh();
    expect(controller.getState().status).toBe('connected');
    expect(JSON.stringify(controller.getState())).not.toContain(deviceCode);
    expect(JSON.stringify(controller.getState())).not.toContain('PRIVATE KEY');
    expect(await readFile(join(root, 'device.enc'), 'utf8')).toBe('OS-PROTECTED');
    expect(requests.find((r) => r.path === '/api/desktop/state')?.authorization).toBe(
      `Bearer ${deviceCode}`,
    );
    await controller.selectProject('p1');
    await controller.setFolder(root);
    expect(controller.getState().folder).toBe(root);
    await expect(controller.installIntegration('codex')).rejects.toThrow('not available');
    await controller.logout();
    expect(controller.getState().status).toBe('signed-out');
  });
  it('refuses portal-origin changes during browser pairing', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'coord-desktop-')));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const controller = await createDesktopController({
      portalUrl: 'https://coord.example',
      stateDirectory: root,
      protect: { encryptString: Buffer.from, decryptString: (b) => b.toString() },
      fetch: (async () =>
        new Response(
          JSON.stringify({
            deviceCode: 'a'.repeat(32),
            userCode: 'ABC123',
            verificationUrl: 'https://other.example/steal',
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          }),
        )) as typeof fetch,
    });
    cleanup.push(controller.dispose);
    await expect(controller.beginPairing()).rejects.toThrow('Unexpected');
  });
  it('delivers encrypted relay snapshots between paired devices with explicit acceptance', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'coord-desktop-relay-')));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const source = join(root, 'source'),
      destination = join(root, 'destination');
    await mkdir(source);
    await mkdir(destination);
    await writeFile(join(source, 'hello.ts'), 'export const hello = "teammate";');
    const devices: { id: string; code: string; encryptionKey: string }[] = [];
    let transfer:
      | { id: string; projectId: string; senderName: string; envelope: unknown; expiresAt: string }
      | undefined;
    let blob: Uint8Array | undefined;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const bearer = new Headers(init?.headers).get('authorization')?.slice(7);
      const device = devices.find((d) => d.code === bearer);
      const json = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      let result: unknown = { ok: true };
      if (path === '/api/device/start') {
        const id = String(devices.length + 1),
          code = 'device-private-code-' + id + '-long-enough';
        devices.push({ id, code, encryptionKey: json.encryptionKey });
        result = {
          deviceCode: code,
          userCode: 'CODE' + id,
          verificationUrl: 'https://coord.example/pair',
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        };
      } else if (path === '/api/device/poll') {
        const d = devices.find((d) => d.code === json.deviceCode)!;
        result = { deviceId: d.id, user: { id: d.id, email: d.id + '@example.com', name: d.id } };
      } else if (path === '/api/desktop/state')
        result = {
          user: { id: device!.id, email: device!.id + '@example.com', name: device!.id },
          projects: [{ id: 'p1', name: 'Project' }],
          devices: devices.map((d) => ({
            id: d.id,
            userId: d.id,
            name: d.id,
            email: d.id + '@example.com',
            encryptionKey: d.encryptionKey,
            lastSeen: new Date().toISOString(),
          })),
          transfers: device!.id === '2' && transfer ? [transfer] : [],
        };
      else if (path === '/api/desktop/transfers') {
        transfer = {
          id: 'transfer-1',
          projectId: json.projectId,
          senderName: 'One',
          envelope: json.envelope,
          expiresAt: json.expiresAt,
        };
        result = { id: 'transfer-1' };
      } else if (path.endsWith('/blob')) {
        if (init?.method === 'PUT') blob = new Uint8Array(init.body as Uint8Array);
        else return new Response(new Uint8Array(blob!));
      } else if (path.endsWith('/ack')) transfer = undefined;
      return new Response(JSON.stringify(result), { status: 200 });
    }) as typeof fetch;
    const make = async (name: string) => {
      const controller = await createDesktopController({
        portalUrl: 'https://coord.example',
        stateDirectory: join(root, name),
        fetch: fetcher,
        protect: {
          encryptString: (value) => Buffer.from(value),
          decryptString: (value) => value.toString(),
        },
      });
      cleanup.push(controller.dispose);
      await controller.beginPairing();
      await controller.refresh();
      await controller.selectProject('p1');
      return controller;
    };
    const sender = await make('sender'),
      receiver = await make('receiver');
    await sender.refresh();
    await sender.setFolder(source);
    await receiver.setFolder(destination);
    await sender.sendFiles(['hello.ts'], '2');
    expect(Buffer.from(blob!).toString('utf8')).not.toContain('teammate');
    await receiver.refresh();
    expect(receiver.getState().transfers).toHaveLength(1);
    expect(JSON.stringify(receiver.getState())).not.toContain('ciphertext');
    const authenticBlob = new Uint8Array(blob!);
    blob![0] = blob![0]! ^ 1;
    await expect(receiver.acceptTransfer('transfer-1')).rejects.toThrow();
    blob = authenticBlob;
    const received = await receiver.acceptTransfer('transfer-1');
    expect(await readFile(join(received.directory, 'hello.ts'), 'utf8')).toBe(
      'export const hello = "teammate";',
    );
    expect(transfer).toBeUndefined();
  });
  it('installs both agents with project-bound bridge arguments and routes tools with the device bearer', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'coord-desktop-mcp-')));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const projectId = '11111111-1111-4111-8111-111111111111';
    const code = 'c'.repeat(64);
    let usedBearer = '';
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      let result: unknown = { ok: true };
      if (path === '/api/device/start')
        result = {
          deviceCode: code,
          userCode: 'CODE',
          verificationUrl: 'https://coord.example/connect',
          expiresAt: Date.now() + 60000,
        };
      if (path === '/api/device/poll')
        result = { deviceId: 'd1', user: { id: 'u1', name: 'One', email: 'one@example.com' } };
      if (path === '/api/desktop/state')
        result = {
          user: { id: 'u1', name: 'One', email: 'one@example.com' },
          projects: [{ id: projectId, name: 'Project' }],
          devices: [],
          transfers: [],
        };
      if (path === '/api/desktop/context') {
        usedBearer = new Headers(init?.headers).get('Authorization') ?? '';
        result = { tasks: [], intents: [], messages: [] };
      }
      return new Response(JSON.stringify(result));
    }) as typeof fetch;
    const controller = await createDesktopController({
      portalUrl: 'https://coord.example',
      stateDirectory: root,
      fetch: fetcher,
      protect: { encryptString: (v) => Buffer.from(v), decryptString: (v) => v.toString() },
      integration: { command: process.execPath, args: ['/test/coord-mcp.cjs'] },
    });
    cleanup.push(controller.dispose);
    await controller.beginPairing();
    await controller.refresh();
    await controller.selectProject(projectId);
    await controller.setFolder(root);
    await controller.installIntegration('codex');
    await controller.installIntegration('claude');
    const codex = await readFile(join(root, '.codex', 'config.toml'), 'utf8');
    const claude = JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8'));
    expect(codex).toContain('--bridge');
    expect(codex).toContain(projectId);
    expect(claude.mcpServers.coord.args).toContain('--bridge');
    expect(claude.mcpServers.coord.args).toContain(projectId);
    expect(
      await callAgentBridge(join(root, 'mcp', 'bridge.json'), {
        projectId,
        agent: 'codex',
        operation: 'coord_get_context',
        input: {},
      }),
    ).toEqual({ tasks: [], intents: [], messages: [] });
    expect(usedBearer).toBe('Bearer ' + code);
    await expect(
      callAgentBridge(join(root, 'mcp', 'bridge.json'), {
        projectId: '22222222-2222-4222-8222-222222222222',
        agent: 'claude',
        operation: 'coord_get_context',
        input: {},
      }),
    ).rejects.toThrow();
    await controller.logout();
    await expect(
      callAgentBridge(join(root, 'mcp', 'bridge.json'), {
        projectId,
        agent: 'codex',
        operation: 'coord_get_context',
        input: {},
      }),
    ).rejects.toThrow();
  });
});

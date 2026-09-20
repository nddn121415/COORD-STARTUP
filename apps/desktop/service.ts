import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { hostname } from 'node:os';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { z } from 'zod';
import { prepareTransfer, fetchSnapshot, stageSnapshot } from '@coord/peer-transfer';
import { prepareNetworkTransfer, receiveNetworkTransfer } from '../cli/src/peer-network.js';
import { startAgentBridge } from './agent-bridge.js';
import { installCodexIntegration } from '@coord/adapter-codex';
import { installClaudeIntegration } from '@coord/adapter-claude';

export type Project = { id: string; name: string };
export type Device = {
  id: string;
  userId: string;
  name: string;
  email: string;
  encryptionKey: string;
  lastSeen: string;
  projectId?: string;
};
export type Transfer = { id: string; projectId: string; senderName: string; expiresAt: string };
export type DesktopState = {
  status: 'signed-out' | 'pairing' | 'connected';
  user?: { id: string; email: string; name: string };
  projects: Project[];
  devices: Device[];
  transfers: Transfer[];
  projectId?: string;
  folder?: string;
  error?: string;
  lastReceived?: string;
  lastTransferRoute?: 'direct' | 'encrypted-relay';
  pairing?: { userCode: string; expiresAt: string };
  sending?: boolean;
  integrationAvailable?: boolean;
};
const timestampSchema = z
  .union([z.string().datetime(), z.number().int().positive()])
  .transform((value) => (typeof value === 'number' ? new Date(value).toISOString() : value));
const userSchema = z.object({ id: z.string(), email: z.string(), name: z.string() });
const deviceSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  encryptionKey: z.string().max(4096),
  lastSeen: timestampSchema,
  projectId: z.string().optional(),
});
const envelopeSchema = z
  .object({
    version: z.literal(1),
    ephemeralKey: z.string().max(4096),
    iv: z.string().max(32),
    tag: z.string().max(32),
    ciphertext: z.string().max(32_000),
  })
  .strict();
export type InvitationEnvelope = z.infer<typeof envelopeSchema>;
const context = Buffer.from('coord-desktop-invitation-v1');
function derive(privateKey: string, publicKey: string) {
  const secret = diffieHellman({
    privateKey: createPrivateKey(privateKey),
    publicKey: createPublicKey({
      key: Buffer.from(publicKey, 'base64'),
      type: 'spki',
      format: 'der',
    }),
  });
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), context, 32));
}
export function createDeviceKeys() {
  const pair = generateKeyPairSync('x25519');
  return {
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}
export function encryptInvitation(value: unknown, recipientPublicKey: string): InvitationEnvelope {
  const ephemeral = createDeviceKeys();
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    'aes-256-gcm',
    derive(ephemeral.privateKey, recipientPublicKey),
    iv,
  );
  cipher.setAAD(context);
  const plaintext = Buffer.from(JSON.stringify(value));
  if (plaintext.length > 16000) throw new Error('Invitation too large');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: 1,
    ephemeralKey: ephemeral.publicKey,
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}
export function decryptInvitation(input: unknown, privateKey: string): unknown {
  const envelope = envelopeSchema.parse(input);
  const iv = Buffer.from(envelope.iv, 'base64'),
    tag = Buffer.from(envelope.tag, 'base64');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid invitation encryption');
  const decipher = createDecipheriv('aes-256-gcm', derive(privateKey, envelope.ephemeralKey), iv);
  decipher.setAAD(context);
  decipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8'),
  );
}
export type DesktopControllerOptions = {
  portalUrl: string;
  stateDirectory: string;
  protect: { encryptString(value: string): Buffer; decryptString(value: Buffer): string };
  onStateChanged?: (state: DesktopState) => void;
  integration?: { command: string; args: string[] };
  fetch?: typeof globalThis.fetch;
};
export async function createDesktopController(options: DesktopControllerOptions) {
  const portal = new URL(options.portalUrl);
  if (
    portal.protocol !== 'https:' &&
    !(portal.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(portal.hostname))
  )
    throw new Error('COORD portal must use HTTPS');
  const transport = options.fetch ?? globalThis.fetch;
  let state: DesktopState = { status: 'signed-out', projects: [], devices: [], transfers: [] };
  let credential:
    | {
        deviceCode: string;
        privateKey: string;
        publicKey: string;
        deviceId?: string;
        projectId?: string;
        folder?: string;
      }
    | undefined;
  let pendingExpiry = 0;
  let disposed = false;
  let busy = false;
  let mailbox: (Transfer & { envelope?: unknown })[] = [];
  const senders = new Set<Awaited<ReturnType<typeof prepareTransfer>>>();
  const storage = join(options.stateDirectory, 'device.enc');
  await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
  function emit() {
    state.integrationAvailable = Boolean(options.integration);
    options.onStateChanged?.(structuredClone(state));
  }
  async function save() {
    if (!credential) return;
    const tmp = join(options.stateDirectory, `.device-${randomBytes(8).toString('hex')}`);
    try {
      await writeFile(tmp, options.protect.encryptString(JSON.stringify(credential)), {
        flag: 'wx',
        mode: 0o600,
      });
      await rename(tmp, storage);
    } finally {
      await rm(tmp, { force: true });
    }
  }
  async function api(path: string, body?: unknown, authenticated = true) {
    if (authenticated && !credential?.deviceId) throw new Error('Sign in first');
    const response = await transport(new URL(path, portal.origin), {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        'Content-Type': 'application/json',
        ...(authenticated && credential
          ? { Authorization: `Bearer ${credential.deviceCode}` }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`COORD request failed (${response.status})`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty COORD response');
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.length;
      if (total > 1024 * 1024) {
        await reader.cancel();
        throw new Error('COORD response too large');
      }
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }
  async function refresh() {
    if (disposed || busy || !credential) return;
    busy = true;
    const activeCredential = credential;
    try {
      if (!credential.deviceId) {
        if (pendingExpiry && Date.now() > pendingExpiry)
          throw new Error('Sign-in request expired. Sign in again.');
        const result = z
          .object({
            status: z.string().optional(),
            deviceId: z.string().optional(),
            user: userSchema.optional(),
          })
          .passthrough()
          .parse(await api('/api/device/poll', { deviceCode: credential.deviceCode }, false));
        if (disposed || credential !== activeCredential || !result.deviceId) return;
        credential.deviceId = result.deviceId;
        state.status = 'connected';
        state.user = result.user;
        state.pairing = undefined;
        await save();
      }
      await api('/api/desktop/heartbeat', {
        ...(credential.projectId ? { projectId: credential.projectId } : {}),
      });
      const result = z
        .object({
          user: userSchema,
          projects: z.array(z.object({ id: z.string(), name: z.string() })).max(500),
          devices: z.array(deviceSchema).max(1000),
          transfers: z
            .array(
              z.object({
                id: z.string(),
                projectId: z.string(),
                senderName: z.string(),
                envelope: z.unknown(),
                expiresAt: timestampSchema,
              }),
            )
            .max(1000),
        })
        .parse(await api('/api/desktop/state'));
      if (disposed || credential !== activeCredential) return;
      mailbox = result.transfers;
      state = {
        ...state,
        status: 'connected',
        user: result.user,
        projects: result.projects,
        devices: result.devices.filter(
          (d, index, list) =>
            d.id !== credential?.deviceId &&
            (!state.projectId || !d.projectId || d.projectId === state.projectId) &&
            list.findIndex(
              (other) =>
                other.id === d.id &&
                (!state.projectId || !other.projectId || other.projectId === state.projectId),
            ) === index,
        ),
        transfers: result.transfers.map(({ envelope: _, ...metadata }) => metadata),
        error: undefined,
      };
      if (state.projectId && !state.projects.some((p) => p.id === state.projectId)) {
        state.projectId = undefined;
        credential.projectId = undefined;
        await save();
      }
    } catch (error) {
      if (credential === activeCredential && !disposed)
        state.error = error instanceof Error ? error.message : 'COORD connection failed';
    } finally {
      busy = false;
      emit();
    }
  }
  try {
    credential = z
      .object({
        deviceCode: z.string(),
        privateKey: z.string(),
        publicKey: z.string(),
        deviceId: z.string().optional(),
        projectId: z.string().optional(),
        folder: z.string().optional(),
      })
      .parse(JSON.parse(options.protect.decryptString(await readFile(storage))));
    state = {
      ...state,
      status: credential.deviceId ? 'connected' : 'signed-out',
      projectId: credential.projectId,
      folder: credential.folder,
    };
    if (!credential.deviceId) credential = undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      state.error = 'Saved sign-in could not be unlocked. Sign in again.';
  }
  const bridge = options.integration
    ? await startAgentBridge({
        stateDirectory: options.stateDirectory,
        coordinate: async (projectId, operation, input, agent) => {
          if (
            !credential?.deviceId ||
            state.projectId !== projectId ||
            !state.projects.some((project) => project.id === projectId)
          )
            throw new Error('Select this shared project in COORD before using agent tools');
          if (operation === 'coord_get_context')
            return api(`/api/desktop/context?projectId=${encodeURIComponent(projectId)}`);
          if (operation === 'coord_create_task')
            return api('/api/desktop/tasks', {
              projectId,
              title: input.title,
              action: 'create',
              agent,
            });
          if (operation === 'coord_claim_task')
            return api('/api/desktop/tasks', {
              projectId,
              taskId: input.taskId,
              action: 'claim',
              agent,
            });
          if (operation === 'coord_announce_intent')
            return api('/api/desktop/intent', {
              projectId,
              paths: input.paths,
              summary: input.summary,
              agent,
            });
          if (operation === 'coord_send_message')
            return api('/api/desktop/messages', { projectId, text: input.text, agent });
          throw new Error('Unknown coordination operation');
        },
      })
    : undefined;
  const timer = setInterval(() => void refresh(), 3000);
  timer.unref();
  return {
    getState: () =>
      structuredClone({ ...state, integrationAvailable: Boolean(options.integration) }),
    refresh,
    async beginPairing() {
      const keys = createDeviceKeys();
      const response = z
        .object({
          deviceCode: z.string().min(16),
          userCode: z.string(),
          verificationUrl: z.string(),
          expiresAt: timestampSchema,
        })
        .parse(
          await api(
            '/api/device/start',
            { name: hostname().slice(0, 80), encryptionKey: keys.publicKey },
            false,
          ),
        );
      const url = new URL(response.verificationUrl, portal.origin);
      if (url.origin !== portal.origin) throw new Error('Unexpected sign-in website');
      credential = {
        deviceCode: response.deviceCode,
        privateKey: keys.privateKey,
        publicKey: keys.publicKey,
      };
      pendingExpiry = Date.parse(response.expiresAt);
      state = {
        status: 'pairing',
        projects: [],
        devices: [],
        transfers: [],
        pairing: { userCode: response.userCode, expiresAt: response.expiresAt },
      };
      await save();
      emit();
      return { url: url.href, userCode: response.userCode, expiresAt: response.expiresAt };
    },
    async selectProject(projectId: string) {
      if (!credential || !state.projects.some((p) => p.id === projectId))
        throw new Error('Choose an available project');
      credential.projectId = projectId;
      state.projectId = projectId;
      await save();
      await refresh();
      emit();
    },
    async setFolder(path: string) {
      if (!credential) throw new Error('Sign in first');
      credential.folder = await realpath(path);
      state.folder = credential.folder;
      await save();
      emit();
    },
    async sendFiles(paths: string[], recipientDeviceId: string) {
      if (!credential?.folder || !state.projectId)
        throw new Error('Choose a project and local folder first');
      const session = credential;
      const projectId = state.projectId;
      const recipient = state.devices.find((d) => d.id === recipientDeviceId);
      if (!recipient) throw new Error('Choose an available teammate device');
      const relativePaths = paths.map((path) => {
        const rel = isAbsolute(path) ? relative(credential!.folder!, path) : path;
        if (isAbsolute(rel) || rel === '..' || rel.startsWith('../'))
          throw new Error('Select files inside the linked folder');
        return rel;
      });
      state.sending = true;
      emit();
      let sender: Awaited<ReturnType<typeof prepareTransfer>> | undefined;
      try {
        sender = await prepareTransfer({
          repoRoot: credential.folder,
          paths: relativePaths,
          ttlSeconds: 900,
        });
        const snapshot = await fetchSnapshot(sender.invitation);
        const transferId = sender.invitation.transfer_id,
          expiresAt = sender.invitation.expires_at;
        let networkInvitation: unknown;
        try {
          const network = await prepareNetworkTransfer(
            { repoRoot: credential.folder, paths: relativePaths, ttlSeconds: 900 },
            {},
            sender,
          );
          sender = network as unknown as typeof sender;
          networkInvitation = network.invitation;
        } catch {
          /* Encrypted HTTPS relay remains available. */
        }
        const relayKey = randomBytes(32),
          iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', relayKey, iv);
        cipher.setAAD(Buffer.from(transferId));
        const encrypted = Buffer.concat([cipher.update(snapshot), cipher.final()]);
        const envelope = encryptInvitation(
          {
            version: 1,
            transferId,
            projectId,
            recipientDeviceId,
            expiresAt,
            networkInvitation,
            relay: {
              key: relayKey.toString('base64'),
              iv: iv.toString('base64'),
              tag: cipher.getAuthTag().toString('base64'),
            },
          },
          recipient.encryptionKey,
        );
        if (credential !== session || state.projectId !== projectId || disposed)
          throw new Error('Sign-in changed during transfer');
        const posted = z.object({ id: z.string() }).parse(
          await api('/api/desktop/transfers', {
            projectId,
            recipientDeviceId,
            envelope,
            expiresAt: Date.parse(expiresAt),
          }),
        );
        const upload = await transport(
          new URL(`/api/desktop/transfers/${encodeURIComponent(posted.id)}/blob`, portal.origin),
          {
            method: 'PUT',
            redirect: 'error',
            signal: AbortSignal.timeout(60000),
            headers: {
              Authorization: `Bearer ${credential.deviceCode}`,
              'Content-Type': 'application/octet-stream',
            },
            body: new Uint8Array(encrypted),
          },
        );
        if (!upload.ok) throw new Error(`Encrypted fallback upload failed (${upload.status})`);
        if (sender) {
          senders.add(sender);
          const activeSender = sender;
          setTimeout(
            () => senders.delete(activeSender),
            Math.max(0, Date.parse(expiresAt) - Date.now()),
          ).unref();
        }
        return { expiresAt };
      } catch (error) {
        await sender?.close();
        throw error;
      } finally {
        state.sending = false;
        emit();
      }
    },
    async acceptTransfer(transferId: string) {
      if (!credential?.folder) throw new Error('Choose a local folder first');
      const transfer = mailbox.find((t) => t.id === transferId);
      if (!transfer || transfer.projectId !== state.projectId)
        throw new Error('Choose a transfer from the selected project');
      const payload = z
        .object({
          version: z.literal(1),
          transferId: z.string().uuid(),
          projectId: z.string(),
          recipientDeviceId: z.string(),
          expiresAt: timestampSchema,
          networkInvitation: z.unknown().optional(),
          relay: z.object({ key: z.string(), iv: z.string(), tag: z.string() }),
        })
        .parse(decryptInvitation(transfer.envelope, credential.privateKey));
      if (
        payload.projectId !== state.projectId ||
        payload.recipientDeviceId !== credential.deviceId
      )
        throw new Error('Transfer recipient or project mismatch');
      if (Date.parse(payload.expiresAt) <= Date.now()) throw new Error('Transfer expired');
      const destination = join(credential.folder, '.coord', 'inbox');
      let received: Awaited<ReturnType<typeof stageSnapshot>> | undefined;
      let route: 'direct' | 'encrypted-relay' = 'direct';
      if (payload.networkInvitation) {
        try {
          received = await receiveNetworkTransfer(payload.networkInvitation, destination);
        } catch {
          /* Authenticated encrypted relay is the fallback. */
        }
      }
      if (!received) {
        route = 'encrypted-relay';
        const response = await transport(
          new URL(`/api/desktop/transfers/${encodeURIComponent(transferId)}/blob`, portal.origin),
          {
            redirect: 'error',
            signal: AbortSignal.timeout(60000),
            headers: { Authorization: `Bearer ${credential.deviceCode}` },
          },
        );
        if (!response.ok) throw new Error(`Encrypted transfer unavailable (${response.status})`);
        const reader = response.body?.getReader();
        if (!reader) throw new Error('Empty encrypted transfer');
        let size = 0;
        const chunks: Uint8Array[] = [];
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 24 * 1024 * 1024) {
            await reader.cancel();
            throw new Error('Encrypted transfer too large');
          }
          chunks.push(part.value);
        }
        const key = Buffer.from(payload.relay.key, 'base64'),
          iv = Buffer.from(payload.relay.iv, 'base64'),
          tag = Buffer.from(payload.relay.tag, 'base64');
        if (key.length !== 32 || iv.length !== 12 || tag.length !== 16)
          throw new Error('Invalid encrypted transfer');
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(Buffer.from(payload.transferId));
        decipher.setAuthTag(tag);
        const bytes = Buffer.concat([decipher.update(Buffer.concat(chunks)), decipher.final()]);
        received = await stageSnapshot(bytes, payload.transferId, destination);
      }
      state.lastReceived = received.directory;
      state.lastTransferRoute = route;
      emit();
      await api(`/api/desktop/transfers/${encodeURIComponent(transferId)}/ack`, {});
      await refresh();
      emit();
      return { directory: received.directory, files: received.manifest.files.map((f) => f.path) };
    },
    async installIntegration(agent: 'codex' | 'claude') {
      if (!options.integration) throw new Error('Agent integration is not available in this build');
      if (!credential?.folder) throw new Error('Choose a local folder first');
      if (!bridge || !state.projectId) throw new Error('Choose a shared project first');
      const integration = {
        command: options.integration.command,
        args: [
          ...options.integration.args,
          '--bridge',
          bridge.configPath,
          '--project',
          state.projectId,
          '--agent',
          agent,
        ],
      };
      if (agent === 'codex')
        return installCodexIntegration({
          ...integration,
          configPath: join(credential.folder, '.codex', 'config.toml'),
        });
      if (agent === 'claude')
        return installClaudeIntegration({ ...integration, repoRoot: credential.folder });
      throw new Error('Unknown integration');
    },
    async logout() {
      for (const sender of senders) await sender.close();
      senders.clear();
      credential = undefined;
      mailbox = [];
      await rm(storage, { force: true });
      state = { status: 'signed-out', projects: [], devices: [], transfers: [] };
      emit();
    },
    async dispose() {
      disposed = true;
      clearInterval(timer);
      await bridge?.close();
      for (const sender of senders) await sender.close();
      senders.clear();
    },
  };
}

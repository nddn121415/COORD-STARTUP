import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AccountRequestError } from './account-client.js';
import type { SnapshotFile } from './workspace-guard.js';
import { safePath, textBytes, workspaceLimits } from './workspace-validation.js';

const hex = z.string().regex(/^[a-f0-9]{64}$/);
const path = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => {
    try {
      safePath(value);
      return true;
    } catch {
      return false;
    }
  }, 'Invalid project path');
const manifestSchema = z.object({
  files: z.array(z.object({ path, hash: hex }).strict()).max(workspaceLimits.files),
  context: z
    .object({
      agents: z
        .array(
          z.object({
            id: z.string().max(200),
            agent: z.string().max(200),
            summary: z.string().max(500),
            paths: z.array(path).max(500),
            seen: z.number(),
          }),
        )
        .max(100),
      locks: z
        .array(z.object({ path, owner: z.string().max(200), expiresAt: z.number() }))
        .max(500),
      peers: z
        .array(z.object({ id: hex, name: z.string().max(200), online: z.boolean() }))
        .max(600),
    })
    .passthrough(),
});
export type CloudRequest = (
  operation: string,
  input: Record<string, unknown>,
  sessionId: string,
) => Promise<unknown>;
const digest = (files: { path: string; hash: string }[]) =>
  createHash('sha256')
    .update(JSON.stringify(files.map((file) => [file.path, file.hash])))
    .digest('hex');
const hash = (content: Buffer | string) => createHash('sha256').update(content).digest('hex');

/** Translate local agent operations into bounded, authenticated HTTPS requests. */
export function createCloudClient(remote: CloudRequest) {
  let cache = new Map<string, string>();
  async function readFile(
    file: { path: string; hash: string },
    sessionId: string,
  ): Promise<SnapshotFile> {
    let content = cache.get(file.hash);
    if (content === undefined) {
      const result = z
        .object({ path, hash: hex, contentBase64: z.string().max(1_398_104) })
        .strict()
        .parse(await remote('read', file, sessionId));
      if (result.path !== file.path || result.hash !== file.hash)
        throw new Error('Website returned a different file revision.');
      const bytes = Buffer.from(result.contentBase64, 'base64');
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      if (
        bytes.length > workspaceLimits.fileBytes ||
        bytes.toString('base64') !== result.contentBase64 ||
        content.includes('\0') ||
        hash(bytes) !== file.hash
      )
        throw new Error('Invalid shared file content or digest.');
      textBytes(content);
    }
    return { ...file, content };
  }
  async function snapshot(input: Record<string, unknown>, sessionId: string) {
    const data = z.object({ digest: hex.optional() }).strict().parse(input);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const manifest = manifestSchema.parse(await remote('manifest', {}, sessionId));
        const identities = manifest.files.map((file) => file.path.normalize('NFC').toLowerCase());
        if (
          new Set(identities).size !== identities.length ||
          identities.some((name) =>
            identities.some((other) => other !== name && name.startsWith(other + '/')),
          )
        )
          throw new Error('Shared project contains overlapping file paths.');
        const current = digest(manifest.files);
        if (data.digest === current) return { digest: current, context: manifest.context };
        const files: SnapshotFile[] = [];
        let total = 0;
        for (const entry of manifest.files) {
          const file = await readFile(entry, sessionId);
          total += Buffer.byteLength(file.content);
          if (total > workspaceLimits.totalBytes) throw new Error('Shared project exceeds 16 MiB.');
          files.push(file);
        }
        // Install a cache only after a complete coherent snapshot; stale manifests never apply.
        cache = new Map(files.map((file) => [file.hash, file.content]));
        return { digest: current, files, context: manifest.context };
      } catch (error) {
        if (
          !(error instanceof AccountRequestError) ||
          ![404, 409].includes(error.status) ||
          attempt === 2
        )
          throw error;
      }
    }
    throw new Error('Shared files changed repeatedly. COORD will retry.');
  }
  async function request(
    operation: string,
    input: Record<string, unknown>,
    sessionId: string,
  ): Promise<unknown> {
    if (operation === 'snapshot') return snapshot(input, sessionId);
    if (operation === 'context') {
      z.object({}).strict().parse(input);
      return manifestSchema.parse(await remote('manifest', {}, sessionId)).context;
    }
    if (operation === 'read') {
      const data = z
        .object({ paths: z.array(path).max(50) })
        .strict()
        .parse(input);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const manifest = manifestSchema.parse(await remote('manifest', {}, sessionId));
          const files: SnapshotFile[] = [];
          let total = 0;
          for (const entry of manifest.files.filter((file) => data.paths.includes(file.path))) {
            const file = await readFile(entry, sessionId);
            total += Buffer.byteLength(file.content);
            if (total > workspaceLimits.totalBytes) throw new Error('Read exceeds 16 MiB.');
            files.push(file);
          }
          return { files };
        } catch (error) {
          if (
            !(error instanceof AccountRequestError) ||
            ![404, 409].includes(error.status) ||
            attempt === 2
          )
            throw error;
        }
      }
    }
    if (operation === 'publish') {
      const data = z
        .object({
          changes: z
            .array(
              z
                .object({
                  path,
                  baseHash: hex.nullable(),
                  content: z.string().max(workspaceLimits.fileBytes).nullable(),
                })
                .strict(),
            )
            .min(1)
            .max(50),
        })
        .strict()
        .parse(input);
      let total = 0;
      const changes = data.changes.map((change) => {
        const bytes = change.content === null ? null : textBytes(change.content);
        if (
          bytes &&
          (bytes.length > workspaceLimits.fileBytes ||
            bytes.toString('utf8') !== change.content ||
            change.content?.includes('\0'))
        )
          throw new Error('Only UTF-8 files of up to 1 MiB can be shared.');
        total += bytes?.length ?? 0;
        if (total > workspaceLimits.totalBytes) throw new Error('Publish exceeds 16 MiB.');
        return {
          path: change.path,
          baseHash: change.baseHash,
          contentBase64: bytes?.toString('base64') ?? null,
        };
      });
      const batchId = randomUUID();
      try {
        for (const change of changes) await remote('stage', { batchId, ...change }, sessionId);
        return z
          .object({
            ok: z.literal(true),
            files: z.array(z.object({ path, hash: hex.nullable() })).max(50),
          })
          .parse(await remote('commit', { batchId }, sessionId));
      } catch (error) {
        await remote('abort', { batchId }, sessionId).catch(() => {});
        throw error;
      }
    }
    if (['heartbeat', 'reserve', 'release'].includes(operation))
      return remote(operation, input, sessionId);
    throw new Error('Unsupported coordination operation');
  }
  return { request };
}

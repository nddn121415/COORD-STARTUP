import { z } from 'zod';
import { safePath, textBytes } from '../desktop/workspace-validation.js';
import { containsSecret } from '../../packages/protocol/src/paths.js';
const path = z
  .string()
  .max(1024)
  .refine((value) => {
    try {
      safePath(value);
      return true;
    } catch {
      return false;
    }
  }, 'Protected or invalid workspace path');
const metadata = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !containsSecret(value), 'Protected metadata');
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const batchId = z.string().uuid();
const empty = z.object({}).strict();
const operations = {
  manifest: empty,
  read: z.object({ path, hash: hash.optional() }).strict(),
  heartbeat: z.object({ agent: metadata(80), label: metadata(200).optional() }).strict(),
  reserve: z
    .object({ paths: z.array(path).min(1).max(50), summary: metadata(500).optional() })
    .strict(),
  release: z.object({ paths: z.array(path).max(50).optional() }).strict(),
  stage: z
    .object({
      batchId,
      path,
      baseHash: hash.nullable(),
      contentBase64: z.string().max(1398104).nullable(),
    })
    .strict(),
  commit: z.object({ batchId }).strict(),
  abort: z.object({ batchId }).strict(),
};
const request = z
  .object({
    peerId: hash,
    sessionId: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9_-]+$/),
    operation: z.enum([
      'manifest',
      'read',
      'heartbeat',
      'reserve',
      'release',
      'stage',
      'commit',
      'abort',
    ]),
    input: z.unknown(),
  })
  .strict();
/** The service key never allows an unvalidated browser/native payload to store arbitrary files. */
export function cloudInput(value: unknown) {
  const parsed = request.parse(value);
  const input = operations[parsed.operation].parse(parsed.input ?? {});
  if (
    parsed.operation === 'stage' &&
    'contentBase64' in input &&
    typeof input.contentBase64 === 'string'
  ) {
    const encoded = input.contentBase64;
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) throw new Error('Invalid base64 file');
    const checked = textBytes(bytes.toString('utf8'));
    if (!checked.equals(bytes)) throw new Error('Only UTF-8 text files are supported');
  }
  return { ...parsed, input };
}

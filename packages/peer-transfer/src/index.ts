import { createHash, randomBytes, randomUUID, timingSafeEqual, X509Certificate } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer, request } from 'node:https';
import { dirname, join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { generate } from 'selfsigned';
import { z } from 'zod';
import { assertSafeLocalPath } from '@coord/git-intel';
import { containsSecret, relativePathSchema, validateRelativePath } from '@coord/protocol';

export const transferLimits = {
  files: 50,
  fileBytes: 4 * 1024 * 1024,
  totalBytes: 16 * 1024 * 1024,
  ttlSeconds: 900,
} as const;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const hex = z.string().regex(/^[a-f0-9]{64}$/);
export const invitationSchema = z
  .object({
    version: z.literal(1),
    transfer_id: z.string().uuid(),
    url: z.string().max(2048),
    token: hex,
    certificate_sha256: hex,
    certificate_pem: z.string().max(8192),
    expires_at: z.string().datetime(),
  })
  .strict();
export type TransferInvitation = z.infer<typeof invitationSchema>;
export const manifestSchema = z
  .object({
    version: z.literal(1),
    transfer_id: z.string().uuid(),
    files: z
      .array(
        z
          .object({
            path: relativePathSchema,
            size: z.number().int().min(0).max(transferLimits.fileBytes),
            sha256: hex,
          })
          .strict(),
      )
      .min(1)
      .max(transferLimits.files),
    total_bytes: z.number().int().min(0).max(transferLimits.totalBytes),
  })
  .strict();
export type TransferManifest = z.infer<typeof manifestSchema>;
function uniquePaths(paths: string[]) {
  const keys = paths.map((p) => validateRelativePath(p).normalize('NFC').toLowerCase());
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate or case-colliding paths');
  for (const key of keys)
    if (keys.some((other) => key.startsWith(other + '/')))
      throw new Error('Overlapping file paths');
}
function scan(bytes: Buffer) {
  const text = bytes.toString('utf8');
  // This prototype handles UTF-8 source/text only so secret checks cannot be bypassed by binary encodings.
  if (text.includes('\0') || !Buffer.from(text).equals(bytes))
    throw new Error('Only UTF-8 text files can be shared');
  if (
    containsSecret(text) ||
    /\b(?:[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*)\s*[=:]\s*["']?[^\s"'`;,$}{]{8,}/i.test(
      text,
    )
  )
    throw new Error('Credential-like file content cannot be shared');
}
function validateInvitation(input: unknown) {
  const invitation = invitationSchema.parse(input);
  const url = new URL(invitation.url);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== `/transfers/${invitation.transfer_id}` ||
    !url.hostname ||
    invitation.url !== url.href
  )
    throw new Error('Invalid direct HTTPS invitation URL');
  const expires = Date.parse(invitation.expires_at);
  if (expires <= Date.now() || expires > Date.now() + transferLimits.ttlSeconds * 1000 + 5000)
    throw new Error('Invitation expired or lifetime invalid');
  if (hash(new X509Certificate(invitation.certificate_pem).raw) !== invitation.certificate_sha256)
    throw new Error('Certificate pin mismatch');
  return invitation;
}
export async function prepareTransfer(options: {
  repoRoot: string;
  paths: string[];
  host?: string;
  advertiseHost?: string;
  port?: number;
  ttlSeconds?: number;
}) {
  const ttl = options.ttlSeconds ?? 600;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > transferLimits.ttlSeconds)
    throw new Error('TTL must be 1–900 seconds');
  if (!options.paths.length || options.paths.length > transferLimits.files)
    throw new Error('Select 1–50 explicit files');
  uniquePaths(options.paths);
  const root = await realpath(options.repoRoot);
  const buffers: Buffer[] = [];
  const files: TransferManifest['files'] = [];
  let total = 0;
  for (const candidate of options.paths) {
    const path = await assertSafeLocalPath(root, candidate);
    let current = root;
    for (const segment of path.split('/')) {
      current = join(current, segment);
      if ((await lstat(current)).isSymbolicLink()) throw new Error('Symlinks cannot be shared');
    }
    const absolute = resolve(root, path);
    const canonical = await realpath(absolute);
    if (canonical !== absolute) throw new Error('Path changed during snapshot');
    const handle = await open(
      absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > transferLimits.fileBytes)
        throw new Error('Only regular files up to 4 MiB can be shared');
      const named = await lstat(absolute);
      if (
        named.ino !== before.ino ||
        named.dev !== before.dev ||
        (await realpath(absolute)) !== canonical
      )
        throw new Error('Path changed during snapshot');
      // Bounded read even if another process grows the file while it is open.
      const bytes = Buffer.alloc(transferLimits.fileBytes + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      const after = await handle.stat();
      if (
        length > transferLimits.fileBytes ||
        before.size !== length ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        throw new Error('File changed or exceeded size limit during snapshot');
      const content = Buffer.from(bytes.subarray(0, length));
      scan(content);
      total += length;
      if (total > transferLimits.totalBytes) throw new Error('Transfer exceeds 16 MiB');
      buffers.push(content);
      files.push({ path, size: length, sha256: hash(content) });
    } finally {
      await handle.close();
    }
  }
  const transfer_id = randomUUID();
  const manifest: TransferManifest = { version: 1, transfer_id, files, total_bytes: total };
  const token = randomBytes(32).toString('hex');
  const tls = await generate([{ name: 'commonName', value: 'localhost' }], {
    algorithm: 'sha256',
    keySize: 2048,
    notBeforeDate: new Date(Date.now() - 60_000),
    notAfterDate: new Date(Date.now() + transferLimits.ttlSeconds * 1000),
  });
  const expires = Date.now() + ttl * 1000;
  const payload = Buffer.from(
    JSON.stringify({ manifest, contents: buffers.map((b) => b.toString('base64')) }),
  );
  const server = createServer(
    { key: tls.private, cert: tls.cert, minVersion: 'TLSv1.2', maxHeaderSize: 8192 },
    (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Connection', 'close');
      const supplied = Buffer.from(req.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${token}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        res.writeHead(403).end();
        return;
      }
      if (Date.now() >= expires) {
        res.writeHead(410).end();
        return;
      }
      if (req.method !== 'GET' || req.url !== `/transfers/${transfer_id}`) {
        res.writeHead(404).end();
        return;
      }
      res
        .writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': payload.length })
        .end(payload);
    },
  );
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.timeout = 15_000;
  server.maxConnections = 8;
  const host = options.host ?? '127.0.0.1';
  const advertised = options.advertiseHost ?? host;
  if (!/^[a-zA-Z0-9.:-]+$/.test(advertised) || advertised === '0.0.0.0' || advertised === '::')
    throw new Error('Provide an explicit reachable advertiseHost for wildcard listeners');
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(options.port ?? 0, host, () => {
      server.off('error', fail);
      ok();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const address = `https://${advertised.includes(':') ? `[${advertised}]` : advertised}:${port}/transfers/${transfer_id}`;
  const invitation: TransferInvitation = {
    version: 1,
    transfer_id,
    url: address,
    token,
    certificate_pem: tls.cert,
    certificate_sha256: hash(new X509Certificate(tls.cert).raw),
    expires_at: new Date(expires).toISOString(),
  };
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
  };
  const timer = setTimeout(() => void close(), ttl * 1000);
  timer.unref();
  return { invitation, manifest, address, close };
}

export async function receiveTransfer(options: { invitation: unknown; destination: string }) {
  const invitation = validateInvitation(options.invitation);
  const bytes = await new Promise<Buffer>((ok, fail) => {
    // The invitation cert is the ONLY trust anchor. Node authenticates TLS, then
    // checks this pin before any HTTP headers (including capability) are sent.
    const req = request(
      invitation.url,
      {
        method: 'GET',
        agent: false,
        ca: invitation.certificate_pem,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        checkServerIdentity: (_host, cert) =>
          hash(cert.raw) === invitation.certificate_sha256
            ? undefined
            : new Error('Certificate pin mismatch'),
        headers: { Authorization: `Bearer ${invitation.token}` },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          fail(new Error(`Peer rejected transfer (${res.statusCode})`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > Math.ceil((transferLimits.totalBytes * 4) / 3) + 100_000) {
            req.destroy(new Error('Transfer response too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => ok(Buffer.concat(chunks)));
        res.on('error', fail);
      },
    );
    const deadline = setTimeout(() => req.destroy(new Error('Transfer timed out')), 30_000);
    req.on('close', () => clearTimeout(deadline));
    req.on('error', fail);
    req.end();
  });
  const body = z
    .object({
      manifest: manifestSchema,
      contents: z
        .array(z.string().max(Math.ceil(transferLimits.fileBytes / 3) * 4))
        .max(transferLimits.files),
    })
    .strict()
    .parse(JSON.parse(bytes.toString('utf8')));
  const manifest = body.manifest;
  uniquePaths(manifest.files.map((f) => f.path));
  if (
    manifest.transfer_id !== invitation.transfer_id ||
    body.contents.length !== manifest.files.length ||
    manifest.total_bytes !== manifest.files.reduce((sum, file) => sum + file.size, 0)
  )
    throw new Error('Invalid transfer manifest');
  const contents = body.contents.map((encoded, i) => {
    const decoded = Buffer.from(encoded, 'base64');
    const file = manifest.files[i]!;
    if (
      decoded.toString('base64') !== encoded ||
      decoded.length !== file.size ||
      hash(decoded) !== file.sha256
    )
      throw new Error('File digest or size mismatch');
    scan(decoded);
    return decoded;
  });
  let ancestor = resolve(options.destination);
  while (true) {
    try {
      if ((await lstat(ancestor)).isSymbolicLink())
        throw new Error('Inbox ancestors cannot be symlinks');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (dirname(ancestor) === ancestor) break;
    ancestor = dirname(ancestor);
  }
  await mkdir(options.destination, { recursive: true, mode: 0o700 });
  const destination = await realpath(options.destination);
  const temporary = await mkdtemp(join(destination, '.coord-receive-'));
  await chmod(temporary, 0o700);
  const directory = join(
    destination,
    `coord-${manifest.transfer_id}-${randomBytes(8).toString('hex')}`,
  );
  try {
    for (let i = 0; i < manifest.files.length; i++) {
      const target = join(temporary, manifest.files[i]!.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, contents[i]!, { flag: 'wx', mode: 0o600 });
    }
    await rename(temporary, directory);
    return { directory, manifest };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

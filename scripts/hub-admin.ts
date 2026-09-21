import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/** No token forwarding to redirects or arbitrary HTTP hosts. */
export function hubAdminClient(options: { url: string; token: string; fetch?: typeof fetch }) {
  const url = new URL(options.url);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('COORD_HUB_URL must be an origin without credentials, a path or query.');
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))
  )
    throw new Error('Use HTTPS, or a loopback HTTP address through an SSH tunnel.');
  if (!/^[a-fA-F0-9]{64,256}$/.test(options.token))
    throw new Error('Set COORD_HUB_ADMIN_TOKEN to a strong random token.');
  const request = async (method: string, path: string, body?: unknown) => {
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(new URL(path, url.origin), {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(45000),
        headers: {
          Authorization: `Bearer ${options.token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error('Cannot reach the hub. Check its address and connection.');
    }
    if (!response.ok)
      throw new Error(
        `Hub request failed (${response.status}). Check the request and administration credentials.`,
      );
    if (response.status === 204) return { ok: true };
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Hub returned an empty response.');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 1024 * 1024) {
          await reader.cancel();
          throw new Error('Oversized response');
        }
        chunks.push(chunk.value);
      }
      const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return data;
    } catch {
      throw new Error('Hub returned an invalid or oversized response.');
    } finally {
      reader.releaseLock();
    }
  };
  const id = (value: string) => {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(value))
      throw new Error('Invalid project or peer identifier.');
    return encodeURIComponent(value);
  };
  return {
    projects: () => request('GET', '/v1/projects'),
    create: (name: string) => {
      if (!name.trim() || name.length > 100)
        throw new Error('Use a project name of 1–100 characters.');
      return request('POST', '/v1/projects', { name });
    },
    invite: (project: string) => request('POST', `/v1/projects/${id(project)}/invitations`, {}),
    revoke: (project: string, peer: string) =>
      request('DELETE', `/v1/projects/${id(project)}/peers/${id(peer)}`),
  };
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'generate-token' && !args.length) {
    process.stdout.write(randomBytes(32).toString('hex') + '\n');
    return;
  }
  if (!['list', 'create', 'invite', 'revoke'].includes(command ?? ''))
    throw new Error(
      'Usage: hub-admin generate-token | list | create NAME | invite PROJECT_ID | revoke PROJECT_ID PEER_ID',
    );
  const client = hubAdminClient({
    url: process.env.COORD_HUB_URL ?? 'http://127.0.0.1:4200',
    token: process.env.COORD_HUB_ADMIN_TOKEN ?? '',
  });
  let result: unknown;
  if (command === 'list' && !args.length) result = await client.projects();
  else if (command === 'create' && args.length === 1) result = await client.create(args[0]!);
  else if (command === 'invite' && args.length === 1) result = await client.invite(args[0]!);
  else if (command === 'revoke' && args.length === 2)
    result = await client.revoke(args[0]!, args[1]!);
  else throw new Error('Incorrect command arguments. Quote project names that contain spaces.');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Hub administration failed.');
    process.exitCode = 1;
  });

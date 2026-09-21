import { z } from 'zod';
export type CloudOptions = { url: string; secretKey: string; fetch?: typeof fetch };
export function createCloudAuthority(options: CloudOptions) {
  const url = new URL(options.url);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['', '/'].includes(url.pathname)
  )
    throw new Error('SUPABASE_URL must be an HTTPS origin');
  if (!options.secretKey || /[\r\n]/.test(options.secretKey))
    throw new Error('SUPABASE_SECRET_KEY is required');
  async function rpc(name: string, projectId: string, peerId: string) {
    z.string().uuid().parse(projectId);
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(peerId);
    const response = await (options.fetch ?? fetch)(`${url.origin}/rest/v1/rpc/${name}`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
      headers: {
        apikey: options.secretKey,
        ...(options.secretKey.startsWith('sb_secret_')
          ? {}
          : { Authorization: `Bearer ${options.secretKey}` }),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_project_id: projectId, p_peer_id: peerId }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Cloud authorization unavailable');
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (reader)
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 8192) throw new Error('Cloud response too large');
          chunks.push(part.value);
        }
    } finally {
      await reader?.cancel().catch(() => {});
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }
  return {
    async project(projectId: string, peerId: string) {
      const raw = await rpc('coord_cloud_project', projectId, peerId);
      if (raw === null) return null;
      const result = z
        .object({ id: z.string().uuid(), name: z.string().min(1).max(100), allowed: z.boolean() })
        .parse(raw);
      if (result.id !== projectId) throw new Error('Cloud project access denied');
      return result;
    },
    async authorized(projectId: string, peerId: string) {
      try {
        return z.boolean().parse(await rpc('coord_peer_authorized', projectId, peerId));
      } catch {
        return false;
      }
    },
  };
}

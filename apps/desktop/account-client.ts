import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
const userSchema = z.object({
  id: z.string().max(200),
  name: z.string().max(200).optional(),
  username: z.string().max(200).optional(),
  email: z.string().max(320).optional(),
});
const projectSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().max(200),
  role: z.string().max(40),
});
const credentialSchema = z.object({ website: z.string(), token: z.string().min(16).max(2048) });
export function validateWebsite(value: string): string {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['', '/'].includes(url.pathname) ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  )
    throw new Error('Use an HTTPS website origin, or HTTP localhost for testing.');
  return url.origin;
}
export async function createAccountClient(options: {
  stateDirectory: string;
  website: string;
  protect: { encryptString(value: string): Buffer; decryptString(value: Buffer): string };
  onChange?: () => void;
  fetch?: typeof fetch;
}) {
  const file = join(options.stateDirectory, 'account-session.bin');
  let website = options.website ? validateWebsite(options.website) : '';
  let token: string | undefined;
  let user: z.infer<typeof userSchema> | undefined;
  let projects: z.infer<typeof projectSchema>[] = [];
  let pairing: { deviceCode: string; userCode: string; expiresAt: number } | undefined;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let error: string | undefined;
  let warning: string | undefined;
  let storage = Promise.resolve();
  const persist = (operation: () => Promise<void>) => {
    const work = storage.then(operation);
    storage = work.catch(() => {});
    return work;
  };
  await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
  try {
    const saved = credentialSchema.parse(
      JSON.parse(options.protect.decryptString(await readFile(file))),
    );
    website = validateWebsite(saved.website);
    token = saved.token;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('Saved website sign-in could not be unlocked.');
  }
  const emit = () => options.onChange?.();
  const getState = () => ({
    website,
    signedIn: !!token,
    user,
    projects,
    pairing: pairing ? { userCode: pairing.userCode, expiresAt: pairing.expiresAt } : undefined,
    error,
    warning,
  });
  async function request(path: string, body?: unknown, authenticated = false) {
    if (!website) throw new Error('Set the collaboration website address first.');
    if (authenticated && !token) throw new Error('Sign in first.');
    const response = await (options.fetch ?? fetch)(`${website}/api/account/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(path.endsWith('/connect') ? 45000 : 15000),
      headers: {
        'Content-Type': 'application/json',
        ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const reader = response.body?.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      if (reader)
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 512 * 1024) throw new Error('Website response was too large.');
          chunks.push(part.value);
        }
    } finally {
      await reader?.cancel().catch(() => {});
    }
    if (!response.ok)
      throw new Error(
        response.status === 401
          ? 'Sign-in expired. Sign in again.'
          : `Website request failed (${response.status}).`,
      );
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }
  async function refresh() {
    const epoch = generation;
    const result = z
      .object({ user: userSchema, projects: z.array(projectSchema).max(500) })
      .parse(await request('workspace', undefined, true));
    if (epoch !== generation) return;
    user = result.user;
    projects = result.projects;
    error = undefined;
    emit();
  }
  async function poll() {
    const current = pairing,
      epoch = generation;
    if (!current || current.expiresAt <= Date.now()) {
      pairing = undefined;
      error = 'Sign-in code expired. Start again.';
      emit();
      return;
    }
    try {
      const result = z
        .discriminatedUnion('status', [
          z.object({ status: z.literal('pending') }),
          z.object({
            status: z.literal('approved'),
            token: z.string().min(16).max(2048),
            user: userSchema.optional(),
          }),
        ])
        .parse(await request('device/poll', { deviceCode: current.deviceCode }));
      if (epoch !== generation) return;
      if (result.status === 'approved') {
        token = result.token;
        user = result.user;
        pairing = undefined;
        const credential = JSON.stringify({ website, token });
        await persist(async () => {
          if (epoch !== generation) return;
          const tmp = `${file}.tmp`;
          await writeFile(tmp, options.protect.encryptString(credential), { mode: 0o600 });
          await rename(tmp, file);
        });
        if (epoch !== generation) return;
        await refresh();
        emit();
        return;
      }
    } catch {
      if (epoch !== generation) return;
      error = 'Could not finish website sign-in. Check the website and try again.';
      emit();
    }
    if (epoch === generation && pairing) {
      timer = setTimeout(() => void poll(), 2500);
      timer.unref();
    }
  }
  async function signOut() {
    generation++;
    clearTimeout(timer);
    pairing = undefined;
    let revokeFailed = false;
    try {
      if (token) await request('logout', {}, true);
    } catch {
      revokeFailed = true;
    } finally {
      token = undefined;
      user = undefined;
      projects = [];
      warning = revokeFailed
        ? 'Signed out on this computer. The website was unreachable; server access could not be revoked. Revoke this device from the website when it is available.'
        : undefined;
      await persist(() => rm(file, { force: true }));
      emit();
    }
  }
  return {
    getState,
    refresh,
    async signIn(value?: string) {
      const next = value?.trim() ? validateWebsite(value.trim()) : website;
      if (!next) throw new Error('Set the collaboration website address first.');
      if (token) await signOut();
      generation++;
      clearTimeout(timer);
      pairing = undefined;
      token = undefined;
      user = undefined;
      projects = [];
      await persist(() => rm(file, { force: true }));
      website = next;
      error = undefined;
      const epoch = generation;
      const result = z
        .object({
          deviceCode: z.string().min(16).max(2048),
          userCode: z.string().min(1).max(100),
          expiresAt: z.number().int().positive(),
        })
        .parse(await request('device/start', { name: 'COORD desktop' }));
      if (epoch !== generation) throw new Error('Sign-in cancelled.');
      if (result.expiresAt <= Date.now() || result.expiresAt > Date.now() + 30 * 60_000)
        throw new Error('Website returned an invalid sign-in expiry.');
      pairing = result;
      timer = setTimeout(() => void poll(), 2500);
      timer.unref();
      emit();
      return `${website}/connect?code=${encodeURIComponent(result.userCode)}`;
    },
    signOut,
    async projectKey(id: string, peerId: string) {
      if (!projects.some((p) => p.id === id) || !/^[a-f0-9]{64}$/.test(peerId))
        throw new Error('Choose an available project.');
      const epoch = generation;
      const result = z
        .object({ key: z.string().startsWith('coord1.').max(4096) })
        .parse(await request(`projects/${encodeURIComponent(id)}/connect`, { peerId }, true));
      if (epoch !== generation) throw new Error('Sign-in changed. Choose the project again.');
      return result.key;
    },
    dispose() {
      generation++;
      clearTimeout(timer);
    },
  };
}

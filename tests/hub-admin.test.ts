import { expect, it } from 'vitest';
import { hubAdminClient } from '../scripts/hub-admin.js';
const token = 'a'.repeat(64);
it('limits credentials to TLS or loopback and forbids redirect forwarding', async () => {
  for (const url of [
    'http://remote.example',
    'https://user:pass@example.com',
    'https://example.com/path',
    'https://example.com?x=y',
  ])
    expect(() => hubAdminClient({ url, token })).toThrow();
  const calls: { url: string; init?: RequestInit }[] = [];
  const client = hubAdminClient({
    url: 'https://coord.example',
    token,
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ id: 'project-1' }), { status: 200 });
    },
  });
  await client.create('Project');
  await client.invite('project-1');
  await client.revoke('project-1', 'peer-1');
  expect(calls.map((x) => x.url)).toEqual([
    'https://coord.example/v1/projects',
    'https://coord.example/v1/projects/project-1/invitations',
    'https://coord.example/v1/projects/project-1/peers/peer-1',
  ]);
  expect(calls.every((x) => x.init?.redirect === 'error')).toBe(true);
  expect(calls[0]?.init?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
});
it('does not leak server error bodies or transport exception credentials', async () => {
  const client = hubAdminClient({
    url: 'http://127.0.0.1:4200',
    token,
    fetch: async () => new Response('secret credentials ' + token, { status: 401 }),
  });
  await expect(client.projects()).rejects.toThrow('Hub request failed (401)');
  try {
    await client.projects();
  } catch (error) {
    expect(String(error)).not.toContain(token);
  }
  const broken = hubAdminClient({
    url: 'http://localhost:4200',
    token,
    fetch: async () => {
      throw new Error(token);
    },
  });
  await expect(broken.projects()).rejects.toThrow('Cannot reach the hub');
  expect(() => client.invite('../escape')).toThrow();
});

it('bounds response bodies and validates server project-name limit', async () => {
  const client = hubAdminClient({
    url: 'http://127.0.0.1:4200',
    token,
    fetch: async () => new Response(JSON.stringify({ data: 'x'.repeat(1024 * 1024) })),
  });
  await expect(client.projects()).rejects.toThrow('invalid or oversized');
  expect(() => client.create('x'.repeat(101))).toThrow('1–100');
});

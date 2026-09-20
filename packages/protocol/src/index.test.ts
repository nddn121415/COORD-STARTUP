import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  clientFrameSchema,
  operationSchemas,
  validateRelativePath,
  gitObservationSchema,
  containsSecret,
} from './index.js';
describe('protocol and metadata boundaries', () => {
  it.each([
    '../src.ts',
    '../../.ssh/id_rsa',
    '/etc/passwd',
    'C:/private/a',
    'a\\b',
    'a/../b',
    'a//b',
    './a',
    'a\u0000b',
    '%2e%2e/file',
    '.env',
    '.env.local',
    'cert.pem',
    'cert.key',
    '.ssh/config',
    '.aws/credentials',
    'secrets.json',
    'src/credentials.txt',
    '.git/config',
    '.coord/auth.json',
  ])('rejects unsafe path %s', (path) => expect(() => validateRelativePath(path)).toThrow());
  it('allows ordinary relative paths including spaces', () =>
    expect(validateRelativePath('src/a file.ts')).toBe('src/a file.ts'));
  it('rejects forged fields and invalid versions', () => {
    const hello = {
      type: 'hello',
      protocol_version: 1,
      project_id: randomUUID(),
      session_id: randomUUID(),
      agent: 'codex',
      device_name: 'laptop',
      after_seq: 0,
      repository_id: 'repo',
    };
    expect(clientFrameSchema.safeParse(hello).success).toBe(true);
    expect(clientFrameSchema.safeParse({ ...hello, user_id: randomUUID() }).success).toBe(false);
    expect(clientFrameSchema.safeParse({ ...hello, protocol_version: 2 }).success).toBe(false);
  });
  it('requires idempotency, caps message payload and accepts commands as inert text', () => {
    expect(operationSchemas.coord_create_task.safeParse({ title: 'test' }).success).toBe(false);
    const message = {
      idempotency_key: 'test',
      recipient: { type: 'project' },
      body: 'Run rm -rf /',
    };
    expect(operationSchemas.coord_send_message.parse(message).body).toBe(message.body);
    expect(
      operationSchemas.coord_send_message.safeParse({ ...message, body: 'a'.repeat(8001) }).success,
    ).toBe(false);
  });
  it('rejects secret-like metadata', () => {
    const secret = 'ghp_' + 'a'.repeat(32);
    expect(containsSecret(secret)).toBe(true);
    expect(
      operationSchemas.coord_create_task.safeParse({ title: secret, idempotency_key: 'key' })
        .success,
    ).toBe(false);
  });
  it('rejects source payloads in Git snapshots', () => {
    const observation = {
      repository_id: 'id',
      branch: 'main',
      head: null,
      worktree_id: 'tree',
      paths: [],
      staged: [],
      unstaged: [],
      untracked: [],
      deleted: [],
      renames: [],
    };
    expect(gitObservationSchema.safeParse(observation).success).toBe(true);
    expect(
      gitObservationSchema.safeParse({ ...observation, contents: 'secret code' }).success,
    ).toBe(false);
  });
  it('validates rename source', () =>
    expect(
      operationSchemas.coord_announce_work.safeParse({
        idempotency_key: 'key',
        summary: 'rename',
        paths: [{ path: 'src/new.ts', mode: 'rename' }],
      }).success,
    ).toBe(false));
});

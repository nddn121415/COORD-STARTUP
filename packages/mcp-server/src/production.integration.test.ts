import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createControlPlane, seedDemo } from '../../../apps/control-plane/src/index.js';
import { withTestDatabase } from '../../../tests/db.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const exec = promisify(execFile);

it('production stdio entry authenticates a real connector and writes durable PostgreSQL tasks', async () => {
  await withTestDatabase(async (pool) => {
    const seed = await seedDemo(pool);
    const control = await createControlPlane({ pool, port: 0 });
    const root = await mkdtemp(join(tmpdir(), 'coord-production-mcp-'));
    const home = join(root, 'private-home'),
      repo = join(root, 'checkout');
    const client = new Client({ name: 'production-mcp-test', version: '1.0.0' });
    try {
      await mkdir(home, { mode: 0o700 });
      await mkdir(repo);
      await exec('git', ['init', '--quiet', repo]);
      await mkdir(join(repo, '.coord'), { mode: 0o700 });
      await writeFile(
        join(home, 'credentials.json'),
        JSON.stringify({ url: control.url, token: seed.waled.token }),
        { mode: 0o600 },
      );
      await writeFile(
        join(repo, '.coord/binding.json'),
        JSON.stringify({
          url: control.url,
          projectId: seed.projectId,
          repositoryId: seed.repositoryId,
        }),
        { mode: 0o600 },
      );
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          '--import',
          pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
          fileURLToPath(new URL('./main.ts', import.meta.url)),
          '--repo',
          repo,
          '--agent',
          'codex',
        ],
        cwd: repo,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              (pair): pair is [string, string] => pair[1] !== undefined,
            ),
          ),
          COORD_HOME: home,
        },
        stderr: 'pipe',
      });
      let stderr = '';
      transport.stderr?.on('data', (chunk) => {
        stderr = (stderr + String(chunk)).slice(-4096);
      });
      await client.connect(transport).catch((error) => {
        throw new Error(`${String(error)}: ${stderr}`);
      });
      expect((await client.listTools()).tools).toHaveLength(12);
      const result = await client.callTool({
        name: 'coord_create_task',
        arguments: { title: 'Production MCP task', idempotency_key: randomUUID() },
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result)).toContain('Production MCP task');
      const stored = await pool.query('SELECT title FROM tasks WHERE project_id=$1', [
        seed.projectId,
      ]);
      expect(stored.rows).toEqual([{ title: 'Production MCP task' }]);
      const context = await client.callTool({ name: 'coord_get_project_context', arguments: {} });
      expect(JSON.stringify(context)).toContain('codex');
      expect(JSON.stringify(context)).toContain('UNTRUSTED COORDINATION DATA');
    } finally {
      await client.close();
      await control.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

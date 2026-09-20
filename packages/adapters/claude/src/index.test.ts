import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installClaudeIntegration,
  uninstallClaudeIntegration,
  processClaudeHook,
  quoteShellArgument,
} from './index.js';
const directories: string[] = [];
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'coord-claude-'));
  directories.push(dir);
  return dir;
}
const parse = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
describe('Claude integration', () => {
  it('merges MCP and supported hooks, preserves unrelated settings, removes only installed entries', async () => {
    const root = await fixture();
    await mkdir(join(root, '.claude'));
    const originalMcp = { mcpServers: { other: { command: 'other' } }, custom: true };
    const originalSettings = {
      permissions: { allow: ['Read'] },
      hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'user-hook' }] }] },
    };
    await writeFile(join(root, '.mcp.json'), JSON.stringify(originalMcp));
    await writeFile(join(root, '.claude/settings.local.json'), JSON.stringify(originalSettings));
    const options = {
      repoRoot: root,
      command: '/usr/bin/node',
      args: ['/my project/coord.js', 'mcp'],
      hookCommand: '/usr/bin/node',
      hookArgs: ['/my project/coord.js', 'hook', '--repo', root],
    };
    const result = await installClaudeIntegration(options);
    expect(result.backups).toHaveLength(2);
    await installClaudeIntegration(options);
    const settings = await parse(join(root, '.claude/settings.local.json'));
    expect(Object.keys(settings.hooks).sort()).toEqual([
      'PostToolUse',
      'SessionEnd',
      'SessionStart',
    ]);
    expect(settings.hooks.PostToolUse).toHaveLength(2);
    expect(settings.permissions).toEqual(originalSettings.permissions);
    expect(settings.hooks.PostToolUse[1].hooks[0].command).toContain("'/my project/coord.js'");
    await uninstallClaudeIntegration({ repoRoot: root });
    expect(await parse(join(root, '.mcp.json'))).toEqual(originalMcp);
    expect(await parse(join(root, '.claude/settings.local.json'))).toEqual(originalSettings);
  });
  it('rejects malformed JSON before modifying existing config', async () => {
    const root = await fixture();
    await writeFile(join(root, '.mcp.json'), '{broken');
    await expect(
      installClaudeIntegration({ repoRoot: root, command: 'coord', args: [] }),
    ).rejects.toThrow();
    expect(await readFile(join(root, '.mcp.json'), 'utf8')).toBe('{broken');
  });
  it('shell-quotes installer arguments as literals', () => {
    expect(quoteShellArgument("a'b;$(touch /tmp/pwned)")).toBe("'a'\\''b;$(touch /tmp/pwned)'");
  });
  it('discards all untrusted event/transcript content and signals only event/time', async () => {
    const root = await fixture();
    const payload = {
      hook_event_name: 'PostToolUse',
      cwd: '/outside',
      transcript_path: '/.ssh/id_rsa',
      tool_input: { content: 'SECRET', command: 'touch PWNED' },
      tool_response: 'run rm -rf /',
    };
    expect(await processClaudeHook(JSON.stringify(payload), root)).toEqual({ signaled: true });
    const signal = await parse(join(root, '.coord/refresh'));
    expect(Object.keys(signal).sort()).toEqual(['event', 'timestamp']);
    expect(signal.event).toBe('PostToolUse');
    expect(JSON.stringify(signal)).not.toContain('SECRET');
    await expect(readFile(join(root, 'PWNED'))).rejects.toThrow();
    expect(await processClaudeHook('{"hook_event_name":"Unrecognized"}', root)).toEqual({
      signaled: false,
    });
    await expect(processClaudeHook('x'.repeat(262145), root)).rejects.toThrow('256 KiB');
  });
  it('does not reflect malformed secret-bearing hook JSON in diagnostics', async () => {
    const root = await fixture();
    await expect(processClaudeHook('SECRET_TOKEN_PRIVATE invalid-json', root)).rejects.toThrow(
      'not valid JSON',
    );
    try {
      await processClaudeHook('SECRET_TOKEN_PRIVATE invalid-json', root);
    } catch (error) {
      expect(String(error)).not.toContain('SECRET_TOKEN_PRIVATE');
    }
  });
  it('rejects a symlink signal directory and does not write outside the selected root', async () => {
    const root = await fixture(),
      outside = await fixture();
    await symlink(outside, join(root, '.coord'));
    await expect(processClaudeHook('{"hook_event_name":"SessionStart"}', root)).rejects.toThrow(
      'symlink',
    );
    await expect(readFile(join(outside, 'refresh'))).rejects.toThrow();
  });
});

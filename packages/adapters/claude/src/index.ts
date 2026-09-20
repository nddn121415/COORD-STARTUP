import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rename, unlink, writeFile } from 'node:fs/promises';
import {
  commandSpec,
  json,
  object,
  prepareDirectory,
  readOptional,
  replaceConfig,
  same,
  type JsonObject,
} from '../../codex/src/config-file.js';

export const supportedHookEvents = ['SessionStart', 'PostToolUse', 'SessionEnd'] as const;
export type ClaudeIntegrationOptions = {
  repoRoot: string;
  command: string;
  args: string[];
  hookCommand?: string;
  hookArgs?: string[];
};
const serialize = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
/** Hooks use a local, installer-selected executable. Quote every literal shell argument. */
export function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function paths(root: string) {
  return {
    mcp: join(root, '.mcp.json'),
    settings: join(root, '.claude', 'settings.local.json'),
    receipt: join(root, '.coord', 'claude-install.json'),
  };
}
function hookEntries(hooks: JsonObject, event: string): unknown[] {
  const entries = hooks[event] ?? [];
  if (!Array.isArray(entries)) throw new Error(`hooks.${event} must be an array`);
  return [...entries];
}
export async function installClaudeIntegration(options: ClaudeIntegrationOptions) {
  const root = resolve(options.repoRoot),
    files = paths(root);
  await prepareDirectory(join(root, '.claude'));
  await prepareDirectory(join(root, '.coord'));
  const [mcpBefore, settingsBefore, receiptBefore] = await Promise.all([
    readOptional(files.mcp),
    readOptional(files.settings),
    readOptional(files.receipt),
  ]);
  const mcp = json(mcpBefore, '.mcp.json'),
    settings = json(settingsBefore, 'Claude settings'),
    receipt = json(receiptBefore, 'COORD receipt');
  const servers = object(mcp.mcpServers ?? {}, 'mcpServers');
  const added = { type: 'stdio', ...commandSpec(options.command, options.args) };
  if (
    servers.coord !== undefined &&
    (!same(servers.coord, added) || !same(receipt.installed, added))
  )
    throw new Error('mcpServers.coord already exists or was edited; refusing to overwrite it.');
  const hooks = object(settings.hooks ?? {}, 'hooks');
  const additions: JsonObject = {};
  if (options.hookCommand) {
    const spec = commandSpec(options.hookCommand, options.hookArgs ?? []);
    const command = [spec.command, ...spec.args].map(quoteShellArgument).join(' ');
    for (const event of supportedHookEvents) {
      const entry = {
        ...(event === 'PostToolUse' ? { matcher: 'Write|Edit|MultiEdit|Bash' } : {}),
        hooks: [{ type: 'command', command, timeout: 5 }],
      };
      const entries = hookEntries(hooks, event);
      if (!entries.some((v) => same(v, entry))) entries.push(entry);
      hooks[event] = entries;
      additions[event] = entry;
    }
    if (receipt.hooks && !same(receipt.hooks, additions))
      throw new Error(
        'Installed COORD hooks differ; uninstall the old integration before changing its command.',
      );
    settings.hooks = hooks;
  } else if (receipt.hooks && Object.keys(object(receipt.hooks, 'receipt hooks')).length) {
    throw new Error(
      'COORD hooks were previously installed; provide their command again or uninstall first.',
    );
  }
  mcp.mcpServers = { ...servers, coord: added };
  await replaceConfig(
    files.receipt,
    receiptBefore,
    serialize({ installed: added, hooks: additions }),
  );
  const backups = [];
  backups.push(await replaceConfig(files.mcp, mcpBefore, serialize(mcp)));
  if (options.hookCommand)
    backups.push(await replaceConfig(files.settings, settingsBefore, serialize(settings)));
  return {
    paths: files,
    backups: backups.filter(Boolean),
    added: { 'mcpServers.coord': added, hooks: additions },
  };
}
export async function uninstallClaudeIntegration(options: { repoRoot: string }) {
  const files = paths(resolve(options.repoRoot));
  const [mcpBefore, settingsBefore, receiptBefore] = await Promise.all([
    readOptional(files.mcp),
    readOptional(files.settings),
    readOptional(files.receipt),
  ]);
  if (!receiptBefore) return { removed: false };
  const receipt = json(receiptBefore, 'COORD receipt'),
    mcp = json(mcpBefore, '.mcp.json'),
    settings = json(settingsBefore, 'Claude settings');
  const servers = object(mcp.mcpServers ?? {}, 'mcpServers'),
    hooks = object(settings.hooks ?? {}, 'hooks');
  if (servers.coord !== undefined && !same(servers.coord, receipt.installed))
    throw new Error('COORD MCP entry was edited; refusing to delete your changes.');
  delete servers.coord;
  if (mcp.mcpServers) mcp.mcpServers = servers;
  for (const [event, entry] of Object.entries(object(receipt.hooks ?? {}, 'receipt hooks'))) {
    if (!supportedHookEvents.includes(event as (typeof supportedHookEvents)[number]))
      throw new Error('Invalid COORD hook receipt');
    const entries = hookEntries(hooks, event);
    hooks[event] = entries.filter((v) => !same(v, entry));
    if (!(hooks[event] as unknown[]).length) delete hooks[event];
  }
  const backups = [];
  if (mcpBefore) backups.push(await replaceConfig(files.mcp, mcpBefore, serialize(mcp)));
  if (settingsBefore)
    backups.push(await replaceConfig(files.settings, settingsBefore, serialize(settings)));
  return { removed: true, backups: backups.filter(Boolean) };
}
/** Accept hook metadata, discard all tool/transcript payload, and signal only a local Git refresh. */
export async function processClaudeHook(
  input: string,
  repoRoot: string,
): Promise<{ signaled: boolean }> {
  if (Buffer.byteLength(input, 'utf8') > 262144)
    throw new Error('Claude hook payload exceeds 256 KiB');
  const data = json(input, 'Claude hook input');
  if (!supportedHookEvents.includes(data.hook_event_name as (typeof supportedHookEvents)[number]))
    return { signaled: false };
  const directory = join(resolve(repoRoot), '.coord');
  await prepareDirectory(directory);
  const target = join(directory, 'refresh');
  await readOptional(target); // Reject symlink/non-regular targets before replacement.
  const temporary = join(directory, `.refresh-${randomUUID()}`);
  try {
    await writeFile(temporary, serialize({ event: data.hook_event_name, timestamp: Date.now() }), {
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  return { signaled: true };
}

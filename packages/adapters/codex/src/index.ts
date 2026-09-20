import TOML from '@iarna/toml';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { commandSpec, json, object, readOptional, replaceConfig, same } from './config-file.js';

function parseToml(text: string) {
  try {
    return TOML.parse(text);
  } catch {
    throw new Error('Codex config is not valid TOML; fix its syntax before retrying.');
  }
}

export type CodexIntegrationOptions = { configPath?: string; command: string; args: string[] };
const configPath = (path?: string) =>
  path ?? join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');

export async function installCodexIntegration(options: CodexIntegrationOptions) {
  const path = configPath(options.configPath),
    receiptPath = `${path}.coord-install.json`;
  const before = await readOptional(path);
  const config = before === undefined ? {} : parseToml(before);
  const servers = object(config.mcp_servers ?? {}, 'mcp_servers');
  const added = {
    ...commandSpec(options.command, options.args),
    startup_timeout_sec: 30,
    tool_timeout_sec: 60,
  };
  const receiptBefore = await readOptional(receiptPath);
  const receipt = json(receiptBefore, 'COORD installation receipt');
  if (
    servers.coord !== undefined &&
    (!same(servers.coord, added) || !same(receipt.installed, added))
  ) {
    throw new Error(
      'mcp_servers.coord already exists or was edited. Preserve it by choosing a different config file or removing it manually first.',
    );
  }
  // Save receipt first: interrupted installs remain safely removable/retryable.
  await replaceConfig(
    receiptPath,
    receiptBefore,
    JSON.stringify({ installed: added }, null, 2) + '\n',
  );
  servers.coord = added;
  config.mcp_servers = servers as TOML.JsonMap;
  const backup = await replaceConfig(path, before, TOML.stringify(config));
  return { path, backup, added: { 'mcp_servers.coord': added } };
}
export async function uninstallCodexIntegration(options: { configPath?: string } = {}) {
  const path = configPath(options.configPath),
    receiptPath = `${path}.coord-install.json`;
  const before = await readOptional(path),
    receiptBefore = await readOptional(receiptPath);
  if (!before || !receiptBefore) return { path, removed: false };
  const config = parseToml(before),
    receipt = json(receiptBefore, 'COORD installation receipt');
  const servers = object(config.mcp_servers ?? {}, 'mcp_servers');
  if (servers.coord === undefined) return { path, removed: false };
  if (!same(servers.coord, receipt.installed))
    throw new Error('COORD entry was edited after installation; refusing to delete your changes.');
  delete servers.coord;
  const backup = await replaceConfig(path, before, TOML.stringify(config));
  return { path, backup, removed: true };
}

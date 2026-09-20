#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { Connector, loadLocalConfig } from '@coord/connector';
import { startMcpServer } from './index.js';

async function main() {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string', default: process.cwd() },
      agent: { type: 'string', default: 'other' },
    },
  });
  if (!['codex', 'claude', 'other'].includes(values.agent!)) throw new Error('Unsupported agent');
  const connector = new Connector({
    ...(await loadLocalConfig(values.repo!)),
    agent: values.agent as 'codex' | 'claude' | 'other',
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await connector.stop();
  };
  process.once('SIGINT', () => {
    void stop().finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void stop().finally(() => process.exit(0));
  });
  try {
    await connector.start();
    const server = await startMcpServer(connector);
    server.server.onclose = () => {
      void stop().catch(() => {
        process.exitCode = 1;
      });
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
main().catch(() => {
  // Deliberately omit low-level errors; transport/config errors can contain secrets.
  console.error(
    'COORD MCP could not start. Check coord status, login, project binding, and control-plane availability.',
  );
  process.exitCode = 1;
});

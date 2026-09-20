#!/usr/bin/env node
import { Command } from 'commander';
import { registerPeerCommands } from './peer.js';
import { runPeerDemo } from './peer-demo.js';

const program = new Command()
  .name('coord-peer')
  .description('COORD direct file-transfer tester — no Git, account or database needed')
  .version('0.3.0')
  .option('--repo <path>', 'Folder containing files to send, or receiver project', process.cwd());
program
  .command('demo')
  .description('Test real encrypted transfer with disposable sample files')
  .option('--wifi', 'Also exercise public automatic peer discovery (requires internet)')
  .action(runPeerDemo);
registerPeerCommands(
  program,
  () => program.opts<{ repo: string }>().repo,
  (value) => {
    console.log(JSON.stringify(value, null, 2));
  },
);
program.parseAsync().catch(() => {
  console.error(
    'COORD could not complete the command. Check your paths, invitation and network connection.',
  );
  process.exitCode = 1;
});

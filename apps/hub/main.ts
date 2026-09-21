import { resolve } from 'node:path';
import { createHub } from './server.js';

const adminToken = process.env.COORD_HUB_ADMIN_TOKEN;
if (!adminToken)
  throw new Error(
    'Set COORD_HUB_ADMIN_TOKEN to a cryptographically random token of at least 32 bytes encoded as hexadecimal.',
  );
const hub = await createHub({
  dataDirectory: resolve(
    process.env.COORD_HUB_DATA ?? process.env.COORD_HUB_DATA_DIRECTORY ?? './.coord/hub',
  ),
  adminToken,
  host: process.env.COORD_HUB_HOST ?? '127.0.0.1',
  port: Number(process.env.COORD_HUB_PORT ?? 4200),
});
console.log(`COORD hub administration listening at ${hub.address}`);
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void hub.close().then(
    () => {
      process.exitCode = 0;
    },
    () => {
      console.error('COORD hub shutdown failed');
      process.exitCode = 1;
    },
  );
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

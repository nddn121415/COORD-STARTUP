import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { user: { type: 'string' }, out: { type: 'string' } } });
if (!values.user || !['waled', 'sarah'].includes(values.user) || !values.out)
  throw new Error('Usage: pnpm demo:token --user waled|sarah --out /private/path/device.token');
const file = resolve(values.out);
const seed = JSON.parse(await readFile('.coord/demo-credentials.json', 'utf8'));
await mkdir(dirname(file), { recursive: true, mode: 0o700 });
await writeFile(file, seed[values.user].token + '\n', { mode: 0o600, flag: 'wx' });
console.log(`Token saved privately: ${file}\nProject ID: ${seed.projectId}\nUser: ${values.user}`);

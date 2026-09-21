import { cp, mkdir } from 'node:fs/promises';
await mkdir('dist/web', { recursive: true });
await cp('apps/web', 'dist/web', { recursive: true });
console.log('COORD website built in dist/web');

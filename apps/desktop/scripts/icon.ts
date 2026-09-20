import { writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const size = 1024,
  raw = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y++)
  for (let x = 0; x < size; x++) {
    const i = y * (size * 4 + 1) + 1 + x * 4;
    const cx = Math.max(256, Math.min(768, x)),
      cy = Math.max(256, Math.min(768, y));
    if (Math.hypot(x - cx, y - cy) > 208) continue;
    const t = (x + y) / (size * 2);
    raw[i] = 76 - 40 * t;
    raw[i + 1] = 128 - 47 * t;
    raw[i + 2] = 255 - 46 * t;
    raw[i + 3] = 255;
    const radius = Math.hypot(x - 512, y - 512),
      angle = Math.atan2(y - 512, x - 512);
    const ring = radius > 209 && radius < 302 && Math.abs(angle) > 0.78;
    const caps = Math.hypot(x - 694, y - 331) < 46 || Math.hypot(x - 694, y - 693) < 46;
    if (ring || caps) raw.fill(255, i, i + 4);
    if (Math.hypot(x - 734, y - 512) < 48) {
      raw[i] = 165;
      raw[i + 1] = 192;
      raw[i + 2] = 255;
    }
  }
function crc(buffer: Buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c ^= byte;
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type), data]),
    length = Buffer.alloc(4),
    sum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([length, body, sum]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(size);
header.writeUInt32BE(size, 4);
header[8] = 8;
header[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);
const assets = join(root, 'assets');
await mkdir(assets, { recursive: true });
await writeFile(join(assets, 'icon.png'), png);
if (process.platform === 'darwin') {
  const icons = join(assets, 'icon.iconset');
  await mkdir(icons, { recursive: true });
  for (const logical of [16, 32, 128, 256, 512])
    for (const scale of [1, 2])
      execFileSync(
        'sips',
        [
          '-z',
          String(logical * scale),
          String(logical * scale),
          join(assets, 'icon.png'),
          '--out',
          join(icons, `icon_${logical}x${logical}${scale === 2 ? '@2x' : ''}.png`),
        ],
        { stdio: 'ignore' },
      );
  const elements: Buffer[] = [];
  for (const [type, logical] of [
    ['icp4', 16],
    ['icp5', 32],
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024],
  ] as const) {
    const bytes = await readFile(
      join(icons, logical === 1024 ? 'icon_512x512@2x.png' : `icon_${logical}x${logical}.png`),
    );
    const h = Buffer.alloc(8);
    h.write(type);
    h.writeUInt32BE(bytes.length + 8, 4);
    elements.push(h, bytes);
  }
  const body = Buffer.concat(elements),
    h = Buffer.alloc(8);
  h.write('icns');
  h.writeUInt32BE(body.length + 8, 4);
  await writeFile(join(assets, 'icon.icns'), Buffer.concat([h, body]));
  await rm(icons, { recursive: true });
}

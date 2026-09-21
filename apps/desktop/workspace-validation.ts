import { containsSecret, validateRelativePath } from '../../packages/protocol/src/paths.js';

export const workspaceLimits = {
  files: 500,
  fileBytes: 1024 * 1024,
  totalBytes: 16 * 1024 * 1024,
  leaseMs: 120_000,
} as const;
const blocked = new Set([
  '.git',
  '.coord',
  '.codex',
  '.claude',
  '.mcp.json',
  'node_modules',
  'dist',
  'build',
  'builds',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  '.ds_store',
]);
export function safePath(path: string) {
  validateRelativePath(path);
  if (
    path
      .split('/')
      .some((part) => blocked.has(part.toLowerCase()) || part.toLowerCase().startsWith('.coord-'))
  )
    throw new Error('Protected workspace path');
  return path;
}
export function textBytes(content: string) {
  if (typeof content !== 'string') throw new Error('File content must be text');
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length > workspaceLimits.fileBytes) throw new Error('File exceeds 1 MiB');
  if (content.includes('\0') || bytes.toString('utf8') !== content)
    throw new Error('Only UTF-8 text files are supported');
  if (
    containsSecret(content) ||
    /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*["']?\s*[=:]\s*["']?[^\s"'`;,$}{]{8,}/i.test(
      content,
    )
  )
    throw new Error('Credential-like file content is protected');
  return bytes;
}

/** Metadata paths only: never resolves or reads file contents. Local code must also check symlinks. */
export function isSensitivePath(path: string): boolean {
  return path.split(/[\\/]/).some((part) => {
    const p = part.toLowerCase();
    return (
      p === '.git' ||
      p === '.coord' ||
      p === '.ssh' ||
      p === '.aws' ||
      p === '.gnupg' ||
      p === '.npmrc' ||
      p === '.netrc' ||
      p === '.pypirc' ||
      p === '.env' ||
      p.startsWith('.env.') ||
      /\.(?:pem|key|p12|pfx|keystore)$/.test(p) ||
      /^id_(?:rsa|ed25519|ecdsa|dsa)(?:\.|$)/.test(p) ||
      /^(?:credentials?|secrets?)/.test(p) ||
      /^(?:auth[-_ ]?tokens?|access[-_ ]?tokens?)(?:\.|$)/.test(p)
    );
  });
}

export function validateRelativePath(path: string): string {
  if (
    !path ||
    path.length > 1024 ||
    /[\x00-\x1f\x7f]/.test(path) ||
    path.includes('\\') ||
    path.startsWith('/') ||
    /^[a-zA-Z]:/.test(path) ||
    /%2e|%2f|%5c/i.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..') ||
    isSensitivePath(path)
  ) {
    throw new Error(
      'Path must be a safe, non-sensitive repository-relative POSIX path',
    );
  }
  return path;
}

/** Fail closed for common credential literals in free-text metadata. Not a general-purpose DLP system. */
export function containsSecret(value: unknown): boolean {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b|\bBearer\s+[A-Za-z0-9._~+\/-]{16,}/i.test(
    text ?? '',
  );
}

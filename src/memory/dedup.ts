import * as crypto from 'node:crypto';

export function normalizeMemoryText(value: unknown): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function buildTextDedupHash(value: unknown): string | null {
  const normalized = normalizeMemoryText(value);
  if (!normalized) {
    return null;
  }

  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export function buildMemoryDedupKeys(input: {
  text?: unknown;
  mem0Hash?: unknown;
  hash?: unknown;
  mem0?: { hash?: unknown } | null;
  mem0_hash?: unknown;
}): string[] {
  const keys: string[] = [];
  const mem0Hash = extractMem0Hash(input);
  if (mem0Hash) {
    keys.push(`mem0:${mem0Hash}`);
  }

  const textHash = buildTextDedupHash(input.text);
  if (textHash) {
    keys.push(`text:${textHash}`);
  }

  return keys;
}

function extractMem0Hash(input: {
  mem0Hash?: unknown;
  hash?: unknown;
  mem0?: { hash?: unknown } | null;
  mem0_hash?: unknown;
}): string | null {
  const value =
    input.mem0Hash ??
    input.mem0?.hash ??
    input.mem0_hash ??
    input.hash;

  const normalized = String(value || '').trim();
  return normalized ? normalized : null;
}

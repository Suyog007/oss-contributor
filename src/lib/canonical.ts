import { createHash } from 'node:crypto';

/**
 * Deterministic serialization used for every content hash in the system:
 * LLM cache keys, investigation dedupe keys, approval binding, and idempotency.
 * Key order in objects never changes the result.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return null;
    return value;
  }
  if (Array.isArray(value)) return value.map(sortValue);
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries.map(([k, v]) => [k, sortValue(v)]));
}

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hashObject(value: unknown): string {
  return sha256(canonicalize(value));
}

export function shortHash(value: unknown, length = 12): string {
  return hashObject(value).slice(0, length);
}

/** Filesystem- and git-safe slug. */
export function slugify(input: string, maxLength = 60): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'item';
}

/** Truncate by bytes without splitting a multi-byte character. */
export function truncateBytes(input: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(input, 'utf8');
  if (buffer.byteLength <= maxBytes) return { text: input, truncated: false };
  const slice = buffer.subarray(0, Math.max(0, maxBytes));
  let text = slice.toString('utf8');
  // toString can leave a replacement char at the boundary.
  if (text.endsWith('\uFFFD')) text = text.slice(0, -1);
  return { text, truncated: true };
}

export function tailBytes(input: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(input, 'utf8');
  if (buffer.byteLength <= maxBytes) return { text: input, truncated: false };
  const slice = buffer.subarray(Math.max(0, buffer.byteLength - maxBytes));
  let text = slice.toString('utf8');
  const firstNewline = text.indexOf('\n');
  if (firstNewline > 0 && firstNewline < 200) text = text.slice(firstNewline + 1);
  return { text, truncated: true };
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

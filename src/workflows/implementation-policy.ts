import type { RepoDigest } from '@/github/repo';

/**
 * Deterministic scope policy for implementation edits.
 *
 * The model proposes paths; this module decides what may be touched. Keeping
 * the rules pure and exported makes them testable without a workspace, a model,
 * or a sandbox.
 */

const LOCKFILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'cargo.lock',
  'go.sum',
  'poetry.lock',
  'pipfile.lock',
  'composer.lock',
  'gemfile.lock',
  'pubspec.lock',
]);

const FORBIDDEN_PREFIXES = ['.github/', '.git/', 'node_modules/', 'vendor/', 'dist/', 'build/'];

/**
 * The editor returns whole files, so a file larger than the model's practical
 * output budget cannot be changed safely. 40 KB of source is roughly 10-12k
 * tokens; the edit call reserves the rest of a 16k-token response for JSON
 * framing and the tests. Larger files are refused at plan time with a clear
 * reason rather than silently truncated.
 */
export const MAX_WHOLE_FILE_EDIT_BYTES = 40_000;

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tgz', '.jar',
  '.woff', '.woff2', '.ttf', '.eot', '.mp4', '.mov', '.webm', '.so', '.dylib', '.dll', '.exe',
  '.pyc', '.bin',
]);

/**
 * Normalize a model-provided path. Returns null when it is absolute, contains
 * traversal or backslashes, or is otherwise not a plain POSIX relative path.
 */
export function cleanRelativePath(input: string): string | null {
  const trimmed = input.trim().replace(/^\.\//, '');
  if (trimmed.length === 0 || trimmed.length > 300) return null;
  if (trimmed.startsWith('/') || trimmed.includes('\0') || trimmed.includes('\\')) return null;
  const segments = trimmed.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  return trimmed;
}

/** Why a path may not be edited, or null when it is allowed. */
export function forbiddenPathReason(path: string): string | null {  const lower = path.toLowerCase();
  const base = lower.split('/').pop() ?? lower;
  if (LOCKFILES.has(base)) return 'lockfiles and dependency pins are out of scope';
  if (base === '.env' || base.startsWith('.env.')) return 'environment files are never edited';
  if (FORBIDDEN_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return 'generated, vendored, or CI files are out of scope';
  }
  if (base.endsWith('.min.js') || base.endsWith('.min.css') || base.endsWith('.map')) {
    return 'binary or generated assets are not supported';
  }
  const dot = base.lastIndexOf('.');
  if (dot > 0 && BINARY_EXTENSIONS.has(base.slice(dot))) {
    return 'binary or generated assets are not supported';
  }
  return null;
}

/** Whether a path is a test file, according to the digest and common layouts. */
export function isTestPath(path: string, digest: RepoDigest): boolean {
  if (digest.tree.testFiles.includes(path)) return true;
  return (
    /(^|\/)(__tests__|tests?|spec)\//i.test(path) ||
    /\.(test|spec)\.[a-z0-9]+$/i.test(path) ||
    /_spec\.rb$/i.test(path) ||
    /(^|\/)test_[^/]+\.py$/i.test(path) ||
    /_test\.(go|py|rb)$/i.test(path)
  );
}

function baseName(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.[^.]+$/, '');
}

/** Test files that look related to the files the hypothesis named. */
export function relatedTestFiles(digest: RepoDigest, files: string[]): string[] {
  const names = files.map(baseName).filter((name) => name.length >= 3);
  const related = digest.tree.testFiles.filter((test) =>
    names.some((name) => test.toLowerCase().includes(name.toLowerCase())),
  );
  return [...new Set([...related.slice(0, 3), ...digest.tree.testFiles.slice(0, 2)])];
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

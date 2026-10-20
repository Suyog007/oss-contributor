import type { RepoDigest } from '@/github/repo';
import { extensionOf } from '@/github/repo';

/**
 * Deterministic contributability check, run before paying for analysis.
 *
 * Purpose: refuse to spend model tokens on repositories where a contribution
 * cannot be verified (no tests, no CI) or where there is no software to fix
 * (prompt collections, awesome lists, documentation-only dumps).
 *
 * These are judgement calls, so they are expressed as explicit numbers and the
 * reasons are recorded on the project, not silently discarded.
 */

export interface ContributabilityResult {
  ok: boolean;
  reasons: string[];
  stats: {
    codeFiles: number;
    testFiles: number;
    docFiles: number;
    manifests: number;
    ciWorkflows: number;
    codeRatio: number;
  };
}

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt', '.kts', '.rb',
  '.php', '.cs', '.c', '.h', '.cc', '.cpp', '.hpp', '.swift', '.scala', '.sh', '.bash', '.lua',
  '.ex', '.exs', '.erl', '.hs', '.ml', '.dart', '.vue', '.svelte', '.sql', '.proto',
]);

export interface ContributabilityOptions {
  /** Repositories below this many source files are not worth an agent's time. */
  minCodeFiles?: number;
  /** Code files as a fraction of all files. */
  minCodeRatio?: number;
  /** Require either tests or CI so a change can be verified by the project. */
  requireVerificationPath?: boolean;
}

export function assessContributability(
  digest: RepoDigest,
  options: ContributabilityOptions = {},
): ContributabilityResult {
  const minCodeFiles = options.minCodeFiles ?? 5;
  const minCodeRatio = options.minCodeRatio ?? 0.05;

  let codeFiles = 0;
  for (const [extension, count] of Object.entries(digest.tree.byExtension)) {
    if (CODE_EXTENSIONS.has(extension)) codeFiles += count;
  }
  const totalFiles = Math.max(1, digest.tree.totalFiles);
  const codeRatio = codeFiles / totalFiles;
  const testFiles = digest.tree.testFiles.length;
  const docFiles = digest.tree.docs.length;
  const ciWorkflows = digest.tree.ciWorkflows.length;
  const manifests = digest.tree.manifests.length;

  const reasons: string[] = [];
  if (codeFiles < minCodeFiles) {
    reasons.push(`only ${codeFiles} source files detected`);
  }
  if (codeRatio < minCodeRatio) {
    reasons.push(`source files are only ${(codeRatio * 100).toFixed(1)}% of the ${totalFiles} files in the tree`);
  }
  if (manifests === 0) {
    reasons.push('no dependency manifest or build file found');
  }
  if ((options.requireVerificationPath ?? true) && testFiles === 0 && ciWorkflows === 0) {
    reasons.push('no tests and no CI: there is no way to verify a change the project would accept');
  }
  if (docFiles > codeFiles * 4 && codeFiles > 0) {
    reasons.push(`documentation dominates the tree (${docFiles} docs vs ${codeFiles} source files)`);
  }

  return {
    ok: reasons.length === 0,
    reasons,
    stats: { codeFiles, testFiles, docFiles, manifests, ciWorkflows, codeRatio: Number(codeRatio.toFixed(4)) },
  };
}

/** Cheap check used by discovery to flag non-code repositories in the digest. */
export function looksLikeCodeRepository(digest: RepoDigest): boolean {
  return Object.entries(digest.tree.byExtension).some(
    ([extension, count]) => CODE_EXTENSIONS.has(extension) && count >= 5 && extensionOf(`x${extension}`) === extension,
  );
}

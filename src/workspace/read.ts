import type { Workspace } from '@/workspace/manager';
import { cleanRelativePath } from '@/workflows/implementation-policy';

export interface ReadFilesLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxFileBytes: number;
}

export interface ReadFilesResult {
  files: Array<{ path: string; text: string }>;
  missing: string[];
}

/**
 * Read a bounded set of files from a workspace for a prompt. Missing files are
 * reported rather than silently skipped, so an agent cannot be told a file
 * exists when it does not.
 */
export async function readWorkspaceFiles(
  workspace: Workspace,
  paths: string[],
  limits: ReadFilesLimits,
): Promise<ReadFilesResult> {
  const files: Array<{ path: string; text: string }> = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const raw of paths) {
    if (files.length >= limits.maxFiles || bytes >= limits.maxTotalBytes) break;
    const path = cleanRelativePath(raw);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const text = await workspace.readFile(path);
    if (text === null) {
      missing.push(path);
      continue;
    }
    const size = Buffer.byteLength(text, 'utf8');
    if (size > limits.maxFileBytes) continue;
    files.push({ path, text });
    bytes += size;
  }
  return { files, missing };
}

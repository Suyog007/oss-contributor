/**
 * Rebuild a repository digest without re-running (and re-paying for) analysis.
 *
 *   pnpm tsx scripts/rebuild-digest.ts owner/name [--sha <commit>]
 *
 * Used when the digest shape changed but the analysis at that commit is still
 * valid, and as the operator's recovery path when a digest is missing or
 * unreadable. The analysis row is left untouched; an event records what changed.
 */
import 'dotenv/config';
import { createDb } from '@/db/client';
import { GitHubClient } from '@/github/client';
import { buildRepoDigest, fetchRepoMetadata, splitFullName, DIGEST_VERSION } from '@/github/repo';
import { recordEvent } from '@/workflow/events';
import type { Prisma } from '@/generated/prisma/client';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const fullName = process.argv[2];
  if (!fullName) {
    console.error('usage: pnpm tsx scripts/rebuild-digest.ts owner/name [--sha <commit>]');
    process.exit(1);
  }
  const db = createDb();
  const client = GitHubClient.fromEnv();
  const project = await db.project.findUniqueOrThrow({ where: { fullName } });
  const sha =
    flag('sha') ??
    project.analysisHeadSha ??
    (
      await client.request<{ object: { sha: string } }>(
        `/repos/${fullName}/git/ref/heads/${encodeURIComponent(project.defaultBranch)}`,
      )
    ).object.sha;

  const metadata = await fetchRepoMetadata(client, splitFullName(fullName));
  const { digest, bytes } = await buildRepoDigest(client, metadata, sha);
  const previous = await db.repoDigest.findUnique({
    where: { projectId_headSha: { projectId: project.id, headSha: sha } },
  });

  await db.repoDigest.upsert({
    where: { projectId_headSha: { projectId: project.id, headSha: sha } },
    create: {
      projectId: project.id,
      headSha: sha,
      json: digest as unknown as Prisma.InputJsonValue,
      bytes,
      fileCount: digest.tree.totalFiles,
    },
    update: {
      json: digest as unknown as Prisma.InputJsonValue,
      bytes,
      fileCount: digest.tree.totalFiles,
    },
  });

  await recordEvent(db, {
    eventType: 'digest_rebuilt',
    reason: `digest rebuilt at ${sha.slice(0, 12)} (${previous ? 'replacing a stored digest' : 'was missing'}); version ${DIGEST_VERSION}, ${bytes} bytes`,
    projectId: project.id,
    actorKind: 'OPERATOR',
    actor: 'rebuild-digest',
    evidence: {
      headSha: sha,
      bytes,
      files: digest.files.length,
      replaced: previous !== null,
      digestVersion: digest.digestVersion,
    },
  });

  console.log(
    `rebuilt digest for ${fullName} at ${sha.slice(0, 12)}: ${digest.tree.totalFiles} files, ${digest.files.length} read, ${bytes} bytes`,
  );
  await db.$disconnect();
}

main().catch((error) => {
  console.error(
    error instanceof Error ? (process.env['DEBUG'] ? error.stack : error.message) : error,
  );
  process.exit(1);
});

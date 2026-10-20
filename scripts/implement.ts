/**
 * Run the implementation pipeline by hand.
 *
 *   pnpm implement --candidate <id>
 *   pnpm implement --contribution <id>
 *   pnpm implement --pending [--limit 2]
 *   pnpm implement --candidate <id> --revision-note "reviewers asked for X"
 *
 * This is the operator path: it runs synchronously, prints the real outcome,
 * and never publishes anything. Publishing is a separate, approval-gated step.
 */
import 'dotenv/config';
import { createDb } from '@/db/client';
import { loadEnv } from '@/config/env';
import { implementContribution } from '@/workflows/implement';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDb();
  const revisionNote = flag('revision-note');
  const options = revisionNote ? { revisionContext: revisionNote } : {};

  const candidateIds: string[] = [];
  const explicit = flag('candidate');
  const contributionId = flag('contribution');
  if (explicit) {
    candidateIds.push(explicit);
  } else if (contributionId) {
    const contribution = await db.contribution.findUniqueOrThrow({
      where: { id: contributionId },
      select: { candidateId: true },
    });
    candidateIds.push(contribution.candidateId);
  } else if (flag('pending')) {
    const limit = Number(flag('limit') ?? 1);
    const tasks = await db.task.findMany({
      where: { kind: 'IMPLEMENT_CONTRIBUTION', status: { in: ['PENDING', 'FAILED'] } },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      take: limit,
      select: { payload: true },
    });
    for (const task of tasks) {
      const payload = task.payload as Record<string, unknown> | null;
      const candidateId = payload?.['candidateId'];
      if (typeof candidateId === 'string') candidateIds.push(candidateId);
    }
  }

  if (candidateIds.length === 0) {
    console.error(
      'usage: pnpm implement --candidate <id> | --contribution <id> | --pending [--limit n] [--revision-note "..."]',
    );
    process.exit(1);
  }

  for (const candidateId of candidateIds) {
    const result = await implementContribution(db, candidateId, options, env);
    console.log(
      JSON.stringify(
        {
          candidateId,
          contributionId: result.contributionId,
          status: result.status,
          revisionIndex: result.revisionIndex,
          note: result.note,
          costUsd: Number(result.costUsd.toFixed(4)),
        },
        null,
        2,
      ),
    );
  }

  await db.$disconnect();
}

main().catch((error) => {
  console.error(
    error instanceof Error ? (process.env['DEBUG'] ? error.stack : error.message) : error,
  );
  process.exit(1);
});

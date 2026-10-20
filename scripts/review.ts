/**
 * Run independent review by hand.
 *
 *   pnpm review --contribution <id>
 *   pnpm review --pending [--limit 2]
 *
 * Reviews the latest committed revision, records one Review row per reviewer,
 * and either advances the contribution to READY_FOR_SUBMISSION or enqueues a
 * revision with the blocking findings as the brief.
 */
import 'dotenv/config';
import { createDb } from '@/db/client';
import { loadEnv } from '@/config/env';
import { reviewContribution } from '@/workflows/review';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDb();
  const ids: string[] = [];

  const explicit = flag('contribution');
  if (explicit) {
    ids.push(explicit);
  } else if (flag('pending')) {
    const limit = Number(flag('limit') ?? 1);
    const tasks = await db.task.findMany({
      where: { kind: 'REVIEW_CONTRIBUTION', status: { in: ['PENDING', 'FAILED'] } },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      take: limit,
      select: { payload: true },
    });
    for (const task of tasks) {
      const payload = task.payload as Record<string, unknown> | null;
      const contributionId = payload?.['contributionId'];
      if (typeof contributionId === 'string') ids.push(contributionId);
    }
  }

  if (ids.length === 0) {
    console.error('usage: pnpm review --contribution <id> | --pending [--limit n]');
    process.exit(1);
  }

  for (const contributionId of ids) {
    const result = await reviewContribution(db, contributionId, env);
    console.log(
      JSON.stringify(
        {
          contributionId,
          status: result.status,
          verdict: result.verdict,
          revisionIndex: result.revisionIndex,
          round: result.round,
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

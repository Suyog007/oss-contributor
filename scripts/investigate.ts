/**
 * Run the multi-agent investigation over one or more candidates.
 *
 *   pnpm tsx scripts/investigate.ts --candidate <id>
 *   pnpm tsx scripts/investigate.ts --project owner/name
 *   pnpm tsx scripts/investigate.ts --pending [--limit 3]
 *
 * `--pending` investigates every candidate still marked PROPOSED, which is the
 * normal way to drain the queue by hand while the worker does not exist yet.
 * Output is the real decision with its rationale; nothing here is simulated.
 */
import 'dotenv/config';
import { createDb } from '@/db/client';
import { loadEnv } from '@/config/env';
import { GitHubClient } from '@/github/client';
import { investigateCandidate, summariseCandidate } from '@/workflows/investigate';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDb();
  const client = GitHubClient.fromEnv();
  const limit = Number(flag('limit') ?? 1);

  let candidateIds: string[] = [];
  const explicit = flag('candidate');
  if (explicit) {
    candidateIds = [explicit];
  } else if (flag('project')) {
    const fullName = flag('project')!;
    const rows = await db.candidate.findMany({
      where: { project: { fullName }, status: { in: ['PROPOSED', 'NEEDS_INVESTIGATION'] } },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    candidateIds = rows.map((row) => row.id);
  } else {
    const rows = await db.candidate.findMany({
      where: { status: 'PROPOSED' },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    candidateIds = rows.map((row) => row.id);
  }

  if (candidateIds.length === 0) {
    console.log('no candidates to investigate');
    await db.$disconnect();
    return;
  }

  console.log(
    `investigating ${candidateIds.length} candidate(s) | sandbox=${env.SANDBOX_MODE} | minConfidence=${env.CANDIDATE_MIN_CONFIDENCE}`,
  );

  for (const candidateId of candidateIds) {
    const started = Date.now();
    console.log(`\n=== ${candidateId}`);
    const result = await investigateCandidate(db, client, candidateId);
    console.log(
      `\n-> ${result.status}${result.outcome ? ` (${result.outcome})` : ''}${result.escalated ? ' [ESCALATED]' : ''} | repro=${result.reproductionMode} | $${result.costUsd.toFixed(4)} | ${((Date.now() - started) / 1000).toFixed(0)}s`,
    );
    for (const [agent, verdict] of Object.entries(result.agents)) {
      console.log(`   ${agent}: ${verdict}`);
    }
    console.log('');
    console.log(await summariseCandidate(db, candidateId));
  }

  await db.$disconnect();
}

main().catch((error) => {
  console.error(error instanceof Error ? (process.env['DEBUG'] ? error.stack : error.message) : error);
  process.exit(1);
});

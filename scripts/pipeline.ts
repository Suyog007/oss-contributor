/**
 * Four-role overview: what each stage has produced and what the verifier decided.
 *
 *   pnpm pipeline            # counts per role
 *   pnpm pipeline --verified # candidates with the verifier's decision and rationale
 *
 * Roles: discoverer (projects), selector (analyzed projects), bug finder
 * (candidates), verifier (decisions).
 */
import 'dotenv/config';
import { createDb } from '@/db/client';

async function main(): Promise<void> {
  const db = createDb();
  try {
    const [projects, analyzed, candidates, decisions] = await Promise.all([
      db.project.groupBy({ by: ['state'], _count: true }),
      db.project.count({ where: { analysisHeadSha: { not: null } } }),
      db.candidate.groupBy({ by: ['status'], _count: true }),
      db.decision.groupBy({ by: ['outcome'], _count: true }),
    ]);
    const fmt = (rows: Array<{ _count: number } & Record<string, unknown>>, key: string) =>
      rows.length === 0 ? '  (none)' : rows.map((r) => `  ${String(r[key]).padEnd(24)} ${r._count}`).join('\n');
    console.log('1. Discoverer — projects found\n' + fmt(projects, 'state'));
    console.log(`\n2. Selector — projects analyzed: ${analyzed} (see \`pnpm shortlist\`)`);
    console.log('\n3. Bug finder — candidates\n' + fmt(candidates, 'status'));
    console.log('\n4. Verifier — decisions\n' + fmt(decisions, 'outcome'));

    if (process.argv.includes('--verified')) {
      const rows = await db.decision.findMany({
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: { candidate: { select: { title: true, project: { select: { fullName: true } } } } },
      });
      console.log('\nRecent verifier decisions');
      for (const row of rows) {
        console.log(
          `  [${row.outcome}${row.escalated ? ', needs human' : ''}] ${row.candidate.project.fullName}: ${row.candidate.title}\n      ${row.rationale.slice(0, 240)}`,
        );
      }
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

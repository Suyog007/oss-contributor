/**
 * Selector agent view: which analyzed projects deserve investigation budget first.
 *
 *   pnpm shortlist [--limit 10]
 *
 * Ranking is deterministic (src/selection/shortlist.ts) and every point is
 * explained. Nothing here calls a model.
 */
import 'dotenv/config';
import { createDb } from '@/db/client';
import type { ProjectAnalysis } from '@/domain/schemas';
import { rankProjects } from '@/selection/shortlist';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const limit = Number(flag('limit') ?? 10);
  const db = createDb();
  try {
    const rows = await db.project.findMany({
      where: { state: 'ACTIVE', analysisHeadSha: { not: null } },
    });
    const inFlight = await db.candidate.groupBy({
      by: ['projectId'],
      where: { status: { in: ['PROPOSED', 'INVESTIGATING', 'VALIDATED'] } },
      _count: true,
    });
    const inFlightByProject = new Map(inFlight.map((row) => [row.projectId, row._count]));
    const ranked = rankProjects(
      rows.map((row) => ({
        fullName: row.fullName,
        state: row.state,
        discoveryScore: row.discoveryScore,
        stars: row.stars,
        language: row.language,
        analysis: row.analysisJson as unknown as ProjectAnalysis,
        openCandidates: inFlightByProject.get(row.id) ?? 0,
      })),
      limit,
    );
    if (ranked.length === 0) {
      console.log('No analyzed projects yet. Run `pnpm discover` and let the worker analyze them.');
      return;
    }
    ranked.forEach((entry, index) => {
      console.log(
        `${String(index + 1).padStart(2)}. ${entry.fullName.padEnd(42)} score=${entry.score.toFixed(1).padStart(6)} stars=${entry.project.stars} ${entry.project.language ?? ''}`,
      );
      for (const reason of entry.reasons) console.log(`      - ${reason}`);
    });
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

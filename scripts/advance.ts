/**
 * Queue the next stage for work that is sitting idle.
 *
 *   pnpm advance [--dry-run]
 *
 * - analyzed projects with no candidates      -> GENERATE_HYPOTHESES
 * - candidates still PROPOSED                 -> INVESTIGATE_CANDIDATE
 * Tasks use the same dedupe keys as the pipeline, so running this twice (or
 * while the worker is running) never creates duplicates.
 */
import 'dotenv/config';
import { createDb } from '@/db/client';
import { enqueue } from '@/workflow/queue';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const db = createDb();
  try {
    const projects = await db.project.findMany({
      where: { state: 'ACTIVE', analysisHeadSha: { not: null }, candidates: { none: {} } },
      select: { id: true, fullName: true, analysisHeadSha: true },
    });
    const candidates = await db.candidate.findMany({
      where: { status: 'PROPOSED' },
      select: { id: true, title: true, projectId: true },
    });

    let created = 0;
    for (const project of projects) {
      console.log(`hypotheses  ${project.fullName}`);
      if (dryRun) continue;
      const result = await enqueue(db, {
        kind: 'GENERATE_HYPOTHESES',
        dedupeKey: `hypotheses:${project.id}:${project.analysisHeadSha}`,
        payload: { projectId: project.id, headSha: project.analysisHeadSha },
        priority: 50,
        projectId: project.id,
      });
      if (result.created) created += 1;
    }
    for (const candidate of candidates) {
      console.log(`investigate ${candidate.title}`);
      if (dryRun) continue;
      const result = await enqueue(db, {
        kind: 'INVESTIGATE_CANDIDATE',
        dedupeKey: `investigate:${candidate.id}`,
        payload: { candidateId: candidate.id },
        priority: 60,
        projectId: candidate.projectId,
      });
      if (result.created) created += 1;
    }
    console.log(
      dryRun
        ? `\n${projects.length + candidates.length} item(s) would be considered (dry run)`
        : `\n${created} new task(s) queued (${projects.length + candidates.length - created} already queued or run before)`,
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

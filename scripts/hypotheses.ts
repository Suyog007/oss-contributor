/**
 * Generate candidate issues for analyzed projects.
 *
 *   pnpm tsx scripts/hypotheses.ts                 # up to 2 projects
 *   pnpm tsx scripts/hypotheses.ts chalk/chalk     # a specific repository
 *
 * Prints each hypothesis with its evidence so the reasoning can be judged
 * before any validation budget is spent on it.
 */
import 'dotenv/config';
import { createDb } from '@/db/client';
import { GitHubClient } from '@/github/client';
import { generateCandidatesForProject } from '@/workflows/generateHypotheses';

async function main(): Promise<void> {
  const db = createDb();
  const client = GitHubClient.fromEnv();
  const fullName = process.argv[2];

  const projects = fullName
    ? [await db.project.findUniqueOrThrow({ where: { fullName } })]
    : await db.project.findMany({
        where: { state: 'ACTIVE', analysisJson: { not: null as never } },
        orderBy: { discoveryScore: 'desc' },
        take: 2,
      });

  for (const project of projects) {
    const started = Date.now();
    const result = await generateCandidatesForProject(db, client, project.id);
    console.log(
      `\n${project.fullName}: ${result.status} — ${result.candidatesCreated} candidate(s) from ${result.hypothesesProposed} hypotheses, $${result.costUsd.toFixed(4)}, ${((Date.now() - started) / 1000).toFixed(0)}s`,
    );
    for (const title of result.titles) console.log(`  - ${title}`);

    const candidates = await db.candidate.findMany({
      where: { projectId: project.id },
      include: { investigations: { where: { kind: 'HYPOTHESIS' }, take: 1 } },
    });
    for (const candidate of candidates) {
      const payload = candidate.investigations[0]?.outputJson as
        | {
            claimedBehavior?: string;
            expectedBehavior?: string;
            evidence?: Array<{ kind: string; ref: string; detail: string }>;
            verificationSteps?: string[];
            verificationCommands?: string[];
            confidence?: number;
          }
        | undefined;
      if (!payload) continue;
      console.log(`\n  [${candidate.severity}] ${candidate.title}`);
      console.log(`    origin: ${candidate.origin}${candidate.originIssueNumber ? ` (#${candidate.originIssueNumber})` : ''} | confidence: ${payload.confidence} | files: ${candidate.files.join(', ') || 'none'}`);
      console.log(`    claims: ${payload.claimedBehavior?.slice(0, 220)}`);
      console.log(`    expects: ${payload.expectedBehavior?.slice(0, 220)}`);
      for (const item of (payload.evidence ?? []).slice(0, 4)) {
        console.log(`    evidence [${item.kind}] ${item.ref}: ${item.detail.slice(0, 200)}`);
      }
      const commands = (payload.verificationCommands ?? []).slice(0, 4);
      if (commands.length > 0) console.log(`    verification: ${commands.join(' ; ')}`);
    }
  }

  await db.$disconnect();
}

main().catch((error) => {
  console.error(error instanceof Error ? (process.env['DEBUG'] ? error.stack : error.message) : error);
  process.exit(1);
});

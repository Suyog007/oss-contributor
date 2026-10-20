/**
 * Run one discovery cycle.
 *
 *   pnpm discover                     # configured packs
 *   pnpm discover --packs emerging    # only the emerging pack
 *   pnpm discover --max-queries 3 --dry-run
 *
 * Prints the deterministic gate results and the discovery score reasoning for
 * every repository considered, so the selection is auditable without any model
 * involvement.
 */
import 'dotenv/config';
import { createDb } from '@/db/client';
import { GitHubClient } from '@/github/client';
import { runDiscovery } from '@/workflows/discover';
import { createLogger } from '@/lib/logger';

const log = createLogger('cli:discover');

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const db = createDb();
  const client = GitHubClient.fromEnv();
  const packs = argValue('packs')
    ?.split(',')
    .map((pack) => pack.trim())
    .filter(Boolean);
  const maxQueries = argValue('max-queries') ? Number(argValue('max-queries')) : undefined;
  const dryRun = process.argv.includes('--dry-run');

  try {
    const summary = await runDiscovery(db, client, { ...(packs ? { packs } : {}), ...(maxQueries ? { maxQueries } : {}), dryRun });
    const recent = await db.project.findMany({
      orderBy: [{ lastSyncedAt: 'desc' }],
      take: 15,
      select: {
        fullName: true,
        stars: true,
        discoveryScore: true,
        state: true,
        stateReason: true,
        language: true,
        license: true,
      },
    });

    console.log('\nDiscovery summary');
    console.log(`  queries run            ${summary.queriesRun}`);
    console.log(`  repositories seen      ${summary.repositoriesSeen}`);
    console.log(`  new projects accepted  ${summary.projectsCreated}`);
    console.log(`  rejected by gates      ${summary.projectsRejected}`);
    console.log(`  existing projects synced ${summary.projectsTracked}`);
    console.log(`  analyses enqueued      ${summary.analysesEnqueued}`);
    if (summary.rateLimited) console.log(`  rate limited until     ${summary.rateLimitResetAt?.toISOString()}`);

    console.log('\nMost recently touched projects');
    for (const project of recent) {
      const state = project.state === 'ACTIVE' ? 'ok ' : 'no ';
      console.log(
        `  ${state}${project.fullName.padEnd(42)} score=${project.discoveryScore.toFixed(1).padStart(5)} stars=${String(project.stars).padStart(6)} ${project.language ?? ''} ${project.license ?? ''}`,
      );
      if (project.stateReason) console.log(`      reason: ${project.stateReason}`);
    }

    const signals = await db.projectSignal.findMany({
      where: { kind: { in: ['SUSPICIOUS_ACTIVITY', 'MAINTENANCE_GAP'] } },
      orderBy: { computedAt: 'desc' },
      take: 5,
      include: { project: { select: { fullName: true } } },
    });
    if (signals.length > 0) {
      console.log('\nAttention and maintenance signals');
      for (const signal of signals) {
        console.log(`  ${signal.project.fullName} [${signal.kind}] ${signal.detail}`);
      }
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  log.error('discovery failed', { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});

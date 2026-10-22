/**
 * Show AI spend against the configured limits.
 *
 *   pnpm budget
 */
import 'dotenv/config';
import { createDb } from '@/db/client';
import { loadEnv } from '@/config/env';
import { BudgetGuard } from '@/workflow/budget';

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDb();
  try {
    const status = await BudgetGuard.fromEnv(db).status({});
    const row = (label: string, spent: number, limit: number) =>
      console.log(`  ${label.padEnd(10)} $${spent.toFixed(4)} of $${limit.toFixed(2)}`);
    console.log(`AI spend (${env.AI_BUDGET_TIMEZONE}); AI_ENABLED=${env.AI_ENABLED} AI_DRY_RUN=${env.AI_DRY_RUN}`);
    row('today', status.dailySpentUsd, status.dailyLimitUsd);
    row('month', status.monthlySpentUsd, status.monthlyLimitUsd);
    console.log(
      `  per candidate cap $${env.AI_CANDIDATE_BUDGET_USD}, per contribution cap $${env.AI_CONTRIBUTION_BUDGET_USD}`,
    );
    const top = await db.budgetPeriod.findMany({
      where: { scope: 'CANDIDATE' },
      orderBy: { spentUsd: 'desc' },
      take: 5,
    });
    if (top.length > 0) {
      console.log('\nMost expensive candidates');
      for (const p of top) console.log(`  ${p.scopeRef}  $${Number(p.spentUsd).toFixed(4)} (${p.calls} calls)`);
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

/**
 * Check that the environment is ready to run the pipeline.
 *
 *   pnpm doctor
 *
 * Exits non-zero if a required check fails. Warnings do not fail the run.
 */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { createDb } from '@/db/client';
import { githubConfigured, llmConfigured, loadEnv } from '@/config/env';

type Level = 'ok' | 'warn' | 'fail';
const results: Array<{ level: Level; name: string; detail: string }> = [];
const report = (level: Level, name: string, detail: string) => results.push({ level, name, detail });

async function main(): Promise<void> {
  let env;
  try {
    env = loadEnv();
    report('ok', 'env', '.env parsed');
  } catch (error) {
    report('fail', 'env', error instanceof Error ? error.message : String(error));
    return;
  }

  const db = createDb();
  try {
    await db.$queryRaw`SELECT 1`;
    report('ok', 'database', 'connected');
    const pending = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "_prisma_migrations" WHERE finished_at IS NULL`;
    if (Number(pending[0]?.n ?? 0) > 0) report('warn', 'migrations', 'unfinished migrations; run `pnpm db:deploy`');
  } catch (error) {
    report('fail', 'database', `${error instanceof Error ? error.message : error} (run \`pnpm db:deploy\`)`);
  } finally {
    await db.$disconnect();
  }

  report(githubConfigured(env) ? 'ok' : 'fail', 'GITHUB_TOKEN', githubConfigured(env) ? 'set' : 'missing');
  report(
    llmConfigured(env) ? 'ok' : 'warn',
    'LLM',
    llmConfigured(env) ? 'Fireworks configured' : 'model calls disabled (no key, AI_ENABLED=false or AI_DRY_RUN=true)',
  );

  if (env.SANDBOX_MODE === 'docker') {
    try {
      execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 });
      report('ok', 'docker', 'daemon reachable');
    } catch {
      report('fail', 'docker', 'SANDBOX_MODE=docker but the daemon is unreachable');
    }
  } else {
    report('warn', 'sandbox', `SANDBOX_MODE=${env.SANDBOX_MODE}`);
  }

  report(
    env.AUTONOMY_LEVEL === 'approval_required' ? 'ok' : 'warn',
    'autonomy',
    `AUTONOMY_LEVEL=${env.AUTONOMY_LEVEL}`,
  );
}

main()
  .catch((error) => report('fail', 'doctor', error instanceof Error ? error.message : String(error)))
  .finally(() => {
    for (const r of results) console.log(`${r.level.toUpperCase().padEnd(4)} ${r.name.padEnd(12)} ${r.detail}`);
    process.exit(results.some((r) => r.level === 'fail') ? 1 : 0);
  });

import { timingSafeEqual } from 'node:crypto';
import { githubConfigured, llmConfigured, loadEnv } from '@/config/env';
import { createDb } from '@/db/client';
import { GitHubClient } from '@/github/client';
import { drainQueue } from '@/worker/drain';
import { triggerToken } from '@/worker/trigger';
import type { TaskKind } from '@/generated/prisma/enums';

/**
 * Background function (15 minute limit): runs queued discovery, analysis,
 * bug-finding and verification tasks. Implementation and review tasks need a
 * Docker sandbox, so they stay queued for a worker that has one.
 *
 * Invoked by the scheduler with a signed header; anyone else gets 401.
 *
 * Netlify only runs `-background` functions through the classic `handler`
 * export, so this is not a default-export (v2) function like the scheduler.
 */
const CLAIM_BUDGET_MS = 9 * 60_000;
const LEASE_MS = 20 * 60_000;

export interface WorkerResponse {
  status: number;
  body: unknown;
}

export async function runWorker(given: string): Promise<WorkerResponse> {
  const env = loadEnv();
  const expected = env.SESSION_SECRET ? triggerToken(env.SESSION_SECRET) : '';
  if (!expected || given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
    return { status: 401, body: 'unauthorized' };
  }
  if (!githubConfigured(env)) {
    console.log('worker: GITHUB_TOKEN is not set; nothing to do');
    return { status: 200, body: 'no github token' };
  }

  // Without a model key only discovery (pure GitHub + scoring) can run.
  const kinds: TaskKind[] = llmConfigured(env)
    ? ['DISCOVER_PROJECTS', 'ANALYZE_PROJECT', 'GENERATE_HYPOTHESES', 'INVESTIGATE_CANDIDATE']
    : ['DISCOVER_PROJECTS'];

  const db = createDb();
  try {
    const result = await drainQueue(db, GitHubClient.fromEnv(env), {
      workerId: `netlify-${Date.now().toString(36)}`,
      kinds,
      claimBudgetMs: CLAIM_BUDGET_MS,
      leaseMs: LEASE_MS,
    });
    console.log('worker finished', JSON.stringify({ kinds, ...result }));
    return { status: 200, body: { kinds, ...result } };
  } catch (error) {
    console.error('worker crashed', error instanceof Error ? error.stack : String(error));
    return { status: 500, body: 'worker error' };
  } finally {
    await db.$disconnect();
  }
}

export const handler = async (event: { headers?: Record<string, string | undefined> }) => {
  const response = await runWorker(event.headers?.['x-worker-token'] ?? '');
  return { statusCode: response.status, body: JSON.stringify(response.body) };
};

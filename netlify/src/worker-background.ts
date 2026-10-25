import { timingSafeEqual } from 'node:crypto';
import { githubConfigured, llmConfigured, loadEnv } from '@/config/env';
import { createDb } from '@/db/client';
import { GitHubClient } from '@/github/client';
import { drainQueue } from '@/worker/drain';
import { recordEvent } from '@/workflow/events';
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
    console.warn(
      `worker: rejected call (token ${given ? `given, ${given.length} chars` : 'missing'}; secret ${env.SESSION_SECRET ? 'set' : 'NOT set'})`,
    );
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
    await recordEvent(db, {
      eventType: 'worker_run_started',
      reason: `worker started; running ${kinds.join(', ')}`,
      actor: 'netlify-worker',
    });
    const result = await drainQueue(db, GitHubClient.fromEnv(env), {
      workerId: `netlify-${Date.now().toString(36)}`,
      kinds,
      claimBudgetMs: CLAIM_BUDGET_MS,
      leaseMs: LEASE_MS,
    });
    console.log('worker finished', JSON.stringify({ kinds, ...result }));
    await recordEvent(db, {
      eventType: 'worker_run_finished',
      reason: `worker finished: ${result.claimed} task(s) claimed, ${result.succeeded} succeeded, ${result.failed} failed in ${(result.elapsedMs / 1000).toFixed(1)}s`,
      actor: 'netlify-worker',
    });
    return { status: 200, body: { kinds, ...result } };
  } catch (error) {
    console.error('worker crashed', error instanceof Error ? error.stack : String(error));
    await recordEvent(db, {
      eventType: 'worker_run_crashed',
      reason: `worker crashed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 400),
      actor: 'netlify-worker',
    }).catch(() => undefined);
    return { status: 500, body: 'worker error' };
  } finally {
    await db.$disconnect();
  }
}

export const handler = async (event: { headers?: Record<string, string | undefined>; body?: string | null }) => {
  // The token travels in a header and, as a fallback, in the JSON body.
  let token = event.headers?.['x-worker-token'] ?? '';
  if (!token && event.body) {
    try {
      token = String((JSON.parse(event.body) as { token?: unknown }).token ?? '');
    } catch {
      /* not JSON; stays unauthorized */
    }
  }
  const response = await runWorker(token);
  return { statusCode: response.status, body: JSON.stringify(response.body) };
};

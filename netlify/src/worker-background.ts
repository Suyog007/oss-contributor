import { createHmac, timingSafeEqual } from 'node:crypto';
import { githubConfigured, llmConfigured, loadEnv } from '@/config/env';
import { createDb } from '@/db/client';
import { GitHubClient } from '@/github/client';
import { drainQueue } from '@/worker/drain';
import type { TaskKind } from '@/generated/prisma/enums';

/**
 * Background function (15 minute limit): runs queued discovery, analysis,
 * bug-finding and verification tasks. Implementation and review tasks need a
 * Docker sandbox, so they stay queued for a worker that has one.
 *
 * Invoked by the scheduler with a signed header; anyone else gets 401.
 */
export function triggerToken(secret: string): string {
  return createHmac('sha256', secret).update('worker-trigger').digest('hex');
}

const CLAIM_BUDGET_MS = 9 * 60_000;
const LEASE_MS = 20 * 60_000;

export default async (request: Request): Promise<Response> => {
  const env = loadEnv();
  const given = request.headers.get('x-worker-token') ?? '';
  const expected = env.SESSION_SECRET ? triggerToken(env.SESSION_SECRET) : '';
  if (!expected || given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
    return new Response('unauthorized', { status: 401 });
  }
  if (!githubConfigured(env)) {
    console.log('worker: GITHUB_TOKEN is not set; nothing to do');
    return new Response('no github token', { status: 200 });
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
    return Response.json({ kinds, ...result });
  } finally {
    await db.$disconnect();
  }
};

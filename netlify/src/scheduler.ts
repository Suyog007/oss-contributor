import { createDb } from '@/db/client';
import { loadEnv } from '@/config/env';
import { enqueue } from '@/workflow/queue';
import { triggerToken } from './worker-background';

/**
 * Scheduled function (every 15 minutes). It only queues work and pokes the
 * background function, so it finishes well inside the scheduled-function
 * limit.
 */
export const config = { schedule: '*/15 * * * *' };

export default async (): Promise<Response> => {
  const env = loadEnv();
  const db = createDb();
  try {
    // One discovery run per day; the dedupe key makes extra calls no-ops.
    const day = new Date().toISOString().slice(0, 10);
    const { created } = await enqueue(db, {
      kind: 'DISCOVER_PROJECTS',
      dedupeKey: `discover:${day}`,
      payload: {},
      priority: 10,
    });

    // Bring idle work forward: analyzed projects with no candidates, and
    // candidates still waiting to be investigated.
    const projects = await db.project.findMany({
      where: { state: 'ACTIVE', analysisHeadSha: { not: null }, candidates: { none: {} } },
      select: { id: true, analysisHeadSha: true },
      take: 20,
    });
    for (const project of projects) {
      await enqueue(db, {
        kind: 'GENERATE_HYPOTHESES',
        dedupeKey: `hypotheses:${project.id}:${project.analysisHeadSha}`,
        payload: { projectId: project.id, headSha: project.analysisHeadSha },
        priority: 50,
        projectId: project.id,
      });
    }
    const candidates = await db.candidate.findMany({
      where: { status: 'PROPOSED' },
      select: { id: true, projectId: true },
      take: 20,
    });
    for (const candidate of candidates) {
      await enqueue(db, {
        kind: 'INVESTIGATE_CANDIDATE',
        dedupeKey: `investigate:${candidate.id}`,
        payload: { candidateId: candidate.id },
        priority: 60,
        projectId: candidate.projectId,
      });
    }

    const base = process.env['URL'];
    if (!base || !env.SESSION_SECRET) {
      return Response.json({ queuedDiscovery: created, triggered: false, reason: 'URL or SESSION_SECRET missing' });
    }
    const response = await fetch(`${base}/.netlify/functions/worker-background`, {
      method: 'POST',
      headers: { 'x-worker-token': triggerToken(env.SESSION_SECRET) },
    });
    return Response.json({ queuedDiscovery: created, triggered: true, status: response.status });
  } finally {
    await db.$disconnect();
  }
};

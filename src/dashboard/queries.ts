import 'server-only';
import { getDb } from '@/db/client';
import type { ProjectAnalysis } from '@/domain/schemas';
import { BudgetGuard } from '@/workflow/budget';
import { rankProjects } from '@/selection/shortlist';

export async function overview() {
  const db = getDb();
  const [projects, analyzed, candidates, decisions, contributions, tasks, budget] = await Promise.all([
    db.project.count(),
    db.project.count({ where: { analysisHeadSha: { not: null } } }),
    db.candidate.groupBy({ by: ['status'], _count: true }),
    db.decision.groupBy({ by: ['outcome'], _count: true }),
    db.contribution.groupBy({ by: ['state'], _count: true }),
    db.task.groupBy({ by: ['status'], _count: true }),
    BudgetGuard.fromEnv(db).status({}),
  ]);
  return { projects, analyzed, candidates, decisions, contributions, tasks, budget };
}

export function listProjects() {
  return getDb().project.findMany({
    orderBy: [{ discoveryScore: 'desc' }, { stars: 'desc' }],
    take: 200,
    select: {
      fullName: true,
      stars: true,
      language: true,
      license: true,
      state: true,
      stateReason: true,
      discoveryScore: true,
      analysisHeadSha: true,
      repoPushedAt: true,
    },
  });
}

export async function shortlist() {
  const db = getDb();
  const rows = await db.project.findMany({
    where: { state: 'ACTIVE', analysisHeadSha: { not: null } },
  });
  const inFlight = await db.candidate.groupBy({
    by: ['projectId'],
    where: { status: { in: ['PROPOSED', 'INVESTIGATING', 'VALIDATED'] } },
    _count: true,
  });
  const counts = new Map(inFlight.map((row) => [row.projectId, row._count]));
  return rankProjects(
    rows.map((row) => ({
      fullName: row.fullName,
      state: row.state,
      discoveryScore: row.discoveryScore,
      stars: row.stars,
      language: row.language,
      analysis: row.analysisJson as unknown as ProjectAnalysis,
      openCandidates: counts.get(row.id) ?? 0,
    })),
    25,
  );
}

export function listCandidates() {
  return getDb().candidate.findMany({
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      project: { select: { fullName: true } },
      decision: { select: { outcome: true, rationale: true, escalated: true } },
    },
  });
}

export function listContributions() {
  return getDb().contribution.findMany({
    orderBy: { updatedAt: 'desc' },
    take: 100,
    include: {
      project: { select: { fullName: true } },
      candidate: { select: { title: true } },
      pullRequests: { select: { number: true, url: true, state: true } },
    },
  });
}

export async function activity() {
  const db = getDb();
  const [events, failing] = await Promise.all([
    db.workflowEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 60 }),
    db.task.findMany({
      where: { status: { in: ['FAILED', 'DEAD'] } },
      orderBy: { updatedAt: 'desc' },
      take: 20,
    }),
  ]);
  return { events, failing };
}

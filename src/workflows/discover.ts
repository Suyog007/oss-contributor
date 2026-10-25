import type { Db } from '@/db/client';
import { loadEnv } from '@/config/env';
import { createLogger } from '@/lib/logger';
import { GitHubClient, GitHubRateLimitError } from '@/github/client';
import { fetchRepoMetadata, fetchReleases, splitFullName } from '@/github/repo';
import { QUERY_PACKS, searchRepositories, type SearchRepoResult } from '@/github/search';
import { SearchPacer } from '@/github/pacing';
import {
  applyGates,
  computeSignals,
  scoreProject,
  type ActivitySample,
  type PreviousSample,
  type Signal,
} from '@/discovery/scoring';
import { recordEvent } from '@/workflow/events';
import { enqueue } from '@/workflow/queue';
import type { TaskKind } from '@/generated/prisma/enums';
import type { Prisma } from '@/generated/prisma/client';

const log = createLogger('discovery');

const DAY_MS = 86_400_000;

export interface DiscoveryRunSummary {
  queriesRun: number;
  repositoriesSeen: number;
  projectsCreated: number;
  projectsUpdated: number;
  projectsRejected: number;
  projectsTracked: number;
  analysesEnqueued: number;
  rateLimited: boolean;
  rateLimitResetAt?: Date;
}

export interface DiscoverOptions {
  /** Override the packs, used by tests and by targeted manual runs. */
  packs?: string[];
  maxQueries?: number;
  dryRun?: boolean;
}

export async function runDiscovery(
  db: Db,
  client: GitHubClient,
  options: DiscoverOptions = {},
): Promise<DiscoveryRunSummary> {
  const env = loadEnv();
  const now = new Date();
  const pacer = new SearchPacer(client);
  const packs = QUERY_PACKS.filter(
    (pack) => !options.packs || options.packs.length === 0 || options.packs.includes(pack.name),
  );
  const configuredPacks = env.DISCOVERY_QUERY_PACKS;
  const selectedPacks =
    configuredPacks.length > 0
      ? packs.filter((pack) => configuredPacks.includes(pack.name))
      : packs;

  const queryContext = {
    today: now.toISOString().slice(0, 10),
    thirtyDaysAgo: new Date(now.getTime() - 30 * DAY_MS).toISOString().slice(0, 10),
    yearAgo: new Date(now.getTime() - 365 * DAY_MS).toISOString().slice(0, 10),
  };

  const queries: Array<{ query: string; pack: string; sort: 'stars' | 'updated' }> = [];
  for (const pack of selectedPacks) {
    for (const query of pack.build(queryContext)) {
      queries.push({ query, pack: pack.name, sort: pack.sort });
    }
  }
  const maxQueries = options.maxQueries ?? env.DISCOVERY_MAX_QUERIES_PER_RUN;
  const limitedQueries = queries.slice(0, maxQueries);

  const summary: DiscoveryRunSummary = {
    queriesRun: 0,
    repositoriesSeen: 0,
    projectsCreated: 0,
    projectsUpdated: 0,
    projectsRejected: 0,
    projectsTracked: 0,
    analysesEnqueued: 0,
    rateLimited: false,
  };

  const seen = new Map<string, SearchRepoResult & { pack: string; query: string }>();
  for (const { query, pack, sort } of limitedQueries) {
    try {
      await pacer.beforeSearch();
      const results = await searchRepositories(client, query, {
        sort,
        perPage: Math.min(env.DISCOVERY_RESULTS_PER_QUERY, 50),
        maxPages: 1,
      });
      summary.queriesRun += 1;
      for (const repo of results) {
        if (!seen.has(repo.fullName)) seen.set(repo.fullName, { ...repo, pack, query });
      }
    } catch (error) {
      if (error instanceof GitHubRateLimitError) {
        summary.rateLimited = true;
        summary.rateLimitResetAt = error.resetAt;
        log.warn('search rate limited; stopping discovery early', {
          resetAt: error.resetAt.toISOString(),
        });
        break;
      }
      throw error;
    }
  }

  summary.repositoriesSeen = seen.size;
  if (summary.repositoriesSeen === 0) {
    await recordEvent(db, {
      eventType: 'discovery_run',
      reason: 'discovery found no repositories',
      evidence: { queriesRun: summary.queriesRun },
    });
    return summary;
  }

  // Existing projects are refreshed so growth is measurable over time, then new
  // repositories are evaluated until the per-run budget of activity calls is spent.
  const tracked = await refreshTrackedProjects(db, client, env.DISCOVERY_TRACK_EXISTING_PER_RUN);
  summary.projectsTracked = tracked;

  const known = new Set(
    (
      await db.project.findMany({
        where: { fullName: { in: [...seen.keys()] } },
        select: { fullName: true },
      })
    ).map((row) => row.fullName),
  );

  const candidates = [...seen.values()]
    .filter((repo) => !known.has(repo.fullName))
    .sort((a, b) => b.stars - a.stars)
    .slice(0, env.DISCOVERY_MAX_PROJECTS_PER_RUN);

  const scored: Array<{ projectId: string; score: number; fullName: string }> = [];

  for (const repo of candidates) {
    try {
      const outcome = await evaluateRepository(db, client, repo, now);
      if (outcome.state === 'ACTIVE') {
        summary.projectsCreated += 1;
        scored.push({
          projectId: outcome.projectId,
          score: outcome.score,
          fullName: repo.fullName,
        });
      } else {
        summary.projectsRejected += 1;
      }
    } catch (error) {
      if (error instanceof GitHubRateLimitError) {
        summary.rateLimited = true;
        summary.rateLimitResetAt = error.resetAt;
        break;
      }
      log.warn('repository evaluation failed', { fullName: repo.fullName, error: String(error) });
    }
  }

  summary.projectsUpdated = summary.projectsTracked;

  if (summary.rateLimited) {
    await recordEvent(db, {
      eventType: 'discovery_rate_limited',
      reason: `GitHub rate limit reached during discovery; resets ${summary.rateLimitResetAt?.toISOString()}`,
      evidence: { ...summary },
    });
  }

  // Analysis is the first step that costs model tokens, so it is limited to the
  // highest scoring projects that are not already analyzed at their current head SHA.
  const analysisTargets = await db.project.findMany({
    where: {
      state: 'ACTIVE',
      OR: [{ analysisAt: null }, { analysisHeadSha: null }],
    },
    orderBy: [{ discoveryScore: 'desc' }, { lastAnalyzedAt: 'asc' }],
    take: env.DISCOVERY_MAX_ANALYSES_PER_RUN,
    select: { id: true, fullName: true, discoveryScore: true },
  });

  if (!options.dryRun) {
    for (const project of analysisTargets) {
      if (project.discoveryScore < env.DISCOVERY_MIN_SCORE_TO_ANALYZE) continue;
      const { created } = await enqueue(db, {
        kind: 'ANALYZE_PROJECT',
        dedupeKey: `analyze:${project.id}:${new Date().toISOString().slice(0, 10)}`,
        payload: { projectId: project.id },
        priority: 40,
        projectId: project.id,
      });
      if (created) summary.analysesEnqueued += 1;
    }
  }

  await recordEvent(db, {
    eventType: 'discovery_run',
    reason: `discovered ${summary.repositoriesSeen} repositories across ${summary.queriesRun} queries; ${summary.projectsCreated} new, ${summary.projectsRejected} rejected by gates`,
    evidence: { ...summary, rateLimitResetAt: summary.rateLimitResetAt?.toISOString() ?? null },
  });

  log.info('discovery run finished', { ...summary });
  return summary;
}

export interface EvaluateOutcome {
  projectId: string;
  state: 'ACTIVE' | 'BLOCKED';
  score: number;
}

/**
 * Evaluate one repository and record it as a project.
 *
 * `manual` is for repositories a person asked for by name: the popularity,
 * age and activity floors are skipped (the person chose it), but the hard
 * safety checks stay (archived, fork, no issues, no license, too large).
 */
export async function evaluateRepository(
  db: Db,
  client: GitHubClient,
  repo: { fullName: string; pack: string; query: string },
  now: Date,
  options: { manual?: boolean } = {},
): Promise<EvaluateOutcome> {
  const env = loadEnv();
  const ref = splitFullName(repo.fullName);
  const metadata = await fetchRepoMetadata(client, ref);

  const sample = await collectActivity(client, ref, metadata);

  const gates = applyGates(
    {
      stars: metadata.stars,
      sizeKb: metadata.sizeKb,
      pushedAt: metadata.pushedAt,
      createdAt: metadata.createdAt,
      archived: metadata.archived,
      fork: metadata.isFork,
      license: metadata.license,
      hasIssues: metadata.hasIssues,
      defaultBranch: metadata.defaultBranch,
    },
    {
      minStars: options.manual ? 0 : env.DISCOVERY_MIN_STARS,
      maxRepoSizeKb: env.DISCOVERY_MAX_REPO_SIZE_KB,
      maxDaysSincePush: options.manual ? Number.POSITIVE_INFINITY : env.DISCOVERY_MAX_DAYS_SINCE_PUSH,
      minRepoAgeDays: options.manual ? 0 : env.DISCOVERY_MIN_REPO_AGE_DAYS,
      requireLicense: env.DISCOVERY_REQUIRE_LICENSE,
      requireTests: false,
    },
    { hasTestSuite: null, now },
  );

  const signals = computeSignals(sample, null, now);
  const scored = scoreProject({ signals, current: sample, now });

  const project = await db.project.upsert({
    where: { githubId: BigInt(metadata.githubId) },
    create: {
      githubId: BigInt(metadata.githubId),
      fullName: metadata.fullName,
      owner: metadata.owner,
      name: metadata.name,
      defaultBranch: metadata.defaultBranch,
      isFork: metadata.isFork,
      archived: metadata.archived,
      license: metadata.license,
      language: metadata.language,
      topics: metadata.topics,
      description: metadata.description,
      sizeKb: metadata.sizeKb,
      stars: metadata.stars,
      forks: metadata.forks,
      watchers: metadata.watchers,
      openIssues: metadata.openIssues,
      repoCreatedAt: metadata.createdAt,
      repoPushedAt: metadata.pushedAt,
      state: gates.accepted ? 'ACTIVE' : 'BLOCKED',
      stateReason: gates.accepted ? null : gates.reasons.join('; '),
      discoveredVia: options.manual ? 'MANUAL' : 'GITHUB_SEARCH',
      discoveryQuery: repo.query,
      discoveryScore: scored.score,
    },
    update: {
      fullName: metadata.fullName,
      defaultBranch: metadata.defaultBranch,
      archived: metadata.archived,
      license: metadata.license,
      language: metadata.language,
      topics: metadata.topics,
      description: metadata.description,
      sizeKb: metadata.sizeKb,
      stars: metadata.stars,
      forks: metadata.forks,
      watchers: metadata.watchers,
      openIssues: metadata.openIssues,
      repoPushedAt: metadata.pushedAt,
      discoveryScore: scored.score,
      lastSyncedAt: now,
      ...(gates.accepted
        ? { state: 'ACTIVE' as const, stateReason: null }
        : { state: 'BLOCKED' as const, stateReason: gates.reasons.join('; ') }),
    },
  });

  await db.projectSnapshot.create({
    data: {
      projectId: project.id,
      stars: sample.stars,
      forks: sample.forks,
      watchers: sample.watchers,
      openIssues: sample.openIssues,
      openPrs: sample.openPrs,
      commitsLast30d: sample.commitsLast30d,
      releasesLast90d: sample.releasesLast90d,
      contributorsLast30d: sample.contributors,
    },
  });

  for (const signal of signals) {
    await db.projectSignal.create({
      data: {
        projectId: project.id,
        kind: signal.kind,
        value: signal.value,
        detail: signal.detail,
        evidence: signal.evidence as Prisma.InputJsonValue,
      },
    });
  }

  await recordEvent(db, {
    eventType: gates.accepted ? 'project_discovered' : 'project_rejected_by_gates',
    reason: gates.accepted
      ? `accepted with discovery score ${scored.score.toFixed(1)}`
      : `rejected: ${gates.reasons.join('; ')}`,
    projectId: project.id,
    evidence: {
      fullName: metadata.fullName,
      score: scored.score,
      reasons: scored.reasons,
      suspicionScore: scored.suspicionScore,
      accepted: gates.accepted,
      gateReasons: gates.reasons,
      query: repo.query,
      pack: repo.pack,
    },
  });

  return {
    projectId: project.id,
    state: gates.accepted ? 'ACTIVE' : 'BLOCKED',
    score: scored.score,
  };
}

/**
 * Cheap activity probes. Each is a single request that uses the Link header to
 * count pages instead of downloading every commit.
 */
async function collectActivity(
  client: GitHubClient,
  ref: { owner: string; name: string; fullName: string },
  metadata: {
    stars: number;
    forks: number;
    watchers: number;
    openIssues: number;
    sizeKb: number;
    license: string | null;
    createdAt: Date;
    pushedAt: Date;
    hasIssues: boolean;
    isFork: boolean;
  },
): Promise<ActivitySample> {
  const since = new Date(Date.now() - 30 * DAY_MS).toISOString();
  const [commits, contributors, openPrs, issues, releases] = await Promise.all([
    client.countByLink(`/repos/${ref.fullName}/commits`, { since }).catch(() => null),
    client.countByLink(`/repos/${ref.fullName}/contributors`).catch(() => null),
    client.countByLink(`/repos/${ref.fullName}/pulls`, { state: 'open' }).catch(() => null),
    client.countByLink(`/repos/${ref.fullName}/issues`, { state: 'open', since }).catch(() => null),
    fetchReleases(client, ref, 10).catch(() => []),
  ]);

  const releasesLast90d = releases.filter(
    (release) => Date.now() - release.publishedAt.getTime() < 90 * DAY_MS,
  ).length;

  return {
    stars: metadata.stars,
    forks: metadata.forks,
    watchers: metadata.watchers,
    openIssues: metadata.openIssues,
    openPrs: openPrs ?? 0,
    issuesLast30d: issues ?? 0,
    commitsLast30d: commits ?? 0,
    releasesLast90d,
    contributors: contributors ?? 0,
    repoCreatedAt: metadata.createdAt,
    repoPushedAt: metadata.pushedAt,
    sizeKb: metadata.sizeKb,
    license: metadata.license,
    hasIssuesEnabled: metadata.hasIssues,
    archived: false,
    isFork: metadata.isFork,
  };
}

/** Refresh counters for projects already on the books, building a time series. */
async function refreshTrackedProjects(
  db: Db,
  client: GitHubClient,
  limit: number,
): Promise<number> {
  if (limit <= 0) return 0;
  const projects = await db.project.findMany({
    where: { state: { in: ['ACTIVE', 'COOLDOWN'] } },
    orderBy: { lastSyncedAt: 'asc' },
    take: limit,
    select: { id: true, fullName: true, owner: true, name: true },
  });

  let refreshed = 0;
  for (const project of projects) {
    try {
      await refreshProject(db, client, project);
      refreshed += 1;
    } catch (error) {
      if (error instanceof GitHubRateLimitError) throw error;
      log.warn('project refresh failed', { fullName: project.fullName, error: String(error) });
    }
  }
  return refreshed;
}

export async function refreshProject(
  db: Db,
  client: GitHubClient,
  projectRef: { id: string; fullName: string; owner: string; name: string },
): Promise<{ score: number; signals: Signal[] }> {
  const ref = splitFullName(projectRef.fullName);
  const metadata = await fetchRepoMetadata(client, ref);
  const previous = await db.projectSnapshot.findFirst({
    where: { projectId: projectRef.id },
    orderBy: { capturedAt: 'desc' },
  });
  const sample = await collectActivity(client, ref, metadata);
  const previousSample: PreviousSample | null = previous
    ? {
        capturedAt: previous.capturedAt,
        stars: previous.stars,
        forks: previous.forks,
        commitsLast30d: previous.commitsLast30d,
        openIssues: previous.openIssues,
      }
    : null;

  const signals = computeSignals(sample, previousSample, new Date());
  const digestRow = await db.repoDigest.findFirst({
    where: { projectId: projectRef.id },
    orderBy: { createdAt: 'desc' },
  });
  const digest = digestRow?.json as
    { tree?: { testFiles?: string[]; ciWorkflows?: string[] } } | undefined;
  const scored = scoreProject({
    signals,
    current: sample,
    hasTestSuite: digest ? (digest.tree?.testFiles?.length ?? 0) > 0 : null,
    hasCi: digest ? (digest.tree?.ciWorkflows?.length ?? 0) > 0 : null,
  });

  await db.project.update({
    where: { id: projectRef.id },
    data: {
      stars: metadata.stars,
      forks: metadata.forks,
      watchers: metadata.watchers,
      openIssues: metadata.openIssues,
      repoPushedAt: metadata.pushedAt,
      sizeKb: metadata.sizeKb,
      license: metadata.license,
      archived: metadata.archived,
      discoveryScore: scored.score,
      lastSyncedAt: new Date(),
    },
  });

  await db.projectSnapshot.create({
    data: {
      projectId: projectRef.id,
      stars: sample.stars,
      forks: sample.forks,
      watchers: sample.watchers,
      openIssues: sample.openIssues,
      openPrs: sample.openPrs,
      commitsLast30d: sample.commitsLast30d,
      releasesLast90d: sample.releasesLast90d,
      contributorsLast30d: sample.contributors,
    },
  });

  for (const signal of signals) {
    await db.projectSignal.create({
      data: {
        projectId: projectRef.id,
        kind: signal.kind,
        value: signal.value,
        detail: signal.detail,
        evidence: signal.evidence as Prisma.InputJsonValue,
      },
    });
  }

  return { score: scored.score, signals };
}

export const DISCOVERY_TASK_KINDS: TaskKind[] = ['DISCOVER_PROJECTS', 'SYNC_PROJECT'];

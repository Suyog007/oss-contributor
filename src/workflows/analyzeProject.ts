import type { Db } from '@/db/client';
import { loadEnv } from '@/config/env';
import { createLogger } from '@/lib/logger';
import type { Prisma } from '@/generated/prisma/client';
import { GitHubClient, GitHubRateLimitError } from '@/github/client';
import {
  buildRepoDigest,
  DIGEST_VERSION,
  fetchRepoMetadata,
  splitFullName,
  type RepoDigest,
} from '@/github/repo';
import { assessContributability } from '@/analysis/precheck';
import { buildProjectAnalysisPrompt, runProjectAnalysis } from '@/agents/projectAnalysis';
import { createAgentContext } from '@/agents/runner';
import { scoreProject, type ActivitySample, type Signal } from '@/discovery/scoring';
import { recordEvent, recordSecurityEvent } from '@/workflow/events';
import { enqueue } from '@/workflow/queue';
import { mergeScreens, screenForInjection } from '@/llm/context';

const log = createLogger('analyze');

export interface AnalyzeResult {
  projectId: string;
  status: 'analyzed' | 'skipped-unchanged' | 'rejected' | 'rate-limited';
  reason: string;
  headSha?: string;
  costUsd?: number;
  candidatesEnqueued?: number;
}

/**
 * Repository analysis.
 *
 * Order matters: fetch the head SHA first and skip when it is unchanged
 * (analysis is cached per commit), then run the deterministic contributability
 * check, and only then spend model tokens on the profile.
 */
export async function analyzeProject(
  db: Db,
  client: GitHubClient,
  projectId: string,
  options: { force?: boolean } = {},
): Promise<AnalyzeResult> {
  const env = loadEnv();
  const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
  const ref = splitFullName(project.fullName);

  let headSha: string;
  try {
    const refData = await client.request<{ object: { sha: string } }>(
      `/repos/${project.fullName}/git/ref/heads/${encodeURIComponent(project.defaultBranch)}`,
    );
    headSha = refData.object.sha;
  } catch (error) {
    if (error instanceof GitHubRateLimitError) {
      return { projectId, status: 'rate-limited', reason: error.message };
    }
    throw error;
  }

  if (!options.force && project.analysisHeadSha === headSha && project.analysisJson) {
    // The analysis is current, but the digest it was built from may not be: a
    // digest that predates a shape change is rebuilt (and the analysis re-run
    // against it) instead of being trusted.
    const currentDigestRow = await db.repoDigest.findUnique({
      where: { projectId_headSha: { projectId, headSha } },
    });
    const currentDigest = currentDigestRow?.json as unknown as RepoDigest | undefined;
    if (currentDigestRow && currentDigest?.digestVersion === DIGEST_VERSION) {
      return {
        projectId,
        status: 'skipped-unchanged',
        reason: `head ${headSha.slice(0, 12)} is already analyzed`,
        headSha,
      };
    }
    await recordEvent(db, {
      eventType: 'digest_rebuild_required',
      reason: `cached digest at ${headSha.slice(0, 12)} is ${
        currentDigestRow ? `version ${currentDigest?.digestVersion ?? 'unknown'}` : 'missing'
      }; rebuilding it and re-running analysis`,
      projectId,
    });
  }

  const metadata = await fetchRepoMetadata(client, ref);

  let digestRow = await db.repoDigest.findUnique({
    where: { projectId_headSha: { projectId, headSha } },
  });
  const cachedDigest = digestRow?.json as unknown as RepoDigest | undefined;
  if (digestRow && cachedDigest?.digestVersion !== DIGEST_VERSION) {
    // The cached digest predates a shape change; rebuild rather than guess.
    await db.repoDigest.delete({ where: { id: digestRow.id } });
    digestRow = null;
  }
  if (!digestRow) {
    const { digest, bytes } = await buildRepoDigest(client, metadata, headSha);
    digestRow = await db.repoDigest.create({
      data: {
        projectId,
        headSha,
        json: digest as unknown as Prisma.InputJsonValue,
        bytes,
        fileCount: digest.tree.totalFiles,
      },
    });
  }
  const digest = digestRow.json as unknown as RepoDigest;

  const contributability = assessContributability(digest);
  if (!contributability.ok) {
    await db.project.update({
      where: { id: projectId },
      data: {
        state: 'COOLDOWN',
        stateReason: `not contributable: ${contributability.reasons.join('; ')}`,
        analysisHeadSha: headSha,
        analysisAt: new Date(),
        analysisJson: {
          rejected: true,
          reason: contributability.reasons,
          stats: contributability.stats,
        } as Prisma.InputJsonValue,
      },
    });
    await recordEvent(db, {
      eventType: 'project_not_contributable',
      reason: contributability.reasons.join('; '),
      projectId,
      evidence: contributability.stats,
    });
    return {
      projectId,
      status: 'rejected',
      reason: contributability.reasons.join('; '),
      headSha,
    };
  }

  // Repository text is untrusted; record anything that looks like an attempt to
  // instruct the agent, and keep it out of the security-critical path.
  const promptPreview = buildProjectAnalysisPrompt({
    digest,
    stats: contributability.stats as unknown as Record<string, number>,
  });
  const screens = [
    promptPreview.screen,
    screenForInjection(digest.repo.description ?? '', { location: 'repository description' }),
  ];
  const merged = mergeScreens(
    screens.map((screen) => ({ location: 'project-analysis-input', screen })),
  );
  if (merged.suspicious) {
    await recordSecurityEvent(db, {
      reason: 'prompt-injection-like text found in repository content',
      detail: merged.extractedInstructions.join(' | ').slice(0, 800),
      projectId,
      evidence: { patterns: merged.patterns as unknown as Prisma.InputJsonValue },
    });
  }

  const ctx = createAgentContext(db);
  const outcome = await runProjectAnalysis(ctx, {
    projectId,
    digest,
    stats: contributability.stats as unknown as Record<string, number>,
  });

  await db.project.update({
    where: { id: projectId },
    data: {
      analysisJson: outcome.output as unknown as Prisma.InputJsonValue,
      analysisHeadSha: headSha,
      analysisAt: new Date(),
      analysisCostUsd: outcome.costUsd,
      lastAnalyzedAt: new Date(),
      state: 'ACTIVE',
      stateReason: null,
    },
  });

  // Re-score now that we know whether the project has tests and CI: this is the
  // first point where that is knowable, and it materially changes the ranking.
  const latestSnapshot = await db.projectSnapshot.findFirst({
    where: { projectId },
    orderBy: { capturedAt: 'desc' },
  });
  if (latestSnapshot) {
    const sample: ActivitySample = {
      stars: latestSnapshot.stars,
      forks: latestSnapshot.forks,
      watchers: latestSnapshot.watchers,
      openIssues: latestSnapshot.openIssues,
      openPrs: latestSnapshot.openPrs,
      issuesLast30d: 0,
      commitsLast30d: latestSnapshot.commitsLast30d,
      releasesLast90d: latestSnapshot.releasesLast90d,
      contributors: latestSnapshot.contributorsLast30d,
      repoCreatedAt: metadata.createdAt,
      repoPushedAt: metadata.pushedAt,
      sizeKb: metadata.sizeKb,
      license: metadata.license,
      hasIssuesEnabled: metadata.hasIssues,
      archived: metadata.archived,
      isFork: metadata.isFork,
    };
    const priorSignals = await db.projectSignal.findMany({
      where: { projectId },
      orderBy: { computedAt: 'desc' },
      take: 20,
      select: { kind: true, value: true, detail: true, evidence: true },
    });
    const signals: Signal[] = priorSignals.map((signal) => ({
      kind: signal.kind,
      value: signal.value,
      detail: signal.detail,
      evidence: signal.evidence as Record<string, unknown>,
    }));
    const scored = scoreProject({
      signals,
      current: sample,
      hasTestSuite: digest.tree.testFiles.length > 0,
      hasCi: digest.tree.ciWorkflows.length > 0,
    });
    await db.project.update({ where: { id: projectId }, data: { discoveryScore: scored.score } });
    await db.projectSignal.create({
      data: {
        projectId,
        kind: 'TEST_COVERAGE_SIGNAL',
        value: digest.tree.testFiles.length,
        detail:
          digest.tree.testFiles.length > 0
            ? `${digest.tree.testFiles.length} test files found; suite can verify changes`
            : 'no test files found; verifying a change will be hard',
        evidence: {
          testFiles: digest.tree.testFiles.length,
          ciWorkflows: digest.tree.ciWorkflows.length,
          score: scored.score,
        } as Prisma.InputJsonValue,
      },
    });
  }

  await recordEvent(db, {
    eventType: 'project_analyzed',
    reason: `analyzed at ${headSha.slice(0, 12)} for $${outcome.costUsd.toFixed(4)}${outcome.cacheHit ? ' (reused)' : ''}`,
    projectId,
    actorKind: 'AGENT',
    actor: 'project-analysis',
    evidence: {
      purpose: outcome.output.purpose,
      weaknesses: outcome.output.weaknesses.length,
      contributionAreas: outcome.output.contributionAreas.length,
      testCommands: outcome.output.testCommands,
      costUsd: outcome.costUsd,
    },
  });

  let candidatesEnqueued = 0;
  if (env.CANDIDATE_MAX_PER_PROJECT > 0) {
    const { created } = await enqueue(db, {
      kind: 'GENERATE_HYPOTHESES',
      dedupeKey: `hypotheses:${projectId}:${headSha}`,
      payload: { projectId, headSha },
      priority: 50,
      projectId,
    });
    if (created) candidatesEnqueued += 1;
  }

  log.info('project analyzed', {
    fullName: project.fullName,
    costUsd: outcome.costUsd,
    cacheHit: outcome.cacheHit,
    contributionAreas: outcome.output.contributionAreas.length,
  });

  return {
    projectId,
    status: 'analyzed',
    reason: outcome.rationale,
    headSha,
    costUsd: outcome.costUsd,
    candidatesEnqueued,
  };
}

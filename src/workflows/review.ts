/**
 * Independent review: four reviewers, deterministic aggregation, bounded
 * revision loop.
 *
 * Reviewers run against the committed revision and its recorded test results.
 * No majority vote: a single evidenced blocking defect stops submission, while
 * style preferences are recorded as notes and never block. When reviewers
 * require changes and the revision budget allows it, the blocking findings are
 * handed back to the implementation pipeline as a revision brief.
 */
import { z } from 'zod';
import type { Db } from '@/db/client';
import type { Prisma } from '@/generated/prisma/client';
import type { Reviewer } from '@/generated/prisma/enums';
import { loadEnv, type Env } from '@/config/env';
import { createLogger } from '@/lib/logger';
import { hashObject } from '@/lib/canonical';
import { recordEvent } from '@/workflow/events';
import { enqueue } from '@/workflow/queue';
import { TaskBlockedError } from '@/workflow/errors';
import { createAgentContext } from '@/agents/runner';
import { REVIEW_PROMPT_VERSION, reviewChange } from '@/agents/reviewer';
import {
  aggregateReviews,
  isBlockingFinding,
  revisionBrief,
  type ReviewedChange,
  type ReviewAggregation,
} from '@/agents/reviewAggregation';
import { findingSchema, solutionPlanSchema, type SolutionPlan } from '@/domain/schemas';
import type { SolutionEvidence } from '@/agents/solution';
import { Workspace } from '@/workspace/manager';
import { readWorkspaceFiles } from '@/workspace/read';
import { resolveWorkingDirectory } from '@/sandbox/docker';
import { ecosystemForInvestigation, manifestDirectoryFor } from '@/sandbox/policy';
import { DIGEST_VERSION } from '@/github/repo';
import { loadDigest, loadEvidence } from '@/workflows/evidence';
import { transitionContribution } from '@/workflows/transitions';

const log = createLogger('review');

const REVIEWERS: Reviewer[] = ['CORRECTNESS', 'SECURITY', 'MAINTAINABILITY', 'ADVERSARIAL'];
const findingsSchema = z.array(findingSchema);

/** States where another review would duplicate finished work. */
const REVIEW_COMPLETE_STATES = new Set([
  'READY_FOR_SUBMISSION',
  'HUMAN_APPROVAL',
  'PR_SUBMITTED',
  'AWAITING_REVIEW',
  'FEEDBACK_RECEIVED',
  'RESOLVED',
  'MERGED',
  'CLOSED_UNMERGED',
  'ABANDONED',
  'CANCELLED',
  'DUPLICATE',
  'REJECTED_CANDIDATE',
  'NEEDS_MAINTAINER_INPUT',
  'FAILED',
]);

export interface ReviewResult {
  contributionId: string;
  status: 'approved' | 'revision-required' | 'already-complete';
  revisionIndex: number;
  round: number;
  verdict: ReviewAggregation['verdict'];
  note: string;
  costUsd: number;
}

export async function reviewContribution(
  db: Db,
  contributionId: string,
  env: Env = loadEnv(),
): Promise<ReviewResult> {
  const contribution = await db.contribution.findUnique({
    where: { id: contributionId },
    include: { project: true, candidate: { include: { decision: true } } },
  });
  if (!contribution) throw new Error(`contribution ${contributionId} not found`);

  const revision = await db.revision.findFirst({
    where: { contributionId },
    orderBy: { index: 'desc' },
  });
  if (!revision) throw new TaskBlockedError(`contribution ${contributionId} has no revision to review`);

  if (REVIEW_COMPLETE_STATES.has(contribution.state)) {
    return {
      contributionId,
      status: 'already-complete',
      revisionIndex: revision.index,
      round: contribution.reviewRound,
      verdict: 'APPROVE_WITH_NOTES',
      note: `contribution is already in state ${contribution.state}`,
      costUsd: 0,
    };
  }
  if (contribution.state !== 'INDEPENDENT_REVIEW') {
    throw new TaskBlockedError(
      `contribution ${contributionId} is in state ${contribution.state}, not INDEPENDENT_REVIEW; run implementation first`,
    );
  }

  const candidate = contribution.candidate;
  const project = contribution.project;
  const headSha = candidate.analysisHeadSha ?? project.analysisHeadSha;
  if (!headSha) throw new TaskBlockedError(`contribution ${contributionId} has no analyzed commit`);

  const digest = await loadDigest(db, project.id, headSha);
  if (!digest) {
    throw new TaskBlockedError(
      `no repository digest for ${project.fullName} at ${headSha.slice(0, 12)}; rebuild it before reviewing`,
    );
  }
  if (digest.digestVersion !== DIGEST_VERSION) {
    throw new TaskBlockedError(
      `digest for ${project.fullName} is version ${String(digest.digestVersion)}, expected ${DIGEST_VERSION}; rebuild it`,
    );
  }

  const bundle = await loadEvidence(db, candidate.id, candidate.title);
  if (!bundle.hypothesis) {
    throw new TaskBlockedError(`the hypothesis behind candidate ${candidate.id} could not be loaded`);
  }

  const parsedPlan = solutionPlanSchema.safeParse(contribution.planJson);
  if (!parsedPlan.success) {
    throw new TaskBlockedError(
      `contribution ${contributionId} has no readable implementation plan; re-run implementation`,
    );
  }
  const plan: SolutionPlan = parsedPlan.data;

  if (!contribution.workspacePath || !contribution.branchName || !contribution.baseSha) {
    throw new TaskBlockedError(
      `contribution ${contributionId} has no workspace, branch, or base commit; re-run implementation`,
    );
  }
  const workspace = Workspace.attach(db, contribution.workspacePath, {
    contributionId,
    projectId: project.id,
    fullName: project.fullName,
    defaultBranch: project.defaultBranch,
    baseSha: contribution.baseSha,
    branchName: contribution.branchName,
  });

  const ecosystem = ecosystemForInvestigation(
    [...candidate.files, ...digest.files.map((file) => file.path)],
    digest.repo.language,
    digest.tree.manifests,
  );
  const workdir = resolveWorkingDirectory(
    manifestDirectoryFor(ecosystem, digest.tree.manifests) ?? undefined,
  );
  const evidence: SolutionEvidence = {
    digest,
    hypothesis: bundle.hypothesis,
    validation: bundle.validation,
    reproduction: bundle.reproduction,
    duplicate: bundle.duplicate,
    maintainer: bundle.maintainer,
    decisionRationale: candidate.decision?.rationale ?? plan.rootCause,
    ecosystem,
    ...(workdir.ok && workdir.relative ? { workingDirectory: workdir.relative } : {}),
  };

  const filePaths = [
    ...new Set([...revision.filesChanged, ...revision.testsAdded, ...plan.changes.map((change) => change.file), ...plan.testsToAdd.map((test) => test.file)]),
  ];
  const fileContents = await readWorkspaceFiles(workspace, filePaths, {
    maxFiles: 16,
    maxTotalBytes: 160_000,
    maxFileBytes: 80_000,
  });
  if (fileContents.missing.length > 0) {
    await recordEvent(db, {
      eventType: 'review_context_incomplete',
      reason: `files in the revision are not readable at the committed workspace: ${fileContents.missing.join(', ')}`,
      projectId: project.id,
      candidateId: candidate.id,
      contributionId,
      actorKind: 'SYSTEM',
      actor: 'review',
    });
  }

  const testRuns = await db.testRun.findMany({
    where: { contributionId, revisionIndex: revision.index },
    orderBy: { createdAt: 'asc' },
  });

  const round = contribution.reviewRound + 1;
  const ctx = createAgentContext(db);
  const outputs: ReviewedChange[] = [];
  let costUsd = 0;
  let llmTokens = 0;

  for (const reviewer of REVIEWERS) {
    const existing = await db.review.findUnique({
      where: {
        contributionId_revisionIndex_reviewer_round: {
          contributionId,
          revisionIndex: revision.index,
          reviewer,
          round,
        },
      },
    });
    if (existing) {
      const findings = findingsSchema.safeParse(existing.findingsJson);
      if (findings.success) {
        outputs.push({
          reviewer,
          output: {
            verdict: existing.verdict,
            summary: `reused recorded ${existing.verdict} review`,
            findings: findings.data,
            verifiedClaims: [],
            questions: [],
          },
        });
        continue;
      }
      await db.review.delete({ where: { id: existing.id } }).catch(() => undefined);
    }

    const outcome = await reviewChange(ctx, {
      reviewer,
      evidence,
      plan,
      revisionIndex: revision.index,
      diff: revision.diff,
      files: fileContents.files,
      testRuns: testRuns.map((run) => ({
        command: run.command,
        status: run.status,
        outputTail: run.outputTail,
      })),
      candidateId: candidate.id,
      contributionId,
    });
    costUsd += outcome.costUsd;
    llmTokens += outcome.promptTokens + outcome.completionTokens;

    const blockingCount = outcome.output.findings.filter(isBlockingFinding).length;

    await db.review.upsert({
      where: {
        contributionId_revisionIndex_reviewer_round: {
          contributionId,
          revisionIndex: revision.index,
          reviewer,
          round,
        },
      },
      create: {
        contributionId,
        revisionIndex: revision.index,
        round,
        reviewer,
        verdict: outcome.output.verdict,
        findingsJson: outcome.output.findings as unknown as Prisma.InputJsonValue,
        blockingCount,
        model: outcome.model,
        costUsd: outcome.costUsd,
        inputHash: hashObject({
          revisionIndex: revision.index,
          reviewer,
          round,
          promptVersion: REVIEW_PROMPT_VERSION,
          diffHash: revision.diffHash,
        }),
      },
      update: {
        verdict: outcome.output.verdict,
        findingsJson: outcome.output.findings as unknown as Prisma.InputJsonValue,
        blockingCount,
        model: outcome.model,
        costUsd: outcome.costUsd,
      },
    });
    outputs.push({ reviewer, output: outcome.output });
  }

  const aggregation = aggregateReviews(outputs);
  await recordEvent(db, {
    eventType: 'review_completed',
    reason: `${aggregation.verdict} for revision ${revision.index}: ${aggregation.rationale.slice(0, 400)}`,
    projectId: project.id,
    candidateId: candidate.id,
    contributionId,
    actorKind: 'AGENT',
    actor: 'review-aggregator',
    evidence: {
      round,
      revisionIndex: revision.index,
      verdicts: outputs.map((entry) => ({ reviewer: entry.reviewer, verdict: entry.output.verdict })),
      blocking: aggregation.blocking.map((entry) => ({
        reviewer: entry.reviewer,
        kind: entry.finding.kind,
        severity: entry.finding.severity,
        file: entry.finding.file ?? null,
      })),
      costUsd: Number(costUsd.toFixed(6)),
    },
  });

  if (aggregation.verdict === 'APPROVE' || aggregation.verdict === 'APPROVE_WITH_NOTES') {
    await transitionContribution(db, {
      contributionId,
      projectId: project.id,
      candidateId: candidate.id,
      fromState: contribution.state,
      toState: 'READY_FOR_SUBMISSION',
      reason: `review ${aggregation.verdict}: ${aggregation.rationale}`,
      actor: 'review-aggregator',
      data: {
        reviewRound: round,
        blockedReason: null,
        costUsd: { increment: costUsd },
        llmTokens: { increment: llmTokens },
      },
    });
    log.info('review approved', { contributionId, revisionIndex: revision.index, round, costUsd });
    return {
      contributionId,
      status: 'approved',
      revisionIndex: revision.index,
      round,
      verdict: aggregation.verdict,
      note: aggregation.rationale,
      costUsd,
    };
  }

  // `round` counts reviews, not implementation attempts: failed sandbox runs
  // produce revisions without consuming the review-revision budget.
  if (round > env.MAX_REVISION_ROUNDS) {
    const reason = `reviewers blocked revision ${revision.index} and the revision cap (${env.MAX_REVISION_ROUNDS}) is reached: ${aggregation.rationale}`;
    await transitionContribution(db, {
      contributionId,
      projectId: project.id,
      candidateId: candidate.id,
      fromState: contribution.state,
      toState: 'FAILED',
      reason,
      actor: 'review-aggregator',
      data: {
        reviewRound: round,
        blockedReason: reason.slice(0, 2000),
        costUsd: { increment: costUsd },
        llmTokens: { increment: llmTokens },
      },
    });
    return {
      contributionId,
      status: 'revision-required',
      revisionIndex: revision.index,
      round,
      verdict: aggregation.verdict,
      note: reason,
      costUsd,
    };
  }

  const brief = revisionBrief(aggregation);
  await transitionContribution(db, {
    contributionId,
    projectId: project.id,
    candidateId: candidate.id,
    fromState: contribution.state,
    toState: 'REVISION_REQUIRED',
    reason: `${aggregation.verdict}: ${aggregation.rationale}`,
    actor: 'review-aggregator',
    data: {
      reviewRound: round,
      blockedReason: brief.slice(0, 2000),
      costUsd: { increment: costUsd },
      llmTokens: { increment: llmTokens },
    },
  });
  await enqueue(db, {
    kind: 'IMPLEMENT_CONTRIBUTION',
    dedupeKey: `implement:${candidate.id}:revision:${revision.index + 1}`,
    payload: { candidateId: candidate.id, revisionContext: brief },
    priority: 50,
    projectId: project.id,
    contributionId,
  });

  log.info('review requested changes', { contributionId, revisionIndex: revision.index, round, costUsd });
  return {
    contributionId,
    status: 'revision-required',
    revisionIndex: revision.index,
    round,
    verdict: aggregation.verdict,
    note: brief.slice(0, 600),
    costUsd,
  };
}

import type { Db } from '@/db/client';
import { loadEnv } from '@/config/env';
import { createLogger } from '@/lib/logger';
import { hashObject } from '@/lib/canonical';
import type { Prisma } from '@/generated/prisma/client';
import { GitHubClient, GitHubRateLimitError } from '@/github/client';
import {
  fetchFileText,
  fetchIssueComments,
  fetchTree,
  splitFullName,
  type CommentSummary,
  type IssueSummary,
  type RepoDigest,
} from '@/github/repo';
import type { ProjectAnalysis } from '@/domain/schemas';
import { triageIssues } from '@/analysis/triage';
import { generateHypotheses, planHypotheses } from '@/agents/hypothesis';
import { createAgentContext } from '@/agents/runner';
import { boundText } from '@/llm/context';
import { recordEvent, recordSecurityEvent } from '@/workflow/events';
import { enqueue } from '@/workflow/queue';

const log = createLogger('hypotheses');

export interface GenerateResult {
  projectId: string;
  status: 'generated' | 'no-analysis' | 'no-digest' | 'rate-limited' | 'nothing-found';
  candidatesCreated: number;
  hypothesesProposed: number;
  hypothesesRejectedUnverifiable: number;
  costUsd: number;
  titles: string[];
}

/**
 * Turn a repository profile into candidate issues.
 *
 * The expensive part (reading code) is bounded deliberately: a plan picks a
 * handful of files, those files are read at the analyzed commit, and the
 * generator only ever sees what was actually fetched. Paths the model invents
 * are filtered against the real tree before anything is persisted.
 */
export async function generateCandidatesForProject(
  db: Db,
  client: GitHubClient,
  projectId: string,
): Promise<GenerateResult> {
  const env = loadEnv();
  const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
  if (!project.analysisJson || !project.analysisHeadSha) {
    return {
      projectId,
      status: 'no-analysis',
      candidatesCreated: 0,
      hypothesesProposed: 0,
      hypothesesRejectedUnverifiable: 0,
      costUsd: 0,
      titles: [],
    };
  }

  const digestRow = await db.repoDigest.findUnique({
    where: { projectId_headSha: { projectId, headSha: project.analysisHeadSha } },
  });
  if (!digestRow) {
    return {
      projectId,
      status: 'no-digest',
      candidatesCreated: 0,
      hypothesesProposed: 0,
      hypothesesRejectedUnverifiable: 0,
      costUsd: 0,
      titles: [],
    };
  }

  const digest = digestRow.json as unknown as RepoDigest;
  const analysis = project.analysisJson as unknown as ProjectAnalysis;
  const ref = splitFullName(project.fullName);
  const headSha = project.analysisHeadSha;
  const ctx = createAgentContext(db);
  let costUsd = 0;

  const issueCandidates = triageIssues(digest.issues);

  const plan = await planHypotheses(ctx, {
    projectId,
    digest,
    analysis,
    issueCandidates,
    taskRef: `plan:${projectId}`,
  });
  costUsd += plan.costUsd;

  // Validate plan file paths against the real tree. This is both a quality
  // guard (no invented paths) and the thing that keeps fetching cheap.
  let treePaths = new Set<string>();
  try {
    const { entries } = await fetchTree(client, ref, headSha);
    treePaths = new Set(
      entries.filter((entry) => entry.type === 'blob').map((entry) => entry.path),
    );
  } catch (error) {
    if (error instanceof GitHubRateLimitError) {
      return {
        projectId,
        status: 'rate-limited',
        candidatesCreated: 0,
        hypothesesProposed: 0,
        hypothesesRejectedUnverifiable: 0,
        costUsd,
        titles: [],
      };
    }
    throw error;
  }

  const requestedFiles = plan.output.filesToInspect.filter((path) => treePaths.has(path));
  const unknownPaths = plan.output.filesToInspect.filter((path) => !treePaths.has(path));
  if (unknownPaths.length > 0) {
    await recordEvent(db, {
      eventType: 'agent_path_hallucination_filtered',
      reason: `${unknownPaths.length} planned file path(s) do not exist in the repository tree and were dropped`,
      projectId,
      actorKind: 'AGENT',
      actor: 'hypothesis-planner',
      evidence: { unknownPaths },
    });
  }

  const files: Array<{ path: string; text: string }> = [];
  let usedBytes = 0;
  const fileBudget = Math.min(env.ANALYSIS_MAX_CONTEXT_BYTES, 80_000);
  for (const path of requestedFiles) {
    if (usedBytes >= fileBudget) break;
    const text = await fetchFileText(client, ref, path, headSha);
    if (!text) continue;
    const bounded = boundText(text, Math.min(24_000, fileBudget - usedBytes));
    usedBytes += Buffer.byteLength(bounded.text, 'utf8');
    files.push({ path, text: bounded.text });
  }

  const issueThreads: Array<{ issue: IssueSummary; comments: CommentSummary[] }> = [];
  for (const issueNumber of plan.output.issueNumbers.slice(0, 4)) {
    const issue = digest.issues.find((candidate) => candidate.number === issueNumber);
    if (!issue) continue;
    const comments = await fetchIssueComments(client, ref, issueNumber, 30).catch(() => []);
    issueThreads.push({
      issue: {
        number: issue.number,
        title: issue.title,
        bodyExcerpt: issue.bodyExcerpt,
        labels: issue.labels,
        state: issue.state,
        authorLogin: issue.authorLogin,
        assignees: issue.assignees,
        comments: issue.comments,
        createdAt: new Date(issue.createdAt),
        updatedAt: new Date(issue.updatedAt),
        url: issue.url,
      },
      comments,
    });
  }

  const existing = await db.candidate.findMany({
    where: { projectId },
    select: { title: true, fingerprint: true, status: true },
  });

  const generation = await generateHypotheses(ctx, {
    projectId,
    digest,
    analysis,
    plan: plan.output,
    files,
    issueThreads,
    knownCandidates: existing.map((candidate) => candidate.title),
    taskRef: `generate:${projectId}`,
  });
  costUsd += generation.costUsd;

  const slots = Math.max(
    0,
    env.CANDIDATE_MAX_PER_PROJECT - existing.filter((c) => c.status !== 'REJECTED').length,
  );
  let created = 0;
  let rejectedUnverifiable = 0;
  const titles: string[] = [];
  const knownFingerprints = new Set(existing.map((candidate) => candidate.fingerprint));
  const seenInThisRun = new Set<string>();

  for (const hypothesis of generation.output.hypotheses) {
    if (created >= slots) break;

    const knownFiles = hypothesis.files.filter((path) => treePaths.has(path));
    if (hypothesis.files.length > 0 && knownFiles.length === 0) {
      // Every file the hypothesis points at is fiction. Do not create a
      // candidate from it, and record that the check fired.
      rejectedUnverifiable += 1;
      continue;
    }

    const fingerprint = hashObject({
      title: normalizeTitle(hypothesis.title),
      files: [...knownFiles].sort(),
    });
    if (knownFingerprints.has(fingerprint) || seenInThisRun.has(fingerprint)) continue;
    seenInThisRun.add(fingerprint);

    const candidate = await db.candidate.create({
      data: {
        projectId,
        title: hypothesis.title,
        summary: hypothesis.summary,
        origin: hypothesis.origin,
        originIssueNumber: hypothesis.originIssueNumber ?? null,
        originIssueUrl: hypothesis.originIssueNumber
          ? `https://github.com/${project.fullName}/issues/${hypothesis.originIssueNumber}`
          : null,
        files: knownFiles,
        fingerprint,
        severity: hypothesis.severity,
        analysisHeadSha: headSha,
        status: 'PROPOSED',
        statusReason: `hypothesis from ${hypothesis.origin.toLowerCase().replace(/_/g, ' ')} at ${headSha.slice(0, 12)}`,
      },
    });
    created += 1;
    titles.push(hypothesis.title);

    await db.investigation.create({
      data: {
        candidateId: candidate.id,
        kind: 'HYPOTHESIS',
        agent: 'hypothesis-generator',
        model: generation.model,
        inputHash: hashObject({ projectId, fingerprint, sha: headSha }).slice(0, 64),
        verdict: 'SUPPORTS',
        confidence: hypothesis.confidence,
        outputJson: hypothesis as unknown as Prisma.InputJsonValue,
        rationale: `${hypothesis.claimedBehavior.slice(0, 200)}`,
        costUsd: 0,
        cacheHit: generation.cacheHit,
      },
    });

    await recordEvent(db, {
      eventType: 'candidate_proposed',
      reason: `candidate proposed from ${hypothesis.origin}: ${hypothesis.summary.slice(0, 200)}`,
      projectId,
      candidateId: candidate.id,
      actorKind: 'AGENT',
      actor: 'hypothesis-generator',
      evidence: {
        files: knownFiles,
        severity: hypothesis.severity,
        confidence: hypothesis.confidence,
        evidence: hypothesis.evidence as unknown as Prisma.InputJsonValue,
        openQuestions: hypothesis.openQuestions,
      },
    });

    await enqueue(db, {
      kind: 'INVESTIGATE_CANDIDATE',
      dedupeKey: `investigate:${candidate.id}`,
      payload: { candidateId: candidate.id },
      priority: 60,
      projectId,
    });
  }

  await recordEvent(db, {
    eventType: 'hypotheses_generated',
    reason: `${created} candidate(s) created from ${generation.output.hypotheses.length} hypothesis(es) for $${costUsd.toFixed(4)}`,
    projectId,
    actorKind: 'AGENT',
    actor: 'hypothesis-generator',
    evidence: {
      proposed: generation.output.hypotheses.length,
      created,
      rejectedUnverifiable,
      consideredAndRejected: generation.output.consideredAndRejected,
      costUsd,
      plan: plan.output.issueNumbers,
    },
  });

  if (rejectedUnverifiable > 0) {
    await recordSecurityEvent(db, {
      reason: 'hypotheses referenced files that do not exist in the repository',
      detail: `${rejectedUnverifiable} hypothesis(es) dropped because none of the referenced paths exist at ${headSha.slice(0, 12)}`,
      projectId,
    });
  }

  log.info('candidates generated', {
    projectId,
    created,
    costUsd,
    proposed: generation.output.hypotheses.length,
  });

  return {
    projectId,
    status: created > 0 ? 'generated' : 'nothing-found',
    candidatesCreated: created,
    hypothesesProposed: generation.output.hypotheses.length,
    hypothesesRejectedUnverifiable: rejectedUnverifiable,
    costUsd,
    titles,
  };
}

/** Titles differ only by case, spacing, or punctuation far more often than they should. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

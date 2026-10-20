import type { Db } from '@/db/client';
import type { Prisma } from '@/generated/prisma/client';
import type {
  ApprovalAction,
  ContributionState,
} from '@/generated/prisma/enums';
import type { Env } from '@/config/env';
import { llmConfigured, loadEnv } from '@/config/env';
import { sha256 } from '@/lib/canonical';
import { createLogger } from '@/lib/logger';
import { createAgentContext } from '@/agents/runner';
import {
  fallbackNarrative,
  validateNarrative,
  writePrNarrative,
  type PrNarrativeInput,
} from '@/agents/prNarrative';
import type { PrNarrative, SolutionPlan } from '@/domain/schemas';
import { solutionPlanSchema } from '@/domain/schemas';
import { loadEvidence } from '@/workflows/evidence';
import { recordEvent } from '@/workflow/events';
import { TaskBlockedError } from '@/workflow/errors';
import { transitionContribution } from '@/workflows/transitions';
import { GitHubClient } from '@/github/client';
import { ecosystemForInvestigation } from '@/sandbox/policy';
import {
  approvalExpired,
  requiredSubmissionActions,
  submissionArtifact,
  type SubmissionContext,
} from '@/workflows/submission-policy';

const log = createLogger('approval');

export interface PreparedSubmission {
  version: 1;
  preparedAt: string;
  forkOwner: string;
  narrative: PrNarrative;
  prTitle: string;
  prBody: string;
  prBodyHash: string;
  testsPerformed: string[];
  issueReferences: string[];
  actions: ApprovalAction[];
  artifactHashes: Partial<Record<ApprovalAction, string>>;
  narrativeSource: 'model' | 'fallback';
  narrativeProblems: string[];
}

export interface SubmissionApprovalView {
  id: string;
  action: ApprovalAction;
  status: string;
  artifactHash: string;
  expiresAt: Date | null;
  decidedBy: string | null;
  note: string | null;
}

export interface PrepareSubmissionResult {
  contributionId: string;
  state: ContributionState;
  actions: ApprovalAction[];
  artifactHashes: Partial<Record<ApprovalAction, string>>;
  approvals: SubmissionApprovalView[];
  readyToPublish: boolean;
  prTitle: string;
  prBody: string;
  warnings: string[];
}

export interface PrepareSubmissionOptions {
  env?: Env;
  /** Injected in tests and by callers that already resolved the fork owner. */
  forkOwner?: string;
  /** Suppress the model call and use the deterministic narrative. */
  deterministicNarrative?: boolean;
}

function parsePlan(planJson: Prisma.JsonValue | null): SolutionPlan {
  const parsed = solutionPlanSchema.safeParse(planJson);
  if (!parsed.success) {
    throw new TaskBlockedError(
      'the contribution has no valid implementation plan; re-run implementation before preparing a submission',
    );
  }
  return parsed.data;
}

function renderPrBody(args: {
  narrative: PrNarrative;
  testRuns: Array<{ command: string; status: string }>;
  docsOnly: boolean;
  featureRequest: boolean;
}): string {
  const sections = [args.narrative.prBody.trim(), '', '## Verification'];
  if (args.testRuns.length > 0) {
    sections.push(
      ...args.testRuns.map(
        (run) => `- \`${run.command.replace(/`/g, '\\`')}\` — ${run.status}`,
      ),
    );
  } else if (args.docsOnly) {
    sections.push('- Documentation-only change; no executable verification applies.');
  } else {
    sections.push('- No verification commands were recorded.');
  }

  if (args.narrative.limitations.length > 0) {
    sections.push('', '## Limitations');
    sections.push(...args.narrative.limitations.map((item) => `- ${item}`));
  }

  if (args.narrative.issueReferences.length > 0) {
    sections.push(
      '',
      `${args.featureRequest ? 'Refs' : 'Fixes'} ${args.narrative.issueReferences.join(', ')}`,
    );
  }

  sections.push(
    '',
    '---',
    '_Prepared by an automated contribution agent. The commands above were run in an isolated sandbox; no maintainer reviewed this change before submission._',
  );
  return sections.join('\n').trim();
}

async function resolveForkOwner(
  db: Db,
  env: Env,
  contributionId: string,
  explicit?: string,
): Promise<string> {
  if (explicit) return explicit;
  if (env.GITHUB_FORK_OWNER) return env.GITHUB_FORK_OWNER;
  if (!env.GITHUB_TOKEN) {
    throw new TaskBlockedError(
      'GITHUB_FORK_OWNER or GITHUB_TOKEN is required to bind a submission to a fork',
    );
  }
  const viewer = await GitHubClient.fromEnv(env).viewer();
  await recordEvent(db, {
    eventType: 'fork_owner_resolved',
    reason: `using the authenticated GitHub account ${viewer.login} as the fork owner`,
    contributionId,
    actorKind: 'SYSTEM',
    actor: 'github',
  });
  return viewer.login;
}

/**
 * Build the exact text and hashes a human will approve.
 *
 * This is the only place that writes a PR narrative. Publishing never asks a
 * model for text: it reads the persisted `submissionJson`, so the approved body
 * cannot drift between approval and submission.
 */
export async function prepareSubmission(
  db: Db,
  contributionId: string,
  options: PrepareSubmissionOptions = {},
): Promise<PrepareSubmissionResult> {
  const env = options.env ?? loadEnv();
  const contribution = await db.contribution.findUnique({
    where: { id: contributionId },
    include: {
      project: true,
      candidate: true,
      revisions: { orderBy: { index: 'desc' }, take: 1 },
      testRuns: { orderBy: { createdAt: 'desc' }, take: 30 },
      pullRequests: { orderBy: { openedAt: 'desc' }, take: 3 },
    },
  });
  if (!contribution) throw new TaskBlockedError(`contribution ${contributionId} not found`);
  if (!['READY_FOR_SUBMISSION', 'HUMAN_APPROVAL'].includes(contribution.state)) {
    throw new TaskBlockedError(
      `contribution is in state ${contribution.state}; only a reviewed contribution ready for submission can be prepared`,
    );
  }
  if (!contribution.headSha || !contribution.branchName || !contribution.baseSha || !contribution.diffHash) {
    throw new TaskBlockedError(
      'the contribution is missing its branch, head commit, base commit, or diff hash',
    );
  }
  const revision = contribution.revisions[0];
  if (!revision) throw new TaskBlockedError('the contribution has no implemented revision');

  const openPull = contribution.pullRequests.find((pull) => pull.state === 'OPEN') ?? null;
  if (contribution.pullRequests.length > 0 && !openPull) {
    throw new TaskBlockedError(
      'the contribution has a closed or merged pull request; it cannot be published again',
    );
  }

  const actions = requiredSubmissionActions({
    hasPullRequest: openPull !== null,
    publishedDiffHash: openPull?.publishedDiffHash ?? null,
    currentDiffHash: contribution.diffHash,
  });
  if (actions.length === 0) {
    throw new TaskBlockedError(
      `the current diff ${contribution.diffHash.slice(0, 12)} is already published`,
    );
  }

  const forkOwner = await resolveForkOwner(db, env, contributionId, options.forkOwner);
  const testRuns = contribution.testRuns
    .filter((run) => run.revisionIndex === revision.index)
    .map((run) => ({ command: run.command, status: run.status }));
  const docsOnly = revision.filesChanged.every((file) => /\.(md|mdx|rst|txt)$/i.test(file));

  let narrative: PrNarrative;
  let narrativeSource: 'model' | 'fallback' = 'fallback';
  let narrativeProblems: string[] = [];

  if (openPull) {
    // A revision keeps the reviewed PR text. Only the branch and commit change,
    // and those are separately approved as PUSH_REVISION.
    narrative = {
      commitSubject: '',
      commitBody: '',
      prTitle: openPull.titleUsed,
      prBody: '',
      testsPerformed: testRuns.map((run) => run.command),
      issueReferences: [],
      limitations: [],
    };
  } else {
    const plan = parsePlan(contribution.planJson);
    const evidenceBundle = await loadEvidence(db, contribution.candidateId, contribution.candidate.title);
    if (!evidenceBundle.hypothesis) {
      throw new TaskBlockedError('the hypothesis behind this contribution is no longer available');
    }
    const featureRequest = /^(add|support|implement|introduce|allow|enable)\b/i.test(
      evidenceBundle.hypothesis.title,
    );
    const allowedIssueNumbers =
      contribution.candidate.origin === 'EXISTING_ISSUE' &&
      typeof contribution.candidate.originIssueNumber === 'number'
        ? [contribution.candidate.originIssueNumber]
        : [];
    const digestRow = await db.repoDigest.findUnique({
      where: {
        projectId_headSha: { projectId: contribution.projectId, headSha: contribution.baseSha },
      },
    });
    if (!digestRow) {
      throw new TaskBlockedError(
        `no repository digest for ${contribution.project.fullName} at ${contribution.baseSha.slice(0, 12)}; rebuild it before preparing a submission`,
      );
    }
    const evidence: PrNarrativeInput['evidence'] = {
      digest: digestRow.json as unknown as PrNarrativeInput['evidence']['digest'],
      hypothesis: evidenceBundle.hypothesis,
      validation: evidenceBundle.validation,
      reproduction: evidenceBundle.reproduction,
      duplicate: evidenceBundle.duplicate,
      maintainer: evidenceBundle.maintainer,
      decisionRationale: contribution.stateReason ?? 'approved by the investigation decision',
      ecosystem: ecosystemForInvestigation(
        [...contribution.candidate.files, ...evidenceBundle.hypothesis.files],
        (digestRow.json as unknown as PrNarrativeInput['evidence']['digest']).repo.language,
        (digestRow.json as unknown as PrNarrativeInput['evidence']['digest']).tree.manifests,
      ),
    };

    const narrativeInput: PrNarrativeInput = {
      evidence,
      plan,
      revision: {
        index: revision.index,
        summary: revision.summary,
        rootCause: revision.rootCause,
        filesChanged: revision.filesChanged,
        testsAdded: revision.testsAdded,
      },
      diff: revision.diff,
      testRuns,
      allowedIssueNumbers,
      featureRequest,
    };

    let generated: PrNarrative | null = null;
    if (!options.deterministicNarrative && llmConfigured(env)) {
      try {
        const outcome = await writePrNarrative(createAgentContext(db), {
          ...narrativeInput,
          candidateId: contribution.candidateId,
          contributionId,
        });
        const validated = validateNarrative(outcome.output, narrativeInput);
        narrativeProblems = validated.problems;
        // Reject the whole draft when it made an unsupported claim. A plain but
        // true description is better than a polished one that invents evidence.
        if (validated.problems.length === 0) {
          generated = validated.narrative;
          narrativeSource = 'model';
        } else {
          await recordEvent(db, {
            eventType: 'pr_narrative_rejected',
            reason: `the drafted PR narrative made unsupported claims: ${validated.problems.join('; ')}`,
            projectId: contribution.projectId,
            candidateId: contribution.candidateId,
            contributionId,
            actorKind: 'AGENT',
            actor: 'pr-narrative',
            evidence: { problems: validated.problems },
          });
        }
      } catch (error) {
        narrativeProblems = [
          `narrative generation failed: ${error instanceof Error ? error.message : String(error)}`,
        ];
        log.warn('PR narrative generation failed; using the deterministic fallback', {
          contributionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    narrative = generated ?? fallbackNarrative(narrativeInput);
    if (!generated) {
      narrativeSource = 'fallback';
      narrative = {
        ...narrative,
        testsPerformed: testRuns.map((run) => run.command),
        issueReferences: narrative.issueReferences.filter((reference) =>
          allowedIssueNumbers.some((number) => reference === `#${number}`),
        ),
      };
    }

    // Stash the feature-request flag in the narrative's issue semantics by
    // keeping it in sync with the rendered body below.
    const prBody = renderPrBody({ narrative, testRuns, docsOnly, featureRequest });
    const prBodyHash = sha256(prBody);
    const context: SubmissionContext = {
      contributionId,
      repoFullName: contribution.project.fullName,
      forkOwner,
      branchName: contribution.branchName,
      baseRef: contribution.baseRef ?? contribution.project.defaultBranch,
      baseSha: contribution.baseSha,
      headSha: contribution.headSha,
      diffHash: contribution.diffHash,
      prNumber: null,
      prTitle: narrative.prTitle,
      prBodyHash,
    };
    const artifactHashes = Object.fromEntries(
      actions.map((action) => [action, submissionArtifact(action, context)]),
    ) as Partial<Record<ApprovalAction, string>>;
    const prepared: PreparedSubmission = {
      version: 1,
      preparedAt: new Date().toISOString(),
      forkOwner,
      narrative,
      prTitle: narrative.prTitle,
      prBody,
      prBodyHash,
      testsPerformed: narrative.testsPerformed,
      issueReferences: narrative.issueReferences,
      actions,
      artifactHashes,
      narrativeSource,
      narrativeProblems,
    };

    await db.contribution.update({
      where: { id: contributionId },
      data: { submissionJson: prepared as unknown as Prisma.InputJsonValue },
    });

    const approvals = await ensureApprovals(db, {
      contribution,
      actions,
      artifactHashes,
      env,
    });

    if (contribution.state === 'READY_FOR_SUBMISSION') {
      await transitionContribution(db, {
        contributionId,
        projectId: contribution.projectId,
        candidateId: contribution.candidateId,
        fromState: contribution.state,
        toState: 'HUMAN_APPROVAL',
        reason: `submission prepared for human approval: ${actions.join(', ')} (head ${contribution.headSha.slice(0, 12)})`,
        actorKind: 'SYSTEM',
        actor: 'approval',
      });
    } else {
      await recordEvent(db, {
        eventType: 'submission_prepared',
        reason: `submission re-prepared: ${actions.join(', ')} (head ${contribution.headSha.slice(0, 12)})`,
        projectId: contribution.projectId,
        candidateId: contribution.candidateId,
        contributionId,
        actorKind: 'SYSTEM',
        actor: 'approval',
        evidence: { artifactHashes },
      });
    }

    return {
      contributionId,
      state: 'HUMAN_APPROVAL',
      actions,
      artifactHashes,
      approvals,
      readyToPublish: approvals.every((approval) => approval.status === 'GRANTED'),
      prTitle: prepared.prTitle,
      prBody: prepared.prBody,
      warnings: prepared.narrativeProblems,
    };
  }

  // Revisions: the PR text is unchanged, and the only external act is a force
  // push of the new head commit to the same branch.
  const current = (contribution.submissionJson as unknown as PreparedSubmission | null) ?? null;
  const prBodyHash = current?.prBodyHash ?? openPull!.bodyHash;
  const context: SubmissionContext = {
    contributionId,
    repoFullName: contribution.project.fullName,
    forkOwner,
    branchName: contribution.branchName,
    baseRef: contribution.baseRef ?? contribution.project.defaultBranch,
    baseSha: contribution.baseSha,
    headSha: contribution.headSha,
    diffHash: contribution.diffHash,
    prNumber: openPull!.number,
    prTitle: openPull!.titleUsed,
    prBodyHash,
  };
  const artifactHashes = Object.fromEntries(
    actions.map((action) => [action, submissionArtifact(action, context)]),
  ) as Partial<Record<ApprovalAction, string>>;
  const prepared: PreparedSubmission = {
    version: 1,
    preparedAt: new Date().toISOString(),
    forkOwner,
    narrative: {
      commitSubject: '',
      commitBody: '',
      prTitle: openPull!.titleUsed,
      prBody: '',
      testsPerformed: testRuns.map((run) => run.command),
      issueReferences: [],
      limitations: [],
    },
    prTitle: openPull!.titleUsed,
    prBody: current?.prBody ?? '',
    prBodyHash,
    testsPerformed: testRuns.map((run) => run.command),
    issueReferences: [],
    actions,
    artifactHashes,
    narrativeSource: current?.narrativeSource ?? 'fallback',
    narrativeProblems: [],
  };
  await db.contribution.update({
    where: { id: contributionId },
    data: { submissionJson: prepared as unknown as Prisma.InputJsonValue },
  });
  const approvals = await ensureApprovals(db, { contribution, actions, artifactHashes, env });
  if (contribution.state === 'READY_FOR_SUBMISSION') {
    await transitionContribution(db, {
      contributionId,
      projectId: contribution.projectId,
      candidateId: contribution.candidateId,
      fromState: contribution.state,
      toState: 'HUMAN_APPROVAL',
      reason: `revision ${revision.index} prepared for human approval: PUSH_REVISION (head ${contribution.headSha.slice(0, 12)})`,
      actorKind: 'SYSTEM',
      actor: 'approval',
    });
  } else {
    await recordEvent(db, {
      eventType: 'submission_prepared',
      reason: `revision ${revision.index} re-prepared for approval: PUSH_REVISION`,
      projectId: contribution.projectId,
      candidateId: contribution.candidateId,
      contributionId,
      actorKind: 'SYSTEM',
      actor: 'approval',
      evidence: { artifactHashes },
    });
  }
  return {
    contributionId,
    state: 'HUMAN_APPROVAL',
    actions,
    artifactHashes,
    approvals,
    readyToPublish: approvals.every((approval) => approval.status === 'GRANTED'),
    prTitle: prepared.prTitle,
    prBody: prepared.prBody,
    warnings: [],
  };
}

interface EnsureApprovalsArgs {
  contribution: {
    id: string;
    projectId: string;
    candidateId: string;
  };
  actions: ApprovalAction[];
  artifactHashes: Partial<Record<ApprovalAction, string>>;
  env: Env;
}

async function ensureApprovals(
  db: Db,
  args: EnsureApprovalsArgs,
): Promise<SubmissionApprovalView[]> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + args.env.APPROVAL_TTL_HOURS * 3_600_000);
  const views: SubmissionApprovalView[] = [];

  for (const action of args.actions) {
    const artifactHash = args.artifactHashes[action];
    if (!artifactHash) continue;

    // Only the newest artifact for an action may be approved. Older grants can
    // never be replayed against a different branch or diff.
    await db.approval.updateMany({
      where: {
        contributionId: args.contribution.id,
        action,
        artifactHash: { not: artifactHash },
        status: { in: ['PENDING', 'GRANTED'] },
      },
      data: {
        status: 'REVOKED',
        note: `superseded by artifact ${artifactHash.slice(0, 12)}`,
      },
    });

    const existing = await db.approval.findUnique({
      where: {
        contributionId_action_artifactHash: {
          contributionId: args.contribution.id,
          action,
          artifactHash,
        },
      },
    });

    let approval = existing;
    if (!approval) {
      approval = await db.approval.create({
        data: {
          contributionId: args.contribution.id,
          action,
          artifactHash,
          status: 'PENDING',
          requestedBy: 'orchestrator',
          expiresAt,
        },
      });
      await recordEvent(db, {
        eventType: 'approval_requested',
        reason: `${action} approval requested for artifact ${artifactHash.slice(0, 12)}`,
        projectId: args.contribution.projectId,
        candidateId: args.contribution.candidateId,
        contributionId: args.contribution.id,
        actorKind: 'SYSTEM',
        actor: 'approval',
        evidence: { action, artifactHash, expiresAt: expiresAt.toISOString() },
      });
    } else if (
      approval.status === 'EXPIRED' ||
      approval.status === 'CONSUMED' ||
      approval.status === 'REVOKED' ||
      ((approval.status === 'PENDING' || approval.status === 'GRANTED') &&
        approvalExpired(approval.expiresAt, now))
    ) {
      const priorStatus = approval.status;
      approval = await db.approval.update({
        where: { id: approval.id },
        data: {
          status: 'PENDING',
          decidedBy: null,
          decidedAt: null,
          consumedAt: null,
          expiresAt,
        },
      });
      await recordEvent(db, {
        eventType: 'approval_reopened',
        reason: `${action} approval reopened for artifact ${artifactHash.slice(0, 12)} (was ${priorStatus})`,
        projectId: args.contribution.projectId,
        candidateId: args.contribution.candidateId,
        contributionId: args.contribution.id,
        actorKind: 'SYSTEM',
        actor: 'approval',
        evidence: { action, artifactHash, expiresAt: expiresAt.toISOString() },
      });
    }

    views.push({
      id: approval.id,
      action: approval.action,
      status: approval.status,
      artifactHash: approval.artifactHash,
      expiresAt: approval.expiresAt,
      decidedBy: approval.decidedBy,
      note: approval.note,
    });
  }
  return views;
}

export async function listApprovals(db: Db, contributionId: string): Promise<SubmissionApprovalView[]> {
  const rows = await db.approval.findMany({
    where: { contributionId },
    orderBy: [{ requestedAt: 'desc' }],
  });
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    status: row.status,
    artifactHash: row.artifactHash,
    expiresAt: row.expiresAt,
    decidedBy: row.decidedBy,
    note: row.note,
  }));
}

/**
 * Record a human decision. The artifact hash is optional but, when supplied,
 * must match the pending approval exactly; that prevents approving a stale
 * request after a revision changed the plan.
 */
export async function decideApproval(
  db: Db,
  args: {
    contributionId: string;
    action: ApprovalAction;
    decision: 'GRANTED' | 'DENIED';
    decidedBy: string;
    artifactHash?: string;
    note?: string;
  },
): Promise<SubmissionApprovalView> {
  const contribution = await db.contribution.findUnique({
    where: { id: args.contributionId },
    select: { id: true, projectId: true, candidateId: true, state: true },
  });
  if (!contribution) throw new TaskBlockedError(`contribution ${args.contributionId} not found`);

  const approval = await db.approval.findFirst({
    where: {
      contributionId: args.contributionId,
      action: args.action,
      ...(args.artifactHash ? { artifactHash: args.artifactHash } : {}),
    },
    orderBy: { requestedAt: 'desc' },
  });
  if (!approval) {
    throw new TaskBlockedError(`no ${args.action} approval was requested for this contribution`);
  }
  if (args.artifactHash && approval.artifactHash !== args.artifactHash) {
    throw new TaskBlockedError(
      `approval hash ${args.artifactHash.slice(0, 12)} does not match the latest request ${approval.artifactHash.slice(0, 12)}`,
    );
  }
  if (approval.status !== 'PENDING') {
    throw new TaskBlockedError(`approval is ${approval.status}, not PENDING`);
  }
  if (approvalExpired(approval.expiresAt, new Date())) {
    await db.approval.update({ where: { id: approval.id }, data: { status: 'EXPIRED' } });
    throw new TaskBlockedError('approval expired; prepare the submission again');
  }

  const updated = await db.approval.update({
    where: { id: approval.id },
    data: {
      status: args.decision,
      decidedBy: args.decidedBy,
      decidedAt: new Date(),
      ...(args.note ? { note: args.note.slice(0, 1000) } : {}),
    },
  });
  await recordEvent(db, {
    eventType: args.decision === 'GRANTED' ? 'approval_granted' : 'approval_denied',
    reason: `${args.action} ${args.decision === 'GRANTED' ? 'approved' : 'denied'} by ${args.decidedBy} for artifact ${approval.artifactHash.slice(0, 12)}`,
    projectId: contribution.projectId,
    candidateId: contribution.candidateId,
    contributionId: contribution.id,
    actorKind: 'HUMAN',
    actor: args.decidedBy,
    evidence: {
      action: args.action,
      artifactHash: approval.artifactHash,
      note: args.note ?? null,
    },
  });
  return {
    id: updated.id,
    action: updated.action,
    status: updated.status,
    artifactHash: updated.artifactHash,
    expiresAt: updated.expiresAt,
    decidedBy: updated.decidedBy,
    note: updated.note,
  };
}

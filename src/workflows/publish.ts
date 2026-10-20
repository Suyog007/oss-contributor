import type { Db } from '@/db/client';
import type { ApprovalAction, ContributionState } from '@/generated/prisma/enums';
import { loadEnv, type Env } from '@/config/env';
import { createLogger } from '@/lib/logger';
import { recordEvent } from '@/workflow/events';
import { TaskBlockedError } from '@/workflow/errors';
import { transitionContribution } from '@/workflows/transitions';
import {
  approvalExpired,
  requiredSubmissionActions,
  submissionArtifact,
} from '@/workflows/submission-policy';
import { Workspace } from '@/workspace/manager';
import { GitHubClient, type GitHubPullRequest } from '@/github/client';
import type { PreparedSubmission } from '@/workflows/approval';

const log = createLogger('publish');

export interface PublishOptions {
  /** When false (the default), report what would happen and touch nothing. */
  execute?: boolean;
  env?: Env;
  github?: GitHubClient;
  now?: Date;
}

export type PublishStatus =
  | 'dry-run'
  | 'awaiting-approval'
  | 'branch-pushed'
  | 'already-published'
  | 'published';

export interface PublishResult {
  contributionId: string;
  status: PublishStatus;
  actions: ApprovalAction[];
  missingApprovals: ApprovalAction[];
  forkOwner: string;
  branchName: string;
  headSha: string;
  diffHash: string;
  pullRequest: { number: number; url: string } | null;
  note: string;
  warnings: string[];
}

/**
 * Publish a prepared submission.
 *
 * The function is deliberately paranoid:
 *  - it reads the prepared text instead of asking a model again, so the body a
 *    human approved is the body that is sent;
 *  - it recomputes every artifact hash from the current database state, so a
 *    changed diff invalidates the approval;
 *  - it verifies the workspace HEAD and changed-file set against the revision
 *    before any network write;
 *  - it never pushes without a GRANTED approval for the exact artifact.
 */
export async function publishContribution(
  db: Db,
  contributionId: string,
  options: PublishOptions = {},
): Promise<PublishResult> {
  const env = options.env ?? loadEnv();
  const execute = options.execute === true;
  const now = options.now ?? new Date();

  const contribution = await db.contribution.findUnique({
    where: { id: contributionId },
    include: {
      project: true,
      candidate: true,
      revisions: { orderBy: { index: 'desc' }, take: 1 },
      pullRequests: { orderBy: { openedAt: 'desc' }, take: 3 },
    },
  });
  if (!contribution) throw new TaskBlockedError(`contribution ${contributionId} not found`);
  if (
    !contribution.headSha ||
    !contribution.branchName ||
    !contribution.baseSha ||
    !contribution.diffHash
  ) {
    throw new TaskBlockedError('the contribution is missing its branch, head, base, or diff hash');
  }
  const revision = contribution.revisions[0];
  if (!revision) throw new TaskBlockedError('the contribution has no implemented revision');

  const openPull = contribution.pullRequests.find((pull) => pull.state === 'OPEN') ?? null;

  if (openPull && openPull.publishedDiffHash === contribution.diffHash) {
    return {
      contributionId,
      status: 'already-published',
      actions: [],
      missingApprovals: [],
      forkOwner: '',
      branchName: contribution.branchName,
      headSha: contribution.headSha,
      diffHash: contribution.diffHash,
      pullRequest: { number: openPull.number, url: openPull.url },
      note: `diff ${contribution.diffHash.slice(0, 12)} is already published as #${openPull.number}`,
      warnings: [],
    };
  }
  if (contribution.pullRequests.length > 0 && !openPull) {
    throw new TaskBlockedError(
      'the contribution has a closed or merged pull request; it cannot be published again',
    );
  }

  const submission = contribution.submissionJson as unknown as PreparedSubmission | null;
  if (!submission || submission.version !== 1) {
    throw new TaskBlockedError(
      `no prepared submission for ${contributionId}; run \`pnpm submit --contribution ${contributionId}\` first`,
    );
  }

  const required = requiredSubmissionActions({
    hasPullRequest: openPull !== null,
    publishedDiffHash: openPull?.publishedDiffHash ?? null,
    currentDiffHash: contribution.diffHash,
  });
  if (required.length === 0) {
    return {
      contributionId,
      status: 'already-published',
      actions: [],
      missingApprovals: [],
      forkOwner: submission.forkOwner,
      branchName: contribution.branchName,
      headSha: contribution.headSha,
      diffHash: contribution.diffHash,
      pullRequest: openPull ? { number: openPull.number, url: openPull.url } : null,
      note: 'the current diff is already published',
      warnings: [],
    };
  }

  const prBodyHash = openPull?.bodyHash ?? submission.prBodyHash;
  const context = {
    contributionId,
    repoFullName: contribution.project.fullName,
    forkOwner: submission.forkOwner,
    branchName: contribution.branchName,
    baseRef: contribution.baseRef ?? contribution.project.defaultBranch,
    baseSha: contribution.baseSha,
    headSha: contribution.headSha,
    diffHash: contribution.diffHash,
    prNumber: openPull?.number ?? null,
    prTitle: openPull?.titleUsed ?? submission.prTitle,
    prBodyHash,
  };
  const artifactHashes = Object.fromEntries(
    required.map((action) => [action, submissionArtifact(action, context)]),
  ) as Partial<Record<ApprovalAction, string>>;

  // A prepared submission can only be published while its stored hashes still
  // describe the current contribution. If they do not, the operator must
  // prepare and approve the new artifact instead of reusing an old decision.
  const stale = required.filter(
    (action) =>
      submission.actions.includes(action) &&
      submission.artifactHashes[action] !== undefined &&
      submission.artifactHashes[action] !== artifactHashes[action],
  );
  if (stale.length > 0) {
    throw new TaskBlockedError(
      `the prepared submission is stale for ${stale.join(', ')}; run \`pnpm submit --contribution ${contributionId}\` again and approve the new artifact`,
    );
  }

  const warnings: string[] = [];
  const github = options.github ?? (execute ? GitHubClient.fromEnv(env) : null);

  // Crash recovery: a previous attempt may have opened the PR after the last
  // database write. Adopt the remote PR before asking for new approvals.
  if (execute && !openPull && github) {
    const remote = await github.findPullRequest({
      owner: contribution.project.fullName.split('/')[0]!,
      repo: contribution.project.fullName.split('/')[1]!,
      head: `${submission.forkOwner}:${contribution.branchName}`,
      base: contribution.baseRef ?? contribution.project.defaultBranch,
    });
    if (remote && remote.head.sha === contribution.headSha) {
      const adopted = await recordPullRequest(db, {
        contribution,
        submission,
        revisionIndex: revision.index,
        remote,
        forkOwner: submission.forkOwner,
        now,
      });
      await markPublished(db, {
        contribution,
        revisionIndex: revision.index,
        headSha: contribution.headSha,
        now,
        reason: `recovered pull request #${remote.number} opened by an earlier attempt`,
      });
      return {
        contributionId,
        status: 'already-published',
        actions: [],
        missingApprovals: [],
        forkOwner: submission.forkOwner,
        branchName: contribution.branchName,
        headSha: contribution.headSha,
        diffHash: contribution.diffHash,
        pullRequest: { number: adopted.number, url: adopted.url },
        note: `adopted existing pull request #${adopted.number}`,
        warnings,
      };
    }
  }

  const approvalRows = await db.approval.findMany({
    where: {
      contributionId,
      action: { in: required },
      artifactHash: { in: Object.values(artifactHashes).filter((value): value is string => !!value) },
    },
  });
  const approved = new Map<ApprovalAction, string>();
  const expiredActions: ApprovalAction[] = [];
  for (const action of required) {
    const hash = artifactHashes[action];
    const row = approvalRows.find(
      (candidate) => candidate.action === action && candidate.artifactHash === hash,
    );
    if (!row || row.status !== 'GRANTED') continue;
    if (approvalExpired(row.expiresAt, now)) {
      expiredActions.push(action);
      await db.approval.update({ where: { id: row.id }, data: { status: 'EXPIRED' } });
      continue;
    }
    approved.set(action, row.id);
  }
  if (expiredActions.length > 0) {
    warnings.push(`approval expired for ${expiredActions.join(', ')}; prepare the submission again`);
  }
  const missing = required.filter((action) => !approved.has(action));

  if (!execute) {
    return {
      contributionId,
      status: missing.length > 0 ? 'awaiting-approval' : 'dry-run',
      actions: required,
      missingApprovals: missing,
      forkOwner: submission.forkOwner,
      branchName: contribution.branchName,
      headSha: contribution.headSha,
      diffHash: contribution.diffHash,
      pullRequest: openPull ? { number: openPull.number, url: openPull.url } : null,
      note:
        missing.length > 0
          ? `no external action was taken; still awaiting approval for ${missing.join(', ')}`
          : `no external action was taken; run again with --execute to publish ${required.join(', ')}`,
      warnings,
    };
  }

  const pushAction: ApprovalAction = openPull ? 'PUSH_REVISION' : 'PUBLISH_BRANCH';
  if (!approved.has(pushAction)) {
    return {
      contributionId,
      status: 'awaiting-approval',
      actions: required,
      missingApprovals: missing,
      forkOwner: submission.forkOwner,
      branchName: contribution.branchName,
      headSha: contribution.headSha,
      diffHash: contribution.diffHash,
      pullRequest: openPull ? { number: openPull.number, url: openPull.url } : null,
      note: `refusing to push: no GRANTED approval for ${pushAction}`,
      warnings,
    };
  }

  if (!github) throw new TaskBlockedError('a GitHub client is required to publish');

  // -------------------------------------------------------------------------
  // Verify the local artifact before touching the network.
  // -------------------------------------------------------------------------
  const workspace = Workspace.forContribution(
    db,
    {
      contributionId,
      projectId: contribution.projectId,
      fullName: contribution.project.fullName,
      defaultBranch: contribution.project.defaultBranch,
      baseSha: contribution.baseSha,
      branchName: contribution.branchName,
    },
    env,
  );

  const head = await workspace.headSha().catch((error) => {
    throw new TaskBlockedError(
      `the contribution workspace is not readable: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  if (head !== contribution.headSha) {
    throw new TaskBlockedError(
      `workspace HEAD ${head.slice(0, 12)} does not match the approved head ${contribution.headSha.slice(0, 12)}; refusing to publish`,
    );
  }
  if (await workspace.hasChanges()) {
    throw new TaskBlockedError(
      'the workspace has uncommitted changes; refusing to publish an artifact that differs from the approved revision',
    );
  }
  const changed = (await workspace.changedFilesBetween(contribution.baseSha, contribution.headSha)).sort();
  const expected = [...revision.filesChanged].sort();
  if (changed.join('\n') !== expected.join('\n')) {
    throw new TaskBlockedError(
      `the commit changes [${changed.join(', ') || 'nothing'}], but revision ${revision.index} recorded [${expected.join(', ')}]; refusing to publish`,
    );
  }

  // -------------------------------------------------------------------------
  // Branch
  // -------------------------------------------------------------------------
  const [, repoName] = contribution.project.fullName.split('/') as [string, string];
  const forkFullName = `${submission.forkOwner}/${repoName}`;
  const viewer = await github.viewer();
  const organization = submission.forkOwner === viewer.login ? undefined : submission.forkOwner;
  const fork = await github.ensureFork(contribution.project.fullName, submission.forkOwner, {
    ...(organization ? { organization } : {}),
  });
  if (fork.private) {
    throw new TaskBlockedError(`fork ${fork.full_name} is private; a public contribution needs a public fork`);
  }

  let remoteHead = await github.branchHead(forkFullName, contribution.branchName);
  if (remoteHead !== contribution.headSha) {
    await workspace.pushBranch({
      remote: 'fork',
      branch: contribution.branchName,
      force: remoteHead !== null,
      ...(remoteHead ? { expectedRemoteSha: remoteHead } : {}),
      forkOwner: submission.forkOwner,
    });
    remoteHead = await github.branchHead(forkFullName, contribution.branchName);
    if (remoteHead !== contribution.headSha) {
      throw new TaskBlockedError(
        `push completed but ${forkFullName}:${contribution.branchName} is at ${remoteHead?.slice(0, 12) ?? 'nothing'}, expected ${contribution.headSha.slice(0, 12)}`,
      );
    }
  }
  await recordEvent(db, {
    eventType: 'branch_published',
    reason: `pushed ${contribution.branchName} at ${contribution.headSha.slice(0, 12)} to ${forkFullName}`,
    projectId: contribution.projectId,
    candidateId: contribution.candidateId,
    contributionId,
    actorKind: 'AGENT',
    actor: 'publish',
    evidence: {
      fork: forkFullName,
      branch: contribution.branchName,
      headSha: contribution.headSha,
      diffHash: contribution.diffHash,
      artifactHash: artifactHashes.PUBLISH_BRANCH ?? artifactHashes.PUSH_REVISION,
    },
  });

  const publishedAt = new Date();

  if (openPull) {
    // Revision: the PR already exists. Update the recorded head only after the
    // push has been verified.
    if (!approved.has('PUSH_REVISION')) {
      return {
        contributionId,
        status: 'branch-pushed',
        actions: required,
        missingApprovals: required.filter((action) => !approved.has(action)),
        forkOwner: submission.forkOwner,
        branchName: contribution.branchName,
        headSha: contribution.headSha,
        diffHash: contribution.diffHash,
        pullRequest: { number: openPull.number, url: openPull.url },
        note: `revision pushed to ${forkFullName}:${contribution.branchName}; PUSH_REVISION approval is still required before the pull request is updated`,
        warnings,
      };
    }
    await db.pullRequest.update({
      where: { id: openPull.id },
      data: {
        headSha: contribution.headSha,
        publishedDiffHash: contribution.diffHash,
        lastSyncedAt: publishedAt,
      },
    });
    await consumeApprovals(db, [...approved.values()], publishedAt);
    await markPublished(db, {
      contribution,
      revisionIndex: revision.index,
      headSha: contribution.headSha,
      now: publishedAt,
      reason: `revision ${revision.index} pushed to pull request #${openPull.number}`,
    });
    await recordEvent(db, {
      eventType: 'revision_published',
      reason: `revision ${revision.index} pushed to #${openPull.number} (${forkFullName}:${contribution.branchName})`,
      projectId: contribution.projectId,
      candidateId: contribution.candidateId,
      contributionId,
      actorKind: 'AGENT',
      actor: 'publish',
      evidence: {
        prNumber: openPull.number,
        headSha: contribution.headSha,
        diffHash: contribution.diffHash,
        artifactHash: artifactHashes.PUSH_REVISION,
      },
    });
    log.info('revision published', { contributionId, prNumber: openPull.number });
    return {
      contributionId,
      status: 'published',
      actions: required,
      missingApprovals: [],
      forkOwner: submission.forkOwner,
      branchName: contribution.branchName,
      headSha: contribution.headSha,
      diffHash: contribution.diffHash,
      pullRequest: { number: openPull.number, url: openPull.url },
      note: `revision ${revision.index} published to #${openPull.number}`,
      warnings,
    };
  }

  // -------------------------------------------------------------------------
  // New pull request
  // -------------------------------------------------------------------------
  if (!approved.has('OPEN_PULL_REQUEST')) {
    return {
      contributionId,
      status: 'branch-pushed',
      actions: required,
      missingApprovals: required.filter((action) => !approved.has(action)),
      forkOwner: submission.forkOwner,
      branchName: contribution.branchName,
      headSha: contribution.headSha,
      diffHash: contribution.diffHash,
      pullRequest: null,
      note: `branch pushed to ${forkFullName}; OPEN_PULL_REQUEST approval is still required, so no pull request was opened`,
      warnings,
    };
  }

  if (!submission.prBody.trim()) {
    throw new TaskBlockedError('the prepared submission has no pull request body');
  }

  const remote = await github.createPullRequest({
    owner: contribution.project.fullName.split('/')[0]!,
    repo: repoName,
    title: submission.prTitle,
    body: submission.prBody,
    head: `${submission.forkOwner}:${contribution.branchName}`,
    base: contribution.baseRef ?? contribution.project.defaultBranch,
    draft: false,
  });
  if (remote.head.sha !== contribution.headSha) {
    throw new TaskBlockedError(
      `GitHub reports pull request head ${remote.head.sha.slice(0, 12)}, expected ${contribution.headSha.slice(0, 12)}; refusing to record it`,
    );
  }

  const record = await recordPullRequest(db, {
    contribution,
    submission,
    revisionIndex: revision.index,
    remote,
    forkOwner: submission.forkOwner,
    now: publishedAt,
  });
  await consumeApprovals(db, [...approved.values()], publishedAt);
  await markPublished(db, {
    contribution,
    revisionIndex: revision.index,
    headSha: contribution.headSha,
    now: publishedAt,
    reason: `pull request #${record.number} opened: ${record.url}`,
  });
  await recordEvent(db, {
    eventType: 'pull_request_opened',
    reason: `opened ${record.url} from ${forkFullName}:${contribution.branchName} into ${contribution.project.defaultBranch}`,
    projectId: contribution.projectId,
    candidateId: contribution.candidateId,
    contributionId,
    actorKind: 'AGENT',
    actor: 'publish',
    evidence: {
      prNumber: record.number,
      url: record.url,
      headSha: contribution.headSha,
      diffHash: contribution.diffHash,
      bodyHash: submission.prBodyHash,
      artifactHashes,
    },
  });
  log.info('pull request opened', { contributionId, prNumber: record.number });
  return {
    contributionId,
    status: 'published',
    actions: required,
    missingApprovals: [],
    forkOwner: submission.forkOwner,
    branchName: contribution.branchName,
    headSha: contribution.headSha,
    diffHash: contribution.diffHash,
    pullRequest: { number: record.number, url: record.url },
    note: `opened pull request #${record.number}`,
    warnings,
  };
}

async function consumeApprovals(db: Db, ids: string[], at: Date): Promise<void> {
  if (ids.length === 0) return;
  await db.approval.updateMany({
    where: { id: { in: ids } },
    data: { status: 'CONSUMED', consumedAt: at },
  });
}

interface ContributionForPublish {
  id: string;
  projectId: string;
  candidateId: string;
  project: { fullName: string };
  branchName: string | null;
  baseRef: string | null;
  baseSha: string | null;
  headSha: string | null;
  diffHash: string | null;
}

async function recordPullRequest(
  db: Db,
  args: {
    contribution: ContributionForPublish;
    submission: PreparedSubmission;
    revisionIndex: number;
    remote: GitHubPullRequest;
    forkOwner: string;
    now: Date;
  },
) {
  const [, repoName] = args.contribution.project.fullName.split('/') as [string, string];
  const existing = await db.pullRequest.findUnique({
    where: {
      repoFullName_number: {
        repoFullName: args.contribution.project.fullName,
        number: args.remote.number,
      },
    },
  });
  const data = {
    number: args.remote.number,
    url: args.remote.html_url,
    nodeId: args.remote.node_id,
    repoFullName: args.contribution.project.fullName,
    headRef: args.contribution.branchName ?? args.remote.head.ref,
    headRepo: `${args.forkOwner}/${repoName}`,
    baseRef: args.contribution.baseRef ?? args.remote.base.ref,
    state: 'OPEN' as const,
    isDraft: args.remote.draft,
    headSha: args.remote.head.sha,
    bodyHash: args.submission.prBodyHash,
    titleUsed: args.submission.prTitle,
    commitMessageUsed: args.submission.narrative.commitSubject || args.submission.prTitle,
    openedAt: args.now,
    lastSyncedAt: args.now,
    publishedDiffHash: args.contribution.diffHash,
  };
  if (existing) {
    return db.pullRequest.update({ where: { id: existing.id }, data });
  }
  return db.pullRequest.create({
    data: {
      contributionId: args.contribution.id,
      ...data,
    },
  });
}

async function markPublished(
  db: Db,
  args: {
    contribution: ContributionForPublish & { state: ContributionState };
    revisionIndex: number;
    headSha: string;
    now: Date;
    reason: string;
  },
): Promise<void> {
  const from = args.contribution.state;
  if (from !== 'PR_SUBMITTED') {
    await transitionContribution(db, {
      contributionId: args.contribution.id,
      projectId: args.contribution.projectId,
      candidateId: args.contribution.candidateId,
      fromState: from,
      toState: 'PR_SUBMITTED',
      reason: args.reason,
      actorKind: 'AGENT',
      actor: 'publish',
      data: {
        submittedAt: args.now,
        stateReason: args.reason,
      },
    });
  }
  await transitionContribution(db, {
    contributionId: args.contribution.id,
    projectId: args.contribution.projectId,
    candidateId: args.contribution.candidateId,
    fromState: 'PR_SUBMITTED',
    toState: 'AWAITING_REVIEW',
    reason: `pull request is open; waiting for maintainer review`,
    actorKind: 'SYSTEM',
    actor: 'publish',
  });
}

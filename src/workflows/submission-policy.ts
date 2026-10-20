import type { ApprovalAction } from '@/generated/prisma/enums';
import { hashObject } from '@/lib/canonical';

/**
 * Approval binding.
 *
 * A human approves an exact external artifact, not a contribution in general.
 * The hash below covers every input that determines what would be published:
 * the repository, the fork, the branch, the base commit, the head commit, the
 * diff, and (for a pull request) the title and body. Changing any of them
 * produces a different hash and the old approval no longer applies.
 */

export interface SubmissionContext {
  contributionId: string;
  repoFullName: string;
  forkOwner: string;
  branchName: string;
  baseRef: string;
  baseSha: string;
  headSha: string;
  diffHash: string;
  /** Null when no pull request exists yet. */
  prNumber: number | null;
  /** Needed for OPEN_PULL_REQUEST; the exact title and body a human approves. */
  prTitle: string | null;
  prBodyHash: string | null;
}

export function submissionArtifact(action: ApprovalAction, context: SubmissionContext): string {
  const base = {
    version: 1,
    action,
    contributionId: context.contributionId,
    repository: context.repoFullName,
    forkOwner: context.forkOwner,
    branch: context.branchName,
    baseRef: context.baseRef,
    baseSha: context.baseSha,
    headSha: context.headSha,
    diffHash: context.diffHash,
  };

  switch (action) {
    case 'OPEN_PULL_REQUEST':
      return hashObject({
        ...base,
        prTitle: context.prTitle,
        prBodyHash: context.prBodyHash,
        // A pull request cannot exist without a pushed branch; binding the
        // action to the branch hash keeps a later revision from reusing it.
        branchArtifact: submissionArtifact('PUBLISH_BRANCH', context),
      });
    case 'PUSH_REVISION':
      return hashObject({
        ...base,
        prNumber: context.prNumber,
      });
    case 'POST_COMMENT':
      return hashObject({ ...base, prNumber: context.prNumber });
    default:
      return hashObject(base);
  }
}

export interface ActionPlanInput {
  hasPullRequest: boolean;
  /** The diff hash recorded when the pull request was last pushed. */
  publishedDiffHash: string | null;
  currentDiffHash: string;
}

/**
 * Which approvals a publish attempt needs.
 *
 * Opening a PR is two external acts: publishing a branch and opening the PR.
 * Both are approved separately so an operator can push a branch for inspection
 * without opening anything. A later revision is a third, separate act.
 */
export function requiredSubmissionActions(input: ActionPlanInput): ApprovalAction[] {
  if (!input.hasPullRequest) return ['PUBLISH_BRANCH', 'OPEN_PULL_REQUEST'];
  if (input.publishedDiffHash === input.currentDiffHash) return [];
  return ['PUSH_REVISION'];
}

export function approvalExpired(expiresAt: Date | null, now: Date): boolean {
  return expiresAt !== null && expiresAt.getTime() <= now.getTime();
}

import { describe, expect, it } from 'vitest';
import {
  approvalExpired,
  requiredSubmissionActions,
  submissionArtifact,
  type SubmissionContext,
} from '@/workflows/submission-policy';

const context: SubmissionContext = {
  contributionId: 'contrib-1',
  repoFullName: 'owner/project',
  forkOwner: 'contributor',
  branchName: 'agent/fix-thing',
  baseRef: 'main',
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  diffHash: 'c'.repeat(64),
  prNumber: null,
  prTitle: 'Fix the thing',
  prBodyHash: 'd'.repeat(64),
};

describe('submissionArtifact', () => {
  it('is deterministic and binds the action, branch, and diff', () => {
    const first = submissionArtifact('PUBLISH_BRANCH', context);
    const second = submissionArtifact('PUBLISH_BRANCH', { ...context });
    expect(first).toBe(second);

    expect(submissionArtifact('PUBLISH_BRANCH', { ...context, headSha: 'e'.repeat(40) })).not.toBe(first);
    expect(submissionArtifact('PUBLISH_BRANCH', { ...context, diffHash: 'f'.repeat(64) })).not.toBe(first);
    expect(submissionArtifact('PUBLISH_BRANCH', { ...context, forkOwner: 'someone-else' })).not.toBe(first);
    expect(submissionArtifact('PUSH_REVISION', context)).not.toBe(first);
  });

  it('binds an opened pull request to the exact title and body', () => {
    const first = submissionArtifact('OPEN_PULL_REQUEST', context);
    expect(submissionArtifact('OPEN_PULL_REQUEST', { ...context, prTitle: 'Different title' })).not.toBe(first);
    expect(submissionArtifact('OPEN_PULL_REQUEST', { ...context, prBodyHash: 'e'.repeat(64) })).not.toBe(first);
    // Approving a pull request also approves the branch it depends on.
    const branch = submissionArtifact('PUBLISH_BRANCH', context);
    expect(first).not.toBe(branch);
    expect(
      submissionArtifact('OPEN_PULL_REQUEST', { ...context, headSha: 'e'.repeat(40) }),
    ).not.toBe(first);
  });

  it('binds a revision push to the pull request it updates', () => {
    const withPull = { ...context, prNumber: 42 };
    const first = submissionArtifact('PUSH_REVISION', withPull);
    expect(submissionArtifact('PUSH_REVISION', { ...withPull, prNumber: 43 })).not.toBe(first);
    expect(submissionArtifact('PUSH_REVISION', { ...withPull, diffHash: 'e'.repeat(64) })).not.toBe(first);
  });
});

describe('requiredSubmissionActions', () => {
  it('needs two approvals to open a first pull request', () => {
    expect(
      requiredSubmissionActions({
        hasPullRequest: false,
        publishedDiffHash: null,
        currentDiffHash: 'abc',
      }),
    ).toEqual(['PUBLISH_BRANCH', 'OPEN_PULL_REQUEST']);
  });

  it('needs one approval to update an existing pull request', () => {
    expect(
      requiredSubmissionActions({
        hasPullRequest: true,
        publishedDiffHash: 'old',
        currentDiffHash: 'new',
      }),
    ).toEqual(['PUSH_REVISION']);
  });

  it('needs nothing when the current diff is already published', () => {
    expect(
      requiredSubmissionActions({
        hasPullRequest: true,
        publishedDiffHash: 'same',
        currentDiffHash: 'same',
      }),
    ).toEqual([]);
  });
});

describe('approvalExpired', () => {
  const now = new Date('2026-10-19T12:00:00Z');

  it('treats a null expiry as no expiry and an equal time as expired', () => {
    expect(approvalExpired(null, now)).toBe(false);
    expect(approvalExpired(new Date(now.getTime() - 1), now)).toBe(true);
    expect(approvalExpired(new Date(now.getTime() + 1), now)).toBe(false);
    expect(approvalExpired(new Date(now), now)).toBe(true);
  });
});

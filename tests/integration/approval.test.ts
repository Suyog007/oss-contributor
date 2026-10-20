import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPrismaClient } from '@/db/client';
import { decideApproval, prepareSubmission } from '@/workflows/approval';
import { publishContribution } from '@/workflows/publish';
import { submissionArtifact } from '@/workflows/submission-policy';

/**
 * The approval gate is the only thing between an automated change and a public
 * repository. These tests exercise it against a real database: prepare binds
 * an exact body to a hash, a human decision is recorded, and publishing
 * refuses unless the hash it is about to publish has a live GRANTED approval.
 */
const url = process.env['TEST_DATABASE_URL'];
const describeDb = url ? describe : describe.skip;
const db = url ? createPrismaClient(url) : null;

const created: string[] = [];

afterAll(async () => {
  if (db) {
    for (const projectId of created) {
      await db.workflowEvent.deleteMany({ where: { projectId } });
      await db.project.delete({ where: { id: projectId } }).catch(() => undefined);
    }
    await db.$disconnect();
  }
});

interface Fixture {
  projectId: string;
  fullName: string;
  candidateId: string;
  contributionId: string;
  headSha: string;
  diffHash: string;
}

async function fixture(options: { state?: 'READY_FOR_SUBMISSION' | 'HUMAN_APPROVAL' } = {}): Promise<Fixture> {
  const suffix = randomUUID();
  const project = await db!.project.create({
    data: {
      githubId: BigInt(`0x${suffix.replaceAll('-', '').slice(0, 12)}`),
      fullName: `approval-test/${suffix}`,
      owner: 'approval-test',
      name: suffix,
      defaultBranch: 'main',
      language: 'Go',
      repoCreatedAt: new Date('2025-01-01T00:00:00Z'),
      repoPushedAt: new Date('2026-01-01T00:00:00Z'),
    },
  });
  created.push(project.id);
  const candidate = await db!.candidate.create({
    data: {
      projectId: project.id,
      title: 'Reasonix stream rejects large records',
      summary: 'The Reasonix backend uses a 10 MiB scanner.',
      origin: 'EXISTING_ISSUE',
      originIssueNumber: 42,
      files: ['server/pkg/agent/reasonix.go'],
      fingerprint: suffix,
      severity: 'high',
      analysisHeadSha: 'a'.repeat(40),
    },
  });
  const headSha = 'b'.repeat(40);
  const diffHash = 'c'.repeat(64);
  const contribution = await db!.contribution.create({
    data: {
      projectId: project.id,
      candidateId: candidate.id,
      state: options.state ?? 'READY_FOR_SUBMISSION',
      idempotencyKey: `approval-test:${suffix}`,
      baseRef: 'main',
      baseSha: 'a'.repeat(40),
      headSha,
      branchName: 'agent/fix-reasonix-stream',
      diffHash,
      workspacePath: '/tmp/does-not-matter-for-dry-run',
      planJson: {
        rootCause: 'The scanner is capped at 10 MiB.',
        approach: 'Use the shared scanner and check its error.',
        changes: [
          { file: 'server/pkg/agent/reasonix.go', intent: 'use the shared scanner', kind: 'modify' },
        ],
        testsToAdd: [{ file: 'server/pkg/agent/reasonix_stream_test.go', intent: 'cover 11 and 33 MiB' }],
        risks: [],
        outOfScope: [],
        verification: ['go test ./...'],
        uncertainties: [],
        needsMoreContext: [],
      },
    },
  });
  await db!.revision.create({
    data: {
      contributionId: contribution.id,
      index: 1,
      summary: 'Use the shared stream scanner',
      rootCause: 'The old scanner was capped at 10 MiB.',
      filesChanged: ['server/pkg/agent/reasonix.go', 'server/pkg/agent/reasonix_stream_test.go'],
      testsAdded: ['server/pkg/agent/reasonix_stream_test.go'],
      diffHash,
      diff: 'diff --git a/server/pkg/agent/reasonix.go b/server/pkg/agent/reasonix.go',
      uncertainty: [],
      addresses: [],
    },
  });
  await db!.testRun.create({
    data: {
      contributionId: contribution.id,
      revisionIndex: 1,
      command: 'go test ./pkg/agent/ -run Reasonix',
      status: 'PASSED',
      exitCode: 0,
      durationMs: 1200,
      sandboxKind: 'docker',
      outputTail: 'ok',
      outputBytes: 2,
      truncated: false,
      kind: 'verification',
    },
  });
  await db!.investigation.create({
    data: {
      candidateId: candidate.id,
      kind: 'HYPOTHESIS',
      agent: 'hypothesis',
      inputHash: suffix,
      verdict: 'SUPPORTS',
      confidence: 0.8,
      outputJson: {
        title: 'Reasonix stream rejects large records',
        summary: 'The Reasonix backend uses a 10 MiB scanner while other backends use 32 MiB.',
        origin: 'EXISTING_ISSUE',
        originIssueNumber: 42,
        files: ['server/pkg/agent/reasonix.go'],
        claimedBehavior: 'An 11 MiB record fails the turn.',
        expectedBehavior: 'The shared 32 MiB bound applies.',
        evidence: [
          {
            kind: 'line',
            ref: 'server/pkg/agent/reasonix.go:218',
            detail: 'bufio.NewScanner with a 10 MiB cap',
          },
        ],
        severity: 'high',
        verificationSteps: [],
        verificationCommands: ['go test ./...'],
        proposedTest: 'An 11 MiB line completes.',
        confidence: 0.8,
        openQuestions: [],
      },
      rationale: 'fixture',
    },
  });
  await db!.repoDigest.create({
    data: {
      projectId: project.id,
      headSha: 'a'.repeat(40),
      json: {
        repo: { fullName: project.fullName, language: 'Go', defaultBranch: 'main' },
        headSha: 'a'.repeat(40),
        tree: { manifests: ['server/go.mod'], testFiles: [] },
      },
      bytes: 100,
      fileCount: 1,
    },
  });
  return {
    projectId: project.id,
    fullName: project.fullName,
    candidateId: candidate.id,
    contributionId: contribution.id,
    headSha,
    diffHash,
  };
}

describeDb('approval gate', () => {
  it('binds the prepared PR body to a hash and requires both approvals before a dry-run publish', async () => {
    const f = await fixture();
    const prepared = await prepareSubmission(db!, f.contributionId, {
      forkOwner: 'test-fork-owner',
      deterministicNarrative: true,
    });

    expect(prepared.actions).toEqual(['PUBLISH_BRANCH', 'OPEN_PULL_REQUEST']);
    expect(prepared.approvals.map((approval) => approval.status)).toEqual(['PENDING', 'PENDING']);
    expect(prepared.prBody).toContain('`go test ./pkg/agent/ -run Reasonix` — PASSED');
    expect(prepared.prBody).toContain('Fixes #42');
    expect(prepared.prBody).toContain('_Prepared by an automated contribution agent.');

    const contribution = await db!.contribution.findUniqueOrThrow({
      where: { id: f.contributionId },
    });
    expect(contribution.state).toBe('HUMAN_APPROVAL');
    expect(contribution.submissionJson).not.toBeNull();

    const awaiting = await publishContribution(db!, f.contributionId, { execute: false });
    expect(awaiting.status).toBe('awaiting-approval');
    expect(awaiting.missingApprovals).toEqual(['PUBLISH_BRANCH', 'OPEN_PULL_REQUEST']);

    for (const approval of prepared.approvals) {
      await decideApproval(db!, {
        contributionId: f.contributionId,
        action: approval.action,
        decision: 'GRANTED',
        decidedBy: 'Test Operator',
        artifactHash: approval.artifactHash,
      });
    }

    const dryRun = await publishContribution(db!, f.contributionId, { execute: false });
    expect(dryRun.status).toBe('dry-run');
    expect(dryRun.missingApprovals).toEqual([]);
    expect(dryRun.note).toContain('no external action was taken');
    expect(dryRun.pullRequest).toBeNull();

    const events = await db!.workflowEvent.findMany({
      where: { contributionId: f.contributionId, eventType: 'approval_granted' },
    });
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.actorKind === 'HUMAN')).toBe(true);
    expect(events.every((event) => event.actor === 'Test Operator')).toBe(true);
  });

  it('refuses an approval bound to a different artifact and expires old ones', async () => {
    const f = await fixture();
    const prepared = await prepareSubmission(db!, f.contributionId, {
      forkOwner: 'test-fork-owner',
      deterministicNarrative: true,
    });
    const branch = prepared.approvals.find((approval) => approval.action === 'PUBLISH_BRANCH')!;

    await expect(
      decideApproval(db!, {
        contributionId: f.contributionId,
        action: 'PUBLISH_BRANCH',
        decision: 'GRANTED',
        decidedBy: 'Test Operator',
        artifactHash: 'f'.repeat(64),
      }),
    ).rejects.toThrow(/does not match/);

    await db!.approval.update({
      where: { id: branch.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(
      decideApproval(db!, {
        contributionId: f.contributionId,
        action: 'PUBLISH_BRANCH',
        decision: 'GRANTED',
        decidedBy: 'Test Operator',
        artifactHash: branch.artifactHash,
      }),
    ).rejects.toThrow(/expired/);
  });

  it('invalidates an approval when the diff it was bound to changes', async () => {
    const f = await fixture();
    const prepared = await prepareSubmission(db!, f.contributionId, {
      forkOwner: 'test-fork-owner',
      deterministicNarrative: true,
    });
    const stored = (await db!.contribution.findUniqueOrThrow({ where: { id: f.contributionId } }))
      .submissionJson as {
      prTitle: string;
      prBodyHash: string;
    };
    const context = {
      contributionId: f.contributionId,
      repoFullName: f.fullName,
      forkOwner: 'test-fork-owner',
      branchName: 'agent/fix-reasonix-stream',
      baseRef: 'main',
      baseSha: 'a'.repeat(40),
      headSha: 'd'.repeat(40),
      diffHash: f.diffHash,
      prNumber: null,
      prTitle: stored.prTitle,
      prBodyHash: stored.prBodyHash,
    };
    expect(submissionArtifact('PUBLISH_BRANCH', context)).not.toBe(
      prepared.artifactHashes.PUBLISH_BRANCH,
    );
    expect(submissionArtifact('OPEN_PULL_REQUEST', context)).not.toBe(
      prepared.artifactHashes.OPEN_PULL_REQUEST,
    );
  });
});

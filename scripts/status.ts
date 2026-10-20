/**
 * Operator view of one contribution: state, diff, tests, reviews, approvals,
 * pull request, and the most recent audit events.
 *
 *   pnpm status --contribution <id>
 */
import 'dotenv/config';
import { createDb } from '@/db/client';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

function line(label: string, value: unknown): void {
  if (value === null || value === undefined || value === '') return;
  console.log(`  ${label.padEnd(16)} ${String(value)}`);
}

async function main(): Promise<void> {
  const contributionId = flag('contribution');
  if (!contributionId) {
    console.error('usage: pnpm status --contribution <id>');
    process.exit(1);
  }
  const db = createDb();
  try {
    const contribution = await db.contribution.findUnique({
      where: { id: contributionId },
      include: {
        project: { select: { fullName: true, defaultBranch: true } },
        candidate: { select: { title: true, origin: true, originIssueNumber: true } },
        revisions: { orderBy: { index: 'desc' } },
        testRuns: { orderBy: { createdAt: 'desc' }, take: 20 },
        reviews: { orderBy: [{ round: 'desc' }, { reviewer: 'asc' }] },
        approvals: { orderBy: { requestedAt: 'desc' } },
        pullRequests: { orderBy: { openedAt: 'desc' } },
        events: { orderBy: { createdAt: 'desc' }, take: 15 },
      },
    });
    if (!contribution) {
      console.error(`contribution ${contributionId} not found`);
      process.exit(1);
    }

    console.log(`${contribution.project.fullName} — ${contribution.candidate.title}`);
    line('id', contribution.id);
    line('state', contribution.state);
    line('reason', contribution.stateReason);
    line('candidate', contribution.candidateId);
    line('issue', contribution.candidate.originIssueNumber ? `#${contribution.candidate.originIssueNumber}` : null);
    line('branch', contribution.branchName);
    line('base', `${contribution.baseRef ?? contribution.project.defaultBranch} @ ${contribution.baseSha?.slice(0, 12)}`);
    line('head', contribution.headSha?.slice(0, 12));
    line('diff', contribution.diffHash?.slice(0, 16));
    line('revisions', contribution.revisionCount);
    line('cost', `$${Number(contribution.costUsd).toFixed(4)} of $${Number(contribution.budgetUsd).toFixed(2)}`);
    line('blocked', contribution.blockedReason);
    line('submitted', contribution.submittedAt?.toISOString());
    line('workspace', contribution.workspacePath);

    const revision = contribution.revisions[0];
    if (revision) {
      console.log('\nLatest revision');
      line('index', revision.index);
      line('summary', revision.summary);
      line('files', revision.filesChanged.join(', '));
      line('tests added', revision.testsAdded.join(', ') || 'none');
      line('diff hash', revision.diffHash.slice(0, 16));
    }

    if (contribution.testRuns.length > 0) {
      console.log('\nTest runs');
      for (const run of contribution.testRuns) {
        console.log(`  r${run.revisionIndex} ${run.status.padEnd(8)} ${run.command} (${(run.durationMs / 1000).toFixed(1)}s)`);
      }
    }

    if (contribution.reviews.length > 0) {
      console.log('\nReviews');
      for (const review of contribution.reviews) {
        console.log(
          `  round ${review.round} r${review.revisionIndex} ${review.reviewer.padEnd(15)} ${review.verdict.padEnd(19)} blocking=${review.blockingCount}`,
        );
      }
    }

    if (contribution.approvals.length > 0) {
      console.log('\nApprovals');
      for (const approval of contribution.approvals) {
        console.log(
          `  ${approval.action.padEnd(18)} ${approval.status.padEnd(9)} ${approval.artifactHash.slice(0, 16)} ${approval.decidedBy ?? ''} ${approval.note ?? ''}`,
        );
      }
    }

    if (contribution.pullRequests.length > 0) {
      console.log('\nPull requests');
      for (const pull of contribution.pullRequests) {
        console.log(`  #${pull.number} ${pull.state} ${pull.url} head=${pull.headSha.slice(0, 12)} published=${pull.publishedDiffHash?.slice(0, 12) ?? 'none'}`);
      }
    }

    console.log('\nRecent events');
    for (const event of contribution.events) {
      console.log(`  ${event.createdAt.toISOString()} ${event.eventType.padEnd(24)} ${event.reason.slice(0, 160)}`);
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

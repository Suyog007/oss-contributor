import type { Db } from '@/db/client';
import type { Task } from '@/generated/prisma/client';
import { createLogger, type Logger } from '@/lib/logger';
import { GitHubClient, GitHubRateLimitError } from '@/github/client';
import { BudgetExceededError } from '@/workflow/budget';
import { TaskBlockedError } from '@/workflow/errors';
import { runDiscovery } from '@/workflows/discover';
import { analyzeProject } from '@/workflows/analyzeProject';
import { generateCandidatesForProject } from '@/workflows/generateHypotheses';
import { investigateCandidate } from '@/workflows/investigate';
import { implementContribution } from '@/workflows/implement';
import { reviewContribution } from '@/workflows/review';

const log = createLogger('dispatcher');

export interface TaskOutcome {
  status: 'succeeded' | 'failed';
  /** Summary stored on the task and in the event log. */
  note: string;
  /** Whether the failure is worth retrying (network, rate limit, transient). */
  retryable: boolean;
  /** Park the task until this time instead of using the exponential backoff. */
  retryAt?: Date;
}

function payloadString(task: Task, key: string): string | undefined {
  const payload = task.payload as Record<string, unknown> | null;
  const value = payload?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The task kinds this worker actually implements. Anything else stays in the
 * queue (and stays visible) instead of being claimed and failed in a loop.
 */
export const SUPPORTED_TASK_KINDS = [
  'DISCOVER_PROJECTS',
  'ANALYZE_PROJECT',
  'GENERATE_HYPOTHESES',
  'INVESTIGATE_CANDIDATE',
  'IMPLEMENT_CONTRIBUTION',
  'REVIEW_CONTRIBUTION',
] as const;

/**
 * Run one claimed task.
 *
 * Errors are classified here, once: rate limits and budget exhaustion are not
 * retried immediately (they will not succeed sooner), while network and
 * sandbox errors are. The classification is recorded on the task so the
 * dashboard can explain every parked or failed job.
 */
export async function runTask(db: Db, client: GitHubClient, task: Task, logger: Logger = log): Promise<TaskOutcome> {
  try {
    switch (task.kind) {
      case 'DISCOVER_PROJECTS': {
        const maxQueries = payloadString(task, 'maxQueries');
        const summary = await runDiscovery(db, client, {
          ...(maxQueries ? { maxQueries: Number(maxQueries) } : {}),
          dryRun: false,
        });
        return {
          status: 'succeeded',
          retryable: false,
          note: `discovery: ${summary.repositoriesSeen} repositories seen, ${summary.projectsCreated} new, ${summary.analysesEnqueued} analyses enqueued${summary.rateLimited ? ' (rate limited)' : ''}`,
        };
      }

      case 'ANALYZE_PROJECT': {
        const projectId = payloadString(task, 'projectId');
        if (!projectId) {
          return { status: 'failed', retryable: false, note: 'payload.projectId is required' };
        }
        const result = await analyzeProject(db, client, projectId, {
          force: (task.payload as Record<string, unknown> | null)?.['force'] === true,
        });
        return {
          status: 'succeeded',
          retryable: false,
          note: `analysis ${result.status}: ${result.reason}`,
        };
      }

      case 'GENERATE_HYPOTHESES': {
        const projectId = payloadString(task, 'projectId');
        if (!projectId) {
          return { status: 'failed', retryable: false, note: 'payload.projectId is required' };
        }
        const result = await generateCandidatesForProject(db, client, projectId);
        return {
          status: 'succeeded',
          retryable: false,
          note: `hypotheses ${result.status}: ${result.candidatesCreated} candidate(s) from ${result.hypothesesProposed} hypothesis(es), $${result.costUsd.toFixed(4)}`,
        };
      }

      case 'INVESTIGATE_CANDIDATE': {
        const candidateId = payloadString(task, 'candidateId');
        if (!candidateId) {
          return { status: 'failed', retryable: false, note: 'payload.candidateId is required' };
        }
        const result = await investigateCandidate(db, client, candidateId);
        return {
          status: 'succeeded',
          retryable: false,
          note: `investigation ${result.status}${result.outcome ? ` (${result.outcome})` : ''}${result.escalated ? ' [escalated]' : ''}: $${result.costUsd.toFixed(4)}`,
        };
      }

      case 'IMPLEMENT_CONTRIBUTION': {
        const candidateId = payloadString(task, 'candidateId');
        if (!candidateId) {
          return { status: 'failed', retryable: false, note: 'payload.candidateId is required' };
        }
        const revisionContext = payloadString(task, 'revisionContext');
        const result = await implementContribution(
          db,
          candidateId,
          revisionContext ? { revisionContext } : {},
        );
        return {
          status: 'succeeded',
          retryable: false,
          note: `implementation ${result.status} (${result.contributionId})${result.revisionIndex ? ` revision ${result.revisionIndex}` : ''}: ${result.note} $${result.costUsd.toFixed(4)}`,
        };
      }

      case 'REVIEW_CONTRIBUTION': {
        const contributionId = payloadString(task, 'contributionId');
        if (!contributionId) {
          return { status: 'failed', retryable: false, note: 'payload.contributionId is required' };
        }
        const result = await reviewContribution(db, contributionId);
        return {
          status: 'succeeded',
          retryable: false,
          note: `review ${result.status} (${result.verdict}) revision ${result.revisionIndex} round ${result.round}: ${result.note} $${result.costUsd.toFixed(4)}`,
        };
      }

      default:
        return {
          status: 'failed',
          retryable: false,
          note: `task kind ${task.kind} is not implemented by this worker; leaving it for a worker that handles it`,
        };
    }
  } catch (error) {
    if (error instanceof TaskBlockedError) {
      return {
        status: 'failed',
        retryable: false,
        note: error.message,
      };
    }
    if (error instanceof BudgetExceededError) {
      return {
        status: 'failed',
        retryable: false,
        note: `budget exhausted (${error.scope}): ${error.detail}`,
      };
    }
    if (error instanceof GitHubRateLimitError) {
      // Park until the reset instead of burning attempts.
      return {
        status: 'failed',
        retryable: true,
        retryAt: new Date(error.resetAt.getTime() + 30_000),
        note: `github ${error.resource} rate limit; resuming after ${error.resetAt.toISOString()}`,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('task threw', { taskId: task.id, kind: task.kind, error: message.slice(0, 300) });
    return { status: 'failed', retryable: true, note: message.slice(0, 1000) };
  }
}

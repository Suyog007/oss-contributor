import type { Db } from '@/db/client';
import type { Task } from '@/generated/prisma/client';
import type { TaskKind } from '@/generated/prisma/enums';
import { GitHubClient } from '@/github/client';
import { createLogger } from '@/lib/logger';
import { claimTask, completeTask, failTask, requeueExpiredLeases } from '@/workflow/queue';
import { runTask, type TaskOutcome } from './dispatcher';

const log = createLogger('drain');

export interface DrainOptions {
  workerId: string;
  kinds: TaskKind[];
  /** Stop claiming new tasks once this much time has passed. */
  claimBudgetMs: number;
  /** Lease long enough to outlive the slowest single task. */
  leaseMs: number;
  /** Injected in tests; defaults to the real dispatcher. */
  run?: (db: Db, client: GitHubClient, task: Task) => Promise<TaskOutcome>;
}

export interface DrainResult {
  claimed: number;
  succeeded: number;
  failed: number;
  elapsedMs: number;
}

/**
 * Run queued tasks one after another for a bounded time.
 *
 * This is the serverless counterpart of the long-running worker: the same
 * queue, dispatcher and lease rules, but it returns when its time budget is
 * spent so a function can finish inside its execution limit. A task still
 * running when the host kills the function keeps its lease and is recovered
 * by `requeueExpiredLeases` on the next run.
 */
export async function drainQueue(db: Db, client: GitHubClient, options: DrainOptions): Promise<DrainResult> {
  const started = Date.now();
  const run = options.run ?? runTask;
  const result: DrainResult = { claimed: 0, succeeded: 0, failed: 0, elapsedMs: 0 };

  await requeueExpiredLeases(db);

  while (Date.now() - started < options.claimBudgetMs) {
    const task = await claimTask(db, options.workerId, options.kinds, options.leaseMs);
    if (!task) break;
    result.claimed += 1;

    let outcome: TaskOutcome;
    try {
      outcome = await run(db, client, task);
    } catch (error) {
      outcome = {
        status: 'failed',
        retryable: true,
        note: `drain error while running task: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (outcome.status === 'succeeded') {
      await completeTask(db, task.id, 'SUCCEEDED', { workerId: options.workerId });
      result.succeeded += 1;
    } else {
      await failTask(db, task.id, outcome.note, {
        retryable: outcome.retryable,
        ...(outcome.retryAt ? { retryAt: outcome.retryAt } : {}),
        workerId: options.workerId,
      });
      result.failed += 1;
    }
    log.info('task finished', { taskId: task.id, kind: task.kind, status: outcome.status, note: outcome.note });
  }

  result.elapsedMs = Date.now() - started;
  return result;
}

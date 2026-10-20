import type { Prisma, Task } from '@/generated/prisma/client';
import type { TaskKind, TaskStatus } from '@/generated/prisma/enums';
import type { Db } from '@/db/client';
import { createLogger } from '@/lib/logger';

const log = createLogger('queue');

export interface EnqueueInput {
  kind: TaskKind;
  /**
   * Idempotency key. Enqueueing the same key twice returns the existing task
   * instead of creating a second one, which is what keeps retries from
   * producing duplicate branches or pull requests.
   */
  dedupeKey: string;
  payload?: Prisma.InputJsonValue;
  priority?: number;
  maxAttempts?: number;
  availableAt?: Date;
  projectId?: string | null;
  contributionId?: string | null;
}

export interface EnqueueResult {
  task: Task;
  created: boolean;
}

export async function enqueue(db: Db, input: EnqueueInput): Promise<EnqueueResult> {
  const inserted = await db.$queryRaw<Array<{ id: string }>>`
    INSERT INTO "Task" ("id", "kind", "status", "dedupeKey", "payload", "priority", "maxAttempts", "availableAt", "projectId", "contributionId", "createdAt", "updatedAt")
    VALUES (
      gen_random_uuid()::text,
      ${input.kind}::"TaskKind",
      'PENDING'::"TaskStatus",
      ${input.dedupeKey},
      ${JSON.stringify(input.payload ?? {})}::jsonb,
      ${input.priority ?? 100},
      ${input.maxAttempts ?? 3},
      ${input.availableAt ?? new Date()},
      ${input.projectId ?? null},
      ${input.contributionId ?? null},
      now(),
      now()
    )
    ON CONFLICT ("dedupeKey") DO NOTHING
    RETURNING "id"
  `;
  const created = inserted.length > 0;
  const task = created
    ? await db.task.findUniqueOrThrow({ where: { id: inserted[0]!.id } })
    : await db.task.findUniqueOrThrow({ where: { dedupeKey: input.dedupeKey } });
  if (created) {
    log.debug('task enqueued', { kind: input.kind, dedupeKey: input.dedupeKey });
  }
  return { task, created };
}

/**
 * Claim one task with `FOR UPDATE SKIP LOCKED`. Safe to run from several
 * workers at once without an external broker.
 */
export async function claimTask(
  db: Db,
  workerId: string,
  kinds: TaskKind[] | null,
  leaseMs: number,
): Promise<Task | null> {
  const kindFilter = kinds && kinds.length > 0 ? kinds.join(',') : null;
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    WITH next AS (
      SELECT "id" FROM "Task"
      WHERE "status" = 'PENDING'::"TaskStatus"
        AND "availableAt" <= now()
        AND (${kindFilter}::text IS NULL OR "kind"::text = ANY(string_to_array(${kindFilter}::text, ',')))
      ORDER BY "priority" ASC, "availableAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "Task" t
    SET "status" = 'RUNNING'::"TaskStatus",
        "lockedBy" = ${workerId},
        "leaseUntil" = now() + make_interval(secs => ${leaseMs / 1000}),
        "attempts" = t."attempts" + 1,
        "updatedAt" = now()
    FROM next
    WHERE t."id" = next."id"
    RETURNING t."id"
  `;
  const id = rows[0]?.id;
  if (!id) return null;
  return db.task.findUniqueOrThrow({ where: { id } });
}

export interface CompleteOptions {
  /**
   * Only apply the update if the task is still locked by this worker. Guards
   * against a late-finishing run clobbering a task another worker has since
   * recovered after our lease expired.
   */
  workerId?: string;
}

/** Returns false when the guard failed and nothing was written. */
export async function completeTask(
  db: Db,
  taskId: string,
  status: TaskStatus = 'SUCCEEDED',
  options: CompleteOptions = {},
): Promise<boolean> {
  const result = await db.task.updateMany({
    where: {
      id: taskId,
      status: 'RUNNING',
      ...(options.workerId ? { lockedBy: options.workerId } : {}),
    },
    data: { status, finishedAt: new Date(), leaseUntil: null, lockedBy: null },
  });
  if (result.count === 0) {
    log.warn('task completion discarded (lease lost or task cancelled)', { taskId, status });
  }
  return result.count > 0;
}

/** Extend the lease on a task this worker still owns. */
export async function renewLease(
  db: Db,
  taskId: string,
  workerId: string,
  leaseMs: number,
): Promise<boolean> {
  const result = await db.task.updateMany({
    where: { id: taskId, status: 'RUNNING', lockedBy: workerId },
    data: { leaseUntil: new Date(Date.now() + leaseMs), updatedAt: new Date() },
  });
  return result.count > 0;
}

export interface FailureOutcome {
  status: TaskStatus;
  retryAt?: Date;
  attempts: number;
  maxAttempts: number;
  /** False when the lease was lost and the write was skipped. */
  applied: boolean;
}

/**
 * Fail a task. Retryable failures go back to PENDING with exponential backoff
 * until maxAttempts is reached; then the task is DEAD and needs an operator.
 * `retryAt` (e.g. a rate-limit reset) overrides the computed backoff.
 */
export async function failTask(
  db: Db,
  taskId: string,
  error: string,
  options: { retryable: boolean; backoffMs?: number; retryAt?: Date; workerId?: string } = { retryable: true },
): Promise<FailureOutcome> {
  const task = await db.task.findUniqueOrThrow({ where: { id: taskId } });
  const exhausted = task.attempts >= task.maxAttempts;
  const retry = options.retryable && !exhausted;
  const base = options.backoffMs ?? 30_000;
  const computedDelay = Math.min(base * 2 ** Math.max(0, task.attempts - 1), 30 * 60_000);
  const retryAt =
    retry && options.retryAt
      ? new Date(Math.max(options.retryAt.getTime(), Date.now()))
      : new Date(Date.now() + computedDelay);
  const delay = retry ? retryAt.getTime() - Date.now() : 0;
  const status: TaskStatus = retry ? 'PENDING' : 'FAILED';
  const result = await db.task.updateMany({
    where: {
      id: taskId,
      status: 'RUNNING',
      ...(options.workerId ? { lockedBy: options.workerId } : {}),
    },
    data: {
      status,
      lastError: error.slice(0, 2000),
      lockedBy: null,
      leaseUntil: null,
      ...(retry ? { availableAt: retryAt } : { finishedAt: new Date() }),
    },
  });
  if (result.count === 0) {
    log.warn('task failure discarded (lease lost or task cancelled)', { taskId, kind: task.kind });
    return { status, attempts: task.attempts, maxAttempts: task.maxAttempts, applied: false };
  }
  log.warn('task failed', {
    taskId,
    kind: task.kind,
    attempts: task.attempts,
    retry,
    delayMs: delay,
    error: error.slice(0, 300),
  });
  return { status, attempts: task.attempts, maxAttempts: task.maxAttempts, retryAt: retry ? retryAt : undefined, applied: true };
}

/** Recover tasks whose worker died holding the lease. */
export async function requeueExpiredLeases(db: Db): Promise<number> {
  const rows = await db.$executeRaw`
    UPDATE "Task"
    SET "status" = CASE WHEN "attempts" >= "maxAttempts" THEN 'FAILED'::"TaskStatus" ELSE 'PENDING'::"TaskStatus" END,
        "lockedBy" = NULL,
        "leaseUntil" = NULL,
        "lastError" = COALESCE("lastError", 'lease expired'),
        "updatedAt" = now()
    WHERE "status" = 'RUNNING'::"TaskStatus" AND "leaseUntil" IS NOT NULL AND "leaseUntil" < now()
  `;
  if (rows > 0) log.warn('requeued tasks with expired leases', { count: rows });
  return rows;
}

export async function cancelTasksForContribution(db: Db, contributionId: string, reason: string): Promise<number> {
  const result = await db.task.updateMany({
    where: { contributionId, status: { in: ['PENDING', 'RUNNING'] } },
    data: { status: 'CANCELLED', finishedAt: new Date(), lastError: reason },
  });
  return result.count;
}

export async function countByStatus(db: Db): Promise<Record<string, number>> {
  const rows = await db.task.groupBy({ by: ['status'], _count: { _all: true } });
  return Object.fromEntries(rows.map((row) => [row.status, row._count._all]));
}

/** Tasks that need a human: retries exhausted or terminally failed. */
export async function failingTasks(db: Db, limit = 50): Promise<Task[]> {
  return db.task.findMany({
    where: { status: { in: ['FAILED', 'DEAD'] } },
    orderBy: { updatedAt: 'desc' },
    take: limit,
  });
}

/**
 * Worker entry point.
 *
 *   pnpm worker
 *
 * Polls the Postgres-backed task queue (`FOR UPDATE SKIP LOCKED`, so several
 * workers can run side by side), runs up to WORKER_CONCURRENCY tasks at once
 * through the dispatcher, renews their leases while they run, and recovers
 * tasks whose worker died. SIGINT/SIGTERM stop claiming new work, let
 * in-flight tasks finish for a short grace period, then exit.
 */
import 'dotenv/config';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import type { Task } from '@/generated/prisma/client';
import type { TaskKind } from '@/generated/prisma/enums';
import { loadEnv, type Env } from '@/config/env';
import { createDb, type Db } from '@/db/client';
import { GitHubClient } from '@/github/client';
import { createLogger, type Logger } from '@/lib/logger';
import { recordEvent } from '@/workflow/events';
import {
  claimTask,
  completeTask,
  failTask,
  renewLease,
  requeueExpiredLeases,
} from '@/workflow/queue';
import { runTask, SUPPORTED_TASK_KINDS, type TaskOutcome } from './dispatcher';

const log = createLogger('worker');

/** How long to wait for in-flight tasks after a stop signal. */
const SHUTDOWN_GRACE_MS = 60_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sleep, but wake up immediately when the worker is asked to stop. */
function delayOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface InFlight {
  taskId: string;
  kind: TaskKind;
  startedAt: number;
  /**
   * Set when the worker stops renewing the lease: either the task exceeded
   * WORKER_TASK_MAX_MS or the lease was already recovered by someone else.
   * The run keeps executing (we cannot preempt it), but its result will be
   * discarded by the guarded complete/fail calls.
   */
  leaseRetired: boolean;
}

export interface WorkerOptions {
  db: Db;
  client: GitHubClient;
  env: Env;
  workerId?: string;
  logger?: Logger;
}

export class Worker {
  readonly workerId: string;
  private readonly db: Db;
  private readonly client: GitHubClient;
  private readonly env: Env;
  private readonly log: Logger;
  private readonly inFlight = new Map<string, InFlight>();
  private readonly abort = new AbortController();
  private stopping = false;
  private readonly timers: Array<NodeJS.Timeout> = [];

  constructor(options: WorkerOptions) {
    this.db = options.db;
    this.client = options.client;
    this.env = options.env;
    this.workerId = options.workerId ?? this.env.WORKER_ID ?? `${os.hostname().split('.')[0]}-${process.pid}`;
    this.log = (options.logger ?? log).child({ workerId: this.workerId });
  }

  /** Ask the worker to stop claiming new tasks and exit once in-flight work settles. */
  requestStop(reason: string): void {
    if (this.stopping) return;
    this.stopping = true;
    this.log.info(`stopping: ${reason}`);
    this.abort.abort();
  }

  /** Claim and run tasks until stopped. */
  async run(): Promise<void> {
    const { env } = this;

    // Recover work orphaned by a crashed worker before claiming anything new.
    await requeueExpiredLeases(this.db).catch((error) =>
      this.log.error('lease recovery failed', { error: message(error) }),
    );

    const heartbeatMs = Math.max(5_000, Math.min(60_000, Math.floor(env.WORKER_LEASE_MS / 3)));
    this.timers.push(
      setInterval(() => {
        void this.heartbeat().catch((error) =>
          this.log.error('heartbeat failed', { error: message(error) }),
        );
      }, heartbeatMs),
    );
    this.timers.push(
      setInterval(() => {
        void requeueExpiredLeases(this.db).catch((error) =>
          this.log.error('lease recovery failed', { error: message(error) }),
        );
      }, Math.max(15_000, heartbeatMs)),
    );

    this.log.info('worker started', {
      concurrency: env.WORKER_CONCURRENCY,
      pollMs: env.WORKER_POLL_MS,
      taskMaxMs: env.WORKER_TASK_MAX_MS,
      leaseMs: env.WORKER_LEASE_MS,
      kinds: [...SUPPORTED_TASK_KINDS],
    });

    while (!this.stopping) {
      const capacity = env.WORKER_CONCURRENCY - this.inFlight.size;
      if (capacity <= 0) {
        await delayOrAbort(250, this.abort.signal);
        continue;
      }
      let claimed = 0;
      for (let slot = 0; slot < capacity && !this.stopping; slot += 1) {
        const task = await claimTask(this.db, this.workerId, [...SUPPORTED_TASK_KINDS], env.WORKER_LEASE_MS);
        if (!task) break;
        claimed += 1;
        this.start(task);
      }
      if (claimed === 0) await delayOrAbort(env.WORKER_POLL_MS, this.abort.signal);
    }

    await this.drain();
  }

  private start(task: Task): void {
    this.inFlight.set(task.id, {
      taskId: task.id,
      kind: task.kind,
      startedAt: Date.now(),
      leaseRetired: false,
    });
    this.log.info('task claimed', { taskId: task.id, kind: task.kind, attempt: task.attempts });
    void this.execute(task).finally(() => {
      this.inFlight.delete(task.id);
    });
  }

  private async execute(task: Task): Promise<void> {
    const logger = this.log.child({ taskId: task.id, kind: task.kind });
    const started = Date.now();
    let outcome: TaskOutcome;
    try {
      outcome = await runTask(this.db, this.client, task, logger);
    } catch (error) {
      // The dispatcher classifies its own errors; this is a last-resort net so
      // a bug in classification cannot leave a task locked until its lease dies.
      outcome = {
        status: 'failed',
        retryable: true,
        note: `worker error while running task: ${message(error)}`,
      };
    }
    const seconds = Number(((Date.now() - started) / 1000).toFixed(1));

    if (outcome.status === 'succeeded') {
      const applied = await completeTask(this.db, task.id, 'SUCCEEDED', { workerId: this.workerId });
      logger.info('task succeeded', { seconds, applied, note: outcome.note });
      return;
    }
    const result = await failTask(this.db, task.id, outcome.note, {
      retryable: outcome.retryable,
      ...(outcome.retryAt ? { retryAt: outcome.retryAt } : {}),
      workerId: this.workerId,
    });
    logger.warn('task failed', {
      seconds,
      applied: result.applied,
      status: result.status,
      retryAt: result.retryAt?.toISOString(),
      note: outcome.note,
    });
  }

  /**
   * Keep leases alive while tasks run, and retire the lease of any run that
   * exceeded WORKER_TASK_MAX_MS so the queue can hand it to another worker.
   */
  private async heartbeat(): Promise<void> {
    const now = Date.now();
    for (const entry of this.inFlight.values()) {
      if (entry.leaseRetired) continue;
      const ageMs = now - entry.startedAt;
      if (ageMs > this.env.WORKER_TASK_MAX_MS) {
        entry.leaseRetired = true;
        this.log.error('task exceeded WORKER_TASK_MAX_MS; no longer renewing its lease', {
          taskId: entry.taskId,
          kind: entry.kind,
          ageMs,
        });
        await recordEvent(this.db, {
          eventType: 'task_overrun',
          reason: `task ${entry.kind} exceeded WORKER_TASK_MAX_MS (${this.env.WORKER_TASK_MAX_MS} ms); lease left to expire so another worker can recover it`,
          taskId: entry.taskId,
          evidence: { kind: entry.kind, ageMs, maxMs: this.env.WORKER_TASK_MAX_MS },
        }).catch((error) => this.log.error('failed to record task_overrun event', { error: message(error) }));
        continue;
      }
      const renewed = await renewLease(this.db, entry.taskId, this.workerId, this.env.WORKER_LEASE_MS).catch(
        (error) => {
          this.log.error('lease renewal failed', { taskId: entry.taskId, error: message(error) });
          return true; // transient database errors should not retire a healthy lease
        },
      );
      if (!renewed) {
        entry.leaseRetired = true;
        this.log.warn('lease lost while running; this run\u2019s result will be discarded', {
          taskId: entry.taskId,
          kind: entry.kind,
        });
      }
    }
  }

  private async drain(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
    if (this.inFlight.size === 0) {
      this.log.info('worker stopped');
      return;
    }
    this.log.info('waiting for in-flight tasks before exiting', {
      count: this.inFlight.size,
      graceMs: SHUTDOWN_GRACE_MS,
    });
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    while (this.inFlight.size > 0 && Date.now() < deadline) await delay(500);
    if (this.inFlight.size > 0) {
      this.log.warn('exiting with tasks still running; their leases expire and another worker recovers them', {
        tasks: [...this.inFlight.values()].map((entry) => ({ taskId: entry.taskId, kind: entry.kind })),
      });
    } else {
      this.log.info('worker stopped cleanly');
    }
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDb();
  const worker = new Worker({ db, client: GitHubClient.fromEnv(), env });
  process.once('SIGINT', () => worker.requestStop('SIGINT'));
  process.once('SIGTERM', () => worker.requestStop('SIGTERM'));
  try {
    await worker.run();
  } finally {
    await db.$disconnect();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? (process.env['DEBUG'] ? error.stack : error.message) : error);
    process.exit(1);
  });
}

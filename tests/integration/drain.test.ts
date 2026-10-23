import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPrismaClient } from '@/db/client';
import type { GitHubClient } from '@/github/client';
import { enqueue } from '@/workflow/queue';
import { drainQueue } from '@/worker/drain';

const url = process.env['TEST_DATABASE_URL'];
const describeDb = url ? describe : describe.skip;
const db = url ? createPrismaClient(url) : null;
const client = {} as GitHubClient;
const keys: string[] = [];

afterAll(async () => {
  if (db) {
    await db.task.deleteMany({ where: { dedupeKey: { in: keys } } });
    await db.$disconnect();
  }
});

async function queue(kind: 'DISCOVER_PROJECTS' | 'IMPLEMENT_CONTRIBUTION') {
  const dedupeKey = `drain-test:${randomUUID()}`;
  keys.push(dedupeKey);
  await enqueue(db!, { kind, dedupeKey, priority: 1 });
  return dedupeKey;
}

describeDb('drainQueue', () => {
  it('runs only the requested kinds and records the outcome', async () => {
    const wanted = await queue('DISCOVER_PROJECTS');
    const other = await queue('IMPLEMENT_CONTRIBUTION');
    const ran: string[] = [];
    const result = await drainQueue(db!, client, {
      workerId: 'test-drain',
      kinds: ['DISCOVER_PROJECTS'],
      claimBudgetMs: 5_000,
      leaseMs: 60_000,
      run: async (_db, _client, task) => {
        ran.push(task.dedupeKey);
        return { status: 'succeeded', retryable: false, note: 'ok' };
      },
    });
    expect(ran).toContain(wanted);
    expect(ran).not.toContain(other);
    expect(result.failed).toBe(0);
    expect((await db!.task.findUniqueOrThrow({ where: { dedupeKey: wanted } })).status).toBe('SUCCEEDED');
    expect((await db!.task.findUniqueOrThrow({ where: { dedupeKey: other } })).status).toBe('PENDING');
  });

  it('marks a failing task and keeps draining', async () => {
    const key = await queue('DISCOVER_PROJECTS');
    const result = await drainQueue(db!, client, {
      workerId: 'test-drain',
      kinds: ['DISCOVER_PROJECTS'],
      claimBudgetMs: 5_000,
      leaseMs: 60_000,
      run: async () => {
        throw new Error('boom');
      },
    });
    expect(result.failed).toBeGreaterThan(0);
    const task = await db!.task.findUniqueOrThrow({ where: { dedupeKey: key } });
    expect(task.lastError).toContain('boom');
  });
});

import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPrismaClient } from '@/db/client';

/**
 * Regression test for a subtle but destructive bug: `@prisma/adapter-pg`
 * formats JS Dates as naive UTC strings and parses timestamptz text by
 * replacing the server offset with +00:00. If the PostgreSQL session is not
 * UTC, every timestamp written or read through Prisma is shifted by the
 * server's timezone offset (5h45m on the development machine). The adapter
 * must pin the session to UTC.
 */
const url = process.env['TEST_DATABASE_URL'];
const describeDb = url ? describe : describe.skip;
const db = url ? createPrismaClient(url) : null;

describeDb('database timestamps', () => {
  afterAll(async () => {
    await db?.$disconnect();
  });

  it('runs in a UTC session', async () => {
    const rows = await db!.$queryRaw<Array<{ tz: string }>>`select current_setting('TimeZone') as tz`;
    expect(rows[0]?.tz).toBe('UTC');
  });

  it('does not shift SQL now() when reading it through Prisma', async () => {
    const before = Date.now();
    const rows = await db!.$queryRaw<Array<{ now: Date }>>`select now() as now`;
    const after = Date.now();
    const read = rows[0]!.now.getTime();
    expect(read).toBeGreaterThanOrEqual(before - 1_000);
    expect(read).toBeLessThanOrEqual(after + 1_000);
  });

  it('round-trips ORM Date fields without changing the instant', async () => {
    const suffix = randomUUID();
    const instant = new Date('2026-01-02T03:04:05.678Z');
    const project = await db!.project.create({
      data: {
        githubId: BigInt(`0x${suffix.replaceAll('-', '').slice(0, 12)}`),
        fullName: `tzprobe/${suffix}`,
        owner: 'tzprobe',
        name: suffix,
        defaultBranch: 'main',
        repoCreatedAt: instant,
        repoPushedAt: instant,
      },
    });
    try {
      expect(project.repoCreatedAt.toISOString()).toBe(instant.toISOString());
      expect(project.repoPushedAt.toISOString()).toBe(instant.toISOString());
      expect(Math.abs(project.firstSeenAt.getTime() - Date.now())).toBeLessThan(10_000);
    } finally {
      await db!.project.delete({ where: { id: project.id } });
    }
  });
});

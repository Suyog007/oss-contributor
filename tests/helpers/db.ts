import { afterAll, beforeEach, describe } from 'vitest';
import { createPrismaClient, type Db } from '@/db/client';

const url = process.env['TEST_DATABASE_URL'];

/** `describe` for tests that need PostgreSQL; skipped when TEST_DATABASE_URL is unset. */
export const describeDb = url ? describe : describe.skip;

// Every table, children first, so one TRUNCATE clears the whole schema.
const TABLES = [
  'PrComment',
  'PullRequest',
  'Review',
  'Revision',
  'TestRun',
  'Approval',
  'Contribution',
  'Decision',
  'Investigation',
  'Candidate',
  'RepoDigest',
  'ProjectSignal',
  'ProjectSnapshot',
  'Lesson',
  'Task',
  'WorkflowEvent',
  'LlmCache',
  'LlmCall',
  'BudgetPeriod',
  'MetricDaily',
  'Setting',
  'Project',
];

/** A Prisma client for the test database, with all tables truncated before each test. */
export function useTestDb(): () => Db {
  let db: Db | undefined;
  const get = () => {
    if (!url) throw new Error('TEST_DATABASE_URL is not set');
    db ??= createPrismaClient(url);
    return db;
  };
  beforeEach(async () => {
    await get().$executeRawUnsafe(
      `TRUNCATE ${TABLES.map((table) => `"${table}"`).join(', ')} RESTART IDENTITY CASCADE`,
    );
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  return get;
}

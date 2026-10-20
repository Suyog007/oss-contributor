import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import { loadEnv } from '@/config/env';

export type Db = PrismaClient;

export function createPrismaClient(connectionString: string): PrismaClient {
  // @prisma/adapter-pg serializes JS Dates as naive UTC strings and parses
  // timestamptz text by replacing its offset with +00:00. Both are only
  // correct when the PostgreSQL session timezone is UTC; without this the
  // server's local timezone silently shifts every timestamp we write/read.
  const adapter = new PrismaPg({
    connectionString,
    options: '-c timezone=UTC',
  });
  return new PrismaClient({ adapter });
}

// Reuse one client across hot reloads in development and across invocations of
// a warm worker process.
const globalForPrisma = globalThis as unknown as { __ossContributorPrisma?: PrismaClient };

export function getDb(): PrismaClient {
  if (!globalForPrisma.__ossContributorPrisma) {
    globalForPrisma.__ossContributorPrisma = createPrismaClient(loadEnv().DATABASE_URL);
  }
  return globalForPrisma.__ossContributorPrisma;
}

/** Fresh client for scripts and tests that manage their own connection. */
export function createDb(): PrismaClient {
  return createPrismaClient(loadEnv().DATABASE_URL);
}

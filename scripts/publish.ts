/**
 * Publish a prepared submission.
 *
 *   pnpm publish --contribution <id>            # dry run, no network writes
 *   pnpm publish --contribution <id> --execute  # push/open, requires approvals
 *
 * The dry run verifies the workspace and reports exactly which approvals are
 * missing. --execute can push a branch, force-push a revision, and open a pull
 * request; it never posts a comment.
 */
import 'dotenv/config';
import { createDb } from '@/db/client';
import { loadEnv } from '@/config/env';
import { publishContribution } from '@/workflows/publish';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const contributionId = flag('contribution');
  if (!contributionId) {
    console.error('usage: pnpm publish --contribution <id> [--execute]');
    process.exit(1);
  }
  const db = createDb();
  try {
    const result = await publishContribution(db, contributionId, {
      execute: process.argv.includes('--execute'),
      env: loadEnv(),
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'awaiting-approval') {
      console.error(
        `No external action was taken. Missing approvals: ${result.missingApprovals.join(', ') || result.actions.join(', ')}`,
      );
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

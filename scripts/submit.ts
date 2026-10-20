/**
 * Prepare a contribution for human approval.
 *
 *   pnpm submit --contribution <id> [--deterministic] [--fork-owner <login>]
 *
 * This writes the exact PR title/body and binds every external action to a
 * hash. It does not push, open, or comment. Run `pnpm approve` next.
 */
import 'dotenv/config';
import { createDb } from '@/db/client';
import { loadEnv } from '@/config/env';
import { prepareSubmission } from '@/workflows/approval';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const contributionId = flag('contribution');
  if (!contributionId) {
    console.error('usage: pnpm submit --contribution <id> [--deterministic] [--fork-owner <login>]');
    process.exit(1);
  }
  const db = createDb();
  try {
    const result = await prepareSubmission(db, contributionId, {
      env: loadEnv(),
      ...(flag('fork-owner') ? { forkOwner: flag('fork-owner') } : {}),
      deterministicNarrative: process.argv.includes('--deterministic'),
    });
    console.log(`Prepared submission for ${result.contributionId}`);
    console.log(`  actions: ${result.actions.join(', ')}`);
    for (const action of result.actions) {
      console.log(`  ${action}: ${result.artifactHashes[action]}`);
    }
    console.log(`  ready:   ${result.readyToPublish ? 'yes (all approvals granted)' : 'no'}`);
    if (result.warnings.length > 0) {
      console.log('  warnings:');
      for (const warning of result.warnings) console.log(`    - ${warning}`);
    }
    console.log('\nApprovals:');
    for (const approval of result.approvals) {
      console.log(
        `  ${approval.action.padEnd(18)} ${approval.status.padEnd(9)} ${approval.artifactHash}  expires ${approval.expiresAt?.toISOString() ?? 'never'}`,
      );
    }
    console.log('\nPR title:');
    console.log(result.prTitle);
    console.log('\nPR body:');
    console.log(result.prBody);
    console.log('\nNext:');
    for (const approval of result.approvals.filter((item) => item.status === 'PENDING')) {
      console.log(
        `  pnpm approve --contribution ${contributionId} --action ${approval.action} --by "<your name>" --hash ${approval.artifactHash}`,
      );
    }
    if (result.approvals.every((approval) => approval.status === 'GRANTED')) {
      console.log(`  pnpm publish --contribution ${contributionId} --execute`);
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

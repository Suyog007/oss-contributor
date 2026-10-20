/**
 * Approve, deny, or list the external actions requested for a contribution.
 *
 *   pnpm approve --contribution <id>
 *   pnpm approve --contribution <id> --action PUBLISH_BRANCH --by "Your Name"
 *   pnpm approve --contribution <id> --action OPEN_PULL_REQUEST --by "Your Name" --hash <hash>
 *   pnpm approve --contribution <id> --action OPEN_PULL_REQUEST --by "Your Name" --deny --note "reason"
 *
 * Approvals are bound to the artifact hash printed by `pnpm submit`; passing
 * --hash is optional but recommended, and a mismatched hash is refused.
 */
import 'dotenv/config';
import { createDb } from '@/db/client';
import { decideApproval, listApprovals } from '@/workflows/approval';
import type { ApprovalAction } from '@/generated/prisma/enums';

const ACTIONS: ApprovalAction[] = [
  'PUBLISH_BRANCH',
  'OPEN_PULL_REQUEST',
  'PUSH_REVISION',
  'POST_COMMENT',
];

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const contributionId = flag('contribution');
  if (!contributionId) {
    console.error('usage: pnpm approve --contribution <id> [--action <action> --by <name> [--hash <hash>] [--deny] [--note <text>]]');
    process.exit(1);
  }
  const db = createDb();
  try {
    const action = flag('action')?.toUpperCase();
    if (!action) {
      const approvals = await listApprovals(db, contributionId);
      if (approvals.length === 0) {
        console.log('No approvals have been requested. Run `pnpm submit` first.');
        return;
      }
      for (const approval of approvals) {
        console.log(
          [
            approval.action.padEnd(18),
            approval.status.padEnd(9),
            approval.artifactHash,
            approval.expiresAt ? `expires ${approval.expiresAt.toISOString()}` : 'no expiry',
            approval.decidedBy ? `by ${approval.decidedBy}` : '',
            approval.note ? `(${approval.note})` : '',
          ]
            .filter(Boolean)
            .join('  '),
        );
      }
      return;
    }
    if (!ACTIONS.includes(action as ApprovalAction)) {
      console.error(`unknown action ${action}; expected one of ${ACTIONS.join(', ')}`);
      process.exit(1);
    }
    const decidedBy = flag('by');
    if (!decidedBy) {
      console.error('--by <your name> is required: approvals are attributed to a human');
      process.exit(1);
    }
    const result = await decideApproval(db, {
      contributionId,
      action: action as ApprovalAction,
      decision: process.argv.includes('--deny') ? 'DENIED' : 'GRANTED',
      decidedBy,
      ...(flag('hash') ? { artifactHash: flag('hash')! } : {}),
      ...(flag('note') ? { note: flag('note')! } : {}),
    });
    console.log(`${result.action} is now ${result.status} (artifact ${result.artifactHash})`);
    if (result.status === 'GRANTED') {
      console.log('Publishing still requires a separate `pnpm publish --execute` invocation.');
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

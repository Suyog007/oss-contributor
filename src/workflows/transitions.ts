import type { Db } from '@/db/client';
import type { Prisma } from '@/generated/prisma/client';
import type { ContributionState } from '@/generated/prisma/enums';
import { recordEvent } from '@/workflow/events';

/**
 * One place that moves a contribution between states, so every transition is
 * recorded with the same shape: from, to, reason, actor, and optional data.
 */
export async function transitionContribution(
  db: Db,
  args: {
    contributionId: string;
    projectId: string;
    candidateId?: string | null;
    fromState: ContributionState;
    toState: ContributionState;
    reason: string;
    actor?: string;
    actorKind?: 'SYSTEM' | 'AGENT' | 'HUMAN' | 'OPERATOR';
    data?: Prisma.ContributionUpdateInput;
  },
): Promise<void> {
  await db.contribution.update({
    where: { id: args.contributionId },
    data: {
      state: args.toState,
      stateReason: args.reason.slice(0, 1000),
      ...(args.data ?? {}),
    },
  });
  await recordEvent(db, {
    eventType: 'contribution_state',
    reason: args.reason.slice(0, 1000),
    projectId: args.projectId,
    candidateId: args.candidateId ?? null,
    contributionId: args.contributionId,
    fromState: args.fromState,
    toState: args.toState,
    actorKind: args.actorKind ?? 'AGENT',
    actor: args.actor ?? 'orchestrator',
  });
}

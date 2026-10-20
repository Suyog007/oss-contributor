import type { ActorKind, Prisma } from '@/generated/prisma/client';
import type { Db } from '@/db/client';

export interface WorkflowEventInput {
  eventType: string;
  reason: string;
  actorKind?: ActorKind;
  actor?: string;
  projectId?: string | null;
  candidateId?: string | null;
  contributionId?: string | null;
  taskId?: string | null;
  fromState?: string | null;
  toState?: string | null;
  evidence?: Prisma.InputJsonValue | null;
  securityRelevant?: boolean;
}

/**
 * Append-only audit trail. Every state transition, decision, approval, publish,
 * failure, and security-relevant observation is recorded with a reason. Nothing
 * in the system deletes events; the dashboard reads them directly.
 */
export async function recordEvent(db: Db, input: WorkflowEventInput): Promise<void> {
  await db.workflowEvent.create({
    data: {
      eventType: input.eventType,
      reason: input.reason,
      actorKind: input.actorKind ?? 'SYSTEM',
      actor: input.actor ?? 'orchestrator',
      projectId: input.projectId ?? null,
      candidateId: input.candidateId ?? null,
      contributionId: input.contributionId ?? null,
      taskId: input.taskId ?? null,
      fromState: input.fromState ?? null,
      toState: input.toState ?? null,
      evidence: input.evidence ?? undefined,
      securityRelevant: input.securityRelevant ?? false,
    },
  });
}

export interface SecurityEventInput {
  reason: string;
  detail: string;
  projectId?: string | null;
  contributionId?: string | null;
  evidence?: Record<string, unknown>;
}

/**
 * Security-relevant events get their own helper so they are never buried and
 * are easy to filter in the dashboard and in incident review.
 */
export async function recordSecurityEvent(db: Db, input: SecurityEventInput): Promise<void> {
  await recordEvent(db, {
    eventType: 'security',
    reason: input.reason,
    actor: 'security-monitor',
    projectId: input.projectId ?? null,
    contributionId: input.contributionId ?? null,
    evidence: { detail: input.detail, ...(input.evidence ?? {}) },
    securityRelevant: true,
  });
}

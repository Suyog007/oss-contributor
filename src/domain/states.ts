import type { ContributionState } from '@/generated/prisma/enums';

/**
 * Workflow state machine.
 *
 * The orchestrator never mutates a contribution state directly: it names an
 * event, and this table decides whether that event is legal from the current
 * state. Illegal transitions are a bug, not a runtime condition, so they raise
 * instead of silently no-op.
 */

export type WorkflowState = ContributionState;

export type WorkflowEvent =
  | 'implementation_started'
  | 'implementation_failed'
  | 'implementation_paused'
  | 'tests_completed'
  | 'review_completed'
  | 'review_blocked'
  | 'revision_limit_reached'
  | 'revision_started'
  | 'marked_ready'
  | 'approval_requested'
  | 'approval_granted'
  | 'approval_denied'
  | 'approval_expired'
  | 'published'
  | 'publish_failed'
  | 'maintainer_feedback'
  | 'pr_merged'
  | 'pr_closed'
  | 'merge_conflict'
  | 'duplicate_found'
  | 'candidate_rejected'
  | 'needs_maintainer_input'
  | 'retryable_error'
  | 'rate_limited'
  | 'budget_exhausted'
  | 'cancelled'
  | 'abandoned'
  | 'operator_retry';

export interface TransitionContext {
  revisionRound: number;
  maxRevisionRounds: number;
}

type Guard = (ctx: TransitionContext) => boolean;

interface Transition {
  to: WorkflowState;
  note: string;
  guard?: Guard;
  /** Recorded when the guard fails, so failures explain themselves. */
  guardDescription?: string;
}

const underRevisionLimit: Guard = (ctx) => ctx.revisionRound < ctx.maxRevisionRounds;
const overRevisionLimit: Guard = (ctx) => ctx.revisionRound >= ctx.maxRevisionRounds;

const TABLE: Record<WorkflowState, Partial<Record<WorkflowEvent, Transition>>> = {
  APPROVED_FOR_IMPLEMENTATION: {
    implementation_started: { to: 'IMPLEMENTING', note: 'solution agent picked up the candidate' },
    duplicate_found: { to: 'DUPLICATE', note: 'duplicate work discovered before implementation' },
    needs_maintainer_input: {
      to: 'NEEDS_MAINTAINER_INPUT',
      note: 'implementation needs a maintainer decision first',
    },
    candidate_rejected: { to: 'REJECTED_CANDIDATE', note: 'candidate withdrawn before implementation' },
    budget_exhausted: { to: 'FAILED', note: 'contribution budget exhausted before implementation' },
    retryable_error: { to: 'RETRYABLE_ERROR', note: 'setup failed in a retryable way' },
    rate_limited: { to: 'RATE_LIMITED', note: 'GitHub rate limit hit during setup' },
    cancelled: { to: 'CANCELLED', note: 'cancelled by operator' },
  },
  IMPLEMENTING: {
    tests_completed: { to: 'TESTING', note: 'change written; running the project suite' },
    implementation_paused: {
      to: 'RETRYABLE_ERROR',
      note: 'implementation paused: environment or reproduction blocked',
    },
    implementation_failed: { to: 'FAILED', note: 'implementation could not produce a change' },
    needs_maintainer_input: {
      to: 'NEEDS_MAINTAINER_INPUT',
      note: 'implementation uncovered a design question for maintainers',
    },
    budget_exhausted: { to: 'FAILED', note: 'contribution budget exhausted during implementation' },
    cancelled: { to: 'CANCELLED', note: 'cancelled by operator' },
    abandoned: { to: 'ABANDONED', note: 'abandoned; workspace kept for inspection' },
  },
  TESTING: {
    review_completed: { to: 'INDEPENDENT_REVIEW', note: 'tests finished; reviews requested' },
    implementation_failed: { to: 'FAILED', note: 'tests could not complete in the sandbox' },
    budget_exhausted: { to: 'FAILED', note: 'budget exhausted during testing' },
    cancelled: { to: 'CANCELLED', note: 'cancelled by operator' },
  },
  INDEPENDENT_REVIEW: {
    marked_ready: {
      to: 'READY_FOR_SUBMISSION',
      note: 'no blocking findings; change is ready for submission',
    },
    review_blocked: {
      to: 'REVISION_REQUIRED',
      note: 'blocking findings found; revision requested',
      guard: underRevisionLimit,
      guardDescription: 'revision rounds remain',
    },
    revision_limit_reached: {
      to: 'FAILED',
      note: 'blocking findings remain after the maximum number of revision rounds',
      guard: overRevisionLimit,
      guardDescription: 'revision rounds exhausted',
    },
    needs_maintainer_input: {
      to: 'NEEDS_MAINTAINER_INPUT',
      note: 'reviewers could not resolve a substantive disagreement',
    },
    budget_exhausted: { to: 'FAILED', note: 'budget exhausted during review' },
    cancelled: { to: 'CANCELLED', note: 'cancelled by operator' },
  },
  REVISION_REQUIRED: {
    revision_started: { to: 'IMPLEMENTING', note: 'solution agent started a revision' },
    implementation_failed: { to: 'FAILED', note: 'revision failed' },
    budget_exhausted: { to: 'FAILED', note: 'budget exhausted during revision' },
    cancelled: { to: 'CANCELLED', note: 'cancelled by operator' },
    abandoned: { to: 'ABANDONED', note: 'abandoned; findings recorded' },
  },
  READY_FOR_SUBMISSION: {
    approval_requested: {
      to: 'HUMAN_APPROVAL',
      note: 'approval requested for publishing the branch and opening the PR',
    },
    review_blocked: { to: 'REVISION_REQUIRED', note: 'a later finding invalidated readiness' },
    candidate_rejected: { to: 'REJECTED_CANDIDATE', note: 'withdrawn before submission' },
    duplicate_found: { to: 'DUPLICATE', note: 'duplicate discovered before submission' },
    cancelled: { to: 'CANCELLED', note: 'cancelled by operator' },
  },
  HUMAN_APPROVAL: {
    approval_granted: { to: 'READY_FOR_SUBMISSION', note: 'approval recorded; publish may proceed' },
    approval_denied: { to: 'ABANDONED', note: 'operator denied the submission' },
    approval_expired: { to: 'READY_FOR_SUBMISSION', note: 'approval expired; a fresh one is required' },
    duplicate_found: { to: 'DUPLICATE', note: 'duplicate discovered while awaiting approval' },
    cancelled: { to: 'CANCELLED', note: 'cancelled by operator' },
  },
  PR_SUBMITTED: {
    maintainer_feedback: { to: 'FEEDBACK_RECEIVED', note: 'a maintainer responded' },
    pr_merged: { to: 'MERGED', note: 'pull request merged' },
    pr_closed: { to: 'CLOSED_UNMERGED', note: 'pull request closed without merging' },
    merge_conflict: { to: 'MERGE_CONFLICT', note: 'base branch moved and the PR conflicts' },
    cancelled: { to: 'CANCELLED', note: 'PR withdrawn by operator' },
  },
  AWAITING_REVIEW: {
    maintainer_feedback: { to: 'FEEDBACK_RECEIVED', note: 'a maintainer responded' },
    pr_merged: { to: 'MERGED', note: 'pull request merged' },
    pr_closed: { to: 'CLOSED_UNMERGED', note: 'pull request closed without merging' },
    merge_conflict: { to: 'MERGE_CONFLICT', note: 'base branch moved and the PR conflicts' },
    abandoned: { to: 'ABANDONED', note: 'no response; contribution abandoned by policy' },
    cancelled: { to: 'CANCELLED', note: 'PR withdrawn by operator' },
  },
  FEEDBACK_RECEIVED: {
    review_blocked: {
      to: 'REVISION_REQUIRED',
      note: 'maintainer requested changes; revision required',
      guard: underRevisionLimit,
      guardDescription: 'revision rounds remain',
    },
    revision_limit_reached: {
      to: 'FAILED',
      note: 'maintainer requested more changes than the revision budget allows',
      guard: overRevisionLimit,
      guardDescription: 'revision rounds exhausted',
    },
    needs_maintainer_input: {
      to: 'NEEDS_MAINTAINER_INPUT',
      note: 'feedback was ambiguous or conflicted with project requirements',
    },
    marked_ready: { to: 'AWAITING_REVIEW', note: 'feedback handled without code changes' },
    pr_merged: { to: 'MERGED', note: 'pull request merged' },
    pr_closed: { to: 'CLOSED_UNMERGED', note: 'pull request closed without merging' },
    cancelled: { to: 'CANCELLED', note: 'PR withdrawn by operator' },
  },
  MERGE_CONFLICT: {
    review_blocked: {
      to: 'REVISION_REQUIRED',
      note: 'rebasing onto the new base requires a revision',
      guard: underRevisionLimit,
      guardDescription: 'revision rounds remain',
    },
    pr_merged: { to: 'MERGED', note: 'merged despite the conflict signal' },
    pr_closed: { to: 'CLOSED_UNMERGED', note: 'closed without merging' },
    abandoned: { to: 'ABANDONED', note: 'conflict left unresolved' },
    cancelled: { to: 'CANCELLED', note: 'PR withdrawn by operator' },
  },
  RETRYABLE_ERROR: {
    operator_retry: { to: 'APPROVED_FOR_IMPLEMENTATION', note: 'retry requested' },
    implementation_failed: { to: 'FAILED', note: 'retries exhausted' },
    cancelled: { to: 'CANCELLED', note: 'cancelled by operator' },
    abandoned: { to: 'ABANDONED', note: 'abandoned after repeated failures' },
  },
  RATE_LIMITED: {
    operator_retry: { to: 'APPROVED_FOR_IMPLEMENTATION', note: 'retry after the rate limit reset' },
    retryable_error: { to: 'RETRYABLE_ERROR', note: 'rate limit persisted' },
    cancelled: { to: 'CANCELLED', note: 'cancelled by operator' },
  },
  NEEDS_MAINTAINER_INPUT: {
    marked_ready: {
      to: 'APPROVED_FOR_IMPLEMENTATION',
      note: 'maintainer answered; implementation may proceed',
    },
    operator_retry: { to: 'APPROVED_FOR_IMPLEMENTATION', note: 'operator cleared the blocker' },
    candidate_rejected: { to: 'REJECTED_CANDIDATE', note: 'maintainer declined the proposal' },
    cancelled: { to: 'CANCELLED', note: 'cancelled by operator' },
    abandoned: { to: 'ABANDONED', note: 'no maintainer response; abandoned' },
  },
  // Terminal states. Only an explicit operator retry can leave them.
  RESOLVED: {},
  MERGED: {},
  CLOSED_UNMERGED: {},
  REJECTED_CANDIDATE: {},
  DUPLICATE: {},
  FAILED: {
    operator_retry: { to: 'APPROVED_FOR_IMPLEMENTATION', note: 'operator requested a retry' },
  },
  ABANDONED: {
    operator_retry: { to: 'APPROVED_FOR_IMPLEMENTATION', note: 'operator revived the contribution' },
  },
  CANCELLED: {
    operator_retry: { to: 'APPROVED_FOR_IMPLEMENTATION', note: 'operator revived the contribution' },
  },
};

export const TERMINAL_STATES: WorkflowState[] = [
  'RESOLVED',
  'MERGED',
  'CLOSED_UNMERGED',
  'REJECTED_CANDIDATE',
  'DUPLICATE',
  'FAILED',
  'ABANDONED',
  'CANCELLED',
];

export const ALL_STATES = Object.keys(TABLE) as WorkflowState[];

export function isTerminal(state: WorkflowState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function isExternallyVisible(state: WorkflowState): boolean {
  return [
    'PR_SUBMITTED',
    'AWAITING_REVIEW',
    'FEEDBACK_RECEIVED',
    'MERGE_CONFLICT',
    'MERGED',
    'CLOSED_UNMERGED',
    'RESOLVED',
  ].includes(state);
}

export type TransitionResult =
  | { ok: true; to: WorkflowState; note: string }
  | { ok: false; reason: string };

export function transition(
  from: WorkflowState,
  event: WorkflowEvent,
  ctx: TransitionContext,
): TransitionResult {
  const row = TABLE[from];
  if (!row) return { ok: false, reason: `unknown state ${from}` };
  const candidate = row[event];
  if (!candidate) {
    return { ok: false, reason: `event ${event} is not valid in state ${from}` };
  }
  if (candidate.guard && !candidate.guard(ctx)) {
    return {
      ok: false,
      reason: `guard failed for ${from} --${event}--> ${candidate.to} (${candidate.guardDescription ?? 'guard'})`,
    };
  }
  return { ok: true, to: candidate.to, note: candidate.note };
}

/** Every event that is legal from a state; used by scripts and the dashboard. */
export function legalEvents(from: WorkflowState): WorkflowEvent[] {
  return Object.keys(TABLE[from] ?? {}) as WorkflowEvent[];
}

import { loadEnv, type Env } from './env';

/**
 * Autonomy policy.
 *
 * The default posture is `approval_required`: nothing that becomes visible
 * outside this machine happens without a recorded human approval bound to the
 * exact artifact (diff hash, comment body hash) that was reviewed.
 *
 * `low_risk_autonomous` unlocks only the actions explicitly listed in
 * AUTONOMY_ALLOWED_ACTIONS, and `full_autonomous` is documented but not the
 * default because the specification requires an explicit opt-in.
 */

export type ExternalAction = 'publish_branch' | 'open_pull_request' | 'push_revision' | 'post_comment';

export type AutonomyLevel = Env['AUTONOMY_LEVEL'];

const ACTION_ENV_NAMES: Record<ExternalAction, string> = {
  publish_branch: 'PUBLISH_BRANCH',
  open_pull_request: 'OPEN_PULL_REQUEST',
  push_revision: 'PUSH_REVISION',
  post_comment: 'POST_COMMENT',
};

export interface PolicySnapshot {
  version: string;
  autonomyLevel: AutonomyLevel;
  requiresApproval: Record<ExternalAction, boolean>;
  dailyBudgetUsd: number;
  monthlyBudgetUsd: number;
  contributionBudgetUsd: number;
  candidateBudgetUsd: number;
  maxRevisionRounds: number;
  sandboxMode: Env['SANDBOX_MODE'];
  sandboxNetwork: boolean;
}

export function requiresApproval(
  action: ExternalAction,
  env: Env = loadEnv(),
): boolean {
  if (env.AUTONOMY_LEVEL === 'approval_required') return true;
  const envName = ACTION_ENV_NAMES[action];
  const listed = env.AUTONOMY_ALLOWED_ACTIONS.includes(envName);
  if (env.AUTONOMY_LEVEL === 'low_risk_autonomous') return !listed;
  return !listed;
}

/**
 * The policy version is part of decision records: when budgets or autonomy
 * change, past decisions stay interpretable against the policy that produced
 * them.
 */
export function policySnapshot(env: Env = loadEnv()): PolicySnapshot {
  const actions: ExternalAction[] = [
    'publish_branch',
    'open_pull_request',
    'push_revision',
    'post_comment',
  ];
  const requiresApprovalMap = Object.fromEntries(
    actions.map((action) => [action, requiresApproval(action, env)]),
  ) as Record<ExternalAction, boolean>;

  const version = [
    `autonomy=${env.AUTONOMY_LEVEL}`,
    `allowed=${[...env.AUTONOMY_ALLOWED_ACTIONS].sort().join('|')}`,
    `budget=d${env.AI_DAILY_BUDGET_USD}/m${env.AI_MONTHLY_BUDGET_USD}/c${env.AI_CONTRIBUTION_BUDGET_USD}`,
    `rounds=${env.MAX_REVISION_ROUNDS}`,
    `sandbox=${env.SANDBOX_MODE}${env.SANDBOX_ALLOW_NETWORK ? '+net' : ''}`,
  ].join(';');

  return {
    version,
    autonomyLevel: env.AUTONOMY_LEVEL,
    requiresApproval: requiresApprovalMap,
    dailyBudgetUsd: env.AI_DAILY_BUDGET_USD,
    monthlyBudgetUsd: env.AI_MONTHLY_BUDGET_USD,
    contributionBudgetUsd: env.AI_CONTRIBUTION_BUDGET_USD,
    candidateBudgetUsd: env.AI_CANDIDATE_BUDGET_USD,
    maxRevisionRounds: env.MAX_REVISION_ROUNDS,
    sandboxMode: env.SANDBOX_MODE,
    sandboxNetwork: env.SANDBOX_ALLOW_NETWORK,
  };
}

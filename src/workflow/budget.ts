import type { Db } from '@/db/client';
import { loadEnv } from '@/config/env';
import { createLogger } from '@/lib/logger';

const log = createLogger('budget');

export class BudgetExceededError extends Error {
  readonly scope: string;
  readonly detail: string;
  constructor(scope: string, detail: string) {
    super(`budget exhausted (${scope}): ${detail}`);
    this.name = 'BudgetExceededError';
    this.scope = scope;
    this.detail = detail;
  }
}

export interface BudgetSubject {
  projectId?: string | null;
  candidateId?: string | null;
  contributionId?: string | null;
}

export interface BudgetStatus {
  dailySpentUsd: number;
  dailyLimitUsd: number;
  monthlySpentUsd: number;
  monthlyLimitUsd: number;
  contributionSpentUsd?: number;
  contributionLimitUsd?: number;
  candidateSpentUsd?: number;
  candidateLimitUsd?: number;
}

/** Calendar key in the configured budget time zone, e.g. "2026-10-18". */
export function periodKeys(now: Date, timeZone: string): { day: string; month: string } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const day = formatter.format(now);
  return { day, month: day.slice(0, 7) };
}

/**
 * Cost guard.
 *
 * Counters live in the database rather than in memory, so a worker restart or a
 * retried task cannot spend the budget twice. The guard checks *before* a call
 * (against the estimated cost) and charges *after* it with real usage.
 */
export class BudgetGuard {
  private constructor(
    private readonly db: Db,
    private readonly timeZone: string,
    private readonly limits: {
      daily: number;
      monthly: number;
      contribution: number;
      candidate: number;
    },
  ) {}

  static fromEnv(db: Db): BudgetGuard {
    const env = loadEnv();
    return new BudgetGuard(db, env.AI_BUDGET_TIMEZONE, {
      daily: env.AI_DAILY_BUDGET_USD,
      monthly: env.AI_MONTHLY_BUDGET_USD,
      contribution: env.AI_CONTRIBUTION_BUDGET_USD,
      candidate: env.AI_CANDIDATE_BUDGET_USD,
    });
  }

  async status(subject: BudgetSubject, now = new Date()): Promise<BudgetStatus> {
    const { day, month } = periodKeys(now, this.timeZone);
    const rows = await this.db.budgetPeriod.findMany({
      where: {
        OR: [
          { scope: 'GLOBAL', periodKey: { in: [day, month] } },
          ...(subject.contributionId
            ? [{ scope: 'CONTRIBUTION' as const, scopeRef: subject.contributionId }]
            : []),
          ...(subject.candidateId
            ? [{ scope: 'CANDIDATE' as const, scopeRef: subject.candidateId }]
            : []),
        ],
      },
    });
    const pick = (scope: string, ref: string, key: string) =>
      rows.find((row) => row.scope === scope && row.scopeRef === ref && row.periodKey === key);

    const daily = pick('GLOBAL', '', day);
    const monthly = pick('GLOBAL', '', month);
    const contribution = subject.contributionId
      ? pick('CONTRIBUTION', subject.contributionId, 'total')
      : undefined;
    const candidate = subject.candidateId
      ? pick('CANDIDATE', subject.candidateId, 'total')
      : undefined;

    return {
      dailySpentUsd: Number(daily?.spentUsd ?? 0),
      dailyLimitUsd: this.limits.daily,
      monthlySpentUsd: Number(monthly?.spentUsd ?? 0),
      monthlyLimitUsd: this.limits.monthly,
      contributionSpentUsd: contribution ? Number(contribution.spentUsd) : 0,
      contributionLimitUsd: this.limits.contribution,
      candidateSpentUsd: candidate ? Number(candidate.spentUsd) : 0,
      candidateLimitUsd: this.limits.candidate,
    };
  }

  /**
   * Throws when the estimated cost cannot be afforded. Called before every
   * model request, so an exhausted budget stops work instead of overspending.
   */
  async assertAffordable(subject: BudgetSubject, estimatedUsd: number, now = new Date()): Promise<void> {
    const status = await this.status(subject, now);
    if (status.dailySpentUsd + estimatedUsd > status.dailyLimitUsd) {
      throw new BudgetExceededError(
        'daily',
        `spent $${status.dailySpentUsd.toFixed(4)} of $${status.dailyLimitUsd.toFixed(2)}, next call needs $${estimatedUsd.toFixed(4)}`,
      );
    }
    if (status.monthlySpentUsd + estimatedUsd > status.monthlyLimitUsd) {
      throw new BudgetExceededError(
        'monthly',
        `spent $${status.monthlySpentUsd.toFixed(4)} of $${status.monthlyLimitUsd.toFixed(2)}`,
      );
    }
    if (
      subject.contributionId &&
      (status.contributionSpentUsd ?? 0) + estimatedUsd > (status.contributionLimitUsd ?? 0)
    ) {
      throw new BudgetExceededError(
        'contribution',
        `spent $${(status.contributionSpentUsd ?? 0).toFixed(4)} of $${(status.contributionLimitUsd ?? 0).toFixed(2)}`,
      );
    }
    if (
      subject.candidateId &&
      (status.candidateSpentUsd ?? 0) + estimatedUsd > (status.candidateLimitUsd ?? 0)
    ) {
      throw new BudgetExceededError(
        'candidate',
        `spent $${(status.candidateSpentUsd ?? 0).toFixed(4)} of $${(status.candidateLimitUsd ?? 0).toFixed(2)}`,
      );
    }
  }

  /** Record real spend. Called exactly once per completed or cached call. */
  async charge(
    subject: BudgetSubject,
    amountUsd: number,
    calls = 0,
    now = new Date(),
  ): Promise<void> {
    if (amountUsd <= 0 && calls === 0) return;
    const { day, month } = periodKeys(now, this.timeZone);
    const spends: Array<{
      scope: 'GLOBAL' | 'CANDIDATE' | 'CONTRIBUTION';
      scopeRef: string;
      periodKey: string;
      limit: number;
    }> = [
      { scope: 'GLOBAL', scopeRef: '', periodKey: day, limit: this.limits.daily },
      { scope: 'GLOBAL', scopeRef: '', periodKey: month, limit: this.limits.monthly },
    ];
    if (subject.contributionId) {
      spends.push({
        scope: 'CONTRIBUTION',
        scopeRef: subject.contributionId,
        periodKey: 'total',
        limit: this.limits.contribution,
      });
    }
    if (subject.candidateId) {
      spends.push({
        scope: 'CANDIDATE',
        scopeRef: subject.candidateId,
        periodKey: 'total',
        limit: this.limits.candidate,
      });
    }

    for (const spend of spends) {
      await this.db.budgetPeriod.upsert({
        where: {
          scope_scopeRef_periodKey: {
            scope: spend.scope,
            scopeRef: spend.scopeRef,
            periodKey: spend.periodKey,
          },
        },
        create: {
          scope: spend.scope,
          scopeRef: spend.scopeRef,
          periodKey: spend.periodKey,
          limitUsd: spend.limit,
          spentUsd: amountUsd,
          calls,
        },
        update: {
          spentUsd: { increment: amountUsd },
          calls: { increment: calls },
          limitUsd: spend.limit,
        },
      });
    }

    if (subject.contributionId) {
      await this.db.contribution.updateMany({
        where: { id: subject.contributionId },
        data: { costUsd: { increment: amountUsd } },
      });
    }
    if (subject.candidateId) {
      await this.db.candidate.updateMany({
        where: { id: subject.candidateId },
        data: { costUsd: { increment: amountUsd }, llmTokens: { increment: 0 } },
      });
    }
  }

  /** For the dashboard: remaining budget for the current period. */
  async remaining(now = new Date()): Promise<{ dailyUsd: number; monthlyUsd: number }> {
    const status = await this.status({}, now);
    return {
      dailyUsd: Math.max(0, status.dailyLimitUsd - status.dailySpentUsd),
      monthlyUsd: Math.max(0, status.monthlyLimitUsd - status.monthlySpentUsd),
    };
  }

  /** An operator can raise the limit for the current period without a deploy. */
  async adjustLimit(
    scope: 'GLOBAL' | 'PROJECT' | 'CANDIDATE' | 'CONTRIBUTION',
    scopeRef: string,
    periodKey: string,
    limitUsd: number,
  ): Promise<void> {
    log.info('budget limit adjusted', { scope, scopeRef, periodKey, limitUsd });
    await this.db.budgetPeriod.upsert({
      where: { scope_scopeRef_periodKey: { scope, scopeRef, periodKey } },
      create: { scope, scopeRef, periodKey, limitUsd, spentUsd: 0 },
      update: { limitUsd },
    });
  }
}

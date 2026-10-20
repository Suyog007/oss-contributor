import type { SignalKind } from '@/generated/prisma/enums';

/**
 * Deterministic discovery scoring.
 *
 * Popularity is not quality, and a star count is not a contribution
 * opportunity, so the score combines several independent observations and
 * records the reasoning behind each one. Nothing here calls a model: the LLM
 * only sees projects that already passed these numeric gates.
 */

export interface ActivitySample {
  stars: number;
  forks: number;
  watchers: number;
  openIssues: number;
  openPrs: number;
  issuesLast30d: number;
  commitsLast30d: number;
  releasesLast90d: number;
  contributors: number;
  repoCreatedAt: Date;
  repoPushedAt: Date;
  sizeKb: number;
  license: string | null;
  hasIssuesEnabled: boolean;
  archived: boolean;
  isFork: boolean;
}

export interface PreviousSample {
  capturedAt: Date;
  stars: number;
  forks: number;
  commitsLast30d: number;
  openIssues: number;
}

export interface Signal {
  kind: SignalKind;
  value: number;
  detail: string;
  evidence: Record<string, unknown>;
}

const DAY_MS = 86_400_000;

function daysBetween(a: Date, b: Date): number {
  return Math.max(1, (b.getTime() - a.getTime()) / DAY_MS);
}

export function computeSignals(
  current: ActivitySample,
  previous: PreviousSample | null,
  now: Date = new Date(),
): Signal[] {
  const signals: Signal[] = [];
  const ageDays = daysBetween(current.repoCreatedAt, now);
  const starVelocity = current.stars / ageDays;

  signals.push({
    kind: 'STAR_GROWTH_30D',
    value: previous ? (current.stars - previous.stars) / daysBetween(previous.capturedAt, now) : starVelocity,
    detail: previous
      ? `${(current.stars - previous.stars).toFixed(0)} stars since the last snapshot ${daysBetween(previous.capturedAt, now).toFixed(1)} days ago`
      : `no previous snapshot; lifetime velocity is ${starVelocity.toFixed(2)} stars/day over ${ageDays.toFixed(0)} days`,
    evidence: {
      stars: current.stars,
      previousStars: previous?.stars ?? null,
      lifetimeVelocity: Number(starVelocity.toFixed(4)),
    },
  });

  signals.push({
    kind: 'STAR_GROWTH_7D',
    value: previous ? (current.stars - previous.stars) / Math.max(1, daysBetween(previous.capturedAt, now) / 7) : starVelocity * 7,
    detail: previous
      ? `~${(((current.stars - previous.stars) / daysBetween(previous.capturedAt, now)) * 7).toFixed(0)} stars/week extrapolated from the last snapshot`
      : 'insufficient history for a weekly rate',
    evidence: { previousCapturedAt: previous?.capturedAt.toISOString() ?? null },
  });

  signals.push({
    kind: 'FORK_GROWTH_30D',
    value: previous ? (current.forks - previous.forks) / daysBetween(previous.capturedAt, now) : 0,
    detail: previous
      ? `${(current.forks - previous.forks).toFixed(0)} forks since the last snapshot`
      : 'no previous snapshot',
    evidence: { forks: current.forks, previousForks: previous?.forks ?? null },
  });

  signals.push({
    kind: 'COMMIT_ACTIVITY_30D',
    value: current.commitsLast30d,
    detail: `${current.commitsLast30d} commits in the last 30 days`,
    evidence: { commitsLast30d: current.commitsLast30d },
  });

  signals.push({
    kind: 'ISSUE_ACTIVITY_30D',
    value: current.issuesLast30d,
    detail: `${current.issuesLast30d} issues opened or updated in the last 30 days`,
    evidence: { issuesLast30d: current.issuesLast30d, openIssues: current.openIssues },
  });

  signals.push({
    kind: 'PR_ACTIVITY_30D',
    value: current.openPrs,
    detail: `${current.openPrs} open pull requests`,
    evidence: { openPrs: current.openPrs },
  });

  signals.push({
    kind: 'CONTRIBUTOR_GROWTH_30D',
    value: current.contributors,
    detail: `${current.contributors} contributors on record`,
    evidence: { contributors: current.contributors },
  });

  signals.push({
    kind: 'RELEASE_RECENCY',
    value: current.releasesLast90d,
    detail:
      current.releasesLast90d > 0
        ? `${current.releasesLast90d} releases in the last 90 days`
        : 'no release in the last 90 days',
    evidence: { releasesLast90d: current.releasesLast90d },
  });

  const stalledDays = daysBetween(current.repoPushedAt, now);
  signals.push({
    kind: 'RESPONSIVENESS',
    value: stalledDays,
    detail: `last push ${stalledDays.toFixed(0)} days ago`,
    evidence: { repoPushedAt: current.repoPushedAt.toISOString(), stalledDays: Number(stalledDays.toFixed(1)) },
  });

  const suspicion = suspicionReasons(current, previous, now);
  if (suspicion.length > 0) {
    signals.push({
      kind: 'SUSPICIOUS_ACTIVITY',
      value: suspicion.length,
      detail: suspicion.join('; '),
      evidence: { reasons: suspicion },
    });
  }

  const maintenanceGap = maintenanceGapReasons(current, stalledDays);
  if (maintenanceGap.length > 0) {
    signals.push({
      kind: 'MAINTENANCE_GAP',
      value: maintenanceGap.length,
      detail: maintenanceGap.join('; '),
      evidence: { reasons: maintenanceGap },
    });
  }

  return signals;
}

/**
 * Heuristics for attention that may not be organic. These are signals to
 * investigate, not verdicts: the dashboard shows the reasoning and the
 * operator can see exactly which observations fired.
 */
export function suspicionReasons(
  current: ActivitySample,
  previous: PreviousSample | null,
  now: Date = new Date(),
): string[] {
  const reasons: string[] = [];
  const ageDays = daysBetween(current.repoCreatedAt, now);
  const starVelocity = current.stars / ageDays;
  const recentVelocity = previous
    ? (current.stars - previous.stars) / daysBetween(previous.capturedAt, now)
    : starVelocity;

  if (starVelocity > 250) reasons.push(`lifetime star velocity is unusually high (${starVelocity.toFixed(0)}/day)`);
  if (recentVelocity > 400) reasons.push(`recent star velocity is unusually high (${recentVelocity.toFixed(0)}/day)`);
  if (ageDays < 90 && current.stars > 5000) {
    reasons.push(`very young repository (${ageDays.toFixed(0)} days) with ${current.stars} stars`);
  }
  if (current.stars > 500 && current.contributors > 0 && current.contributors < 3 && ageDays > 30) {
    reasons.push(`only ${current.contributors} contributors against ${current.stars} stars`);
  }
  if (current.commitsLast30d === 0 && current.stars > 1000) {
    reasons.push('no commits in 30 days despite significant attention');
  }
  if (current.watchers === 0 && current.stars > 1000) {
    reasons.push('no watchers reported alongside a large star count');
  }
  if (current.openIssues === 0 && current.stars > 8000 && current.commitsLast30d > 0) {
    reasons.push('no open issues at all despite high activity (unusual for a used project)');
  }
  return reasons;
}

/** Reasons a mature project looks like there is work worth doing. */
export function maintenanceGapReasons(current: ActivitySample, stalledDays: number): string[] {
  const reasons: string[] = [];
  if (current.openIssues > 60 && current.commitsLast30d > 0) {
    reasons.push(`${current.openIssues} open issues with active development`);
  }
  if (current.openPrs > 10) reasons.push(`${current.openPrs} open pull requests, suggesting review backlog`);
  if (current.commitsLast30d >= 5 && current.releasesLast90d === 0 && stalledDays < 30) {
    reasons.push('active development but no release in 90 days');
  }
  if (current.commitsLast30d > 0 && current.openIssues > 20 && current.contributors < 20) {
    reasons.push('issue load is high relative to the contributor count');
  }
  return reasons;
}

export interface ScoreInput {
  signals: Signal[];
  current: ActivitySample;
  /** From the repository digest when available: does the project run tests in CI? */
  hasTestSuite?: boolean | null;
  hasCi?: boolean | null;
  openGoodFirstIssues?: number | null;
  now?: Date;
}

export interface ScoreResult {
  score: number;
  reasons: string[];
  suspicionScore: number;
}

/**
 * Weighted, explainable 0..100 score. Every component appends a reason string
 * so the dashboard can show *why* a project was ranked where it was.
 */
export function scoreProject(input: ScoreInput): ScoreResult {
  const now = input.now ?? new Date();
  const reasons: string[] = [];
  const signal = (kind: SignalKind) => input.signals.find((entry) => entry.kind === kind);
  const current = input.current;
  const ageDays = daysBetween(current.repoCreatedAt, now);
  const stalledDays = daysBetween(current.repoPushedAt, now);

  let score = 0;

  const starVelocity = current.stars / ageDays;
  const velocityPoints = Math.min(20, Math.log10(Math.max(1, starVelocity)) * 10);
  score += velocityPoints;
  if (starVelocity >= 1) {
    reasons.push(`+${velocityPoints.toFixed(1)} star velocity ${starVelocity.toFixed(2)}/day`);
  }

  const commits = current.commitsLast30d;
  const commitPoints = Math.min(20, commits * 0.8);
  score += commitPoints;
  if (commits > 0) reasons.push(`+${commitPoints.toFixed(1)} ${commits} commits in 30 days`);
  else reasons.push('-12 no commits in the last 30 days');

  if (commits === 0) score -= 12;

  const issuePoints = Math.min(12, current.openIssues / 10);
  score += issuePoints;
  if (current.openIssues > 0) reasons.push(`+${issuePoints.toFixed(1)} ${current.openIssues} open issues`);

  const prPoints = Math.min(8, current.openPrs / 3);
  score += prPoints;
  if (current.openPrs > 0) reasons.push(`+${prPoints.toFixed(1)} ${current.openPrs} open PRs`);

  const contributorPoints = Math.min(10, current.contributors * 0.4);
  score += contributorPoints;
  if (current.contributors > 0) {
    reasons.push(`+${contributorPoints.toFixed(1)} ${current.contributors} contributors`);
  }

  const release = signal('RELEASE_RECENCY');
  if (release && release.value > 0) {
    score += Math.min(8, release.value * 2);
    reasons.push(`+${Math.min(8, release.value * 2).toFixed(1)} ${release.value} releases in 90 days`);
  }

  if (input.hasTestSuite === true) {
    score += 8;
    reasons.push('+8.0 repository has a test suite');
  } else if (input.hasTestSuite === false) {
    score -= 6;
    reasons.push('-6.0 no tests found; changes cannot be verified by the project suite');
  }
  if (input.hasCi === true) {
    score += 6;
    reasons.push('+6.0 continuous integration configured');
  }
  if ((input.openGoodFirstIssues ?? 0) > 0) {
    score += Math.min(6, (input.openGoodFirstIssues ?? 0) * 0.5);
    reasons.push(`+${Math.min(6, (input.openGoodFirstIssues ?? 0) * 0.5).toFixed(1)} ${input.openGoodFirstIssues} good-first-issue labels open`);
  }
  if (current.watchers > 50) {
    score += 4;
    reasons.push('+4.0 meaningful watcher base');
  }

  // Freshness matters more than absolute popularity for finding work to do.
  if (stalledDays <= 7) {
    score += 6;
    reasons.push('+6.0 pushed within the last week');
  } else if (stalledDays > 45) {
    score -= 15;
    reasons.push('-15.0 no push in 45 days');
  }

  if (current.sizeKb > 400_000) {
    score -= 10;
    reasons.push('-10.0 repository is very large; analysis and sandbox costs rise sharply');
  }

  const suspicious = signal('SUSPICIOUS_ACTIVITY');
  let suspicionScore = 0;
  if (suspicious) {
    suspicionScore = Math.min(100, suspicious.value * 25);
    score -= suspicionScore / 2;
    reasons.push(`-${(suspicionScore / 2).toFixed(1)} attention patterns need verification: ${suspicious.detail}`);
  }

  return {
    score: Math.max(0, Math.min(100, Number(score.toFixed(2)))),
    reasons,
    suspicionScore,
  };
}

/**
 * Hard gates evaluated before any model call. Rejections are recorded with a
 * reason so the dashboard can explain why a repository was never analyzed.
 */
export interface GateConfig {
  minStars: number;
  maxRepoSizeKb: number;
  maxDaysSincePush: number;
  /** Repositories younger than this cannot be judged: attention may be a spike. */
  minRepoAgeDays: number;
  requireLicense: boolean;
  requireTests: boolean;
}

export interface GateResult {
  accepted: boolean;
  reasons: string[];
}

export function applyGates(
  repo: {
    stars: number;
    sizeKb: number;
    pushedAt: Date;
    createdAt: Date;
    archived: boolean;
    fork: boolean;
    license: string | null;
    hasIssues: boolean;
    defaultBranch: string;
  },
  config: GateConfig,
  options: { hasTestSuite?: boolean | null; now?: Date } = {},
): GateResult {
  const now = options.now ?? new Date();
  const reasons: string[] = [];
  const daysSincePush = (now.getTime() - repo.pushedAt.getTime()) / DAY_MS;
  const repoAgeDays = (now.getTime() - repo.createdAt.getTime()) / DAY_MS;

  if (repo.archived) reasons.push('repository is archived');
  if (repo.fork) reasons.push('repository is a fork');
  if (!repo.hasIssues) reasons.push('issues are disabled, so there is nothing to report or discuss');
  if (repo.stars < config.minStars) reasons.push(`only ${repo.stars} stars (floor is ${config.minStars})`);
  if (repo.sizeKb > config.maxRepoSizeKb) reasons.push(`repository size ${repo.sizeKb}KB exceeds the limit`);
  if (daysSincePush > config.maxDaysSincePush) reasons.push(`last push was ${daysSincePush.toFixed(0)} days ago`);
  if (repoAgeDays < config.minRepoAgeDays) {
    reasons.push(
      `repository is ${repoAgeDays.toFixed(0)} days old (minimum ${config.minRepoAgeDays}); early attention is not evidence of a healthy project`,
    );
  }
  if (config.requireLicense && !repo.license) reasons.push('no license detected');
  if (!repo.defaultBranch) reasons.push('no default branch');
  if (config.requireTests && options.hasTestSuite === false) reasons.push('no tests detected');

  return { accepted: reasons.length === 0, reasons };
}

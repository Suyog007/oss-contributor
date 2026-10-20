import type { DigestPull, RepoDigest } from '@/github/repo';

/**
 * Issue triage heuristics.
 *
 * Reported issues are a *source of hypotheses*, not a work queue: an issue can
 * be stale, already fixed, assigned to someone, or described in a way that does
 * not match the code. These functions only order and filter what is worth
 * investigating; the evidence-based validation decides what is real.
 */

export interface IssueCandidate {
  number: number;
  title: string;
  labels: string[];
  comments: number;
  updatedAt: string;
  createdAt: string;
  assignees: string[];
  authorLogin: string | null;
  url: string;
  /** Deterministic 0..1 ordering score; explains itself through `reasons`. */
  priority: number;
  reasons: string[];
  signals: {
    isBug: boolean;
    isFeatureRequest: boolean;
    isQuestion: boolean;
    isStale: boolean;
    looksAssigned: boolean;
    maintainerEngaged: boolean;
    hasReproductionSteps: boolean;
    hasRecentActivity: boolean;
  };
}

const BUG_LABELS = ['bug', 'defect', 'regression', 'crash', 'error', 'incorrect', 'type: bug', 'kind/bug', 'bug report'];
const FEATURE_LABELS = ['enhancement', 'feature', 'feature request', 'improvement', 'type: feature', 'kind/enhancement'];
const QUESTION_LABELS = ['question', 'help wanted?', 'support', 'needs-info', 'triage'];
const STALE_LABELS = ['stale', 'wontfix', 'invalid', 'duplicate', 'needs more info', 'needs-info', 'blocked'];
const MAINTAINER_LABEL_HINTS = ['good first issue', 'help wanted', 'accepted', 'confirmed', 'bug', 'priority'];

export function triageIssues(
  issues: RepoDigest['issues'],
  options: { now?: Date; maxAgeDays?: number } = {},
): IssueCandidate[] {
  const now = options.now ?? new Date();
  const maxAgeDays = options.maxAgeDays ?? 540;

  return issues
    .map((issue) => {
      const labels = issue.labels.map((label) => label.toLowerCase());
      const ageDays = (now.getTime() - new Date(issue.createdAt).getTime()) / 86_400_000;
      const sinceUpdateDays = (now.getTime() - new Date(issue.updatedAt).getTime()) / 86_400_000;
      const body = issue.bodyExcerpt.toLowerCase();

      const signals = {
        isBug: labels.some((label) => BUG_LABELS.some((candidate) => label.includes(candidate))),
        isFeatureRequest: labels.some((label) => FEATURE_LABELS.some((candidate) => label.includes(candidate))),
        isQuestion: labels.some((label) => QUESTION_LABELS.some((candidate) => label.includes(candidate))),
        isStale: labels.some((label) => STALE_LABELS.some((candidate) => label.includes(candidate))) || ageDays > maxAgeDays,
        looksAssigned: (issue.assignees ?? []).length > 0,
        maintainerEngaged: labels.some((label) => MAINTAINER_LABEL_HINTS.includes(label)) || issue.comments > 0,
        hasReproductionSteps: /(steps to reproduce|to reproduce|repro\b|minimal example|stack ?trace|expected behavior)/.test(body),
        hasRecentActivity: sinceUpdateDays < 90,
      };

      const reasons: string[] = [];
      let priority = 0.3;

      if (signals.isBug) {
        priority += 0.25;
        reasons.push('labelled as a bug');
      }
      if (signals.hasReproductionSteps) {
        priority += 0.15;
        reasons.push('body contains reproduction details');
      }
      if (signals.hasRecentActivity) {
        priority += 0.1;
        reasons.push(`updated ${sinceUpdateDays.toFixed(0)} days ago`);
      }
      if (labels.includes('good first issue')) {
        priority += 0.05;
        reasons.push('labelled good first issue');
      }
      if (signals.isFeatureRequest && !signals.isBug) {
        priority -= 0.1;
        reasons.push('feature request rather than a defect');
      }
      if (signals.isQuestion) {
        priority -= 0.15;
        reasons.push('looks like a question or support request');
      }
      if (signals.looksAssigned) {
        priority -= 0.3;
        reasons.push(`already assigned to ${issue.assignees.join(', ')}`);
      }
      if (signals.isStale) {
        priority -= 0.25;
        reasons.push('stale, rejected, or very old');
      }
      if (issue.comments > 12) {
        priority -= 0.05;
        reasons.push(`${issue.comments} comments: likely contested or already discussed at length`);
      }
      if (issue.comments === 0) {
        priority += 0.05;
        reasons.push('no comments yet');
      }
      if (body.length < 80) {
        priority -= 0.1;
        reasons.push('very short description, hard to verify');
      }

      return {
        number: issue.number,
        title: issue.title,
        labels: issue.labels,
        comments: issue.comments,
        updatedAt: issue.updatedAt,
        createdAt: issue.createdAt,
        assignees: issue.assignees ?? [],
        authorLogin: issue.authorLogin,
        url: issue.url,
        priority: Math.max(0, Math.min(1, Number(priority.toFixed(3)))),
        reasons,
        signals,
      };
    })
    .filter((issue) => !issue.signals.isStale)
    .sort((a, b) => b.priority - a.priority);
}

/** Titles that suggest the repository is not the right place for the issue. */
export function looksOutOfScope(title: string): boolean {
  return /^(?:\[?question\]?|how (?:do|to)|is it possible|where is|can someone|please help|support request)/i.test(
    title.trim(),
  );
}

export function summarisePullRequestActivity(open: DigestPull[], merged: DigestPull[]): string {
  const openByAuthors = new Map<string, number>();
  for (const pr of open) {
    const author = pr.authorLogin ?? 'unknown';
    openByAuthors.set(author, (openByAuthors.get(author) ?? 0) + 1);
  }
  const externalOpen = [...openByAuthors.entries()]
    .filter(([author]) => !merged.some((pr) => pr.authorLogin === author))
    .reduce((sum, [, count]) => sum + count, 0);

  const mergedLast30 = merged.filter(
    (pr) => pr.mergedAt !== null && Date.now() - new Date(pr.mergedAt).getTime() < 30 * 86_400_000,
  ).length;

  return [
    `${open.length} open pull requests (${externalOpen} from authors with no merged PR in the sample)`,
    `${mergedLast30} merged in the last 30 days (sample of ${merged.length})`,
  ].join('; ');
}

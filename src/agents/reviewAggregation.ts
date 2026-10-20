import type { Finding, Review } from '@/domain/schemas';
import type { Reviewer } from '@/generated/prisma/enums';

/**
 * Deterministic review aggregation.
 *
 * No majority vote: a single evidenced blocking defect is enough to stop a
 * submission, and a pile of style preferences can never block one. The rules
 * below are the whole policy, and they are unit-tested.
 */

const BLOCKING_KINDS = new Set<Finding['kind']>([
  'ACTUAL_DEFECT',
  'REGRESSION_RISK',
  'SECURITY',
  'TEST_GAP',
  'RELIABILITY',
]);

/** Whether a finding meets the bar to stop submission. */
export function isBlockingFinding(finding: Finding): boolean {
  if (!finding.blocksSubmission) return false;
  if (!BLOCKING_KINDS.has(finding.kind)) return false;
  return finding.severity === 'MAJOR' || finding.severity === 'CRITICAL';
}

export interface ReviewedChange {
  reviewer: Reviewer;
  output: Review;
}

export interface BlockingFinding {
  reviewer: Reviewer;
  finding: Finding;
}

export type AggregatedVerdict = 'APPROVE' | 'APPROVE_WITH_NOTES' | 'REQUEST_CHANGES' | 'BLOCK';

export interface ReviewAggregation {
  verdict: AggregatedVerdict;
  blocking: BlockingFinding[];
  notes: BlockingFinding[];
  rationale: string;
}

export function aggregateReviews(reviews: ReviewedChange[]): ReviewAggregation {
  const blocking: BlockingFinding[] = [];
  const notes: BlockingFinding[] = [];

  for (const review of reviews) {
    for (const finding of review.output.findings) {
      if (isBlockingFinding(finding)) blocking.push({ reviewer: review.reviewer, finding });
      else if (finding.severity !== 'INFO') notes.push({ reviewer: review.reviewer, finding });
    }
  }

  const critical = blocking.find(
    (entry) => entry.finding.severity === 'CRITICAL' || entry.finding.kind === 'SECURITY',
  );
  if (critical) {
    return {
      verdict: 'BLOCK',
      blocking,
      notes,
      rationale: `${critical.reviewer} raised a ${critical.finding.severity.toLowerCase()} ${critical.finding.kind}: ${critical.finding.explanation.slice(0, 220)}`,
    };
  }
  if (blocking.length > 0) {
    return {
      verdict: 'REQUEST_CHANGES',
      blocking,
      notes,
      rationale: `${blocking.length} blocking finding(s): ${blocking
        .slice(0, 4)
        .map((entry) => `${entry.reviewer} ${entry.finding.kind} in ${entry.finding.file ?? 'the diff'}`)
        .join('; ')}`,
    };
  }

  const unsupportedRejections = reviews.filter(
    (review) => (review.output.verdict === 'REQUEST_CHANGES' || review.output.verdict === 'BLOCK') && review.output.findings.every((finding) => !isBlockingFinding(finding)),
  );
  const hasNotes = notes.length > 0 || reviews.some((review) => review.output.verdict === 'APPROVE_WITH_NOTES');
  return {
    verdict: hasNotes ? 'APPROVE_WITH_NOTES' : 'APPROVE',
    blocking,
    notes,
    rationale:
      unsupportedRejections.length > 0
        ? `no finding met the blocking bar (${unsupportedRejections.map((review) => review.reviewer).join(', ')} requested changes without one)`
        : notes.length > 0
          ? `${notes.length} non-blocking note(s); no blocking finding`
          : 'all reviewers approved with no findings',
  };
}

/** Human-readable revision brief handed to the next implementation attempt. */
export function revisionBrief(aggregation: ReviewAggregation): string {
  const lines = [
    `Review verdict: ${aggregation.verdict} (${aggregation.rationale})`,
    '',
    'Blocking findings that must be addressed:',
    ...aggregation.blocking.map(
      (entry, index) =>
        `${index + 1}. [${entry.reviewer}/${entry.finding.severity}/${entry.finding.kind}] ${entry.finding.file ?? '(diff)'}${entry.finding.line ? `:${entry.finding.line}` : ''}: ${entry.finding.explanation}${entry.finding.suggestedCorrection ? ` Suggested: ${entry.finding.suggestedCorrection}` : ''}`,
    ),
  ];
  return lines.join('\n').slice(0, 8000);
}

import { describe, expect, it } from 'vitest';
import { aggregateReviews, isBlockingFinding, revisionBrief } from '@/agents/reviewAggregation';
import type { Finding, Review } from '@/domain/schemas';
import type { Reviewer } from '@/generated/prisma/enums';

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  kind: 'ACTUAL_DEFECT',
  severity: 'MAJOR',
  file: 'src/example.ts',
  line: 12,
  explanation: 'The new branch returns undefined when the input list is empty.',
  evidence: [
    { kind: 'file', ref: 'src/example.ts:12', detail: 'returns null instead of an empty array' },
  ],
  blocksSubmission: true,
  confidence: 0.9,
  ...overrides,
});

const review = (overrides: Partial<Review> = {}): Review => ({
  verdict: 'APPROVE',
  summary: 'Reviewed the diff.',
  findings: [],
  verifiedClaims: [],
  questions: [],
  ...overrides,
});

const reviewed = (reviewer: Reviewer, output: Review) => ({ reviewer, output });

describe('isBlockingFinding', () => {
  it('blocks on a major defect that is explicitly marked blocking', () => {
    expect(isBlockingFinding(finding())).toBe(true);
  });

  it('does not block when the reviewer did not mark it blocking', () => {
    expect(isBlockingFinding(finding({ blocksSubmission: false }))).toBe(false);
  });

  it('does not block minor findings even if they are marked blocking', () => {
    expect(isBlockingFinding(finding({ severity: 'MINOR' }))).toBe(false);
    expect(isBlockingFinding(finding({ severity: 'INFO' }))).toBe(false);
  });

  it('never blocks style, convention, scope, or uncertainty', () => {
    for (const kind of ['STYLE_PREFERENCE', 'CONVENTION', 'SCOPE', 'UNCERTAINTY'] as const) {
      expect(isBlockingFinding(finding({ kind, severity: 'CRITICAL' }))).toBe(false);
    }
  });

  it('blocks security and test-gap findings at major or critical severity', () => {
    expect(isBlockingFinding(finding({ kind: 'SECURITY', severity: 'MAJOR' }))).toBe(true);
    expect(isBlockingFinding(finding({ kind: 'TEST_GAP', severity: 'CRITICAL' }))).toBe(true);
  });
});

describe('aggregateReviews', () => {
  it('approves when there are no findings', () => {
    const result = aggregateReviews([
      reviewed('CORRECTNESS', review()),
      reviewed('SECURITY', review()),
    ]);
    expect(result.verdict).toBe('APPROVE');
    expect(result.blocking).toHaveLength(0);
    expect(result.rationale).toContain('approved');
  });

  it('blocks on a single critical finding, regardless of how many reviewers approve', () => {
    const result = aggregateReviews([
      reviewed('CORRECTNESS', review()),
      reviewed('MAINTAINABILITY', review({ findings: [finding({ severity: 'CRITICAL' })] })),
      reviewed('SECURITY', review()),
    ]);
    expect(result.verdict).toBe('BLOCK');
    expect(result.blocking).toHaveLength(1);
    expect(result.rationale).toContain('MAINTAINABILITY');
  });

  it('blocks on any security finding even at major severity', () => {
    const result = aggregateReviews([
      reviewed('SECURITY', review({ findings: [finding({ kind: 'SECURITY', severity: 'MAJOR' })] })),
    ]);
    expect(result.verdict).toBe('BLOCK');
  });

  it('requests changes for non-critical blocking findings', () => {
    const result = aggregateReviews([
      reviewed('CORRECTNESS', review({ findings: [finding({ severity: 'MAJOR' })] })),
    ]);
    expect(result.verdict).toBe('REQUEST_CHANGES');
    expect(result.blocking).toHaveLength(1);
  });

  it('never blocks on style-only findings, even when a reviewer votes to reject', () => {
    const result = aggregateReviews([
      reviewed(
        'ADVERSARIAL',
        review({
          verdict: 'REQUEST_CHANGES',
          findings: [
            finding({
              kind: 'STYLE_PREFERENCE',
              severity: 'MAJOR',
              blocksSubmission: true,
            }),
          ],
        }),
      ),
    ]);
    expect(result.verdict).toBe('APPROVE_WITH_NOTES');
    expect(result.blocking).toHaveLength(0);
    expect(result.rationale).toContain('no finding met the blocking bar');
  });

  it('surfaces non-blocking findings as notes', () => {
    const result = aggregateReviews([
      reviewed('CORRECTNESS', review({ findings: [finding({ severity: 'MINOR' })] })),
    ]);
    expect(result.verdict).toBe('APPROVE_WITH_NOTES');
    expect(result.notes).toHaveLength(1);
  });

  it('ignores INFO findings entirely', () => {
    const result = aggregateReviews([
      reviewed('ADVERSARIAL', review({ findings: [finding({ severity: 'INFO', kind: 'SCOPE' })] })),
    ]);
    expect(result.verdict).toBe('APPROVE');
    expect(result.notes).toHaveLength(0);
  });
});

describe('revisionBrief', () => {
  it('only includes blocking findings', () => {
    const aggregation = aggregateReviews([
      reviewed(
        'CORRECTNESS',
        review({
          findings: [
            finding({ explanation: 'A real blocker in the empty-list branch.' }),
            finding({
              kind: 'STYLE_PREFERENCE',
              severity: 'MINOR',
              explanation: 'Prefers a different helper name here.',
            }),
          ],
        }),
      ),
    ]);
    const brief = revisionBrief(aggregation);
    expect(brief).toContain('A real blocker');
    expect(brief).not.toContain('Prefers a different helper name');
    expect(brief).toContain('CORRECTNESS');
  });
});

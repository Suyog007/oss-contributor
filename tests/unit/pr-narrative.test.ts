import { describe, expect, it } from 'vitest';
import { fallbackNarrative, validateNarrative, type PrNarrativeInput } from '@/agents/prNarrative';
import type { PrNarrative } from '@/domain/schemas';

const input = {
  testRuns: [
    { command: 'go test ./pkg/agent/', status: 'PASSED' },
    { command: 'go vet ./pkg/agent/', status: 'PASSED' },
  ],
  allowedIssueNumbers: [42],
} as Pick<PrNarrativeInput, 'testRuns' | 'allowedIssueNumbers'>;

function narrative(overrides: Partial<PrNarrative> = {}): PrNarrative {
  return {
    commitSubject: 'Use the shared stream scanner in Reasonix',
    commitBody: '',
    prTitle: 'Fix large Reasonix stream records',
    prBody: '## Summary\nUse the shared scanner.\n\nFixes #42',
    testsPerformed: ['go test ./pkg/agent/'],
    issueReferences: ['#42'],
    limitations: [],
    ...overrides,
  };
}

describe('validateNarrative', () => {
  it('keeps only commands that actually ran and allowed issue references', () => {
    const result = validateNarrative(narrative(), input);
    expect(result.problems).toEqual([]);
    expect(result.narrative.testsPerformed).toEqual(['go test ./pkg/agent/']);
  });

  it('reports an invented test command and removes it', () => {
    const result = validateNarrative(
      narrative({ testsPerformed: ['go test ./...', 'npm test'] }),
      input,
    );
    expect(result.problems[0]).toMatch(/not actually run/);
    expect(result.narrative.testsPerformed).toEqual(['go test ./pkg/agent/']);
  });

  it('rejects an issue that was not the candidate source', () => {
    const result = validateNarrative(
      narrative({ issueReferences: ['#42', '#99'], prBody: 'Fixes #99' }),
      input,
    );
    expect(result.problems).toHaveLength(2);
    expect(result.narrative.issueReferences).toEqual(['#42']);
  });
});

describe('fallbackNarrative', () => {
  it('uses the recorded revision and test commands, and cites only allowed issues', () => {
    const full = {
      ...input,
      evidence: {} as PrNarrativeInput['evidence'],
      plan: {} as PrNarrativeInput['plan'],
      revision: {
        index: 2,
        summary: 'Route stdout through the shared scanner',
        rootCause: 'The old scanner was capped at 10 MiB.',
        filesChanged: ['server/pkg/agent/reasonix.go'],
        testsAdded: ['server/pkg/agent/reasonix_stream_test.go'],
      },
      diff: '',
      featureRequest: false,
    } as PrNarrativeInput;
    const result = fallbackNarrative(full);
    expect(result.testsPerformed).toEqual(input.testRuns.map((run) => run.command));
    expect(result.issueReferences).toEqual(['#42']);
    expect(result.prBody).toContain('Route stdout through the shared scanner');
    expect(result.prBody).toContain('server/pkg/agent/reasonix.go');
  });

  it('does not invent an issue when the candidate had none', () => {
    const result = fallbackNarrative({
      ...input,
      allowedIssueNumbers: [],
      evidence: {} as PrNarrativeInput['evidence'],
      plan: {} as PrNarrativeInput['plan'],
      revision: {
        index: 1,
        summary: 'Fix a thing',
        rootCause: null,
        filesChanged: [],
        testsAdded: [],
      },
      diff: '',
      featureRequest: false,
    } as PrNarrativeInput);
    expect(result.issueReferences).toEqual([]);
    expect(result.prBody).not.toContain('#');
  });
});

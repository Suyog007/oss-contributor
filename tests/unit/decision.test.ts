import { describe, expect, it } from 'vitest';
import { decide, INVESTIGATION_POLICY_VERSION } from '@/agents/decision';
import type {
  DuplicateCheck,
  Hypothesis,
  MaintainerContext,
  Reproduction,
  Validation,
} from '@/domain/schemas';

const hypothesis: Hypothesis = {
  title: 'parseDuration truncates sub-second values in config reload',
  summary: 'Values below one second are rounded down to zero.',
  origin: 'CODE_INSPECTION',
  files: ['src/config/parse.ts'],
  claimedBehavior: 'parseDuration("500ms") returns 0',
  expectedBehavior: 'parseDuration("500ms") returns 500',
  evidence: [
    { kind: 'file', ref: 'src/config/parse.ts:42', detail: 'Math.floor(ms / 1000) * 1000' },
  ],
  severity: 'medium',
  verificationSteps: ['call parseDuration("500ms")'],
  verificationCommands: ['npx vitest run tests/parse.test.ts'],
  proposedTest: 'expect parseDuration("500ms")).toBe(500)',
  confidence: 0.7,
  openQuestions: [],
};

const validation = (overrides: Partial<Validation> = {}): Validation => ({
  verdict: 'SUPPORTS',
  behaviorIsIncorrect: 'yes',
  intentional: 'no',
  documentedExpectation: 'The README documents sub-second durations as supported.',
  supporting: [{ kind: 'doc', ref: 'README.md', detail: 'duration accepts "ms" suffixes' }],
  contradictions: [],
  existingTestsCovering: [],
  compatibilityRisk: 'none',
  compatibilityNotes: '',
  scopeFit: 'in_scope',
  confidence: 0.82,
  recommendedNextAction: 'IMPLEMENT',
  residualUncertainty: [],
  ...overrides,
});

const reproduction = (overrides: Partial<Reproduction> = {}): Reproduction => ({
  status: 'REPRODUCED',
  method: 'targeted vitest run',
  commands: [
    {
      command: 'npx vitest run tests/parse.test.ts',
      exitCode: 1,
      observation: 'expected 500 received 0',
    },
  ],
  observedBehavior: 'parseDuration("500ms") === 0',
  expectedBehavior: 'parseDuration("500ms") === 500',
  minimalReproduction: 'node -e "console.log(parseDuration(\'500ms\'))"',
  evidence: [
    { kind: 'runtime_output', ref: 'vitest assertion', detail: 'expected 500 received 0' },
  ],
  confidence: 0.9,
  blockers: [],
  observedInSandbox: true,
  ...overrides,
});

const duplicate = (overrides: Partial<DuplicateCheck> = {}): DuplicateCheck => ({
  verdict: 'NEW',
  matches: [],
  maintainerInvolvement: [],
  previouslyRejectedApproaches: [],
  confidence: 0.8,
  recommendation: 'PROCEED',
  notes: 'no matching work',
  ...overrides,
});

const maintainer = (overrides: Partial<MaintainerContext> = {}): MaintainerContext => ({
  guidelinesSummary: 'Open an issue first for behavior changes.',
  inScope: 'yes',
  scopeNotes: '',
  requiredProcess: ['run the suite'],
  breakingChangePolicy: 'documented changes only',
  needsMaintainerSignoff: false,
  signoffReason: '',
  testRequirements: ['tests for new behavior'],
  documentationRequirements: [],
  conflicts: [],
  confidence: 0.7,
  recommendation: 'PROCEED',
  ...overrides,
});

const base = {
  hypothesis,
  validation: validation(),
  reproduction: reproduction(),
  duplicate: duplicate(),
  maintainer: maintainer(),
  minConfidence: 0.6,
};

describe('decision rules', () => {
  it('confirms implementation when the defect is documented, reproduced, and wanted', () => {
    const result = decide(base);
    expect(result.outcome).toBe('IMPLEMENT');
    expect(result.escalated).toBe(false);
    expect(result.rationale).toContain('problem confirmed');
  });

  it('treats existing work as decisive even when the defect is real', () => {
    const result = decide({
      ...base,
      duplicate: duplicate({
        verdict: 'DUPLICATE',
        confidence: 0.9,
        recommendation: 'STOP_DUPLICATE',
        matches: [
          {
            kind: 'pull_request',
            reference: '#412',
            title: 'fix parseDuration',
            state: 'open',
            relation: 'same_fix',
            note: 'same change',
          },
        ],
      }),
    });
    expect(result.outcome).toBe('DUPLICATE');
    expect(result.rationale).toContain('#412');
  });

  it('waits for a maintainer when the duplicate signal is weak', () => {
    const result = decide({
      ...base,
      duplicate: duplicate({
        verdict: 'DUPLICATE',
        confidence: 0.3,
        recommendation: 'ASK_MAINTAINER',
      }),
    });
    expect(result.outcome).toBe('IMPLEMENT');
  });

  it('does not decide anything without a validation verdict', () => {
    const result = decide({ ...base, validation: null });
    expect(result.outcome).toBe('NEEDS_INVESTIGATION');
    expect(result.rationale).toContain('validation');
  });

  it('rejects claims the material refutes', () => {
    const result = decide({
      ...base,
      validation: validation({
        verdict: 'CONTRADICTS',
        behaviorIsIncorrect: 'no',
        intentional: 'yes',
        documentedExpectation: 'Rounding down is documented in docs/config.md.',
        recommendedNextAction: 'REJECT',
      }),
      reproduction: reproduction({ status: 'NOT_REPRODUCED', observedInSandbox: true }),
    });
    expect(result.outcome).toBe('NOT_A_PROBLEM');
  });

  it('does not confuse "the behavior happens" with "the behavior is a defect"', () => {
    const result = decide({
      ...base,
      validation: validation({
        verdict: 'CONTRADICTS',
        behaviorIsIncorrect: 'no',
        intentional: 'no',
      }),
      reproduction: reproduction({ status: 'REPRODUCED', observedInSandbox: true }),
    });
    expect(result.outcome).toBe('NOT_A_PROBLEM');
    expect(result.rationale).toContain('observed in the sandbox');
  });

  it('asks a maintainer about intent when execution is the only settled fact', () => {
    const result = decide({
      ...base,
      validation: validation({
        verdict: 'CONTRADICTS',
        behaviorIsIncorrect: 'unclear',
        intentional: 'unclear',
        recommendedNextAction: 'ASK_MAINTAINER',
      }),
      reproduction: reproduction({ status: 'REPRODUCED', observedInSandbox: true }),
    });
    expect(result.outcome).toBe('NEEDS_MAINTAINER_INPUT');
    expect(result.escalated).toBe(false);
  });

  it('respects project scope over a confirmed defect', () => {
    const result = decide({
      ...base,
      maintainer: maintainer({ inScope: 'no', scopeNotes: 'parser is frozen until v3' }),
    });
    expect(result.outcome).toBe('OUT_OF_SCOPE');
    expect(result.rationale).toContain('frozen');
  });

  it('requires maintainer sign-off before implementation', () => {
    const result = decide({
      ...base,
      maintainer: maintainer({
        needsMaintainerSignoff: true,
        signoffReason: 'behavior changes need an accepted issue',
      }),
    });
    expect(result.outcome).toBe('NEEDS_MAINTAINER_INPUT');
  });

  it('escalates high compatibility risk instead of implementing quietly', () => {
    const result = decide({ ...base, validation: validation({ compatibilityRisk: 'high' }) });
    expect(result.outcome).toBe('NEEDS_MAINTAINER_INPUT');
  });

  it('asks for adjudication when code reading and execution disagree', () => {
    const result = decide({
      ...base,
      reproduction: reproduction({ status: 'NOT_REPRODUCED', observedInSandbox: true }),
    });
    expect(result.outcome).toBe('NEEDS_INVESTIGATION');
    expect(result.adjudication).not.toBeNull();
    expect(result.escalated).toBe(true);
  });

  it('does not adjudicate a static "not reproduced" note, which is just code reading', () => {
    const result = decide({
      ...base,
      reproduction: reproduction({ status: 'NOT_REPRODUCED', observedInSandbox: false }),
    });
    expect(result.outcome).toBe('IMPLEMENT');
    expect(result.adjudication).toBeNull();
  });

  it('holds back a weak positive', () => {
    const result = decide({ ...base, validation: validation({ confidence: 0.4 }) });
    expect(result.outcome).toBe('NEEDS_INVESTIGATION');
    expect(result.rationale).toContain('threshold');
  });

  it('proceeds on code evidence alone when the environment blocked the experiment', () => {
    const result = decide({
      ...base,
      reproduction: reproduction({
        status: 'BLOCKED_ENVIRONMENT',
        observedInSandbox: false,
        confidence: 0.2,
      }),
    });
    expect(result.outcome).toBe('IMPLEMENT');
    expect(result.rationale).toContain('sandbox could not run');
  });

  it('records the policy version with every decision', () => {
    expect(INVESTIGATION_POLICY_VERSION).toBe('investigation/1');
    const result = decide(base);
    const evidence = result.evidenceJson as Record<string, unknown>;
    expect(evidence['minConfidence']).toBe(0.6);
    expect((evidence['validation'] as Record<string, unknown>)['verdict']).toBe('SUPPORTS');
  });
});

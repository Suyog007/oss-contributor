import type { Review as ReviewOutput, SolutionPlan } from '@/domain/schemas';
import { reviewSchema } from '@/domain/schemas';
import { buildSystemPrompt, boundText, wrapUntrusted } from '@/llm/context';
import type { Reviewer } from '@/generated/prisma/enums';
import type { AgentContext, AgentOutcome } from './runner';
import { renderFileList } from './context';
import { renderEvidence, renderRepoFacts, type SolutionEvidence } from './solution';

export const REVIEW_PROMPT_VERSION = 1;

interface ReviewerProfile {
  reviewer: Reviewer;
  role: string;
  objective: string;
  rules: string[];
}

const COMMON_RULES = [
  'Review only what the diff changes; do not demand unrelated improvements.',
  'Every finding must cite a real path and line in the provided code and explain the mechanism.',
  'Findings are typed. STYLE_PREFERENCE, CONVENTION, SCOPE, and UNCERTAINTY are notes, never blockers.',
  'Set blocksSubmission only for a defect that must be fixed before a PR is opened.',
  'If the change is correct and adequately tested, approve it. Do not request changes to seem rigorous.',
  'List the claims you actually verified in verifiedClaims, including those that turned out wrong.',
];

const PROFILES: ReviewerProfile[] = [
  {
    reviewer: 'CORRECTNESS',
    role: 'a reviewer responsible for behavioral correctness',
    objective:
      'Decide whether this diff fixes the validated behavior and does not break existing callers.',
    rules: [
      'Trace the changed code end to end, including every caller visible in the provided files.',
      'A change that fixes the reported example but not the stated behavior is an ACTUAL_DEFECT.',
      'A test that would also pass on the base commit is a TEST_GAP, because it cannot prove the fix.',
      'Check error paths, null/empty handling, and resource cleanup that the diff touches.',
      ...COMMON_RULES,
    ],
  },
  {
    reviewer: 'SECURITY',
    role: 'a security reviewer',
    objective: 'Find security regressions introduced by this diff, not pre-existing issues elsewhere.',
    rules: [
      'Focus on trust boundaries, authorization, injection, secrets, path traversal, unsafe deserialization, SSRF, and denial of service.',
      'A finding needs a concrete attack or failure mode reachable through the diff.',
      'Do not flag the absence of unrelated hardening or generic best practices.',
      ...COMMON_RULES,
    ],
  },
  {
    reviewer: 'MAINTAINABILITY',
    role: 'a maintainer reviewing for fit with this project',
    objective: 'Decide whether the change follows the project\u2019s conventions and can be maintained.',
    rules: [
      'Compare the diff with adjacent code, tests, and commit conventions provided in the context.',
      'Scope creep, dead code, duplicated logic, and undocumented public behavior are legitimate findings.',
      'Style preferences are STYLE_PREFERENCE and must not block.',
      'Tests should use the project\u2019s existing framework and live where the project keeps its tests.',
      ...COMMON_RULES,
    ],
  },
  {
    reviewer: 'ADVERSARIAL',
    role: 'an adversarial reviewer trying to falsify this change',
    objective:
      'Find the input, configuration, platform, or sequence where this change is wrong or incomplete.',
    rules: [
      'Construct concrete counterexamples and cite the exact line that fails.',
      'Probe edge cases the tests miss: empty, unicode, very large, concurrent, and failure paths.',
      'Do not speculate without a mechanism; if you cannot falsify it, approve it.',
      ...COMMON_RULES,
    ],
  },
];

export function reviewerProfile(reviewer: Reviewer): ReviewerProfile {
  const profile = PROFILES.find((candidate) => candidate.reviewer === reviewer);
  if (!profile) throw new Error(`unknown reviewer ${reviewer}`);
  return profile;
}

export interface ReviewInput {
  reviewer: Reviewer;
  evidence: SolutionEvidence;
  plan: SolutionPlan;
  revisionIndex: number;
  diff: string;
  /** Post-change contents of the changed files and their tests. */
  files: Array<{ path: string; text: string }>;
  testRuns: Array<{ command: string; status: string; outputTail: string }>;
}

export function buildReviewPrompt(input: ReviewInput): { system: string; user: string } {
  const profile = reviewerProfile(input.reviewer);
  const system = buildSystemPrompt({
    role: profile.role,
    objective: profile.objective,
    rules: profile.rules,
  });

  const runs =
    input.testRuns.length === 0
      ? 'no test runs were recorded'
      : input.testRuns
          .map(
            (run) =>
              `### ${run.status}: ${run.command}\n${wrapUntrusted(`test-${run.command}`.slice(0, 80), boundText(run.outputTail, 3000).text)}`,
          )
          .join('\n\n');

  const user = [
    '## Repository facts',
    renderRepoFacts(input.evidence),
    '',
    '## What this change is supposed to do',
    renderEvidence(input.evidence),
    '',
    '## Approved plan',
    wrapUntrusted('plan', JSON.stringify(input.plan, null, 2).slice(0, 20_000)),
    '',
    `## Diff under review (revision ${input.revisionIndex})`,
    wrapUntrusted('diff', boundText(input.diff, 60_000).text),
    '',
    '## Post-change file contents',
    renderFileList(input.files, 80_000).text || '(no files provided)',
    '',
    '## Test runs',
    runs,
    '',
    '## Your task',
    `Review as ${input.reviewer}. Return JSON only, matching the required schema.`,
  ].join('\n');
  return { system, user };
}

export async function reviewChange(
  ctx: AgentContext,
  args: ReviewInput & { candidateId: string; contributionId: string },
): Promise<AgentOutcome<ReviewOutput>> {
  const { system, user } = buildReviewPrompt(args);
  const kind =
    args.reviewer === 'CORRECTNESS'
      ? 'REVIEW_CORRECTNESS'
      : args.reviewer === 'SECURITY'
        ? 'REVIEW_SECURITY'
        : args.reviewer === 'MAINTAINABILITY'
          ? 'REVIEW_MAINTAINABILITY'
          : 'REVIEW_ADVERSARIAL';

  return ctx.runtime.run({
    agent: `review:${args.reviewer.toLowerCase()}`,
    kind,
    tier: 'deep',
    system,
    user,
    schema: reviewSchema,
    schemaName: 'review',
    promptVersion: REVIEW_PROMPT_VERSION,
    candidateId: args.candidateId,
    contributionId: args.contributionId,
    subject: { candidateId: args.candidateId, contributionId: args.contributionId },
    maxOutputTokens: 6000,
    interpret: (output) => ({
      verdict: output.verdict === 'APPROVE' || output.verdict === 'APPROVE_WITH_NOTES' ? 'SUPPORTS' : 'CONTRADICTS',
      confidence: output.verdict === 'APPROVE' ? 0.8 : output.verdict === 'BLOCK' ? 0.8 : 0.6,
      rationale: `${output.verdict}: ${output.summary.slice(0, 200)}`,
    }),
  });
}

import { validationSchema, type Validation } from '@/domain/schemas';
import { buildSystemPrompt, wrapUntrusted } from '@/llm/context';
import type { RepoDigest } from '@/github/repo';
import type { Hypothesis } from '@/domain/schemas';
import type { AgentContext, AgentOutcome } from './runner';
import { renderFileList, renderIssueThread } from './context';
import type { CommentSummary, IssueSummary } from '@/github/repo';

export const VALIDATION_PROMPT_VERSION = 1;

const SYSTEM = buildSystemPrompt({
  role: 'a skeptical reviewer whose job is to disprove a proposed problem before anyone writes code for it',
  objective:
    'Decide whether the claimed behavior is actually wrong, whether it is intentional, whether existing tests already cover it, and whether a change could break other users. Actively look for evidence that the hypothesis is wrong.',
  rules: [
    'Your default position is that the claim is unproven. Switch only on evidence you can point at.',
    'Check what the project says it should do: README, docs, doc comments, type definitions, tests. A behavior that matches documented intent is not a defect, even if it is surprising.',
    'Look for tests that already assert the current behavior. If a test asserts it deliberately, say so and cite the test.',
    'Consider backwards compatibility: who calls this, and what would the proposed change do to them?',
    'Report supporting and contradictory evidence separately. It is common to find both.',
    'If the material does not settle the question, say INCONCLUSIVE and list what would settle it. Do not guess.',
  ],
});

export interface ValidationInput {
  digest: RepoDigest;
  hypothesis: Hypothesis;
  /** Contents of the files named by the hypothesis, read at the analyzed commit. */
  files: Array<{ path: string; text: string }>;
  /** Files the hypothesis did not name but that matter (e.g. the test file). */
  relatedFiles: Array<{ path: string; text: string }>;
  issueThread?: { issue: IssueSummary; comments: CommentSummary[] } | null;
  analysisSummary?: string;
}

export function buildValidationPrompt(input: ValidationInput): {
  system: string;
  user: string;
  screens: ReturnType<typeof renderFileList>['screen'];
} {
  const hypothesis = input.hypothesis;
  const primary = renderFileList(input.files);
  const related = renderFileList(input.relatedFiles, 30_000);

  const user = [
    '## The claim under review',
    wrapUntrusted(
      'hypothesis',
      [
        `title: ${hypothesis.title}`,
        `summary: ${hypothesis.summary}`,
        `origin: ${hypothesis.origin}${hypothesis.originIssueNumber ? ` (issue #${hypothesis.originIssueNumber})` : ''}`,
        `files: ${hypothesis.files.join(', ') || 'none named'}`,
        `claimed behavior: ${hypothesis.claimedBehavior}`,
        `expected behavior: ${hypothesis.expectedBehavior}`,
        `proposed test: ${hypothesis.proposedTest}`,
        `the generator\u2019s evidence:`,
        ...hypothesis.evidence.map((item) => `  - [${item.kind}] ${item.ref}: ${item.detail}`),
        `open questions: ${hypothesis.openQuestions.join(' | ') || 'none'}`,
      ].join('\n'),
    ),
    '',
    input.analysisSummary ? `## Earlier project profile\n${input.analysisSummary}` : '',
    '',
    '## Repository facts',
    [
      `repo: ${input.digest.repo.fullName} | language: ${input.digest.repo.language ?? 'unknown'} | stars: ${input.digest.repo.stars}`,
      `head commit: ${input.digest.headSha}`,
      `tests present: ${input.digest.tree.testFiles.length} (${input.digest.tree.testFiles.slice(0, 12).join(', ') || 'none'})`,
      `commands: ${input.digest.derivedTestCommands.join(' | ') || 'none'}`,
      `open issues sampled: ${input.digest.issues.length}`,
    ].join('\n'),
    '',
    '## Contents of the files named by the hypothesis',
    primary.text.length > 0 ? primary.text : '(none could be read)',
    '',
    related.text.length > 0 ? '## Related files (tests, docs, definitions)\n' + related.text : '',
    '',
    input.issueThread
      ? '## The reported issue and its discussion\n' +
        renderIssueThread(input.issueThread.issue, input.issueThread.comments).text
      : '',
    '',
    'Return your verdict. Base every statement on the material above and cite file paths plus the exact code or text you relied on.',
  ]
    .filter((section) => section !== '')
    .join('\n');

  return { system: SYSTEM, user, screens: related.screen };
}

export async function runValidation(
  ctx: AgentContext,
  args: ValidationInput & { candidateId: string; taskRef?: string },
): Promise<AgentOutcome<Validation>> {
  const prompt = buildValidationPrompt(args);
  return ctx.runtime.run({
    agent: 'issue-validator',
    kind: 'VALIDATION',
    tier: 'deep',
    system: prompt.system,
    user: prompt.user,
    schema: validationSchema,
    schemaName: 'validation',
    promptVersion: VALIDATION_PROMPT_VERSION,
    candidateId: args.candidateId,
    subject: { candidateId: args.candidateId },
    ...(args.taskRef ? { taskRef: args.taskRef } : {}),
    interpret: (output) => ({
      verdict: output.verdict,
      confidence: output.confidence,
      rationale: `${output.verdict}: incorrect=${output.behaviorIsIncorrect}, intentional=${output.intentional}, risk=${output.compatibilityRisk} — ${output.documentedExpectation.slice(0, 160)}`,
    }),
  });
}

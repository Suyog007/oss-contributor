import type { PrNarrative, SolutionPlan } from '@/domain/schemas';
import { prNarrativeSchema } from '@/domain/schemas';
import { buildSystemPrompt, wrapUntrusted } from '@/llm/context';
import type { AgentContext, AgentOutcome } from './runner';
import type { SolutionEvidence } from './solution';
import { renderEvidence, renderRepoFacts } from './solution';

export const PR_NARRATIVE_PROMPT_VERSION = 1;

/**
 * Facts the narrative is allowed to use. Everything here was produced by the
 * orchestrator from recorded data: no maintainer conversations, no unrun
 * commands, no memory of the repository outside the evidence.
 */
export interface PrNarrativeInput {
  evidence: SolutionEvidence;
  plan: SolutionPlan;
  revision: {
    index: number;
    summary: string;
    rootCause: string | null;
    filesChanged: string[];
    testsAdded: string[];
  };
  diff: string;
  testRuns: Array<{ command: string; status: string }>;
  /** Issue numbers the candidate actually came from. Nothing else may be cited. */
  allowedIssueNumbers: number[];
  /** True when the issue is a feature request rather than a defect. */
  featureRequest: boolean;
}

const SYSTEM = buildSystemPrompt({
  role: 'a maintainer writing the public description of a change to their own project',
  objective:
    'Explain one already-implemented change to the maintainers who will review the pull request. The description must be useful, specific, and completely truthful about what was and was not verified.',
  rules: [
    'Write only from the supplied facts. Do not claim a test, benchmark, reproduction, or conversation that is not listed.',
    'Never claim that maintainers were contacted, that an approach was agreed, or that someone else reviewed this change.',
    'Cite an issue only from allowedIssueNumbers. If the change fixes it, use "Fixes #N"; if it only relates, use "Refs #N". If no number is allowed, cite none.',
    'Do not describe the change as "minor", "safe", "backward compatible", or "complete" unless the evidence says so.',
    'Do not add a Verification section: the orchestrator appends the exact commands and their recorded outcomes.',
    'prBody has three markdown sections: "## Summary", "## Root cause", and "## Changes". Keep it under 2500 characters.',
    'commitSubject is imperative, has no conventional-commit prefix, and is at most 72 characters.',
    'prTitle names the user-visible behavior, not the implementation detail.',
    'limitations lists what this change does not cover and what remains uncertain, from the evidence.',
    'testsPerformed must be exactly the commands from the supplied test runs; copy them verbatim.',
    'issueReferences must be only "#N" strings from allowedIssueNumbers.',
    'Return JSON only.',
  ],
});

export function buildPrNarrativePrompt(input: PrNarrativeInput): { system: string; user: string } {
  const runs =
    input.testRuns.length === 0
      ? 'no commands were run'
      : input.testRuns.map((run) => `${run.status}: ${run.command}`).join('\n');
  const allowed =
    input.allowedIssueNumbers.length === 0
      ? 'none'
      : input.allowedIssueNumbers.map((number) => `#${number}`).join(', ');
  const user = [
    '## Repository facts',
    renderRepoFacts(input.evidence),
    '',
    '## Evidence behind the change',
    renderEvidence(input.evidence),
    '',
    '## Approved plan',
    wrapUntrusted('solution-plan', JSON.stringify(input.plan, null, 2).slice(0, 20_000)),
    '',
    '## Implemented revision',
    wrapUntrusted(
      'revision',
      [
        `index: ${input.revision.index}`,
        `summary: ${input.revision.summary}`,
        `root cause: ${input.revision.rootCause ?? 'not recorded'}`,
        `files changed: ${input.revision.filesChanged.join(', ')}`,
        `tests added or updated: ${input.revision.testsAdded.join(', ') || 'none'}`,
        `change kind: ${input.featureRequest ? 'feature request' : 'defect fix'}`,
      ].join('\n'),
    ),
    '',
    '## Diff',
    wrapUntrusted('diff', input.diff.slice(0, 60_000)),
    '',
    '## Commands that actually ran',
    wrapUntrusted('test-runs', runs),
    '',
    `Allowed issue numbers: ${allowed}`,
    '',
    '## Your task',
    'Write the commit message and pull request description. Return JSON only.',
  ].join('\n');
  return { system: SYSTEM, user };
}

export interface ValidatedNarrative {
  narrative: PrNarrative;
  problems: string[];
}

/**
 * Enforce the two claims that are mechanically checkable: the tests reported
 * were actually run, and every cited issue was in the allowed set. Anything
 * else the writer invented is caught by the same human approval gate that sees
 * the final body.
 */
export function validateNarrative(
  narrative: PrNarrative,
  input: Pick<PrNarrativeInput, 'testRuns' | 'allowedIssueNumbers'>,
): ValidatedNarrative {
  const problems: string[] = [];
  const commands = new Set(input.testRuns.map((run) => run.command));
  const testsPerformed = narrative.testsPerformed.filter((command) => commands.has(command));
  if (testsPerformed.length !== narrative.testsPerformed.length) {
    problems.push('narrative reported a command that was not actually run');
  }
  const allowed = new Set(input.allowedIssueNumbers.map((number) => `#${number}`));
  const issueReferences = narrative.issueReferences.filter((reference) =>
    allowed.has(reference.trim()),
  );
  if (issueReferences.length !== narrative.issueReferences.length) {
    problems.push('narrative cited an issue that the candidate did not come from');
  }

  const cited = [...narrative.prBody.matchAll(/#(\d+)/g)].map((match) => `#${match[1]}`);
  const invented = cited.filter((reference) => !allowed.has(reference));
  if (invented.length > 0) {
    problems.push(`narrative body cited unsupported issue(s): ${[...new Set(invented)].join(', ')}`);
  }

  return {
    narrative: {
      ...narrative,
      testsPerformed,
      issueReferences: [...new Set(issueReferences)],
    },
    problems,
  };
}

/**
 * A deterministic description used when the model cannot produce a grounded
 * narrative. It is intentionally plain: a truthful PR beats a polished one
 * that claims something nobody verified.
 */
export function fallbackNarrative(input: PrNarrativeInput): PrNarrative {
  const issue = input.allowedIssueNumbers[0];
  const verb = input.featureRequest ? 'Add' : 'Fix';
  const summary = input.revision.summary.trim().slice(0, 400) || 'code change';
  const title = `${verb}: ${summary.replace(/^[a-z]+:\s*/i, '').replace(/\.$/, '')}`.slice(0, 140);
  const changes = input.revision.filesChanged.map((file) => `- \`${file}\``).join('\n');
  return {
    commitSubject: title.slice(0, 72),
    commitBody: summary,
    prTitle: title,
    prBody: [
      '## Summary',
      summary,
      '',
      '## Root cause',
      input.revision.rootCause?.trim() || 'Not separately recorded; see the change and evidence above.',
      '',
      '## Changes',
      changes || '- No files recorded.',
    ].join('\n'),
    testsPerformed: input.testRuns.map((run) => run.command),
    issueReferences: issue ? [`#${issue}`] : [],
    limitations: [],
  };
}

export async function writePrNarrative(
  ctx: AgentContext,
  args: PrNarrativeInput & { candidateId: string; contributionId: string },
): Promise<AgentOutcome<PrNarrative>> {
  const { system, user } = buildPrNarrativePrompt(args);
  return ctx.runtime.run({
    agent: 'pr-narrative',
    kind: 'PR_NARRATIVE',
    tier: 'fast',
    system,
    user,
    schema: prNarrativeSchema,
    schemaName: 'prNarrative',
    promptVersion: PR_NARRATIVE_PROMPT_VERSION,
    candidateId: args.candidateId,
    contributionId: args.contributionId,
    subject: { candidateId: args.candidateId, contributionId: args.contributionId },
    maxOutputTokens: 3000,
    interpret: (output) => ({
      verdict: 'SUPPORTS',
      confidence: 0.7,
      rationale: `PR narrative: ${output.prTitle.slice(0, 180)}`,
    }),
  });
}

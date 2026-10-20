import {
  hypothesisPlanSchema,
  hypothesisSchema,
  type HypothesisPlan,
  type Hypotheses,
  type ProjectAnalysis,
} from '@/domain/schemas';
import { buildSystemPrompt, wrapUntrusted } from '@/llm/context';
import type { RepoDigest } from '@/github/repo';
import type { CommentSummary, IssueSummary } from '@/github/repo';
import type { IssueCandidate } from '@/analysis/triage';
import { summarisePullRequestActivity } from '@/analysis/triage';
import type { AgentContext, AgentOutcome } from './runner';
import { renderIssueThread, renderRepoDigest, renderFileList } from './context';

export const HYPOTHESIS_PLAN_PROMPT_VERSION = 1;
export const HYPOTHESIS_GENERATE_PROMPT_VERSION = 1;

const PLAN_SYSTEM = buildSystemPrompt({
  role: 'a staff engineer deciding where to spend a limited investigation budget in an unfamiliar codebase',
  objective:
    'Choose which reported issues and which files are most likely to reveal a real, verifiable, in-scope problem that a single focused pull request could fix.',
  rules: [
    'Prefer specific, reproducible defects over broad refactors or design debates.',
    'Prefer files that the project already tests if possible, so the fix can be verified by the project suite.',
    'Avoid issues that are assigned, stale, rejected, or clearly product decisions rather than defects.',
    'Files must be exact paths that appear in the file inventory you were given.',
    'It is correct to select nothing and say why.',
    'You are choosing where to look, not deciding what is wrong. Do not assert a defect yet.',
  ],
});

const GENERATE_SYSTEM = buildSystemPrompt({
  role: 'a staff engineer writing precise, falsifiable bug hypotheses from real code and issue text',
  objective:
    'Produce candidate problems that a reviewer could independently confirm or refute. Each hypothesis must state what the code claims to do, what it actually does, and how to check.',
  rules: [
    'A hypothesis is not a claim of proof. State it so that it can be disproved.',
    'Every hypothesis needs at least one piece of concrete evidence: a specific file and what in it contradicts the expected behavior, or a reported issue whose claims are consistent with the code you were shown.',
    'Do not invent line numbers, function names, or file paths that are not in the material provided.',
    'verificationCommands must be commands a person can actually run in this repository (use the derived commands and the project layout). Never invent tooling that is not present.',
    'proposedTest must describe the smallest test that would fail before the fix and pass after it.',
    'Prefer small, checkable problems: incorrect edge-case handling, a documented behavior that the code does not implement, an error path that loses information, a boundary condition that is off by one, a fix applied in one place but missed in a sibling caller.',
    'Avoid cosmetic changes, dependency bumps, and anything that requires a maintainer design decision.',
    'If the material does not support a real hypothesis, return fewer hypotheses or none, and list what you considered and rejected.',
  ],
});

export interface PlanInput {
  digest: RepoDigest;
  analysis: ProjectAnalysis;
  issueCandidates: IssueCandidate[];
}

export function buildPlanPrompt(input: PlanInput): { system: string; user: string } {
  const { digest, analysis } = input;
  const fileInventory = Object.entries(digest.tree.byExtension)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([ext, count]) => `${ext}:${count}`)
    .join(', ');

  const user = [
    '## Project profile produced earlier from this same commit',
    wrapUntrusted('project-analysis', JSON.stringify(analysis, null, 2).slice(0, 12_000)),
    '',
    '## Repository layout',
    [
      `total files: ${digest.tree.totalFiles} (${fileInventory})`,
      `top-level: ${digest.tree.topLevelDirectories.join(', ')}`,
      `manifests: ${digest.tree.manifests.join(', ')}`,
      `tests: ${digest.tree.testFiles.slice(0, 40).join(', ') || 'none'}`,
      `ci: ${digest.tree.ciWorkflows.join(', ')}`,
      `derived commands: ${digest.derivedTestCommands.join(' | ') || 'none'}`,
    ].join('\n'),
    '',
    '## Files available to inspect (exact paths)',
    // Give the planner a wide but bounded path list to choose from.
    digest.tree.docs
      .concat(digest.files.map((file) => file.path))
      .concat(digest.tree.manifests)
      .filter((path, index, all) => all.indexOf(path) === index)
      .slice(0, 400)
      .join('\n'),
    '',
    '## Reported issues, ordered by a deterministic triage score',
    input.issueCandidates.length === 0
      ? 'none'
      : input.issueCandidates
          .slice(0, 25)
          .map((issue) =>
            wrapUntrusted(
              `issue-${issue.number}`,
              [
                `#${issue.number} [priority ${issue.priority}] ${issue.title}`,
                `labels: ${issue.labels.join(', ') || 'none'} | comments: ${issue.comments} | updated ${issue.updatedAt.slice(0, 10)} | assignees: ${issue.assignees.join(', ') || 'none'}`,
                `triage reasons: ${issue.reasons.join('; ')}`,
                `body: ${digest.issues.find((candidate) => candidate.number === issue.number)?.bodyExcerpt.slice(0, 700) ?? '(not sampled)'}`,
              ].join('\n'),
            ),
          )
          .join('\n\n'),
    '',
    '## Pull request reality check',
    summarisePullRequestActivity(digest.pullRequests, digest.recentMergedPullRequests),
    '',
    'Choose the issues worth investigating and the exact files to read. Return the plan as JSON.',
  ].join('\n');

  return { system: PLAN_SYSTEM, user };
}

export async function planHypotheses(
  ctx: AgentContext,
  args: {
    projectId: string;
    digest: RepoDigest;
    analysis: ProjectAnalysis;
    issueCandidates: IssueCandidate[];
    taskRef?: string;
  },
): Promise<AgentOutcome<HypothesisPlan>> {
  const prompt = buildPlanPrompt({
    digest: args.digest,
    analysis: args.analysis,
    issueCandidates: args.issueCandidates,
  });
  return ctx.runtime.run({
    agent: 'hypothesis-planner',
    kind: 'HYPOTHESIS',
    tier: 'deep',
    system: prompt.system,
    user: prompt.user,
    schema: hypothesisPlanSchema,
    schemaName: 'hypothesisPlan',
    promptVersion: HYPOTHESIS_PLAN_PROMPT_VERSION,
    subject: { projectId: args.projectId },
    ...(args.taskRef ? { taskRef: args.taskRef } : {}),
    interpret: (output) => ({
      verdict: 'NOT_APPLICABLE',
      confidence: 0.6,
      rationale: `selected ${output.issueNumbers.length} issue(s) and ${output.filesToInspect.length} file(s): ${output.rationale.slice(0, 160)}`,
    }),
  });
}

export interface GenerateInput {
  digest: RepoDigest;
  analysis: ProjectAnalysis;
  plan: HypothesisPlan;
  files: Array<{ path: string; text: string }>;
  issueThreads: Array<{ issue: IssueSummary; comments: CommentSummary[] }>;
  /** Existing candidate titles, so the generator does not repeat known work. */
  knownCandidates: string[];
}

export function buildGeneratePrompt(input: GenerateInput): {
  system: string;
  user: string;
  screens: ReturnType<typeof renderFileList>['screen'];
} {
  const renderedFiles = renderFileList(input.files);
  const issueSection = input.issueThreads
    .map((thread) => renderIssueThread(thread.issue, thread.comments).text)
    .join('\n\n---\n\n');

  const user = [
    '## What the project is',
    wrapUntrusted('project-analysis', JSON.stringify(input.analysis, null, 2).slice(0, 10_000)),
    '',
    '## Repository facts',
    [
      `repo: ${input.digest.repo.fullName} | language: ${input.digest.repo.language ?? 'unknown'} | license: ${input.digest.repo.license ?? 'none'}`,
      `head commit: ${input.digest.headSha}`,
      `tests: ${input.digest.tree.testFiles.length} files (${input.digest.tree.testDirectories.slice(0, 5).join(', ') || 'none'})`,
      `ci: ${input.digest.tree.ciWorkflows.join(', ') || 'none'}`,
      `commands: ${input.digest.derivedTestCommands.join(' | ') || 'none'}`,
      `test command conventions: run the smallest command that covers the changed package.`,
    ].join('\n'),
    '',
    '## Investigation plan chosen in the previous step',
    wrapUntrusted('hypothesis-plan', JSON.stringify(input.plan, null, 2)),
    '',
    issueSection.length > 0
      ? '## Reported issue threads\n' + issueSection
      : '## Reported issue threads\nnone selected',
    '',
    '## File contents (read in full for this decision)',
    renderedFiles.text.length > 0 ? renderedFiles.text : '(no files were fetched)',
    '',
    input.knownCandidates.length > 0
      ? `## Candidates already recorded for this project (do not duplicate)\n${input.knownCandidates.map((title) => `- ${title}`).join('\n')}`
      : '',
    '',
    'Produce the hypotheses now. Each must be independently checkable against the code shown. If nothing is supported, return an empty array and explain in consideredAndRejected.',
  ]
    .filter((section) => section !== '')
    .join('\n');

  return { system: GENERATE_SYSTEM, user, screens: renderedFiles.screen };
}

export async function generateHypotheses(
  ctx: AgentContext,
  args: GenerateInput & { projectId: string; taskRef?: string },
): Promise<AgentOutcome<Hypotheses>> {
  const prompt = buildGeneratePrompt(args);
  return ctx.runtime.run({
    agent: 'hypothesis-generator',
    kind: 'HYPOTHESIS',
    tier: 'deep',
    system: prompt.system,
    user: prompt.user,
    schema: hypothesisSchema,
    schemaName: 'hypotheses',
    promptVersion: HYPOTHESIS_GENERATE_PROMPT_VERSION,
    subject: { projectId: args.projectId },
    ...(args.taskRef ? { taskRef: args.taskRef } : {}),
    interpret: (output) => {
      const strongest = output.hypotheses.reduce(
        (max, hypothesis) => Math.max(max, hypothesis.confidence),
        0,
      );
      return {
        verdict: output.hypotheses.length > 0 ? 'SUPPORTS' : 'INCONCLUSIVE',
        confidence: output.hypotheses.length > 0 ? strongest : 0,
        rationale:
          output.hypotheses.length > 0
            ? `${output.hypotheses.length} hypothesis(es): ${output.hypotheses
                .map((hypothesis) => hypothesis.title)
                .join(' | ')
                .slice(0, 300)}`
            : `no hypotheses supported by the material (${output.consideredAndRejected.length} ideas rejected)`,
      };
    },
  });
}

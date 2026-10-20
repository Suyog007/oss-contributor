import {
  solutionEditSchema,
  solutionPlanSchema,
  type DuplicateCheck,
  type Hypothesis,
  type MaintainerContext,
  type Reproduction,
  type SolutionEdit,
  type SolutionPlan,
  type Validation,
} from '@/domain/schemas';
import { loadEnv } from '@/config/env';
import { buildSystemPrompt, wrapUntrusted } from '@/llm/context';
import { projectDirectories } from '@/sandbox/policy';
import { MAX_WHOLE_FILE_EDIT_BYTES } from '@/workflows/implementation-policy';
import type { RepoDigest } from '@/github/repo';
import type { AgentContext, AgentOutcome } from './runner';
import { renderFileList } from './context';

export const SOLUTION_PLAN_PROMPT_VERSION = 2;
export const SOLUTION_EDIT_PROMPT_VERSION = 2;

const PLAN_SYSTEM = buildSystemPrompt({
  role: 'a senior maintainer of this repository planning the smallest correct change',
  objective:
    'Turn validated evidence into a concrete, reviewable implementation plan. The plan is the scope contract for the edit step and for reviewers.',
  rules: [
    'Fix the validated behavior; do not refactor, modernize, or reformat unrelated code.',
    'Prefer editing an existing function or module over adding a new abstraction.',
    'No new dependencies. Never propose changes to lockfiles, CI workflows, licensing, or version numbers.',
    'Plan a test change: name an existing test file to extend, or a new test file placed where this project keeps its tests.',
    'Only reference paths that appear in the provided file list, the repository inventory, or the evidence. Never invent a file.',
    'The edit step returns whole files, so do not plan to modify a file larger than 40 KB; say so in uncertainties instead.',
    'If a path you need was not provided, list it in needsMoreContext instead of guessing its contents.',
    'Keep the change to the fewest files that make the behavior correct and testable.',
    'Tests must be deterministic and offline: no network, no real clocks, no long sleeps.',
    'If the evidence does not support a safe change, say so in uncertainties and keep the plan minimal.',
  ],
});

const EDIT_SYSTEM = buildSystemPrompt({
  role: 'a careful engineer making exactly the planned change to this repository',
  objective:
    'Return the complete new contents of every file you change. The orchestrator applies your files to a clean checkout and runs the project tests.',
  rules: [
    'Return whole-file contents, never patches or elisions. Every file you return replaces the existing file.',
    'Preserve everything you are not intentionally changing: imports, comments, formatting, and unrelated behavior.',
    'Follow the existing style of the file and the project; do not reformat untouched lines.',
    'Stay within the approved plan. If a compilation-required change to another file is unavoidable, include it and explain why in notesForReviewers.',
    'Add or update the test the plan calls for. The test must fail without your change and pass with it.',
    'No new dependencies, no lockfile edits, no CI changes, no generated files, no binary files.',
    'Do not include secrets, tokens, absolute host paths, or content from outside the repository.',
    'verificationCommands must be commands this project already supports (from its manifests, CI, or scripts), one per entry.',
  ],
});

export interface SolutionEvidence {
  digest: RepoDigest;
  hypothesis: Hypothesis;
  validation: Validation | null;
  reproduction: Reproduction | null;
  duplicate: DuplicateCheck | null;
  maintainer: MaintainerContext | null;
  decisionRationale: string;
  ecosystem: string;
  workingDirectory?: string;
}

export function renderEvidence(evidence: SolutionEvidence): string {
  const { hypothesis: h, validation: v, reproduction: r, duplicate: d, maintainer: m } = evidence;
  const parts: string[] = [];

  parts.push(
    wrapUntrusted(
      'hypothesis',
      [
        `title: ${h.title}`,
        `origin: ${h.origin}${h.originIssueNumber ? ` (#${h.originIssueNumber})` : ''}`,
        `summary: ${h.summary}`,
        `claimed behavior: ${h.claimedBehavior}`,
        `expected behavior: ${h.expectedBehavior}`,
        `severity: ${h.severity}`,
        `files named by the hypothesis: ${h.files.join(', ') || 'none'}`,
        `proposed test: ${h.proposedTest || 'none'}`,
        `verification steps: ${h.verificationSteps.join(' | ') || 'none'}`,
      ].join('\n'),
    ),
  );

  if (v) {
    parts.push(
      wrapUntrusted(
        'validation',
        [
          `behavior is incorrect: ${v.behaviorIsIncorrect}; intentional: ${v.intentional}`,
          `documented expectation: ${v.documentedExpectation}`,
          `scope fit: ${v.scopeFit}; compatibility risk: ${v.compatibilityRisk}`,
          `compatibility notes: ${v.compatibilityNotes}`,
          `existing tests covering this: ${v.existingTestsCovering.join(', ') || 'none'}`,
          `contradictions: ${v.contradictions.map((c) => `${c.ref}: ${c.detail}`).join(' | ') || 'none'}`,
          `residual uncertainty: ${v.residualUncertainty.join(' | ') || 'none'}`,
        ].join('\n'),
      ),
    );
  }

  if (r) {
    parts.push(
      wrapUntrusted(
        'reproduction',
        [
          `status: ${r.status}; observed in sandbox: ${r.observedInSandbox}`,
          `observed behavior: ${r.observedBehavior}`,
          `expected behavior: ${r.expectedBehavior}`,
          `minimal reproduction: ${r.minimalReproduction}`,
          `blockers: ${r.blockers.join(' | ') || 'none'}`,
        ].join('\n'),
      ),
    );
  }

  if (d) {
    parts.push(
      wrapUntrusted(
        'duplicate-check',
        [
          `verdict: ${d.verdict}; recommendation: ${d.recommendation}`,
          `related work: ${d.matches.map((match) => `${match.reference} (${match.relation}): ${match.note}`).join(' | ') || 'none'}`,
          `previously rejected approaches: ${d.previouslyRejectedApproaches.map((item) => `${item.reference}: ${item.approach} (rejected because ${item.whyRejected})`).join(' | ') || 'none'}`,
        ].join('\n'),
      ),
    );
  }

  if (m) {
    parts.push(
      wrapUntrusted(
        'maintainer-context',
        [
          `guidelines: ${m.guidelinesSummary}`,
          `in scope: ${m.inScope} (${m.scopeNotes})`,
          `required process: ${m.requiredProcess.join(' | ') || 'none'}`,
          `test requirements: ${m.testRequirements.join(' | ') || 'none'}`,
          `documentation requirements: ${m.documentationRequirements.join(' | ') || 'none'}`,
          `breaking change policy: ${m.breakingChangePolicy}`,
        ].join('\n'),
      ),
    );
  }

  parts.push(`## Decision rationale\n${wrapUntrusted('decision', evidence.decisionRationale)}`);
  return parts.join('\n\n');
}

export function renderRepoFacts(evidence: SolutionEvidence): string {
  const { digest } = evidence;
  return [
    `repository: ${digest.repo.fullName}`,
    `analyzed commit: ${digest.headSha}`,
    `ecosystem: ${evidence.ecosystem}${evidence.workingDirectory ? ` (project root: ${evidence.workingDirectory})` : ''}`,
    `project commands derived from manifests and CI: ${digest.derivedTestCommands.join(' | ') || 'none'}`,
    `manifests: ${digest.tree.manifests.join(', ') || 'none'}`,
    `project directories: ${projectDirectories(digest.tree.manifests).join(', ') || 'repository root'}`,
    `test files (sample): ${digest.tree.testFiles.slice(0, 25).join(', ') || 'none detected'}`,
    `top-level directories: ${digest.tree.topLevelDirectories.join(', ')}`,
    `commit conventions: conventional=${digest.commitConventions.conventionalCommits}, dominant prefix=${digest.commitConventions.dominantPrefix ?? 'none'}, references issues=${digest.commitConventions.referencesIssues}`,
    `recent commit subjects: ${digest.commitConventions.sampleSubjects.slice(0, 8).join(' | ')}`,
  ].join('\n');
}

export function buildSolutionPlanPrompt(
  evidence: SolutionEvidence,
  files: Array<{ path: string; text: string }>,
): { system: string; user: string } {
  const rendered = renderFileList(files, 100_000, MAX_WHOLE_FILE_EDIT_BYTES);
  const user = [
    '## Repository facts',
    renderRepoFacts(evidence),
    '',
    '## Evidence',
    renderEvidence(evidence),
    '',
    '## File contents available at the analyzed commit',
    rendered.text.length > 0 ? rendered.text : '(no file contents were provided)',
    '',
    '## Your task',
    'Produce an implementation plan. Name every file you will modify or add, and the test you will add or update.',
    'If you need to see more files before you can plan safely, list them in needsMoreContext (at most 6).',
    'Return JSON only.',
  ].join('\n');
  return { system: PLAN_SYSTEM, user };
}

export async function planSolution(
  ctx: AgentContext,
  args: SolutionEvidence & {
    candidateId: string;
    files: Array<{ path: string; text: string }>;
    /** Present when revising after review; explains what must change. */
    revisionContext?: string;
  },
): Promise<AgentOutcome<SolutionPlan>> {
  const { system, user } = buildSolutionPlanPrompt(args, args.files);
  const revisionNote = args.revisionContext
    ? `\n\n## Revision required\n${wrapUntrusted('review-findings', args.revisionContext)}\nAddress these findings in the plan.`
    : '';
  return ctx.runtime.run({
    agent: 'solution-planner',
    kind: 'SOLUTION_PLAN',
    tier: 'deep',
    system,
    user: `${user}${revisionNote}`,
    schema: solutionPlanSchema,
    schemaName: 'solutionPlan',
    promptVersion: SOLUTION_PLAN_PROMPT_VERSION,
    candidateId: args.candidateId,
    subject: { candidateId: args.candidateId, projectId: undefined },
    maxOutputTokens: 6000,
    interpret: (output) => ({
      verdict: output.changes.length > 0 ? 'SUPPORTS' : 'INCONCLUSIVE',
      confidence: output.changes.length > 0 ? 0.7 : 0.3,
      rationale: `${output.changes.length} file(s) planned, ${output.testsToAdd.length} test(s): ${output.approach.slice(0, 180)}`,
    }),
  });
}

export interface SolutionEditInput {
  evidence: SolutionEvidence;
  plan: SolutionPlan;
  files: Array<{ path: string; text: string }>;
  /** When revising, the previous diff and the reviewers' findings. */
  revisionContext?: string;
}

export function buildSolutionEditPrompt(input: SolutionEditInput): { system: string; user: string } {
  const rendered = renderFileList(input.files, 150_000, MAX_WHOLE_FILE_EDIT_BYTES);
  const user = [
    '## Repository facts',
    renderRepoFacts(input.evidence),
    '',
    '## Approved plan',
    wrapUntrusted('solution-plan', JSON.stringify(input.plan, null, 2).slice(0, 24_000)),
    '',
    '## File contents at the analyzed commit',
    rendered.text.length > 0 ? rendered.text : '(no file contents were provided)',
    '',
    '## Your task',
    'Implement the plan. Return the complete new content of every file you change, plus the test change.',
    'If a file you must change is not shown above, you may still return it, but only if the plan explicitly names it.',
    'Return JSON only.',
  ].join('\n');
  const revision = input.revisionContext
    ? `\n\n## Revision required\n${wrapUntrusted('review-findings', input.revisionContext)}\nThe previous attempt was rejected. Fix these findings without widening the scope.`
    : '';
  return { system: EDIT_SYSTEM, user: `${user}${revision}` };
}

export async function writeSolution(
  ctx: AgentContext,
  args: SolutionEditInput & { candidateId: string; contributionId: string },
): Promise<AgentOutcome<SolutionEdit>> {
  const { system, user } = buildSolutionEditPrompt(args);
  return ctx.runtime.run({
    agent: 'solution-editor',
    kind: 'SOLUTION_EDIT',
    // Whole-file edits are long but not deep-reasoning-bound. The deep tier
    // (kimi-k3) cannot emit a 16k-token file edit inside the provider's
    // ~300s connection ceiling. The fast tier generates ~110 tok/s and
    // finishes the same edits with room to spare.
    tier: 'fast',
    system,
    user,
    schema: solutionEditSchema,
    schemaName: 'solutionEdit',
    promptVersion: SOLUTION_EDIT_PROMPT_VERSION,
    candidateId: args.candidateId,
    contributionId: args.contributionId,
    subject: { candidateId: args.candidateId, contributionId: args.contributionId },
    maxOutputTokens: 16_000,
    // Returning whole files is the one call that can legitimately take many
    // minutes. Do not fan out three 4-minute timeouts; a failed attempt is
    // retried at the task level, where the plan is reused from cache.
    timeoutMs: loadEnv().AI_LONG_REQUEST_TIMEOUT_MS,
    retries: 0,
    interpret: (output) => ({
      verdict: output.edits.length > 0 ? 'SUPPORTS' : 'INCONCLUSIVE',
      confidence: output.edits.length > 0 ? 0.7 : 0.3,
      rationale: `${output.edits.length} file(s) written: ${output.summary.slice(0, 180)}`,
    }),
  });
}

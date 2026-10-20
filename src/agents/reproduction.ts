import {
  reproductionPlanSchema,
  reproductionSchema,
  type Reproduction,
  type ReproductionPlan,
} from '@/domain/schemas';
import { buildSystemPrompt, wrapUntrusted } from '@/llm/context';
import { projectDirectories } from '@/sandbox/policy';
import type { RepoDigest } from '@/github/repo';
import type { Hypothesis } from '@/domain/schemas';
import type { AgentContext, AgentOutcome } from './runner';
import { renderFileList } from './context';

export const REPRODUCTION_PLAN_PROMPT_VERSION = 2;
export const REPRODUCTION_INTERPRET_PROMPT_VERSION = 1;

const PLAN_SYSTEM = buildSystemPrompt({
  role: 'a test engineer designing the smallest possible experiment that would reveal a specific behavior',
  objective:
    'Choose commands that will reveal the behavior in question inside an isolated container that has the project checked out at the analyzed commit. Prefer one small, fast, targeted command over running the whole suite.',
  rules: [
    'Commands run inside a Linux container. Use only tooling the project itself declares; the container provides that toolchain.',
    'Do not install anything: dependencies are prepared separately, and the container has no network.',
    'Set workingDirectory when the project does not live at the repository root, for example "server" or "backend" for a monorepo; commands run from that directory.',
    'Prefer a single small test invocation (for example one test file, one filter) over a full suite run.',
    'If a tiny reproduction can be written without modifying the repository, express it as a one-liner using the project runtime.',
    'Never use network commands, package managers, or anything that writes outside the project directory.',
    'If the behavior cannot be observed by running a command, return an empty command list and explain why in rationale.',
    'filesToInspect should list files whose contents will make the outcome interpretable (the implementation and its test).',
  ],
});

const INTERPRET_SYSTEM = buildSystemPrompt({
  role: 'an engineer reading the actual output of an experiment',
  objective:
    'Report what the commands actually did. Distinguish "the behavior was observed" from "the behavior is plausible from reading code".',
  rules: [
    'Report exactly what the captured output shows. Do not embellish or infer beyond it.',
    'If the command failed to run (missing tooling, dependency error, timeout), the status is BLOCKED_ENVIRONMENT, not REPRODUCED.',
    'observedInSandbox must be true only when the runtime output itself demonstrates the behavior.',
    'For a documentation inconsistency, observedInSandbox is false unless a command showed the mismatch.',
    'quote the decisive output lines in the observations.',
  ],
});

export interface ReproductionInput {
  digest: RepoDigest;
  hypothesis: Hypothesis;
  files: Array<{ path: string; text: string }>;
  ecosystem: string;
  image: string;
  /** Command results from the sandbox, in the order they were run. */
  results: Array<{
    command: string;
    exitCode: number | null;
    timedOut: boolean;
    refusedReason?: string;
    output: string;
  }>;
  mode: 'runtime' | 'static';
}

export function buildReproductionPlanPrompt(input: {
  digest: RepoDigest;
  hypothesis: Hypothesis;
  files: Array<{ path: string; text: string }>;
  ecosystem: string;
}): { system: string; user: string } {
  const rendered = renderFileList(input.files, 40_000);
  const user = [
    '## The behavior to observe',
    wrapUntrusted(
      'hypothesis',
      [
        `title: ${input.hypothesis.title}`,
        `claimed behavior: ${input.hypothesis.claimedBehavior}`,
        `expected behavior: ${input.hypothesis.expectedBehavior}`,
        `verification steps suggested by the author: ${input.hypothesis.verificationSteps.join(' | ') || 'none'}`,
        `commands suggested by the author: ${input.hypothesis.verificationCommands.join(' | ') || 'none'}`,
      ].join('\n'),
    ),
    '',
    '## Repository facts',
    [
      `repo: ${input.digest.repo.fullName} | ecosystem: ${input.ecosystem} | container image provides that toolchain`,
      `head commit: ${input.digest.headSha}`,
      `derived project commands: ${input.digest.derivedTestCommands.join(' | ') || 'none'}`,
      `project directories (from manifests): ${projectDirectories(input.digest.tree.manifests).join(', ') || 'repository root'}`,
      `test files: ${input.digest.tree.testFiles.slice(0, 20).join(', ') || 'none'}`,
      `manifests: ${input.digest.tree.manifests.join(', ') || 'none'}`,
      'note: dependencies for this project were already installed in the container before the command list runs.',
    ].join('\n'),
    '',
    '## File contents',
    rendered.text.length > 0 ? rendered.text : '(no files were provided)',
    '',
    'Return the command list. Keep it to at most three commands, each completing in under two minutes if possible.',
  ].join('\n');
  return { system: PLAN_SYSTEM, user };
}

export async function planReproduction(
  ctx: AgentContext,
  args: {
    digest: RepoDigest;
    hypothesis: Hypothesis;
    files: Array<{ path: string; text: string }>;
    ecosystem: string;
    candidateId: string;
  },
): Promise<AgentOutcome<ReproductionPlan>> {
  const prompt = buildReproductionPlanPrompt(args);
  return ctx.runtime.run({
    agent: 'reproduction-planner',
    kind: 'REPRODUCTION',
    tier: 'fast',
    system: prompt.system,
    user: prompt.user,
    schema: reproductionPlanSchema,
    schemaName: 'reproductionPlan',
    promptVersion: REPRODUCTION_PLAN_PROMPT_VERSION,
    candidateId: args.candidateId,
    subject: { candidateId: args.candidateId },
    maxOutputTokens: 4000,
    interpret: (output) => ({
      verdict: 'NOT_APPLICABLE',
      confidence: output.commands.length > 0 ? 0.6 : 0.3,
      rationale: `${output.commands.length} command(s) planned: ${output.rationale.slice(0, 180)}`,
    }),
  });
}

export function buildReproductionInterpretPrompt(input: ReproductionInput): {
  system: string;
  user: string;
} {
  const commandResults = input.results
    .map((result, index) =>
      [
        `### command ${index + 1}: ${result.command}`,
        `exit code: ${result.exitCode === null ? 'not executed' : result.exitCode}${result.timedOut ? ' (timed out)' : ''}${result.refusedReason ? ` (refused: ${result.refusedReason})` : ''}`,
        wrapUntrusted(`command-${index + 1}-output`, result.output.slice(-6000)),
      ].join('\n'),
    )
    .join('\n\n');

  const user = [
    '## The behavior we were testing for',
    wrapUntrusted(
      'hypothesis',
      [
        `title: ${input.hypothesis.title}`,
        `claimed behavior: ${input.hypothesis.claimedBehavior}`,
        `expected behavior: ${input.hypothesis.expectedBehavior}`,
      ].join('\n'),
    ),
    '',
    `## Reproduction mode`,
    input.mode === 'runtime'
      ? 'Commands were executed in an isolated container against the analyzed commit.'
      : 'No commands were run: this is a static, code-reading reproduction. Base the report on the file contents below and set observedInSandbox to false.',
    '',
    `## Sandbox: ${input.image} (network disabled, workspace mounted read-write, no credentials present)`,
    '',
    input.results.length > 0 ? `## Command results\n${commandResults}` : '## Command results\nnone',
    '',
    '## Implementation files for reference',
    renderFileList(input.files, 20_000).text,
    '',
    'Report what actually happened, as JSON.',
  ].join('\n');
  return { system: INTERPRET_SYSTEM, user };
}

export async function interpretReproduction(
  ctx: AgentContext,
  args: ReproductionInput & { candidateId: string },
): Promise<AgentOutcome<Reproduction>> {
  const prompt = buildReproductionInterpretPrompt(args);
  return ctx.runtime.run({
    agent: 'reproduction-interpreter',
    kind: 'REPRODUCTION',
    tier: 'fast',
    system: prompt.system,
    user: prompt.user,
    schema: reproductionSchema,
    schemaName: 'reproduction',
    promptVersion: REPRODUCTION_INTERPRET_PROMPT_VERSION,
    candidateId: args.candidateId,
    subject: { candidateId: args.candidateId },
    maxOutputTokens: 5000,
    interpret: (output) => ({
      verdict:
        output.status === 'REPRODUCED'
          ? 'SUPPORTS'
          : output.status === 'NOT_REPRODUCED'
            ? 'CONTRADICTS'
            : 'INCONCLUSIVE',
      confidence: output.confidence,
      rationale: `${output.status}${output.observedInSandbox ? ' (observed in sandbox)' : ' (static analysis)'}: ${output.observedBehavior.slice(0, 180)}`,
    }),
  });
}

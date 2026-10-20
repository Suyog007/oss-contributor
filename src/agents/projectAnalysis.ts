import { projectAnalysisSchema, type ProjectAnalysis } from '@/domain/schemas';
import { buildSystemPrompt } from '@/llm/context';
import type { AgentContext, AgentOutcome } from './runner';
import { renderRepoDigest } from './context';
import type { RepoDigest } from '@/github/repo';

export const PROJECT_ANALYSIS_PROMPT_VERSION = 1;

const SYSTEM = buildSystemPrompt({
  role: 'a senior engineer performing due diligence on an unfamiliar open-source repository',
  objective:
    'Produce a factual, evidence-based profile of this repository that another engineer could use to make their first contribution. Report the project as it is, not as you would like it to be.',
  rules: [
    'Base every statement on the material provided. If something is not visible in the provided files, say so in uncertainties instead of guessing.',
    'Distinguish what the code does from what you assume it does. Point at file paths (and line context where clear) in the evidence arrays.',
    'Do not describe a missing test, an unusual style, or a different architecture as a defect unless the material shows it contradicts the project\u2019s own documented behavior.',
    'testCommands must be commands that the project itself uses (from manifests or CI), never invented commands.',
    'conventions.commitStyle must be derived from the actual commit subjects shown.',
    'weaknesses and contributionAreas must be concrete and small enough for one focused pull request.',
    'If the repository looks like a content collection rather than software, say so plainly in purpose and keep weaknesses minimal.',
  ],
});

export interface AnalysisInput {
  digest: RepoDigest;
  /** Deterministic contributability stats, provided so the model does not re-derive them. */
  stats: Record<string, number>;
}

export function buildProjectAnalysisPrompt(input: AnalysisInput): {
  system: string;
  user: string;
  screen: ReturnType<typeof renderRepoDigest>['screen'];
} {
  const rendered = renderRepoDigest(input.digest);
  const user = [
    'Analyze the repository below and return the JSON profile.',
    '',
    `Deterministic observations already computed from the GitHub API (use these as facts): ${JSON.stringify(input.stats)}`,
    '',
    rendered.text,
    '',
    'Return the profile now.',
  ].join('\n');
  return { system: SYSTEM, user, screen: rendered.screen };
}

export async function runProjectAnalysis(
  ctx: AgentContext,
  args: {
    projectId: string;
    digest: RepoDigest;
    stats: Record<string, number>;
    taskRef?: string;
  },
): Promise<AgentOutcome<ProjectAnalysis>> {
  const prompt = buildProjectAnalysisPrompt({ digest: args.digest, stats: args.stats });
  return ctx.runtime.run({
    agent: 'project-analysis',
    kind: 'PROJECT_ANALYSIS',
    tier: 'fast',
    system: prompt.system,
    user: prompt.user,
    schema: projectAnalysisSchema,
    schemaName: 'projectAnalysis',
    promptVersion: PROJECT_ANALYSIS_PROMPT_VERSION,
    subject: { projectId: args.projectId },
    ...(args.taskRef ? { taskRef: args.taskRef } : {}),
    interpret: (output) => ({
      verdict: 'NOT_APPLICABLE',
      confidence:
        output.weaknesses.length > 0
          ? Math.max(0.4, Math.min(0.95, 1 - output.uncertainties.length * 0.05))
          : 0.5,
      rationale: `${output.purpose.slice(0, 140)} | weaknesses: ${output.weaknesses.length}, contribution areas: ${output.contributionAreas.length}`,
    }),
  });
}

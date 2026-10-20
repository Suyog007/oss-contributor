import type { Db } from '@/db/client';
import type { DecisionOutcome } from '@/generated/prisma/enums';
import { loadEnv } from '@/config/env';
import { createLogger } from '@/lib/logger';
import { boundText } from '@/llm/context';
import { BudgetExceededError } from '@/workflow/budget';
import { recordEvent } from '@/workflow/events';
import { enqueue } from '@/workflow/queue';
import { GitHubClient, GitHubRateLimitError } from '@/github/client';
import {
  fetchFileText,
  fetchIssue,
  fetchIssueComments,
  fetchTree,
  splitFullName,
  DIGEST_VERSION,
  type CommentSummary,
  type IssueSummary,
  type RepoDigest,
} from '@/github/repo';
import { SearchPacer } from '@/github/pacing';
import { createAgentContext, type AgentContext } from '@/agents/runner';
import { runValidation } from '@/agents/validator';
import { interpretReproduction, planReproduction } from '@/agents/reproduction';
import { collectDuplicateEvidence, runDuplicateCheck } from '@/agents/duplicate';
import { runMaintainerContext } from '@/agents/maintainerContext';
import {
  adjudicate,
  decide,
  persistDecision,
  INVESTIGATION_POLICY_VERSION,
} from '@/agents/decision';
import {
  DockerSandbox,
  SandboxError,
  resolveWorkingDirectory,
  summarizeSandboxResult,
  type SandboxResult,
} from '@/sandbox/docker';
import {
  ecosystemForInvestigation,
  installCommandsFor,
  manifestDirectoryFor,
} from '@/sandbox/policy';
import { Workspace } from '@/workspace/manager';
import {
  hypothesisItemSchema,
  type Adjudication,
  type Hypothesis,
  type ProjectAnalysis,
} from '@/domain/schemas';

const log = createLogger('investigate');

export type InvestigateStatus =
  | 'validated'
  | 'needs-investigation'
  | 'needs-maintainer-input'
  | 'duplicate'
  | 'rejected'
  | 'out-of-scope'
  | 'abandoned'
  | 'already-decided'
  | 'missing-hypothesis'
  | 'no-digest'
  | 'rate-limited';

export interface InvestigateResult {
  candidateId: string;
  status: InvestigateStatus;
  outcome?: DecisionOutcome;
  escalated: boolean;
  reproductionMode: 'runtime' | 'static' | 'skipped';
  costUsd: number;
  /** Per-agent verdict summary for logs and the CLI. */
  agents: Record<string, string>;
}

const STATUS_FOR_OUTCOME: Record<DecisionOutcome, InvestigateStatus> = {
  IMPLEMENT: 'validated',
  NEEDS_INVESTIGATION: 'needs-investigation',
  NEEDS_MAINTAINER_INPUT: 'needs-maintainer-input',
  DUPLICATE: 'duplicate',
  NOT_A_PROBLEM: 'rejected',
  TOO_RISKY: 'out-of-scope',
  OUT_OF_SCOPE: 'out-of-scope',
};

/**
 * Investigate one candidate with independent agents.
 *
 * Order matters: validation decides whether the claim is real, reproduction
 * checks it against execution, duplicate search checks whether the work already
 * exists, and maintainer context checks whether the project wants it. Each agent
 * only ever sees material that was fetched for it, and every output is persisted
 * before the decision is computed.
 *
 * The function is idempotent: agent outputs are reused by content hash, the
 * decision row is upserted, and the candidate status is derived from the
 * decision, so re-running after a crash continues instead of duplicating work.
 */
export async function investigateCandidate(
  db: Db,
  client: GitHubClient,
  candidateId: string,
  options: { reuseInvestigations?: boolean } = {},
): Promise<InvestigateResult> {
  const env = loadEnv();
  const candidate = await db.candidate.findUniqueOrThrow({
    where: { id: candidateId },
    include: { project: true, decision: true },
  });
  const project = candidate.project;

  if (
    candidate.decision &&
    candidate.status !== 'PROPOSED' &&
    candidate.status !== 'INVESTIGATING' &&
    candidate.status !== 'NEEDS_INVESTIGATION'
  ) {
    return {
      candidateId,
      status: 'already-decided',
      outcome: candidate.decision.outcome,
      escalated: candidate.decision.escalated,
      reproductionMode: 'skipped',
      costUsd: 0,
      agents: {},
    };
  }

  const fail = async (status: InvestigateStatus, reason: string): Promise<InvestigateResult> => {
    await recordEvent(db, {
      eventType: 'investigation_blocked',
      reason,
      projectId: project.id,
      candidateId,
      actorKind: 'SYSTEM',
      actor: 'investigate',
    });
    return {
      candidateId,
      status,
      escalated: false,
      reproductionMode: 'skipped',
      costUsd: 0,
      agents: {},
    };
  };

  if (!project.analysisJson || !project.analysisHeadSha) {
    return fail(
      'missing-hypothesis',
      'the project has no analysis at a known commit; investigate after analyzing',
    );
  }

  const hypothesisRows = await db.investigation.findMany({
    where: { candidateId, kind: 'HYPOTHESIS' },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { outputJson: true },
  });
  // Per-candidate hypotheses are stored individually, but the same `kind` is
  // also used for the batch output. Find the row that parses, preferring the
  // one whose title matches this candidate.
  let hypothesis: Hypothesis | null = null;
  for (const row of hypothesisRows) {
    const parsed = hypothesisItemSchema.safeParse(row.outputJson);
    if (parsed.success && parsed.data.title === candidate.title) {
      hypothesis = parsed.data;
      break;
    }
  }
  if (!hypothesis) {
    for (const row of hypothesisRows) {
      const parsed = hypothesisItemSchema.safeParse(row.outputJson);
      if (parsed.success) {
        hypothesis = parsed.data;
        break;
      }
    }
  }
  if (!hypothesis) {
    await db.candidate.update({
      where: { id: candidateId },
      data: { status: 'ABANDONED', statusReason: 'no stored hypothesis to investigate' },
    });
    return fail(
      'missing-hypothesis',
      'the candidate has no readable hypothesis record; it was likely created outside the hypothesis workflow',
    );
  }
  const analysis = project.analysisJson as unknown as ProjectAnalysis;

  // Evidence is read at the commit the hypothesis was generated at. If that
  // digest is gone (rebuilt at a newer commit), fall back to the project's
  // current digest and record the drift instead of pretending nothing changed.
  const candidateSha = candidate.analysisHeadSha ?? project.analysisHeadSha;
  let headSha = candidateSha;
  let digestRow = await db.repoDigest.findUnique({
    where: { projectId_headSha: { projectId: project.id, headSha: candidateSha } },
  });
  let digestDrift = false;
  if (!digestRow && candidateSha !== project.analysisHeadSha) {
    digestRow = await db.repoDigest.findUnique({
      where: { projectId_headSha: { projectId: project.id, headSha: project.analysisHeadSha } },
    });
    headSha = project.analysisHeadSha;
    digestDrift = digestRow !== null;
  }
  if (!digestRow) {
    return fail(
      'no-digest',
      `the repository digest for ${candidateSha.slice(0, 12)} is missing; re-run analysis`,
    );
  }
  const digest = digestRow.json as unknown as RepoDigest;
  if (digest.digestVersion !== DIGEST_VERSION) {
    return fail(
      'no-digest',
      `the stored digest is version ${digest.digestVersion}, expected ${DIGEST_VERSION}; re-run analysis`,
    );
  }
  if (digestDrift) {
    await recordEvent(db, {
      eventType: 'evidence_commit_drift',
      reason: `the digest for ${candidateSha.slice(0, 12)} was rebuilt away; evidence is read at ${headSha.slice(0, 12)} instead`,
      projectId: project.id,
      candidateId,
      actorKind: 'SYSTEM',
      actor: 'investigate',
      evidence: { hypothesisSha: candidateSha, actualSha: headSha },
    });
  }

  await db.candidate.update({
    where: { id: candidateId },
    data: { status: 'INVESTIGATING', statusReason: 'investigation started' },
  });
  await recordEvent(db, {
    eventType: 'investigation_started',
    reason: `investigating: ${hypothesis.title}`,
    projectId: project.id,
    candidateId,
    fromState: candidate.status,
    toState: 'INVESTIGATING',
    actorKind: 'SYSTEM',
    actor: 'investigate',
    evidence: {
      headSha,
      hypothesisSha: candidateSha,
      digestDrift,
      policyVersion: INVESTIGATION_POLICY_VERSION,
    },
  });

  const ctx: AgentContext = createAgentContext(db, {
    ...(options.reuseInvestigations !== undefined
      ? { reuseInvestigations: options.reuseInvestigations }
      : {}),
  });
  const ref = splitFullName(project.fullName);
  const sandbox = DockerSandbox.fromEnv(db, env);
  const agents: Record<string, string> = {};
  let costUsd = 0;

  try {
    // -----------------------------------------------------------------------
    // Material gathering. Every path is checked against the real tree first, so
    // no agent can be shown a file that does not exist at this commit: the
    // hypothesis's own files, then whatever the reproduction plan asks for.
    // -----------------------------------------------------------------------
    let treePaths = new Set<string>();
    try {
      const { entries } = await fetchTree(client, ref, headSha);
      treePaths = new Set(
        entries.filter((entry) => entry.type === 'blob').map((entry) => entry.path),
      );
    } catch (error) {
      if (error instanceof GitHubRateLimitError) {
        return fail(
          'rate-limited',
          'github rate limit reached while reading the tree; retry later',
        );
      }
      throw error;
    }

    const fileBudget = Math.min(env.ANALYSIS_MAX_CONTEXT_BYTES, 80_000);
    const files: Array<{ path: string; text: string }> = [];
    let usedBytes = 0;
    const readPath = async (path: string, perFileLimit = 24_000): Promise<boolean> => {
      if (files.some((file) => file.path === path) || !treePaths.has(path)) return false;
      if (usedBytes >= fileBudget) return false;
      const text = await fetchFileText(client, ref, path, headSha);
      if (!text) return false;
      const bounded = boundText(text, Math.min(perFileLimit, fileBudget - usedBytes));
      usedBytes += Buffer.byteLength(bounded.text, 'utf8');
      files.push({ path, text: bounded.text });
      return true;
    };

    const unknownHypothesisPaths = hypothesis.files.filter((path) => !treePaths.has(path));
    if (unknownHypothesisPaths.length > 0) {
      await recordEvent(db, {
        eventType: 'agent_path_hallucination_filtered',
        reason: `${unknownHypothesisPaths.length} hypothesis file path(s) do not exist at ${headSha.slice(0, 12)} and were dropped`,
        projectId: project.id,
        candidateId,
        actorKind: 'AGENT',
        actor: 'investigate',
        evidence: { unknown: unknownHypothesisPaths },
      });
    }
    for (const path of hypothesis.files) await readPath(path);

    // The toolchain that matters is the one for the files in question, not the
    // first manifest in the repository root (monorepos are both at once).
    const planEcosystem = ecosystemForInvestigation(
      hypothesis.files,
      project.language,
      digest.tree.manifests,
    );

    const plan = await planReproduction(ctx, {
      digest,
      hypothesis,
      files,
      ecosystem: planEcosystem,
      candidateId,
    });
    costUsd += plan.costUsd;
    agents['reproduction-plan'] =
      `${plan.output.commands.length} command(s), ecosystem=${planEcosystem}, workingDirectory=${plan.output.workingDirectory ?? 'project root'}`;

    const unknownPlannedPaths = plan.output.filesToInspect.filter((path) => !treePaths.has(path));
    if (unknownPlannedPaths.length > 0) {
      await recordEvent(db, {
        eventType: 'agent_path_hallucination_filtered',
        reason: `${unknownPlannedPaths.length} planned file path(s) do not exist at ${headSha.slice(0, 12)} and were dropped`,
        projectId: project.id,
        candidateId,
        actorKind: 'AGENT',
        actor: 'reproduction-planner',
        evidence: { unknown: unknownPlannedPaths },
      });
    }
    for (const path of plan.output.filesToInspect) await readPath(path);

    // Recompute with everything now known (hypothesis files + planned files):
    // this is the ecosystem the sandbox image and install commands use.
    const ecosystem = ecosystemForInvestigation(
      files.map((file) => file.path),
      project.language,
      digest.tree.manifests,
    );
    const installDirectory = manifestDirectoryFor(ecosystem, digest.tree.manifests);
    const plannedDirectory = plan.output.workingDirectory
      ? resolveWorkingDirectory(plan.output.workingDirectory)
      : null;
    const plannedDirectoryExists =
      plannedDirectory?.ok === true &&
      plannedDirectory.relative !== null &&
      [...treePaths].some((path) => path.startsWith(`${plannedDirectory.relative}/`));
    const reproductionDirectory =
      plannedDirectory?.ok && plannedDirectoryExists && plannedDirectory.relative
        ? plannedDirectory.relative
        : installDirectory;

    // Related files: the tests that cover the files in question, found by name
    // rather than by asking a model to guess.
    const stems = new Set(
      files.map((file) =>
        (file.path.split('/').pop() ?? '').replace(
          /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|cs)$/,
          '',
        ),
      ),
    );
    const relatedCandidates = digest.tree.testFiles
      .filter((path) => !files.some((file) => file.path === path))
      .filter((path) => [...stems].some((stem) => stem.length >= 4 && path.includes(stem)))
      .slice(0, 3);
    const relatedFiles: Array<{ path: string; text: string }> = [];
    for (const path of relatedCandidates) {
      if (usedBytes >= fileBudget + 24_000) break;
      const text = await fetchFileText(client, ref, path, headSha);
      if (!text) continue;
      const bounded = boundText(text, 12_000);
      usedBytes += Buffer.byteLength(bounded.text, 'utf8');
      relatedFiles.push({ path, text: bounded.text });
    }

    let issueThread: { issue: IssueSummary; comments: CommentSummary[] } | null = null;
    if (hypothesis.originIssueNumber) {
      const issue = await fetchIssue(client, ref, hypothesis.originIssueNumber).catch(() => null);
      if (issue) {
        const comments = await fetchIssueComments(client, ref, issue.number, 30).catch(() => []);
        issueThread = { issue, comments };
      }
    }

    // -----------------------------------------------------------------------
    // Agent B: validation
    // -----------------------------------------------------------------------
    const validation = await runValidation(ctx, {
      digest,
      hypothesis,
      files,
      relatedFiles,
      issueThread,
      analysisSummary: `${analysis.purpose}\nTesting: ${analysis.testingStrategy}\nWeaknesses: ${analysis.weaknesses.map((weakness) => weakness.area).join(', ')}`,
      candidateId,
      taskRef: `validation:${candidateId}`,
    });
    costUsd += validation.costUsd;
    agents['validation'] =
      `${validation.verdict} (${validation.output.behaviorIsIncorrect}, intentional=${validation.output.intentional}, conf ${validation.confidence.toFixed(2)})`;

    // -----------------------------------------------------------------------
    // Agent C: reproduction (plan -> sandbox -> interpret)
    // -----------------------------------------------------------------------
    let reproductionMode: 'runtime' | 'static' | 'skipped' = 'static';
    const planCommands = plan.output.commands
      .slice(0, 3)
      .filter((command) => command.trim().length > 0);
    let reproductionResults: SandboxResult[] = [];
    let workspacePath: string | null = null;

    if (planCommands.length > 0 && env.SANDBOX_MODE !== 'none') {
      const workspace = Workspace.forContribution(db, {
        contributionId: candidate.id,
        projectId: project.id,
        fullName: project.fullName,
        defaultBranch: project.defaultBranch,
        baseSha: headSha,
        branchName: `agent/repro-${candidate.id.slice(-8)}`,
      });
      try {
        await workspace.startFromBase();
        workspacePath = workspace.path;
        reproductionMode = 'runtime';
      } catch (error) {
        await recordEvent(db, {
          eventType: 'reproduction_clone_failed',
          reason: `could not prepare a workspace at ${headSha.slice(0, 12)}: ${error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)}`,
          projectId: project.id,
          candidateId,
          actorKind: 'SYSTEM',
          actor: 'investigate',
        });
        reproductionMode = 'static';
      }
    }

    if (reproductionMode === 'runtime' && workspacePath) {
      try {
        const installs = installCommandsFor(ecosystem, digest.tree.manifests).slice(0, 2);
        const prepared = await sandbox.prepare({
          workspacePath,
          commands: installs,
          ecosystem,
          ...(installDirectory ? { workingDirectory: installDirectory } : {}),
          projectId: project.id,
          contributionId: candidate.id,
        });
        for (const result of prepared) {
          await recordEvent(db, {
            eventType: 'sandbox_prepare',
            reason: summarizeSandboxResult(result),
            projectId: project.id,
            candidateId,
            actorKind: 'SYSTEM',
            actor: 'sandbox',
            evidence: {
              command: result.command,
              exitCode: result.exitCode,
              outputTail: result.output.slice(-2000),
            },
          });
        }

        for (const command of planCommands) {
          const result = await sandbox.run({
            workspacePath,
            command,
            ecosystem,
            ...(reproductionDirectory ? { workingDirectory: reproductionDirectory } : {}),
            allowNetwork: false,
            timeoutMs: Math.min(env.SANDBOX_TIMEOUT_MS, 300_000),
            projectId: project.id,
            contributionId: candidate.id,
            label: `repro: ${command}`,
          });
          reproductionResults.push(result);
          await recordEvent(db, {
            eventType: 'reproduction_command',
            reason: summarizeSandboxResult(result),
            projectId: project.id,
            candidateId,
            actorKind: 'SYSTEM',
            actor: 'sandbox',
            evidence: {
              command: result.command,
              exitCode: result.exitCode,
              timedOut: result.timedOut,
              refusedReason: result.refusedReason ?? null,
              network: result.network,
              outputTail: result.output.slice(-4000),
            },
          });
        }
      } catch (error) {
        // A broken sandbox must not silently turn into "not reproduced".
        reproductionMode = 'static';
        reproductionResults = [];
        await recordEvent(db, {
          eventType: 'reproduction_sandbox_failed',
          reason: `sandbox execution failed, falling back to static analysis: ${error instanceof SandboxError ? error.message : String(error).slice(0, 300)}`,
          projectId: project.id,
          candidateId,
          actorKind: 'SYSTEM',
          actor: 'sandbox',
        });
      }
    }

    if (reproductionMode === 'static' && planCommands.length > 0) {
      reproductionResults = planCommands.map((command) => ({
        command,
        exitCode: null,
        output: 'not executed: no isolated workspace was available for this candidate',
        durationMs: 0,
        timedOut: false,
        truncated: false,
        sandboxKind: 'none' as const,
        refusedReason: 'not executed',
        network: false,
      }));
    }

    const reproduction = await interpretReproduction(ctx, {
      digest,
      hypothesis,
      files,
      ecosystem,
      image: sandbox.imageFor(ecosystem),
      results: reproductionResults.map((result) => ({
        command: result.command,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        ...(result.refusedReason ? { refusedReason: result.refusedReason } : {}),
        output: result.output,
      })),
      mode: reproductionMode === 'runtime' ? 'runtime' : 'static',
      candidateId,
    });
    costUsd += reproduction.costUsd;
    agents['reproduction'] =
      `${reproduction.output.status} (${reproductionMode}, conf ${reproduction.confidence.toFixed(2)})`;

    // -----------------------------------------------------------------------
    // Agent D: duplicates and history
    // -----------------------------------------------------------------------
    const bundle = await collectDuplicateEvidence(client, hypothesis, {
      digest,
      pacer: new SearchPacer(client),
    });
    const duplicate = await runDuplicateCheck(ctx, {
      digest,
      hypothesis,
      bundle,
      candidateId,
      taskRef: `duplicate:${candidateId}`,
    });
    costUsd += duplicate.costUsd;
    agents['duplicate'] =
      `${duplicate.output.verdict} (${duplicate.output.matches.length} refs, conf ${duplicate.confidence.toFixed(2)})`;

    // -----------------------------------------------------------------------
    // Agent E: maintainer context
    // -----------------------------------------------------------------------
    const maintainer = await runMaintainerContext(ctx, {
      digest,
      hypothesis,
      analysis,
      candidateId,
      taskRef: `maintainer:${candidateId}`,
    });
    costUsd += maintainer.costUsd;
    agents['maintainer'] =
      `${maintainer.output.recommendation} (in scope ${maintainer.output.inScope}, signoff ${maintainer.output.needsMaintainerSignoff})`;

    // -----------------------------------------------------------------------
    // Decision
    // -----------------------------------------------------------------------
    let result = decide({
      hypothesis,
      validation: validation.output,
      reproduction: reproduction.output,
      duplicate: duplicate.output,
      maintainer: maintainer.output,
      minConfidence: env.CANDIDATE_MIN_CONFIDENCE,
    });

    let adjudicationInfo: {
      resolution: Adjudication['resolution'];
      rationale: string;
      investigationId: string;
    } | null = null;
    if (result.adjudication) {
      const adjudicationOutcome = await adjudicate(ctx, {
        candidateId,
        hypothesis,
        validation: validation.output,
        reproduction: reproduction.output,
        question: result.adjudication.question,
        conflict: result.adjudication.conflict,
        taskRef: `adjudicate:${candidateId}`,
      });
      costUsd += adjudicationOutcome.costUsd;
      const resolution = adjudicationOutcome.output.resolution;
      agents['adjudication'] = `${resolution} (conf 0.50)`;
      adjudicationInfo = {
        resolution,
        rationale: adjudicationOutcome.output.rationale.slice(0, 1200),
        investigationId: adjudicationOutcome.investigationId,
      };

      if (resolution === 'IMPLEMENT') {
        result = {
          ...result,
          outcome: 'IMPLEMENT',
          escalated: false,
          adjudication: null,
          rationale: `adjudication: ${adjudicationOutcome.output.rationale.slice(0, 400)}`,
        };
      } else if (resolution === 'NOT_A_PROBLEM') {
        result = {
          ...result,
          outcome: 'NOT_A_PROBLEM',
          escalated: false,
          adjudication: null,
          rationale: `adjudication: ${adjudicationOutcome.output.rationale.slice(0, 400)}`,
        };
      } else if (resolution === 'NEEDS_MAINTAINER_INPUT') {
        result = {
          ...result,
          outcome: 'NEEDS_MAINTAINER_INPUT',
          escalated: false,
          adjudication: null,
          rationale: `adjudication: ${adjudicationOutcome.output.rationale.slice(0, 400)}`,
        };
      } else {
        // Unresolved conflict: the decision stays escalated and a human decides.
        result = {
          ...result,
          outcome: 'NEEDS_INVESTIGATION',
          escalated: true,
          adjudication: null,
          rationale: `adjudication could not settle the conflict: ${adjudicationOutcome.output.rationale.slice(0, 400)}`,
        };
      }
    }

    await persistDecision(db, {
      candidateId,
      result,
      adjudication: adjudicationInfo,
      decidedBy: 'decision-aggregator',
    });

    const reproducedInSandbox =
      reproduction.output.observedInSandbox && reproductionMode === 'runtime';
    await recordEvent(db, {
      eventType: 'investigation_completed',
      reason: `${result.outcome}: ${result.rationale.slice(0, 250)}`,
      projectId: project.id,
      candidateId,
      toState: result.outcome,
      actorKind: 'SYSTEM',
      actor: 'investigate',
      evidence: {
        agents,
        reproductionMode,
        reproducedInSandbox,
        escalated: result.escalated,
        costUsd: Number(costUsd.toFixed(6)),
        policyVersion: INVESTIGATION_POLICY_VERSION,
      },
    });

    if (result.outcome === 'IMPLEMENT') {
      await enqueue(db, {
        kind: 'IMPLEMENT_CONTRIBUTION',
        dedupeKey: `implement:${candidateId}`,
        payload: { candidateId },
        priority: 50,
        projectId: project.id,
      });
    }

    log.info('investigation complete', {
      candidateId,
      outcome: result.outcome,
      costUsd: Number(costUsd.toFixed(4)),
      reproductionMode,
    });

    return {
      candidateId,
      status: STATUS_FOR_OUTCOME[result.outcome],
      outcome: result.outcome,
      escalated: result.escalated,
      reproductionMode,
      costUsd: Number(costUsd.toFixed(6)),
      agents,
    };
  } catch (error) {
    if (error instanceof BudgetExceededError) {
      await db.candidate.update({
        where: { id: candidateId },
        data: {
          status: 'ABANDONED',
          statusReason: `budget exhausted: ${error.detail.slice(0, 300)}`,
        },
      });
      await recordEvent(db, {
        eventType: 'budget_exhausted',
        reason: `investigation stopped: ${error.scope} budget exhausted (${error.detail})`,
        projectId: project.id,
        candidateId,
        actorKind: 'SYSTEM',
        actor: 'investigate',
      });
      return {
        candidateId,
        status: 'abandoned',
        escalated: false,
        reproductionMode: 'skipped',
        costUsd,
        agents,
      };
    }

    if (error instanceof GitHubRateLimitError) {
      return fail(
        'rate-limited',
        `github rate limit reached during investigation: ${error.message.slice(0, 200)}`,
      );
    }

    await recordEvent(db, {
      eventType: 'investigation_failed',
      reason: `investigation failed: ${error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400)}`,
      projectId: project.id,
      candidateId,
      actorKind: 'SYSTEM',
      actor: 'investigate',
    });
    throw error;
  }
}

/** Small helper used by the CLI: everything the dashboard needs for one candidate. */
export async function summariseCandidate(db: Db, candidateId: string): Promise<string> {
  const candidate = await db.candidate.findUniqueOrThrow({
    where: { id: candidateId },
    include: {
      project: true,
      decision: true,
      investigations: { orderBy: { createdAt: 'desc' }, take: 8 },
    },
  });
  const lines = [
    `${candidate.project.fullName} — candidate ${candidate.id}`,
    `title: ${candidate.title}`,
    `status: ${candidate.status}${candidate.statusReason ? ` (${candidate.statusReason})` : ''}`,
    candidate.decision
      ? `decision: ${candidate.decision.outcome}${candidate.decision.escalated ? ' [escalated]' : ''} — ${candidate.decision.rationale}`
      : 'decision: pending',
    'investigations:',
    ...candidate.investigations.map(
      (investigation) =>
        `  - ${investigation.kind} ${investigation.verdict} (${investigation.confidence.toFixed(2)}) ${investigation.rationale.slice(0, 120)}`,
    ),
  ];
  return lines.join('\n');
}

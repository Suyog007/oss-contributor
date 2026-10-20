/**
 * Implementation pipeline: evidence -> plan -> whole-file edits -> diff ->
 * revision -> sandbox tests -> ready for independent review.
 *
 * The orchestrator, not the model, decides what is allowed to change: every
 * path is validated against the workspace, scope-changing files (lockfiles,
 * CI, vendored code) are refused, and tests are run in the same isolated
 * container used for reproduction. A contribution only reaches review with a
 * recorded diff, a recorded test outcome, and an audit trail.
 */
import type { Db } from '@/db/client';
import type { Prisma } from '@/generated/prisma/client';
import type { ContributionState } from '@/generated/prisma/enums';
import { loadEnv, type Env } from '@/config/env';
import { createLogger } from '@/lib/logger';
import { recordEvent, recordSecurityEvent } from '@/workflow/events';
import { enqueue } from '@/workflow/queue';
import { TaskBlockedError } from '@/workflow/errors';
import {
  cleanRelativePath,
  forbiddenPathReason,
  isTestPath,
  MAX_WHOLE_FILE_EDIT_BYTES,
  relatedTestFiles,
  slugify,
} from '@/workflows/implementation-policy';
import { createAgentContext } from '@/agents/runner';
import { planSolution, writeSolution, type SolutionEvidence } from '@/agents/solution';
import { loadDigest, loadEvidence } from '@/workflows/evidence';
import { transitionContribution } from '@/workflows/transitions';
import type { SolutionPlan } from '@/domain/schemas';
import { Workspace } from '@/workspace/manager';
import { readWorkspaceFiles } from '@/workspace/read';
import { DockerSandbox, resolveWorkingDirectory, summarizeSandboxResult } from '@/sandbox/docker';
import {
  ecosystemForInvestigation,
  installCommandsFor,
  manifestDirectoryFor,
  stripRedundantCd,
  validateCommand,
  type Ecosystem,
} from '@/sandbox/policy';
import { DIGEST_VERSION, type RepoDigest } from '@/github/repo';

const log = createLogger('implement');

/** States in which re-running implementation would duplicate finished work. */
const COMPLETE_STATES: ContributionState[] = [
  'INDEPENDENT_REVIEW',
  'READY_FOR_SUBMISSION',
  'HUMAN_APPROVAL',
  'PR_SUBMITTED',
  'AWAITING_REVIEW',
  'FEEDBACK_RECEIVED',
  'RESOLVED',
  'MERGED',
  'CLOSED_UNMERGED',
  'ABANDONED',
  'CANCELLED',
  'DUPLICATE',
  'REJECTED_CANDIDATE',
  'NEEDS_MAINTAINER_INPUT',
];

export interface ImplementResult {
  contributionId: string;
  status: 'ready-for-review' | 'tests-failed' | 'blocked' | 'already-complete';
  revisionIndex: number | null;
  note: string;
  costUsd: number;
}

export async function implementContribution(
  db: Db,
  candidateId: string,
  options: { revisionContext?: string } = {},
  env: Env = loadEnv(),
): Promise<ImplementResult> {
  const candidate = await db.candidate.findUnique({
    where: { id: candidateId },
    include: { project: true, decision: true },
  });
  if (!candidate) throw new Error(`candidate ${candidateId} not found`);
  if (candidate.decision?.outcome !== 'IMPLEMENT') {
    throw new TaskBlockedError(
      `candidate ${candidateId} is not approved for implementation (decision: ${candidate.decision?.outcome ?? 'none'})`,
    );
  }

  const project = candidate.project;
  const headSha = candidate.analysisHeadSha ?? project.analysisHeadSha;
  if (!headSha) {
    throw new TaskBlockedError(
      `candidate ${candidateId} has no analyzed commit; re-run hypotheses or set analysisHeadSha`,
    );
  }

  const digest = await loadDigest(db, project.id, headSha);
  if (!digest) {
    throw new TaskBlockedError(
      `no repository digest for ${project.fullName} at ${headSha.slice(0, 12)}; run \`pnpm rebuild-digest ${project.fullName} --sha ${headSha}\``,
    );
  }
  if (digest.digestVersion !== DIGEST_VERSION) {
    throw new TaskBlockedError(
      `digest for ${project.fullName} is version ${String(digest.digestVersion)}, expected ${DIGEST_VERSION}; rebuild it`,
    );
  }

  const { hypothesis, validation, reproduction, duplicate, maintainer } = await loadEvidence(
    db,
    candidateId,
    candidate.title,
  );
  if (!hypothesis) {
    throw new TaskBlockedError(`the hypothesis behind candidate ${candidateId} could not be loaded from the investigation log`);
  }

  const idempotencyKey = `contribution:${candidate.id}`;
  let contribution = await db.contribution.findUnique({ where: { idempotencyKey } });
  if (contribution && COMPLETE_STATES.includes(contribution.state)) {
    return {
      contributionId: contribution.id,
      status: 'already-complete',
      revisionIndex: contribution.revisionCount > 0 ? contribution.revisionCount : null,
      note: `contribution is already in state ${contribution.state}`,
      costUsd: 0,
    };
  }

  // The cap applies to review-driven revisions, not to retries after an
  // infrastructure failure. A failed sandbox run must not consume the budget
  // reserved for addressing reviewers' findings.
  if (
    options.revisionContext &&
    contribution &&
    contribution.reviewRound > env.MAX_REVISION_ROUNDS
  ) {
    throw new TaskBlockedError(
      `contribution ${contribution.id} has already completed ${contribution.reviewRound} review round(s), the configured maximum of ${env.MAX_REVISION_ROUNDS}; it cannot be revised again`,
    );
  }

  const branchName =
    contribution?.branchName ??
    `agent/fix-${slugify(candidate.title) || 'change'}-${candidate.id.slice(-6)}`;

  if (!contribution) {
    contribution = await db.contribution.create({
      data: {
        projectId: project.id,
        candidateId: candidate.id,
        idempotencyKey,
        state: 'IMPLEMENTING',
        stateReason: `approved by the investigation decision: ${candidate.decision.rationale.slice(0, 400)}`,
        baseRef: project.defaultBranch,
        baseSha: headSha,
        branchName,
        budgetUsd: env.AI_CONTRIBUTION_BUDGET_USD,
      },
    });
    await recordEvent(db, {
      eventType: 'contribution_created',
      reason: `contribution created from candidate ${candidate.id} at ${headSha.slice(0, 12)}`,
      projectId: project.id,
      candidateId: candidate.id,
      contributionId: contribution.id,
      toState: 'IMPLEMENTING',
      actorKind: 'AGENT',
      actor: 'implement',
      evidence: { branchName, baseSha: headSha },
    });
  } else {
    contribution = await db.contribution.update({
      where: { id: contribution.id },
      data: { state: 'IMPLEMENTING', stateReason: 'implementation restarted', branchName, baseSha: headSha },
    });
    await recordEvent(db, {
      eventType: 'contribution_restarted',
      reason: `implementation restarted for ${contribution.id}${options.revisionContext ? ' with review findings' : ''}`,
      projectId: project.id,
      candidateId: candidate.id,
      contributionId: contribution.id,
      toState: 'IMPLEMENTING',
      actorKind: 'AGENT',
      actor: 'implement',
    });
  }
  const contributionId = contribution.id;

  let state: ContributionState = contribution.state;
  const transition = async (
    toState: ContributionState,
    reason: string,
    data: Prisma.ContributionUpdateInput = {},
  ): Promise<void> => {
    await transitionContribution(db, {
      contributionId,
      projectId: project.id,
      candidateId: candidate.id,
      fromState: state,
      toState,
      reason,
      actorKind: 'AGENT',
      actor: 'implement',
      data,
    });
    state = toState;
  };

  const block = async (reason: string): Promise<ImplementResult> => {
    await transition('FAILED', reason);
    await db.contribution.update({ where: { id: contributionId }, data: { blockedReason: reason.slice(0, 2000) } });
    log.warn('implementation blocked', { contributionId, reason: reason.slice(0, 300) });
    return { contributionId, status: 'blocked', revisionIndex: null, note: reason, costUsd: 0 };
  };

  const workspace = Workspace.forContribution(
    db,
    {
      contributionId,
      projectId: project.id,
      fullName: project.fullName,
      defaultBranch: project.defaultBranch,
      baseSha: headSha,
      branchName,
    },
    env,
  );
  await workspace.startFromBase();
  await db.contribution.update({
    where: { id: contributionId },
    data: { workspacePath: workspace.path, sandboxKind: env.SANDBOX_MODE },
  });
  await recordEvent(db, {
    eventType: 'workspace_prepared',
    reason: `clean checkout of ${project.fullName} at ${headSha.slice(0, 12)} on ${branchName}`,
    projectId: project.id,
    candidateId: candidate.id,
    contributionId,
    actorKind: 'SYSTEM',
    actor: 'workspace',
    evidence: { workspacePath: workspace.path, baseSha: headSha, branchName },
  });

  // The planning context is decided by the files the investigation is about,
  // not by every file in the repository: in a polyglot monorepo the largest
  // language would otherwise win and point the plan at the wrong toolchain.
  const ecosystem = ecosystemForInvestigation(
    [...candidate.files, ...hypothesis.files],
    digest.repo.language,
    digest.tree.manifests,
  );
  const evidence: SolutionEvidence = {
    digest,
    hypothesis,
    validation,
    reproduction,
    duplicate,
    maintainer,
    decisionRationale: candidate.decision.rationale,
    ecosystem,
  };
  const projectDirectory = manifestDirectoryFor(ecosystem, digest.tree.manifests);
  const workdir = resolveWorkingDirectory(projectDirectory);
  if (!workdir.ok) {
    return block(`the project directory derived from manifests is unsafe: ${workdir.reason}`);
  }
  evidence.workingDirectory = workdir.relative ?? undefined;

  // -----------------------------------------------------------------------
  // Plan
  // -----------------------------------------------------------------------
  const initialPaths = [
    ...candidate.files,
    ...hypothesis.files,
    ...relatedTestFiles(digest, [...candidate.files, ...hypothesis.files]),
    ...digest.tree.manifests,
    ...digest.files.map((file) => file.path),
  ];
  const initial = await readWorkspaceFiles(workspace, initialPaths, {
    maxFiles: 12,
    maxTotalBytes: 120_000,
    maxFileBytes: 60_000,
  });

  const ctx = createAgentContext(db);
  const planOutcome = await planSolution(ctx, {
    ...evidence,
    candidateId,
    files: initial.files,
    ...(options.revisionContext ? { revisionContext: options.revisionContext } : {}),
  });
  let costUsd = planOutcome.costUsd;
  const llmTokens = planOutcome.promptTokens + planOutcome.completionTokens;
  let plan: SolutionPlan = planOutcome.output;

  const plannedChanges: SolutionPlan['changes'] = [];
  const plannedTests: SolutionPlan['testsToAdd'] = [];
  const planProblems: string[] = [];
  for (const change of plan.changes) {
    const path = cleanRelativePath(change.file);
    if (!path) {
      planProblems.push(`unsafe path in plan: ${change.file}`);
      continue;
    }
    if (change.kind === 'delete') {
      planProblems.push(`deletion proposed for ${path}; deletions are not supported`);
      continue;
    }
    const forbidden = forbiddenPathReason(path);
    if (forbidden) {
      planProblems.push(`planned change to ${path} refused: ${forbidden}`);
      continue;
    }
    const existing = await workspace.readFile(path);
    if (change.kind === 'modify' && existing === null) {
      planProblems.push(`planned modification of ${path}, which does not exist at the base commit`);
      continue;
    }
    if (existing !== null && Buffer.byteLength(existing, 'utf8') > MAX_WHOLE_FILE_EDIT_BYTES) {
      planProblems.push(
        `planned change to ${path} refused: ${Buffer.byteLength(existing, 'utf8')} bytes exceeds the ${MAX_WHOLE_FILE_EDIT_BYTES}-byte whole-file editing limit`,
      );
      continue;
    }
    plannedChanges.push({ ...change, file: path });
  }
  for (const test of plan.testsToAdd) {
    const path = cleanRelativePath(test.file);
    if (!path) {
      planProblems.push(`unsafe test path in plan: ${test.file}`);
      continue;
    }
    const forbidden = forbiddenPathReason(path);
    if (forbidden) {
      planProblems.push(`planned test at ${path} refused: ${forbidden}`);
      continue;
    }
    const existingTest = await workspace.readFile(path);
    if (existingTest !== null && Buffer.byteLength(existingTest, 'utf8') > MAX_WHOLE_FILE_EDIT_BYTES) {
      planProblems.push(
        `planned test at ${path} refused: ${Buffer.byteLength(existingTest, 'utf8')} bytes exceeds the ${MAX_WHOLE_FILE_EDIT_BYTES}-byte whole-file editing limit`,
      );
      continue;
    }
    plannedTests.push({ ...test, file: path });
  }
  plan = { ...plan, changes: plannedChanges, testsToAdd: plannedTests };

  // The plan decides which toolchain actually has to run. Deriving this from
  // the candidate files only (rather than every file in the digest) keeps a
  // Go change in a polyglot monorepo from being tested with pnpm.
  const testEcosystem = ecosystemForInvestigation(
    [
      ...candidate.files,
      ...hypothesis.files,
      ...plan.changes.map((change) => change.file),
      ...plan.testsToAdd.map((test) => test.file),
    ],
    digest.repo.language,
    digest.tree.manifests,
  );
  const testProjectDirectory = manifestDirectoryFor(testEcosystem, digest.tree.manifests);
  const testWorkdir = resolveWorkingDirectory(testProjectDirectory);
  if (!testWorkdir.ok) {
    return block(`the test project directory derived from manifests is unsafe: ${testWorkdir.reason}`);
  }

  await db.contribution.update({ where: { id: contributionId }, data: { planJson: plan as unknown as Prisma.InputJsonValue } });
  await recordEvent(db, {
    eventType: 'solution_planned',
    reason: `${plan.changes.length} file(s), ${plan.testsToAdd.length} test(s): ${plan.approach.slice(0, 300)}`,
    projectId: project.id,
    candidateId: candidate.id,
    contributionId,
    actorKind: 'AGENT',
    actor: 'solution-planner',
    evidence: {
      files: plan.changes.map((change) => change.file),
      tests: plan.testsToAdd.map((test) => test.file),
      droppedByPolicy: planProblems,
      uncertainties: plan.uncertainties,
      testEcosystem,
    },
  });

  if (plan.changes.length === 0) {
    return block(
      `the planner produced no applicable changes${planProblems.length > 0 ? `: ${planProblems.join('; ')}` : ''}`,
    );
  }

  // -----------------------------------------------------------------------
  // Edit
  // -----------------------------------------------------------------------
  const contextPaths = [
    ...new Set([
      ...plan.changes.map((change) => change.file),
      ...plan.testsToAdd.map((test) => test.file),
      ...plan.needsMoreContext,
      ...relatedTestFiles(digest, plan.changes.map((change) => change.file)),
      ...candidate.files,
      ...hypothesis.files,
    ]),
  ];
  const editContext = await readWorkspaceFiles(workspace, contextPaths, {
    maxFiles: env.MAX_FILES_PER_CHANGE + 8,
    maxTotalBytes: 180_000,
    maxFileBytes: 90_000,
  });
  const editOutcome = await writeSolution(ctx, {
    evidence,
    candidateId,
    contributionId,
    plan,
    files: editContext.files,
    ...(options.revisionContext ? { revisionContext: options.revisionContext } : {}),
  });
  costUsd += editOutcome.costUsd;

  const edits: Array<{ path: string; content: string; intent: string; isTest: boolean }> = [];
  const refused: Array<{ path: string; reason: string }> = [];
  let totalBytes = 0;
  for (const edit of editOutcome.output.edits) {
    const path = cleanRelativePath(edit.path);
    if (!path) {
      refused.push({ path: edit.path, reason: 'unsafe path' });
      continue;
    }
    const forbidden = forbiddenPathReason(path);
    if (forbidden) {
      refused.push({ path, reason: forbidden });
      continue;
    }
    if (edit.content.includes('\0')) {
      refused.push({ path, reason: 'binary content' });
      continue;
    }
    const bytes = Buffer.byteLength(edit.content, 'utf8');
    if (bytes > env.MAX_EDIT_BYTES_PER_FILE) {
      refused.push({ path, reason: `file is ${bytes} bytes, over the ${env.MAX_EDIT_BYTES_PER_FILE} byte limit` });
      continue;
    }
    totalBytes += bytes;
    if (totalBytes > env.MAX_EDIT_BYTES_TOTAL) {
      refused.push({ path, reason: `change set exceeds ${env.MAX_EDIT_BYTES_TOTAL} bytes` });
      break;
    }
    edits.push({ ...edit, path, isTest: edit.isTest || isTestPath(path, digest) });
  }

  if (refused.length > 0) {
    await recordSecurityEvent(db, {
      reason: 'solution output refused by scope policy',
      detail: refused.map((item) => `${item.path}: ${item.reason}`).join('; ').slice(0, 1000),
      projectId: project.id,
      contributionId,
      evidence: { refused, editCount: editOutcome.output.edits.length },
    });
    return block(`solution output was refused by policy: ${refused.map((item) => `${item.path} (${item.reason})`).join('; ')}`);
  }

  if (edits.length === 0) {
    return block('the editor produced no usable edits');
  }
  if (edits.length > env.MAX_FILES_PER_CHANGE) {
    return block(`the editor proposed ${edits.length} files, over the limit of ${env.MAX_FILES_PER_CHANGE}`);
  }
  if (!edits.some((edit) => !edit.isTest)) {
    return block('the editor only changed test files; a contribution needs a production change');
  }

  const unplanned = edits
    .map((edit) => edit.path)
    .filter((path) => !plan.changes.some((change) => change.file === path) && !plan.testsToAdd.some((test) => test.file === path));
  if (unplanned.length > 0) {
    await recordEvent(db, {
      eventType: 'solution_unplanned_files',
      reason: `the editor changed files outside the approved plan: ${unplanned.join(', ')}`,
      projectId: project.id,
      candidateId: candidate.id,
      contributionId,
      actorKind: 'AGENT',
      actor: 'solution-editor',
      evidence: { unplanned },
    });
  }

  await workspace.writeFiles(edits.map((edit) => ({ path: edit.path, content: edit.content, isTest: edit.isTest })));
  const diff = await workspace.diff();
  if (diff.files.length === 0) {
    return block('the applied edits produced an empty diff');
  }
  await recordEvent(db, {
    eventType: 'solution_applied',
    reason: `${editOutcome.output.summary.slice(0, 300)} (${diff.files.length} file(s), ${Buffer.byteLength(diff.diff)} bytes)`,
    projectId: project.id,
    candidateId: candidate.id,
    contributionId,
    actorKind: 'AGENT',
    actor: 'solution-editor',
    evidence: {
      files: diff.files,
      diffHash: diff.hash,
      unplanned,
      uncertainty: editOutcome.output.uncertainty,
      notesForReviewers: editOutcome.output.notesForReviewers.slice(0, 1000),
    },
  });

  const revisionIndex = (await db.contribution.findUniqueOrThrow({ where: { id: contributionId } })).revisionCount + 1;
  await db.revision.create({
    data: {
      contributionId,
      index: revisionIndex,
      summary: editOutcome.output.summary.slice(0, 2000),
      rootCause: editOutcome.output.rootCause.slice(0, 2000),
      filesChanged: diff.files,
      testsAdded: edits.filter((edit) => edit.isTest).map((edit) => edit.path),
      diffHash: diff.hash,
      diff: diff.diff.slice(0, 500_000),
      uncertainty: editOutcome.output.uncertainty as Prisma.InputJsonValue,
      addresses: (options.revisionContext ? [{ reviewContext: options.revisionContext.slice(0, 4000) }] : []) as Prisma.InputJsonValue,
      costUsd,
    },
  });
  await db.contribution.update({
    where: { id: contributionId },
    data: {
      revisionCount: revisionIndex,
      diffHash: diff.hash,
      diffStat: diff.stat.slice(0, 4000),
      filesChanged: diff.files,
      costUsd: { increment: costUsd },
      llmTokens: { increment: llmTokens + editOutcome.promptTokens + editOutcome.completionTokens },
    },
  });
  await transition('TESTING', `revision ${revisionIndex} applied: ${diff.files.join(', ')}`);

  // -----------------------------------------------------------------------
  // Tests
  // -----------------------------------------------------------------------
  const docsOnly = diff.files.every((file) => /\.(md|mdx|rst|txt)$/i.test(file));
  const commands: string[] = [];
  const requested = editOutcome.output.verificationCommands
    .map((command) => command.trim())
    .filter((command) => command.length > 0 && command.length <= 300);
  for (const raw of [...requested.slice(0, 6), ...digest.derivedTestCommands.slice(0, 3)]) {
    if (commands.length >= 3) break;
    const command = stripRedundantCd(raw, testWorkdir.relative);
    if (commands.includes(command)) continue;
    const verdict = validateCommand(command, { allowNetwork: false });
    if (!verdict.allowed) {
      await recordEvent(db, {
        eventType: 'test_command_refused',
        reason: `verification command refused by sandbox policy: ${verdict.reason}`,
        projectId: project.id,
        candidateId: candidate.id,
        contributionId,
        actorKind: 'SYSTEM',
        actor: 'sandbox',
        evidence: { command: command.slice(0, 300) },
      });
      continue;
    }
    commands.push(command);
  }

  const sandbox = DockerSandbox.fromEnv(db, env);
  const testRuns: Array<{ command: string; status: string }> = [];

  const recordRun = async (
    result: Awaited<ReturnType<DockerSandbox['run']>>,
    kind: string,
  ): Promise<string> => {
    const status =
      result.refusedReason !== undefined
        ? 'SKIPPED'
        : result.timedOut
          ? 'TIMEOUT'
          : result.exitCode === 0
            ? 'PASSED'
            : 'FAILED';
    await db.testRun.create({
      data: {
        contributionId,
        revisionIndex,
        command: result.command.slice(0, 1000),
        status,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        sandboxKind: result.sandboxKind,
        outputTail: result.output.slice(-20_000),
        outputBytes: Buffer.byteLength(result.output, 'utf8'),
        truncated: result.truncated,
        kind,
      },
    });
    await recordEvent(db, {
      eventType: 'test_run',
      reason: summarizeSandboxResult(result),
      projectId: project.id,
      candidateId: candidate.id,
      contributionId,
      actorKind: 'SYSTEM',
      actor: 'sandbox',
      evidence: {
        kind,
        command: result.command,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        refusedReason: result.refusedReason ?? null,
        network: result.network,
        outputTail: result.output.slice(-4000),
      },
    });
    testRuns.push({ command: result.command, status });
    return status;
  };

  if (commands.length === 0 && !docsOnly) {
    return block(
      'no verification command could be derived for a code change; refusing to advance a contribution that was never tested',
    );
  }

  if (env.SANDBOX_MODE === 'none' && !docsOnly) {
    return block('SANDBOX_MODE=none: refusing to advance an untested code change');
  }

  let testsPassed = true;
  let environmentFailure: string | null = null;

  if (commands.length > 0) {
    const installs = installCommandsFor(testEcosystem, digest.tree.manifests);
    try {
      const prepared = await sandbox.prepare({
        workspacePath: workspace.path,
        commands: installs.slice(0, 2),
        ecosystem: testEcosystem,
        ...(testWorkdir.relative ? { workingDirectory: testWorkdir.relative } : {}),
        projectId: project.id,
        contributionId,
      });
      for (const result of prepared) {
        const status = await recordRun(result, 'dependency_prepare');
        if (status !== 'PASSED') {
          environmentFailure = `dependency preparation failed: ${result.command}`;
          break;
        }
      }
    } catch (error) {
      environmentFailure = `dependency preparation could not run: ${error instanceof Error ? error.message : String(error)}`;
    }

    if (!environmentFailure) {
      for (const command of commands) {
        const result = await sandbox.run({
          workspacePath: workspace.path,
          command,
          ecosystem: testEcosystem,
          ...(testWorkdir.relative ? { workingDirectory: testWorkdir.relative } : {}),
          allowNetwork: false,
          timeoutMs: Math.min(env.SANDBOX_TIMEOUT_MS, 15 * 60_000),
          projectId: project.id,
          contributionId,
          label: `test: ${command}`,
        });
        const status = await recordRun(result, 'verification');
        if (status !== 'PASSED') {
          testsPassed = false;
          break;
        }
      }
    } else {
      testsPassed = false;
    }
  } else {
    await db.testRun.create({
      data: {
        contributionId,
        revisionIndex,
        command: '(none: documentation-only change)',
        status: 'SKIPPED',
        exitCode: null,
        durationMs: 0,
        sandboxKind: 'none',
        outputTail: 'No executable verification applies to a documentation-only change.',
        outputBytes: 0,
        truncated: false,
        kind: 'none',
      },
    });
    await recordEvent(db, {
      eventType: 'test_run_skipped',
      reason: 'documentation-only change; no executable verification applies',
      projectId: project.id,
      candidateId: candidate.id,
      contributionId,
      actorKind: 'SYSTEM',
      actor: 'sandbox',
    });
  }

  if (environmentFailure) {
    const reason = `${environmentFailure}; the change stays in the workspace and is not submitted`;
    await transition('RETRYABLE_ERROR', reason);
    await db.contribution.update({ where: { id: contributionId }, data: { blockedReason: reason.slice(0, 2000) } });
    return { contributionId, status: 'tests-failed', revisionIndex, note: reason, costUsd };
  }

  if (!testsPassed) {
    const failed = testRuns.filter((run) => run.status !== 'PASSED');
    const reason = `tests did not pass: ${failed.map((run) => `${run.command} (${run.status})`).join('; ').slice(0, 800)}`;
    await transition('REVISION_REQUIRED', reason);
    await db.contribution.update({ where: { id: contributionId }, data: { blockedReason: reason.slice(0, 2000) } });
    return { contributionId, status: 'tests-failed', revisionIndex, note: reason, costUsd };
  }

  // -----------------------------------------------------------------------
  // Commit and queue review
  // -----------------------------------------------------------------------
  const prefix = candidate.origin === 'DOC_INCONSISTENCY' ? 'docs' : 'fix';
  const firstLine = editOutcome.output.summary.split('\n')[0]!.replace(/^\w+:\s*/, '').replace(/\.$/, '').trim();
  const subject = `${prefix}: ${firstLine}`.slice(0, 72);
  const bodyParts = [
    editOutcome.output.summary,
    editOutcome.output.rootCause ? `Root cause: ${editOutcome.output.rootCause}` : '',
    editOutcome.output.notesForReviewers ? `Notes for reviewers: ${editOutcome.output.notesForReviewers}` : '',
    unplanned.length > 0 ? `Files outside the plan: ${unplanned.join(', ')}` : '',
  ].filter((part) => part.length > 0);
  const commitSha = await workspace.commit(`${subject}\n\n${bodyParts.join('\n\n')}`.slice(0, 20_000));

  await db.contribution.update({
    where: { id: contributionId },
    data: { headSha: commitSha },
  });
  const reviewRound = contribution.reviewRound;
  await transition('INDEPENDENT_REVIEW', `tests passed (${testRuns.map((run) => run.status).join(', ') || 'documentation-only'}); independent review pending`);
  await enqueue(db, {
    kind: 'REVIEW_CONTRIBUTION',
    dedupeKey: `review:${contributionId}:${revisionIndex}:${reviewRound}`,
    payload: { contributionId, revisionIndex },
    priority: 50,
    projectId: project.id,
    contributionId,
  });

  log.info('implementation ready for review', { contributionId, revisionIndex, costUsd: Number(costUsd.toFixed(4)) });
  return {
    contributionId,
    status: 'ready-for-review',
    revisionIndex,
    note: `revision ${revisionIndex} committed as ${commitSha.slice(0, 12)}; tests: ${testRuns.map((run) => run.status).join(', ') || 'skipped (docs only)'}`,
    costUsd,
  };
}

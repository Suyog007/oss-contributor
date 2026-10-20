import type { DecisionOutcome } from '@/generated/prisma/enums';
import type { Prisma } from '@/generated/prisma/client';
import type { Db } from '@/db/client';
import { policySnapshot } from '@/config/policy';
import { recordEvent } from '@/workflow/events';
import {
  adjudicationSchema,
  type Adjudication,
  type DuplicateCheck,
  type Hypothesis,
  type MaintainerContext,
  type Reproduction,
  type Validation,
} from '@/domain/schemas';
import { buildSystemPrompt, wrapUntrusted } from '@/llm/context';
import type { AgentContext, AgentOutcome } from './runner';

export const ADJUDICATION_PROMPT_VERSION = 1;
/** Bump when the rules below change meaning. Stored on every Decision row. */
export const INVESTIGATION_POLICY_VERSION = 'investigation/1';

/**
 * Aggregated evidence for one candidate. All fields are optional because an
 * agent can fail or be skipped; a missing input is itself information and is
 * never treated as agreement.
 */
export interface DecisionInputs {
  hypothesis: Hypothesis;
  validation: Validation | null;
  reproduction: Reproduction | null;
  duplicate: DuplicateCheck | null;
  maintainer: MaintainerContext | null;
  minConfidence: number;
}

export interface DecisionResult {
  outcome: DecisionOutcome;
  rationale: string;
  evidenceJson: Prisma.InputJsonValue;
  /** True when a human must decide because agents did not agree. */
  escalated: boolean;
  /** Set when the rules could not decide between two evidenced readings. */
  adjudication: {
    question: string;
    conflict: string;
  } | null;
}

function evidenceSummary(inputs: DecisionInputs): Prisma.InputJsonValue {
  const validation = inputs.validation;
  return {
    hypothesis: {
      title: inputs.hypothesis.title,
      origin: inputs.hypothesis.origin,
      severity: inputs.hypothesis.severity,
      claimedBehavior: inputs.hypothesis.claimedBehavior,
    },
    validation: validation
      ? {
          verdict: validation.verdict,
          behaviorIsIncorrect: validation.behaviorIsIncorrect,
          intentional: validation.intentional,
          scopeFit: validation.scopeFit,
          compatibilityRisk: validation.compatibilityRisk,
          confidence: validation.confidence,
          recommendedNextAction: validation.recommendedNextAction,
          existingTestsCovering: validation.existingTestsCovering,
          contradictions: validation.contradictions as unknown as Prisma.InputJsonValue,
          residualUncertainty: validation.residualUncertainty,
        }
      : null,
    reproduction: inputs.reproduction
      ? {
          status: inputs.reproduction.status,
          observedInSandbox: inputs.reproduction.observedInSandbox,
          confidence: inputs.reproduction.confidence,
          blockers: inputs.reproduction.blockers,
          observedBehavior: inputs.reproduction.observedBehavior,
        }
      : null,
    duplicate: inputs.duplicate
      ? {
          verdict: inputs.duplicate.verdict,
          recommendation: inputs.duplicate.recommendation,
          confidence: inputs.duplicate.confidence,
          matches: inputs.duplicate.matches as unknown as Prisma.InputJsonValue,
          previouslyRejectedApproaches: inputs.duplicate
            .previouslyRejectedApproaches as unknown as Prisma.InputJsonValue,
        }
      : null,
    maintainer: inputs.maintainer
      ? {
          recommendation: inputs.maintainer.recommendation,
          inScope: inputs.maintainer.inScope,
          needsMaintainerSignoff: inputs.maintainer.needsMaintainerSignoff,
          signoffReason: inputs.maintainer.signoffReason,
          conflicts: inputs.maintainer.conflicts as unknown as Prisma.InputJsonValue,
        }
      : null,
    minConfidence: inputs.minConfidence,
  };
}

/**
 * Deterministic aggregation. No majority vote, no averaging of opinions.
 *
 * The rules encode a single question each — is it already done, is it a real
 * defect, is it wanted here, is it safe to attempt — and the most decisive
 * answer wins. When two evidenced readings genuinely conflict, this function
 * refuses to pick one and asks for exactly one adjudication call instead.
 */
export function decide(inputs: DecisionInputs): DecisionResult {
  const { validation, reproduction, duplicate, maintainer } = inputs;
  const base = { evidenceJson: evidenceSummary(inputs) };

  // 1. Existing work wins over everything: implementing a duplicate is waste.
  if (
    duplicate?.verdict === 'DUPLICATE' &&
    duplicate.confidence >= 0.6 &&
    duplicate.recommendation === 'STOP_DUPLICATE'
  ) {
    return {
      ...base,
      outcome: 'DUPLICATE',
      escalated: false,
      adjudication: null,
      rationale: `duplicate found: ${
        duplicate.matches
          .map((match) => match.reference)
          .slice(0, 4)
          .join(', ') || 'matching work exists'
      }`,
    };
  }

  // 2. Validation is the backbone of the decision. Without it, nothing is known.
  if (!validation) {
    return {
      ...base,
      outcome: 'NEEDS_INVESTIGATION',
      escalated: false,
      adjudication: null,
      rationale: 'validation did not produce a verdict; the candidate is unproven',
    };
  }

  const reproductionReproduced = reproduction?.status === 'REPRODUCED';
  const reproductionContradicted =
    reproduction?.status === 'NOT_REPRODUCED' && reproduction.observedInSandbox === true;

  // 3. Refuted: not a defect, or a deliberate behavior. Reproducing the behavior
  //    does not make it a defect; it only confirms the behavior exists.
  if (
    validation.verdict === 'CONTRADICTS' &&
    (validation.behaviorIsIncorrect === 'no' || validation.intentional === 'yes')
  ) {
    const why =
      validation.intentional === 'yes'
        ? `behavior is intentional: ${validation.documentedExpectation.slice(0, 220)}`
        : `behavior is as documented: ${validation.documentedExpectation.slice(0, 220)}`;
    return {
      ...base,
      outcome: 'NOT_A_PROBLEM',
      escalated: false,
      adjudication: null,
      rationale: reproductionReproduced
        ? `${why}; the behavior itself was observed in the sandbox, but observing it is not evidence that it is a defect`
        : why,
    };
  }

  // 3b. The behavior is real (execution showed it) but nobody can say whether it
  //     is intended. Only a maintainer can answer a question about intent.
  if (reproductionReproduced && validation.intentional === 'unclear' && validation.behaviorIsIncorrect !== 'yes') {
    return {
      ...base,
      outcome: 'NEEDS_MAINTAINER_INPUT',
      escalated: false,
      adjudication: null,
      rationale: `the behavior was observed in the sandbox, but whether it is intended is unclear: ${validation.documentedExpectation.slice(0, 220)}`,
    };
  }

  // 4. Scope: the project does not want this class of change here.
  if (
    validation.scopeFit === 'out_of_scope' ||
    maintainer?.inScope === 'no' ||
    maintainer?.recommendation === 'DO_NOT_PROCEED'
  ) {
    return {
      ...base,
      outcome: 'OUT_OF_SCOPE',
      escalated: false,
      adjudication: null,
      rationale:
        maintainer?.inScope === 'no' || maintainer?.recommendation === 'DO_NOT_PROCEED'
          ? `maintainer guidelines exclude this change: ${maintainer.scopeNotes.slice(0, 220)}`
          : 'validation judged the change out of scope for the project',
    };
  }

  // 5. A maintainer decision is required before code, whatever the evidence.
  if (maintainer?.needsMaintainerSignoff || maintainer?.recommendation === 'ASK_MAINTAINER_FIRST') {
    return {
      ...base,
      outcome: 'NEEDS_MAINTAINER_INPUT',
      escalated: false,
      adjudication: null,
      rationale: `maintainer sign-off required: ${maintainer.signoffReason.slice(0, 220)}`,
    };
  }

  // 6. High compatibility risk is a design question, not a bug-fix decision.
  if (validation.compatibilityRisk === 'high' && validation.behaviorIsIncorrect !== 'no') {
    return {
      ...base,
      outcome: 'NEEDS_MAINTAINER_INPUT',
      escalated: false,
      adjudication: null,
      rationale: `high compatibility risk: ${validation.compatibilityNotes.slice(0, 220)}`,
    };
  }

  const problemEstablished =
    validation.verdict === 'SUPPORTS' &&
    validation.behaviorIsIncorrect === 'yes' &&
    validation.intentional !== 'yes';

  if (problemEstablished) {
    // 7. The one genuine conflict worth a bounded adjudication: the code reading
    //    says the defect is real, but running it did not show the behavior.
    if (reproductionContradicted) {
      return {
        ...base,
        outcome: 'NEEDS_INVESTIGATION',
        escalated: true,
        adjudication: {
          question:
            'Validation concluded the behavior is an incorrect defect from reading the code, while the sandbox experiment did not reproduce it. Decide which reading the evidence supports, or whether more investigation is needed.',
          conflict: `validation: SUPPORTS (confidence ${validation.confidence}) | reproduction: NOT_REPRODUCED (confidence ${reproduction?.confidence})`,
        },
        rationale: 'validation and reproduction disagree; adjudication required',
      };
    }

    // 8. Confidence gate. A weak positive is not a reason to write code.
    if (validation.confidence < inputs.minConfidence) {
      return {
        ...base,
        outcome: 'NEEDS_INVESTIGATION',
        escalated: false,
        adjudication: null,
        rationale: `validation confidence ${validation.confidence.toFixed(2)} is below the ${inputs.minConfidence} threshold`,
      };
    }

    if (reproduction && reproduction.observedInSandbox && reproduction.confidence < 0.4) {
      return {
        ...base,
        outcome: 'NEEDS_INVESTIGATION',
        escalated: false,
        adjudication: null,
        rationale: `observed reproduction is not conclusive (confidence ${reproduction.confidence.toFixed(2)})`,
      };
    }

    const reproductionNote = reproductionReproduced
      ? `; reproduced in the sandbox (${reproduction?.observedBehavior.slice(0, 160) ?? ''})`
      : reproduction?.status === 'BLOCKED_ENVIRONMENT'
        ? '; the sandbox could not run the reproduction, so the verdict rests on the code evidence'
        : '';

    return {
      ...base,
      outcome: 'IMPLEMENT',
      escalated: false,
      adjudication: null,
      rationale: `problem confirmed: ${validation.documentedExpectation.slice(0, 200)}${reproductionNote}`,
    };
  }

  // 9. Everything else is insufficient evidence, described as such.
  if (validation.recommendedNextAction === 'REJECT') {
    return {
      ...base,
      outcome: 'NOT_A_PROBLEM',
      escalated: false,
      adjudication: null,
      rationale: `validation recommended rejection: ${validation.residualUncertainty.join(' | ').slice(0, 220) || validation.documentedExpectation.slice(0, 220)}`,
    };
  }

  const reason =
    validation.verdict === 'INCONCLUSIVE'
      ? `inconclusive: ${validation.residualUncertainty.slice(0, 3).join(' | ') || 'the material did not settle the question'}`
      : `validation returned ${validation.verdict} with incorrect=${validation.behaviorIsIncorrect}`;
  return {
    ...base,
    outcome: 'NEEDS_INVESTIGATION',
    escalated: false,
    adjudication: null,
    rationale: reason,
  };
}

const ADJUDICATION_SYSTEM = buildSystemPrompt({
  role: 'a senior engineer resolving one specific disagreement between two evidence-based reports',
  objective:
    'Choose the reading the evidence supports, or state explicitly that the evidence cannot settle it. You are not deciding what to build; you are deciding what is true.',
  rules: [
    'Weigh the concrete evidence in both reports (cited files, test results, output). Ignore confidence numbers; they are opinions about opinions.',
    'A reproduction that failed because the environment was missing tooling is not evidence against the defect. Only an experiment that actually exercised the behavior counts.',
    'If the deciding evidence is not in the reports, resolution is NEEDS_INVESTIGATION with the missing evidence named.',
    'IMPLEMENT means: the evidence establishes a real, incorrect behavior that is worth fixing.',
    'decisiveEvidence must quote the inputs; never invent test results or file contents.',
  ],
});

export function buildAdjudicationPrompt(input: {
  hypothesis: Hypothesis;
  validation: Validation;
  reproduction: Reproduction;
  question: string;
  conflict: string;
}): { system: string; user: string } {
  const user = [
    '## The disagreement',
    input.question,
    `stated as: ${input.conflict}`,
    '',
    '## The claim',
    wrapUntrusted(
      'hypothesis',
      [
        `title: ${input.hypothesis.title}`,
        `claimed behavior: ${input.hypothesis.claimedBehavior}`,
        `expected behavior: ${input.hypothesis.expectedBehavior}`,
      ].join('\n'),
    ),
    '',
    '## Report 1: validation (code reading)',
    wrapUntrusted(
      'validation-report',
      [
        `verdict: ${input.validation.verdict} | behaviorIsIncorrect: ${input.validation.behaviorIsIncorrect} | intentional: ${input.validation.intentional} | confidence: ${input.validation.confidence}`,
        `documented expectation: ${input.validation.documentedExpectation}`,
        `supporting evidence: ${input.validation.supporting.map((item) => `[${item.kind}] ${item.ref}: ${item.detail}`).join(' || ') || 'none'}`,
        `contradictions: ${input.validation.contradictions.map((item) => `[${item.kind}] ${item.ref}: ${item.detail}`).join(' || ') || 'none'}`,
        `existing tests covering: ${input.validation.existingTestsCovering.join(' | ') || 'none'}`,
        `residual uncertainty: ${input.validation.residualUncertainty.join(' | ') || 'none'}`,
      ].join('\n'),
    ),
    '',
    '## Report 2: reproduction (execution)',
    wrapUntrusted(
      'reproduction-report',
      [
        `status: ${input.reproduction.status} | observedInSandbox: ${input.reproduction.observedInSandbox} | confidence: ${input.reproduction.confidence}`,
        `method: ${input.reproduction.method}`,
        `commands: ${input.reproduction.commands.map((command) => `${command.command} (exit ${command.exitCode ?? 'n/a'}): ${command.observation}`).join(' || ') || 'none'}`,
        `observed behavior: ${input.reproduction.observedBehavior}`,
        `blockers: ${input.reproduction.blockers.join(' | ') || 'none'}`,
        `evidence: ${input.reproduction.evidence.map((item) => `[${item.kind}] ${item.ref}: ${item.detail}`).join(' || ') || 'none'}`,
      ].join('\n'),
    ),
    '',
    'Resolve the disagreement as JSON.',
  ].join('\n');
  return { system: ADJUDICATION_SYSTEM, user };
}

export async function adjudicate(
  ctx: AgentContext,
  args: {
    candidateId: string;
    hypothesis: Hypothesis;
    validation: Validation;
    reproduction: Reproduction;
    question: string;
    conflict: string;
    taskRef?: string;
  },
): Promise<AgentOutcome<Adjudication>> {
  const prompt = buildAdjudicationPrompt(args);
  return ctx.runtime.run({
    agent: 'decision-adjudicator',
    kind: 'DECISION_ADJUDICATION',
    tier: 'deep',
    system: prompt.system,
    user: prompt.user,
    schema: adjudicationSchema,
    schemaName: 'adjudication',
    promptVersion: ADJUDICATION_PROMPT_VERSION,
    candidateId: args.candidateId,
    subject: { candidateId: args.candidateId },
    maxOutputTokens: 5000,
    ...(args.taskRef ? { taskRef: args.taskRef } : {}),
    interpret: (output) => ({
      verdict:
        output.resolution === 'IMPLEMENT'
          ? 'SUPPORTS'
          : output.resolution === 'NOT_A_PROBLEM'
            ? 'CONTRADICTS'
            : 'INCONCLUSIVE',
      confidence: 0.5,
      rationale: `adjudication ${output.resolution}: ${output.rationale.slice(0, 180)}`,
    }),
  });
}

const CANDIDATE_STATUS_FOR_OUTCOME = {
  IMPLEMENT: 'VALIDATED',
  NEEDS_INVESTIGATION: 'NEEDS_INVESTIGATION',
  NEEDS_MAINTAINER_INPUT: 'NEEDS_MAINTAINER_INPUT',
  DUPLICATE: 'DUPLICATE',
  NOT_A_PROBLEM: 'REJECTED',
  TOO_RISKY: 'OUT_OF_SCOPE',
  OUT_OF_SCOPE: 'OUT_OF_SCOPE',
} as const;

/**
 * Persist the decision and move the candidate to the matching status.
 *
 * One `Decision` row per candidate: re-investigation updates the row with the
 * new policy version instead of accumulating contradictory decisions, and the
 * change is recorded as an event.
 */
export async function persistDecision(
  db: Db,
  args: {
    candidateId: string;
    result: DecisionResult;
    /** Set when an adjudication call contributed to the outcome. */
    adjudication?: {
      resolution: Adjudication['resolution'];
      rationale: string;
      investigationId: string;
    } | null;
    decidedBy?: string;
  },
): Promise<void> {
  const candidate = await db.candidate.findUniqueOrThrow({
    where: { id: args.candidateId },
    select: { id: true, projectId: true, status: true },
  });
  const previous = await db.decision.findUnique({ where: { candidateId: args.candidateId } });

  const evidenceJson = {
    ...(args.result.evidenceJson as Record<string, unknown>),
    policy: policySnapshot().version,
    adjudication: args.adjudication ?? null,
  } as Prisma.InputJsonValue;

  await db.decision.upsert({
    where: { candidateId: args.candidateId },
    create: {
      candidateId: args.candidateId,
      outcome: args.result.outcome,
      rationale: args.result.rationale.slice(0, 2000),
      evidenceJson,
      escalated: args.result.escalated,
      policyVersion: INVESTIGATION_POLICY_VERSION,
      decidedBy: args.decidedBy ?? 'orchestrator',
    },
    update: {
      outcome: args.result.outcome,
      rationale: args.result.rationale.slice(0, 2000),
      evidenceJson,
      escalated: args.result.escalated,
      policyVersion: INVESTIGATION_POLICY_VERSION,
      decidedBy: args.decidedBy ?? 'orchestrator',
    },
  });

  const status = CANDIDATE_STATUS_FOR_OUTCOME[args.result.outcome];
  await db.candidate.update({
    where: { id: args.candidateId },
    data: {
      status,
      statusReason: `${args.result.outcome}: ${args.result.rationale.slice(0, 400)}`,
    },
  });

  await recordEvent(db, {
    eventType: previous ? 'decision_updated' : 'decision_made',
    reason: `${args.result.outcome}: ${args.result.rationale.slice(0, 300)}`,
    projectId: candidate.projectId,
    candidateId: candidate.id,
    fromState: previous?.outcome ?? candidate.status,
    toState: args.result.outcome,
    actorKind: 'SYSTEM',
    actor: 'decision-aggregator',
    evidence: {
      policyVersion: INVESTIGATION_POLICY_VERSION,
      escalated: args.result.escalated,
      adjudicated: args.adjudication !== undefined && args.adjudication !== null,
    },
  });

  if (args.result.escalated) {
    await recordEvent(db, {
      eventType: 'decision_escalated',
      reason: `decision escalated for human review: ${args.result.adjudication?.question ?? args.result.rationale.slice(0, 200)}`,
      projectId: candidate.projectId,
      candidateId: candidate.id,
      actorKind: 'SYSTEM',
      actor: 'decision-aggregator',
      evidence: { question: args.result.adjudication?.question ?? null },
      securityRelevant: false,
    });
  }
}

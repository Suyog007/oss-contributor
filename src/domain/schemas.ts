import { z } from 'zod';

/**
 * Structured agent contracts.
 *
 * Every agent returns one of these shapes. The orchestrator persists the raw
 * JSON and drives decisions from it, so a schema change is a workflow change:
 * the schemas are versioned and the version is part of the investigation cache
 * key, which keeps cached outputs from a previous schema from being reused.
 */

export const CONTRACT_VERSION = 1;

const confidence = z.number().min(0).max(1);

export const evidenceSchema = z.object({
  kind: z.enum([
    'file',
    'line',
    'github_issue',
    'github_comment',
    'github_pr',
    'commit',
    'release',
    'doc',
    'test_result',
    'runtime_output',
    'discussion',
  ]),
  ref: z.string().min(1),
  detail: z.string().min(1),
  excerpt: z.string().optional(),
});
export type Evidence = z.infer<typeof evidenceSchema>;

// ---------------------------------------------------------------------------
// Discovery triage (only used when a batch is larger than the analysis budget)
// ---------------------------------------------------------------------------

export const projectTriageSchema = z.object({
  assessments: z.array(
    z.object({
      fullName: z.string(),
      contributionPotential: confidence,
      reasons: z.array(z.string()),
      suspiciousSignals: z.array(z.string()),
      suggestedFocus: z.string(),
    }),
  ),
});
export type ProjectTriage = z.infer<typeof projectTriageSchema>;

// ---------------------------------------------------------------------------
// Agent: project analysis
// ---------------------------------------------------------------------------

export const projectAnalysisSchema = z.object({
  purpose: z.string(),
  architecture: z.string(),
  components: z.array(z.object({ path: z.string(), role: z.string() })),
  stack: z.array(z.string()),
  testingStrategy: z.string(),
  testCommands: z.array(z.string()),
  conventions: z.object({
    commitStyle: z.string(),
    branchNaming: z.string().optional(),
    changelog: z.string().optional(),
    prTemplate: z.string().optional(),
    styleNotes: z.array(z.string()),
    requiresIssueLink: z.boolean().optional(),
    signOffRequired: z.boolean().optional(),
  }),
  activity: z.object({
    recentFocus: z.string(),
    cadence: z.string(),
    maintenanceHealth: z.enum(['active', 'steady', 'slow', 'stalled']),
  }),
  weaknesses: z.array(
    z.object({
      area: z.string(),
      observation: z.string(),
      evidence: z.array(evidenceSchema),
      confidence,
    }),
  ),
  contributionAreas: z.array(
    z.object({
      area: z.string(),
      why: z.string(),
      difficulty: z.enum(['small', 'medium', 'large']),
      evidence: z.array(evidenceSchema),
    }),
  ),
  runInstructions: z.string(),
  uncertainties: z.array(z.string()),
});
export type ProjectAnalysis = z.infer<typeof projectAnalysisSchema>;

// ---------------------------------------------------------------------------
// Agent A: hypothesis generation
// ---------------------------------------------------------------------------

/**
 * Investigation plan: which issues to look at and which files to read before
 * generating hypotheses. Splitting this from generation keeps the context
 * bounded: the planner sees paths and summaries, the generator sees contents.
 */
export const hypothesisPlanSchema = z.object({
  issueNumbers: z.array(z.number().int()).max(4),
  filesToInspect: z.array(z.string()).max(10),
  inspectionFocus: z.array(z.object({ area: z.string(), why: z.string() })).max(5),
  rationale: z.string(),
  consideredAndRejected: z.array(z.object({ idea: z.string(), why: z.string() })).max(6),
});
export type HypothesisPlan = z.infer<typeof hypothesisPlanSchema>;

export const hypothesisItemSchema = z.object({
  title: z.string().min(8),
  summary: z.string(),
  origin: z.enum(['EXISTING_ISSUE', 'CODE_INSPECTION', 'DOC_INCONSISTENCY', 'TEST_GAP']),
  originIssueNumber: z.number().int().positive().optional(),
  files: z.array(z.string()),
  claimedBehavior: z.string(),
  expectedBehavior: z.string(),
  evidence: z.array(evidenceSchema).min(1),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  verificationSteps: z.array(z.string()),
  verificationCommands: z.array(z.string()),
  proposedTest: z.string(),
  confidence,
  openQuestions: z.array(z.string()),
});
/** A single hypothesis. The unit every later agent reasons about. */
export type Hypothesis = z.infer<typeof hypothesisItemSchema>;

export const hypothesisSchema = z.object({
  hypotheses: z.array(hypothesisItemSchema),
  // Ideas the agent considered and dropped. Kept so weak candidates are visible.
  consideredAndRejected: z.array(z.object({ idea: z.string(), why: z.string() })),
});
export type Hypotheses = z.infer<typeof hypothesisSchema>;

// ---------------------------------------------------------------------------
// Agent B: validation
// ---------------------------------------------------------------------------

export const validationSchema = z.object({
  verdict: z.enum(['SUPPORTS', 'CONTRADICTS', 'INCONCLUSIVE']),
  behaviorIsIncorrect: z.enum(['yes', 'no', 'unclear']),
  intentional: z.enum(['yes', 'no', 'unclear']),
  documentedExpectation: z.string(),
  supporting: z.array(evidenceSchema),
  contradictions: z.array(evidenceSchema),
  existingTestsCovering: z.array(z.string()),
  compatibilityRisk: z.enum(['none', 'low', 'medium', 'high']),
  compatibilityNotes: z.string(),
  scopeFit: z.enum(['in_scope', 'out_of_scope', 'unclear']),
  confidence,
  recommendedNextAction: z.enum([
    'REPRODUCE',
    'IMPLEMENT',
    'ASK_MAINTAINER',
    'REJECT',
    'MORE_INVESTIGATION',
  ]),
  residualUncertainty: z.array(z.string()),
});
export type Validation = z.infer<typeof validationSchema>;

// ---------------------------------------------------------------------------
// Agent C: reproduction
//
// The plan is produced by the model; execution is performed by the sandbox
// runner; interpretation is a second, cheaper model call over real output.
// ---------------------------------------------------------------------------

export const reproductionPlanSchema = z.object({
  /** Commands to run inside the sandbox, in order. Empty when nothing is safe to run. */
  commands: z.array(z.string()),
  workingDirectory: z.string().optional(),
  /** Files the interpreter should be shown after execution. */
  filesToInspect: z.array(z.string()),
  expectedObservation: z.string(),
  fallbackIfBlocked: z.string(),
  rationale: z.string(),
});
export type ReproductionPlan = z.infer<typeof reproductionPlanSchema>;

export const reproductionSchema = z.object({
  status: z.enum(['REPRODUCED', 'NOT_REPRODUCED', 'BLOCKED_ENVIRONMENT', 'INCONCLUSIVE']),
  method: z.string(),
  commands: z.array(
    z.object({
      command: z.string(),
      exitCode: z.number().int().nullable(),
      observation: z.string(),
    }),
  ),
  observedBehavior: z.string(),
  expectedBehavior: z.string(),
  minimalReproduction: z.string(),
  evidence: z.array(evidenceSchema),
  confidence,
  blockers: z.array(z.string()),
  /** True only when the failure was observed in the sandbox, not inferred. */
  observedInSandbox: z.boolean(),
});
export type Reproduction = z.infer<typeof reproductionSchema>;

// ---------------------------------------------------------------------------
// Agent D: duplicate and history
// ---------------------------------------------------------------------------

export const duplicateSchema = z.object({
  verdict: z.enum(['DUPLICATE', 'RELATED', 'NEW']),
  matches: z.array(
    z.object({
      kind: z.enum(['issue', 'pull_request', 'commit', 'discussion']),
      reference: z.string(),
      url: z.string().optional(),
      title: z.string(),
      state: z.string(),
      relation: z.enum(['same_problem', 'same_fix', 'same_area', 'rejected_approach']),
      note: z.string(),
    }),
  ),
  maintainerInvolvement: z.array(z.object({ reference: z.string(), note: z.string() })),
  previouslyRejectedApproaches: z.array(
    z.object({ reference: z.string(), approach: z.string(), whyRejected: z.string() }),
  ),
  confidence,
  recommendation: z.enum(['PROCEED', 'PROCEED_WITH_REFERENCE', 'STOP_DUPLICATE', 'ASK_MAINTAINER']),
  notes: z.string(),
});
export type DuplicateCheck = z.infer<typeof duplicateSchema>;

// ---------------------------------------------------------------------------
// Agent E: maintainer context
// ---------------------------------------------------------------------------

export const maintainerContextSchema = z.object({
  guidelinesSummary: z.string(),
  inScope: z.enum(['yes', 'no', 'unclear']),
  scopeNotes: z.string(),
  requiredProcess: z.array(z.string()),
  breakingChangePolicy: z.string(),
  needsMaintainerSignoff: z.boolean(),
  signoffReason: z.string(),
  testRequirements: z.array(z.string()),
  documentationRequirements: z.array(z.string()),
  conflicts: z.array(z.object({ reference: z.string(), note: z.string() })),
  confidence,
  recommendation: z.enum(['PROCEED', 'ASK_MAINTAINER_FIRST', 'DO_NOT_PROCEED']),
});
export type MaintainerContext = z.infer<typeof maintainerContextSchema>;

// ---------------------------------------------------------------------------
// Orchestrator decision (deterministic aggregation; the model is used only to
// adjudicate a specific conflict when asked to)
// ---------------------------------------------------------------------------

export const adjudicationSchema = z.object({
  resolution: z.enum([
    'IMPLEMENT',
    'NEEDS_INVESTIGATION',
    'NEEDS_MAINTAINER_INPUT',
    'NOT_A_PROBLEM',
  ]),
  rationale: z.string(),
  /** Evidence that decided it, not opinions. */
  decisiveEvidence: z.array(evidenceSchema),
  remainingUncertainty: z.array(z.string()),
});
export type Adjudication = z.infer<typeof adjudicationSchema>;

// ---------------------------------------------------------------------------
// Solution agent
// ---------------------------------------------------------------------------

export const solutionPlanSchema = z.object({
  rootCause: z.string(),
  approach: z.string(),
  changes: z.array(
    z.object({
      file: z.string(),
      intent: z.string(),
      kind: z.enum(['modify', 'add', 'delete']),
    }),
  ),
  testsToAdd: z.array(z.object({ file: z.string(), intent: z.string() })),
  risks: z.array(z.string()),
  outOfScope: z.array(z.string()),
  verification: z.array(z.string()),
  uncertainties: z.array(z.string()),
  /** Additional files the agent needs before it can implement. */
  needsMoreContext: z.array(z.string()),
});
export type SolutionPlan = z.infer<typeof solutionPlanSchema>;

/**
 * The solution agent edits files by emitting whole-file content for the files
 * it touches. Whole-file edits are reviewable, hashable, and cannot half-apply
 * the way a patch can.
 */
export const solutionEditSchema = z.object({
  edits: z
    .array(
      z.object({
        path: z.string(),
        content: z.string(),
        intent: z.string(),
        isTest: z.boolean(),
      }),
    )
    .min(1),
  summary: z.string(),
  rootCause: z.string(),
  uncertainty: z.array(z.string()),
  /** Commands that verify the change, chosen from the project's own tooling. */
  verificationCommands: z.array(z.string()),
  notesForReviewers: z.string(),
});
export type SolutionEdit = z.infer<typeof solutionEditSchema>;

// ---------------------------------------------------------------------------
// Reviewers
// ---------------------------------------------------------------------------

export const findingSchema = z.object({
  kind: z.enum([
    'ACTUAL_DEFECT',
    'REGRESSION_RISK',
    'TEST_GAP',
    'SECURITY',
    'RELIABILITY',
    'CONVENTION',
    'SCOPE',
    'STYLE_PREFERENCE',
    'UNCERTAINTY',
  ]),
  severity: z.enum(['INFO', 'MINOR', 'MAJOR', 'CRITICAL']),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  explanation: z.string().min(10),
  evidence: z.array(evidenceSchema),
  suggestedCorrection: z.string().optional(),
  blocksSubmission: z.boolean(),
  confidence,
});
export type Finding = z.infer<typeof findingSchema>;

export const reviewSchema = z.object({
  verdict: z.enum(['APPROVE', 'APPROVE_WITH_NOTES', 'REQUEST_CHANGES', 'BLOCK']),
  summary: z.string(),
  findings: z.array(findingSchema),
  /** Claims the reviewer checked against the repository rather than trusting. */
  verifiedClaims: z.array(z.object({ claim: z.string(), verified: z.boolean(), how: z.string() })),
  questions: z.array(z.string()),
});
export type Review = z.infer<typeof reviewSchema>;

// ---------------------------------------------------------------------------
// PR narrative
// ---------------------------------------------------------------------------

export const prNarrativeSchema = z.object({
  commitSubject: z.string().min(8).max(120),
  commitBody: z.string(),
  prTitle: z.string().min(8).max(160),
  prBody: z.string(),
  /** Must be a subset of the commands the orchestrator actually ran. */
  testsPerformed: z.array(z.string()),
  issueReferences: z.array(z.string()),
  limitations: z.array(z.string()),
});
export type PrNarrative = z.infer<typeof prNarrativeSchema>;

// ---------------------------------------------------------------------------
// Maintainer feedback triage
// ---------------------------------------------------------------------------

export const feedbackTriageSchema = z.object({
  items: z.array(
    z.object({
      /** Our internal PrComment id, so the mapping back to GitHub is exact. */
      commentId: z.string(),
      classification: z.enum([
        'ACTIONABLE',
        'INFORMATIONAL',
        'ACKNOWLEDGED',
        'REPLY_ONLY',
        'ESCALATED',
        'NOT_APPLICABLE',
      ]),
      understood: z.string(),
      technicallyJustified: z.enum(['yes', 'no', 'unclear']),
      justification: z.string(),
      scopeImpact: z.enum(['none', 'small', 'large']),
      plan: z.string(),
      needsClarification: z.boolean(),
      escalationReason: z.string(),
    }),
  ),
  revisionSummary: z.string(),
  lessons: z.array(
    z.object({ kind: z.string(), text: z.string(), evidence: z.array(evidenceSchema) }),
  ),
});
export type FeedbackTriage = z.infer<typeof feedbackTriageSchema>;

// ---------------------------------------------------------------------------
// Prompt-injection screening
//
// Repository text is untrusted input. This classifier runs deterministically
// (no model) and only flags content for the security log and for prompt
// framing; it never changes what the agent is allowed to do.
// ---------------------------------------------------------------------------

export const injectionScreenSchema = z.object({
  suspicious: z.boolean(),
  patterns: z.array(z.object({ pattern: z.string(), location: z.string() })),
  /** Never obeyed, only recorded. */
  extractedInstructions: z.array(z.string()),
});
export type InjectionScreen = z.infer<typeof injectionScreenSchema>;

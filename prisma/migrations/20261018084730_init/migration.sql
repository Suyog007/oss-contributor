-- CreateEnum
CREATE TYPE "ProjectState" AS ENUM ('ACTIVE', 'COOLDOWN', 'IGNORED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "DiscoverySource" AS ENUM ('GITHUB_SEARCH', 'GITHUB_TRENDING', 'GITHUB_EVENT', 'MANUAL');

-- CreateEnum
CREATE TYPE "SignalKind" AS ENUM ('STAR_GROWTH_7D', 'STAR_GROWTH_30D', 'FORK_GROWTH_30D', 'ISSUE_ACTIVITY_30D', 'PR_ACTIVITY_30D', 'COMMIT_ACTIVITY_30D', 'CONTRIBUTOR_GROWTH_30D', 'RELEASE_RECENCY', 'RESPONSIVENESS', 'TEST_COVERAGE_SIGNAL', 'SUSPICIOUS_ACTIVITY', 'MAINTENANCE_GAP');

-- CreateEnum
CREATE TYPE "CandidateStatus" AS ENUM ('PROPOSED', 'INVESTIGATING', 'VALIDATED', 'NEEDS_INVESTIGATION', 'NEEDS_MAINTAINER_INPUT', 'DUPLICATE', 'REJECTED', 'OUT_OF_SCOPE', 'PROMOTED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "CandidateOrigin" AS ENUM ('EXISTING_ISSUE', 'CODE_INSPECTION', 'DOC_INCONSISTENCY', 'TEST_GAP');

-- CreateEnum
CREATE TYPE "InvestigationKind" AS ENUM ('PROJECT_ANALYSIS', 'HYPOTHESIS', 'VALIDATION', 'REPRODUCTION', 'DUPLICATE_SEARCH', 'MAINTAINER_CONTEXT', 'DECISION_ADJUDICATION', 'SOLUTION_PLAN', 'REVIEW_CORRECTNESS', 'REVIEW_SECURITY', 'REVIEW_MAINTAINABILITY', 'REVIEW_ADVERSARIAL', 'REVIEW_AGGREGATION', 'FEEDBACK_TRIAGE', 'PR_NARRATIVE');

-- CreateEnum
CREATE TYPE "InvestigationVerdict" AS ENUM ('SUPPORTS', 'CONTRADICTS', 'INCONCLUSIVE', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "DecisionOutcome" AS ENUM ('IMPLEMENT', 'NEEDS_INVESTIGATION', 'NEEDS_MAINTAINER_INPUT', 'DUPLICATE', 'NOT_A_PROBLEM', 'TOO_RISKY', 'OUT_OF_SCOPE');

-- CreateEnum
CREATE TYPE "ContributionState" AS ENUM ('APPROVED_FOR_IMPLEMENTATION', 'IMPLEMENTING', 'TESTING', 'INDEPENDENT_REVIEW', 'REVISION_REQUIRED', 'READY_FOR_SUBMISSION', 'HUMAN_APPROVAL', 'PR_SUBMITTED', 'AWAITING_REVIEW', 'FEEDBACK_RECEIVED', 'RESOLVED', 'REJECTED_CANDIDATE', 'DUPLICATE', 'NEEDS_MAINTAINER_INPUT', 'FAILED', 'RETRYABLE_ERROR', 'RATE_LIMITED', 'CANCELLED', 'ABANDONED', 'MERGE_CONFLICT', 'CLOSED_UNMERGED', 'MERGED');

-- CreateEnum
CREATE TYPE "Reviewer" AS ENUM ('CORRECTNESS', 'SECURITY', 'MAINTAINABILITY', 'ADVERSARIAL');

-- CreateEnum
CREATE TYPE "ReviewVerdict" AS ENUM ('APPROVE', 'APPROVE_WITH_NOTES', 'REQUEST_CHANGES', 'BLOCK');

-- CreateEnum
CREATE TYPE "FindingSeverity" AS ENUM ('INFO', 'MINOR', 'MAJOR', 'CRITICAL');

-- CreateEnum
CREATE TYPE "FindingKind" AS ENUM ('ACTUAL_DEFECT', 'REGRESSION_RISK', 'TEST_GAP', 'SECURITY', 'RELIABILITY', 'CONVENTION', 'SCOPE', 'STYLE_PREFERENCE', 'UNCERTAINTY');

-- CreateEnum
CREATE TYPE "TestStatus" AS ENUM ('PASSED', 'FAILED', 'ERROR', 'TIMEOUT', 'SKIPPED');

-- CreateEnum
CREATE TYPE "PrState" AS ENUM ('DRAFT', 'OPEN', 'MERGED', 'CLOSED');

-- CreateEnum
CREATE TYPE "CommentKind" AS ENUM ('ISSUE_COMMENT', 'REVIEW', 'REVIEW_COMMENT', 'MERGE_STATE');

-- CreateEnum
CREATE TYPE "CommentDisposition" AS ENUM ('PENDING', 'ACTIONABLE', 'INFORMATIONAL', 'ACKNOWLEDGED', 'REPLY_ONLY', 'ESCALATED', 'NOT_APPLICABLE', 'NO_ACTION');

-- CreateEnum
CREATE TYPE "ActorKind" AS ENUM ('SYSTEM', 'AGENT', 'HUMAN');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TaskKind" AS ENUM ('DISCOVER_PROJECTS', 'SYNC_PROJECT', 'ANALYZE_PROJECT', 'GENERATE_HYPOTHESES', 'INVESTIGATE_CANDIDATE', 'IMPLEMENT_CONTRIBUTION', 'RUN_TESTS', 'REVIEW_CONTRIBUTION', 'PREPARE_SUBMISSION', 'PUBLISH_CONTRIBUTION', 'SYNC_PULL_REQUEST', 'HANDLE_FEEDBACK', 'MAINTAIN_CONTRIBUTIONS', 'ROLLUP_METRICS');

-- CreateEnum
CREATE TYPE "BudgetScope" AS ENUM ('GLOBAL', 'PROJECT', 'CANDIDATE', 'CONTRIBUTION');

-- CreateEnum
CREATE TYPE "ApprovalAction" AS ENUM ('PUBLISH_BRANCH', 'OPEN_PULL_REQUEST', 'PUSH_REVISION', 'POST_COMMENT');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'GRANTED', 'DENIED', 'EXPIRED', 'CONSUMED', 'REVOKED');

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "githubId" BIGINT NOT NULL,
    "fullName" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL,
    "isFork" BOOLEAN NOT NULL DEFAULT false,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "license" TEXT,
    "language" TEXT,
    "topics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "description" TEXT,
    "sizeKb" INTEGER NOT NULL DEFAULT 0,
    "stars" INTEGER NOT NULL DEFAULT 0,
    "forks" INTEGER NOT NULL DEFAULT 0,
    "watchers" INTEGER NOT NULL DEFAULT 0,
    "openIssues" INTEGER NOT NULL DEFAULT 0,
    "repoCreatedAt" TIMESTAMP(3) NOT NULL,
    "repoPushedAt" TIMESTAMP(3) NOT NULL,
    "state" "ProjectState" NOT NULL DEFAULT 'ACTIVE',
    "stateReason" TEXT,
    "discoveredVia" "DiscoverySource" NOT NULL DEFAULT 'GITHUB_SEARCH',
    "discoveryQuery" TEXT,
    "discoveryScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "analysisJson" JSONB,
    "analysisHeadSha" TEXT,
    "analysisAt" TIMESTAMP(3),
    "analysisCostUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAnalyzedAt" TIMESTAMP(3),

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectSnapshot" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "stars" INTEGER NOT NULL,
    "forks" INTEGER NOT NULL,
    "watchers" INTEGER NOT NULL,
    "openIssues" INTEGER NOT NULL,
    "openPrs" INTEGER NOT NULL DEFAULT 0,
    "commitsLast30d" INTEGER NOT NULL DEFAULT 0,
    "releasesLast90d" INTEGER NOT NULL DEFAULT 0,
    "contributorsLast30d" INTEGER NOT NULL DEFAULT 0,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectSignal" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" "SignalKind" NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "detail" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepoDigest" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "json" JSONB NOT NULL,
    "bytes" INTEGER NOT NULL,
    "fileCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepoDigest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Candidate" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "origin" "CandidateOrigin" NOT NULL,
    "originIssueNumber" INTEGER,
    "originIssueUrl" TEXT,
    "files" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "fingerprint" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'unknown',
    "status" "CandidateStatus" NOT NULL DEFAULT 'PROPOSED',
    "statusReason" TEXT,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "llmTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Candidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Investigation" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT,
    "contributionId" TEXT,
    "kind" "InvestigationKind" NOT NULL,
    "agent" TEXT NOT NULL,
    "model" TEXT,
    "inputHash" TEXT NOT NULL,
    "verdict" "InvestigationVerdict" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "outputJson" JSONB NOT NULL,
    "rationale" TEXT NOT NULL,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "cacheHit" BOOLEAN NOT NULL DEFAULT false,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Investigation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Decision" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "outcome" "DecisionOutcome" NOT NULL,
    "rationale" TEXT NOT NULL,
    "evidenceJson" JSONB NOT NULL,
    "escalated" BOOLEAN NOT NULL DEFAULT false,
    "policyVersion" TEXT NOT NULL,
    "decidedBy" TEXT NOT NULL DEFAULT 'orchestrator',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contribution" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "state" "ContributionState" NOT NULL DEFAULT 'APPROVED_FOR_IMPLEMENTATION',
    "stateReason" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "workspacePath" TEXT,
    "sandboxKind" TEXT NOT NULL DEFAULT 'none',
    "branchName" TEXT,
    "baseRef" TEXT,
    "baseSha" TEXT,
    "headSha" TEXT,
    "diffHash" TEXT,
    "diffStat" TEXT,
    "filesChanged" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "planJson" JSONB,
    "revisionCount" INTEGER NOT NULL DEFAULT 0,
    "reviewRound" INTEGER NOT NULL DEFAULT 0,
    "budgetUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "llmTokens" INTEGER NOT NULL DEFAULT 0,
    "blockedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Contribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Revision" (
    "id" TEXT NOT NULL,
    "contributionId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "rootCause" TEXT,
    "filesChanged" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "testsAdded" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "diffHash" TEXT NOT NULL,
    "diff" TEXT NOT NULL,
    "uncertainty" JSONB NOT NULL,
    "addresses" JSONB NOT NULL,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "contributionId" TEXT NOT NULL,
    "revisionIndex" INTEGER NOT NULL,
    "round" INTEGER NOT NULL,
    "reviewer" "Reviewer" NOT NULL,
    "verdict" "ReviewVerdict" NOT NULL,
    "findingsJson" JSONB NOT NULL,
    "blockingCount" INTEGER NOT NULL DEFAULT 0,
    "model" TEXT,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "inputHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestRun" (
    "id" TEXT NOT NULL,
    "contributionId" TEXT NOT NULL,
    "revisionIndex" INTEGER NOT NULL,
    "command" TEXT NOT NULL,
    "status" "TestStatus" NOT NULL,
    "exitCode" INTEGER,
    "durationMs" INTEGER NOT NULL,
    "sandboxKind" TEXT NOT NULL,
    "outputTail" TEXT NOT NULL,
    "outputBytes" INTEGER NOT NULL DEFAULT 0,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "kind" TEXT NOT NULL DEFAULT 'project_suite',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TestRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PullRequest" (
    "id" TEXT NOT NULL,
    "contributionId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "nodeId" TEXT,
    "repoFullName" TEXT NOT NULL,
    "headRef" TEXT NOT NULL,
    "headRepo" TEXT NOT NULL,
    "baseRef" TEXT NOT NULL,
    "state" "PrState" NOT NULL DEFAULT 'OPEN',
    "isDraft" BOOLEAN NOT NULL DEFAULT false,
    "headSha" TEXT NOT NULL,
    "mergeable" BOOLEAN,
    "mergeableState" TEXT,
    "reviewDecision" TEXT,
    "bodyHash" TEXT NOT NULL,
    "titleUsed" TEXT NOT NULL,
    "commitMessageUsed" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "mergedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedDiffHash" TEXT,

    CONSTRAINT "PullRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrComment" (
    "id" TEXT NOT NULL,
    "prId" TEXT NOT NULL,
    "githubId" BIGINT NOT NULL,
    "kind" "CommentKind" NOT NULL,
    "author" TEXT NOT NULL,
    "authorAssociation" TEXT,
    "body" TEXT NOT NULL,
    "path" TEXT,
    "line" INTEGER,
    "url" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "bodyHash" TEXT NOT NULL,
    "disposition" "CommentDisposition" NOT NULL DEFAULT 'PENDING',
    "triageJson" JSONB,
    "handledAt" TIMESTAMP(3),
    "handledByRevision" INTEGER,
    "replyBody" TEXT,
    "replyPublishedAt" TIMESTAMP(3),
    "replyCommentId" BIGINT,

    CONSTRAINT "PrComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowEvent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "candidateId" TEXT,
    "contributionId" TEXT,
    "taskId" TEXT,
    "eventType" TEXT NOT NULL,
    "fromState" TEXT,
    "toState" TEXT,
    "actorKind" "ActorKind" NOT NULL DEFAULT 'SYSTEM',
    "actor" TEXT NOT NULL DEFAULT 'orchestrator',
    "reason" TEXT NOT NULL,
    "evidence" JSONB,
    "securityRelevant" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "kind" "TaskKind" NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'PENDING',
    "dedupeKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "lockedBy" TEXT,
    "lastError" TEXT,
    "projectId" TEXT,
    "contributionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LlmCall" (
    "id" TEXT NOT NULL,
    "agent" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "taskRef" TEXT,
    "inputHash" TEXT NOT NULL,
    "cacheHit" BOOLEAN NOT NULL DEFAULT false,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "error" TEXT,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "reasoningTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedPromptTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LlmCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LlmCache" (
    "key" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LlmCache_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "BudgetPeriod" (
    "id" TEXT NOT NULL,
    "scope" "BudgetScope" NOT NULL,
    "scopeRef" TEXT NOT NULL DEFAULT '',
    "periodKey" TEXT NOT NULL,
    "limitUsd" DECIMAL(12,6) NOT NULL,
    "spentUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BudgetPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "contributionId" TEXT NOT NULL,
    "action" "ApprovalAction" NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "artifactHash" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL DEFAULT 'orchestrator',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "note" TEXT,
    "consumedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lesson" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'agent',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Lesson_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetricDaily" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "key" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "meta" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetricDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "valueJson" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "Project_githubId_key" ON "Project"("githubId");

-- CreateIndex
CREATE UNIQUE INDEX "Project_fullName_key" ON "Project"("fullName");

-- CreateIndex
CREATE INDEX "Project_state_repoPushedAt_idx" ON "Project"("state", "repoPushedAt");

-- CreateIndex
CREATE INDEX "Project_discoveryScore_idx" ON "Project"("discoveryScore");

-- CreateIndex
CREATE INDEX "ProjectSnapshot_projectId_capturedAt_idx" ON "ProjectSnapshot"("projectId", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectSnapshot_projectId_capturedAt_key" ON "ProjectSnapshot"("projectId", "capturedAt");

-- CreateIndex
CREATE INDEX "ProjectSignal_kind_value_idx" ON "ProjectSignal"("kind", "value");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectSignal_projectId_kind_computedAt_key" ON "ProjectSignal"("projectId", "kind", "computedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RepoDigest_projectId_headSha_key" ON "RepoDigest"("projectId", "headSha");

-- CreateIndex
CREATE INDEX "Candidate_status_createdAt_idx" ON "Candidate"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Candidate_projectId_fingerprint_key" ON "Candidate"("projectId", "fingerprint");

-- CreateIndex
CREATE INDEX "Investigation_candidateId_kind_idx" ON "Investigation"("candidateId", "kind");

-- CreateIndex
CREATE INDEX "Investigation_contributionId_kind_idx" ON "Investigation"("contributionId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "Investigation_kind_inputHash_key" ON "Investigation"("kind", "inputHash");

-- CreateIndex
CREATE UNIQUE INDEX "Decision_candidateId_key" ON "Decision"("candidateId");

-- CreateIndex
CREATE INDEX "Decision_outcome_createdAt_idx" ON "Decision"("outcome", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Contribution_idempotencyKey_key" ON "Contribution"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Contribution_state_updatedAt_idx" ON "Contribution"("state", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Revision_contributionId_index_key" ON "Revision"("contributionId", "index");

-- CreateIndex
CREATE INDEX "Review_contributionId_round_idx" ON "Review"("contributionId", "round");

-- CreateIndex
CREATE UNIQUE INDEX "Review_contributionId_revisionIndex_reviewer_round_key" ON "Review"("contributionId", "revisionIndex", "reviewer", "round");

-- CreateIndex
CREATE INDEX "TestRun_contributionId_revisionIndex_idx" ON "TestRun"("contributionId", "revisionIndex");

-- CreateIndex
CREATE INDEX "PullRequest_state_idx" ON "PullRequest"("state");

-- CreateIndex
CREATE UNIQUE INDEX "PullRequest_repoFullName_number_key" ON "PullRequest"("repoFullName", "number");

-- CreateIndex
CREATE UNIQUE INDEX "PrComment_githubId_key" ON "PrComment"("githubId");

-- CreateIndex
CREATE INDEX "PrComment_prId_disposition_idx" ON "PrComment"("prId", "disposition");

-- CreateIndex
CREATE INDEX "WorkflowEvent_contributionId_createdAt_idx" ON "WorkflowEvent"("contributionId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkflowEvent_eventType_createdAt_idx" ON "WorkflowEvent"("eventType", "createdAt");

-- CreateIndex
CREATE INDEX "WorkflowEvent_securityRelevant_createdAt_idx" ON "WorkflowEvent"("securityRelevant", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Task_dedupeKey_key" ON "Task"("dedupeKey");

-- CreateIndex
CREATE INDEX "Task_status_availableAt_priority_idx" ON "Task"("status", "availableAt", "priority");

-- CreateIndex
CREATE INDEX "Task_kind_status_idx" ON "Task"("kind", "status");

-- CreateIndex
CREATE INDEX "LlmCall_agent_createdAt_idx" ON "LlmCall"("agent", "createdAt");

-- CreateIndex
CREATE INDEX "LlmCall_createdAt_idx" ON "LlmCall"("createdAt");

-- CreateIndex
CREATE INDEX "LlmCache_expiresAt_idx" ON "LlmCache"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetPeriod_scope_scopeRef_periodKey_key" ON "BudgetPeriod"("scope", "scopeRef", "periodKey");

-- CreateIndex
CREATE INDEX "Approval_status_idx" ON "Approval"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Approval_contributionId_action_artifactHash_key" ON "Approval"("contributionId", "action", "artifactHash");

-- CreateIndex
CREATE INDEX "Lesson_projectId_kind_idx" ON "Lesson"("projectId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "MetricDaily_date_key_key" ON "MetricDaily"("date", "key");

-- AddForeignKey
ALTER TABLE "ProjectSnapshot" ADD CONSTRAINT "ProjectSnapshot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectSignal" ADD CONSTRAINT "ProjectSignal_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepoDigest" ADD CONSTRAINT "RepoDigest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Candidate" ADD CONSTRAINT "Candidate_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Investigation" ADD CONSTRAINT "Investigation_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Investigation" ADD CONSTRAINT "Investigation_contributionId_fkey" FOREIGN KEY ("contributionId") REFERENCES "Contribution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contribution" ADD CONSTRAINT "Contribution_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contribution" ADD CONSTRAINT "Contribution_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Revision" ADD CONSTRAINT "Revision_contributionId_fkey" FOREIGN KEY ("contributionId") REFERENCES "Contribution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_contributionId_fkey" FOREIGN KEY ("contributionId") REFERENCES "Contribution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestRun" ADD CONSTRAINT "TestRun_contributionId_fkey" FOREIGN KEY ("contributionId") REFERENCES "Contribution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PullRequest" ADD CONSTRAINT "PullRequest_contributionId_fkey" FOREIGN KEY ("contributionId") REFERENCES "Contribution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrComment" ADD CONSTRAINT "PrComment_prId_fkey" FOREIGN KEY ("prId") REFERENCES "PullRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowEvent" ADD CONSTRAINT "WorkflowEvent_contributionId_fkey" FOREIGN KEY ("contributionId") REFERENCES "Contribution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_contributionId_fkey" FOREIGN KEY ("contributionId") REFERENCES "Contribution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_contributionId_fkey" FOREIGN KEY ("contributionId") REFERENCES "Contribution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lesson" ADD CONSTRAINT "Lesson_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

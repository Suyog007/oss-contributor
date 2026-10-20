import type { z } from 'zod';
import type { Db } from '@/db/client';
import type { InvestigationKind, InvestigationVerdict } from '@/generated/prisma/enums';
import type { Prisma } from '@/generated/prisma/client';
import { hashObject } from '@/lib/canonical';
import { createLogger, type Logger } from '@/lib/logger';
import { LlmClient, LlmDryRunError } from '@/llm/client';
import type { BudgetSubject } from '@/workflow/budget';
import { recordEvent } from '@/workflow/events';

export interface AgentContext {
  db: Db;
  llm: LlmClient;
  runtime: AgentRuntime;
  log: Logger;
}

export interface AgentInvocation<TOutput> {
  /** Stable agent name for cost attribution and audit, e.g. "review:adversarial". */
  agent: string;
  kind: InvestigationKind;
  tier: 'fast' | 'deep';
  system: string;
  user: string;
  schema: z.ZodType<TOutput>;
  schemaName: string;
  /** Bump when the prompt or schema changes meaning. Part of the cache key. */
  promptVersion: number;
  candidateId?: string | null;
  contributionId?: string | null;
  subject: BudgetSubject;
  maxOutputTokens?: number;
  temperature?: number;
  cache?: boolean;
  taskRef?: string;
  /** Per-call HTTP timeout and retry count for unusually large outputs. */
  timeoutMs?: number;
  retries?: number;
  /**
   * How to read a verdict and confidence out of the output. Kept per agent so
   * the orchestrator never has to guess what "confidence" refers to.
   */
  interpret: (output: TOutput) => {
    verdict: InvestigationVerdict;
    confidence: number;
    rationale: string;
  };
}

export interface AgentOutcome<TOutput> {
  output: TOutput;
  investigationId: string;
  verdict: InvestigationVerdict;
  confidence: number;
  rationale: string;
  costUsd: number;
  cacheHit: boolean;
  model: string;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
}

export interface AgentRuntimeOptions {
  /** Set false to bypass the investigation-level cache (used by tests). */
  reuseInvestigations?: boolean;
}

/**
 * One place where agents actually run.
 *
 * Responsibilities kept here (and therefore identical for every agent):
 *  - content-addressed reuse: an identical (prompt, schema, model) invocation
 *    is answered from `Investigation` instead of the model;
 *  - budget enforcement, through the LLM client;
 *  - persistence of the full structured output plus a one-line rationale;
 *  - failure handling that records the attempt without pretending it succeeded.
 */
export class AgentRuntime {
  constructor(
    private readonly db: Db,
    private readonly llm: LlmClient,
    private readonly options: AgentRuntimeOptions = {},
  ) {}

  get logger(): Logger {
    return createLogger('agent');
  }

  async run<TOutput>(invocation: AgentInvocation<TOutput>): Promise<AgentOutcome<TOutput>> {
    const model = this.llm.modelFor({ tier: invocation.tier });
    const inputHash = hashObject({
      agent: invocation.agent,
      kind: invocation.kind,
      schemaName: invocation.schemaName,
      promptVersion: invocation.promptVersion,
      model,
      system: invocation.system,
      user: invocation.user,
      maxOutputTokens: invocation.maxOutputTokens ?? null,
      temperature: invocation.temperature ?? 0,
    });

    if (this.options.reuseInvestigations !== false) {
      const existing = await this.db.investigation.findUnique({
        where: { kind_inputHash: { kind: invocation.kind, inputHash } },
      });
      if (existing) {
        const parsed = invocation.schema.safeParse(existing.outputJson);
        if (parsed.success) {
          const interpreted = invocation.interpret(parsed.data);
          return {
            output: parsed.data,
            investigationId: existing.id,
            verdict: existing.verdict,
            confidence: existing.confidence,
            rationale: existing.rationale,
            costUsd: 0,
            cacheHit: true,
            model: existing.model ?? model,
            promptTokens: 0,
            completionTokens: 0,
            durationMs: 0,
          };
        }
        await this.db.investigation.delete({ where: { id: existing.id } }).catch(() => undefined);
      }
    }

    const started = Date.now();
    try {
      const result = await this.llm.chatJson({
        agent: invocation.agent,
        system: invocation.system,
        user: invocation.user,
        schema: invocation.schema,
        schemaName: invocation.schemaName,
        tier: invocation.tier,
        subject: invocation.subject,
        promptVersion: invocation.promptVersion,
        ...(invocation.maxOutputTokens ? { maxOutputTokens: invocation.maxOutputTokens } : {}),
        ...(invocation.temperature !== undefined ? { temperature: invocation.temperature } : {}),
        ...(invocation.cache !== undefined ? { cache: invocation.cache } : {}),
        ...(invocation.taskRef ? { taskRef: invocation.taskRef } : {}),
        ...(invocation.timeoutMs !== undefined ? { timeoutMs: invocation.timeoutMs } : {}),
        ...(invocation.retries !== undefined ? { retries: invocation.retries } : {}),
      });

      const interpreted = invocation.interpret(result.value);
      const investigation = await this.db.investigation.create({
        data: {
          candidateId: invocation.candidateId ?? null,
          contributionId: invocation.contributionId ?? null,
          kind: invocation.kind,
          agent: invocation.agent,
          model: result.model,
          inputHash,
          verdict: interpreted.verdict,
          confidence: interpreted.confidence,
          outputJson: result.value as Prisma.InputJsonValue,
          rationale: interpreted.rationale.slice(0, 1000),
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          costUsd: result.costUsd,
          cacheHit: result.cacheHit,
          durationMs: result.durationMs,
        },
      });

      if (invocation.candidateId) {
        await this.db.candidate.update({
          where: { id: invocation.candidateId },
          data: {
            llmTokens: {
              increment: result.usage.promptTokens + result.usage.completionTokens,
            },
          },
        });
      }

      return {
        output: result.value,
        investigationId: investigation.id,
        verdict: interpreted.verdict,
        confidence: interpreted.confidence,
        rationale: interpreted.rationale,
        costUsd: result.costUsd,
        cacheHit: result.cacheHit,
        model: result.model,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      if (error instanceof LlmDryRunError) throw error;
      await recordEvent(this.db, {
        eventType: 'agent_failed',
        reason: `agent ${invocation.agent} failed: ${error instanceof Error ? error.message : String(error)}`,
        candidateId: invocation.candidateId ?? null,
        contributionId: invocation.contributionId ?? null,
        actorKind: 'AGENT',
        actor: invocation.agent,
        evidence: { schemaName: invocation.schemaName, inputHash: inputHash.slice(0, 16) },
      });
      throw error;
    }
  }
}

export function createAgentRuntime(db: Db, options?: AgentRuntimeOptions): AgentRuntime {
  return new AgentRuntime(db, new LlmClient(db), options);
}

/** Full agent context: database, model client, and the runtime that persists runs. */
export function createAgentContext(db: Db, options?: AgentRuntimeOptions): AgentContext {
  const llm = new LlmClient(db);
  return {
    db,
    llm,
    runtime: new AgentRuntime(db, llm, options),
    log: createLogger('agent'),
  };
}

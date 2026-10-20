import { z } from 'zod';
import type { Db } from '@/db/client';
import { loadEnv, type Env } from '@/config/env';
import { BudgetGuard, type BudgetSubject } from '@/workflow/budget';
import { hashObject, truncateBytes } from '@/lib/canonical';
import { createLogger, redact } from '@/lib/logger';
import { costUsd, estimateCostUsd, estimateTokens, priceFor, roundUsd, type Usage } from './pricing';

const log = createLogger('llm');

export class LlmUnavailableError extends Error {
  constructor(reason: string) {
    super(`LLM unavailable: ${reason}`);
    this.name = 'LlmUnavailableError';
  }
}

export class LlmDryRunError extends Error {
  constructor(
    readonly agent: string,
    readonly model: string,
    readonly estimatedUsd: number,
    readonly promptTokens: number,
  ) {
    super(
      `AI_DRY_RUN: would call ${model} for ${agent} (~${promptTokens} prompt tokens, ~$${estimatedUsd.toFixed(5)})`,
    );
    this.name = 'LlmDryRunError';
  }
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface LlmResult<T> {
  value: T;
  model: string;
  usage: Usage;
  costUsd: number;
  cacheHit: boolean;
  durationMs: number;
  attempts: number;
  raw: string;
}

export interface LlmCallOptions<T> {
  /** Agent name, used for cost attribution and audit. */
  agent: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  schemaName: string;
  tier?: 'fast' | 'deep';
  model?: string;
  maxOutputTokens?: number;
  temperature?: number;
  subject?: BudgetSubject;
  /** Set false for calls whose output should never be reused. */
  cache?: boolean;
  taskRef?: string;
  /** Per-call HTTP timeout, overriding AI_REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Per-call retry count, overriding AI_MAX_RETRIES. */
  retries?: number;
  /** Included in the cache key; bump when a prompt changes meaning. */
  promptVersion?: number;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string | null; reasoning_content?: string | null }; finish_reason?: string }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  error?: { message?: string; type?: string; code?: string };
}

const JSON_INSTRUCTION =
  'Respond with a single JSON object and nothing else. Do not wrap it in prose or markdown fences.';

/**
 * JSON Schema for a Zod contract, used for constrained decoding. Constrained
 * decoding makes a whole class of invalid responses impossible, so it is tried
 * first and only disabled per model if the API rejects it.
 */
export function jsonSchemaFor(schema: z.ZodType<unknown>, name: string): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema, { io: 'output', target: 'draft-7' }) as Record<string, unknown>;
  delete jsonSchema['$schema'];
  return { type: 'json_schema', json_schema: { name, schema: jsonSchema } };
}

/** Compact statement of the required shape, included in every prompt. */
export function shapeHint(schema: z.ZodType<unknown>, name: string, maxChars = 3500): string {
  const jsonSchema = jsonSchemaFor(schema, name) as { json_schema?: { schema?: unknown } };
  const text = JSON.stringify(jsonSchema.json_schema?.schema ?? {});
  return text.length > maxChars ? `${text.slice(0, maxChars)}…(truncated)` : text;
}

/** Models that rejected `response_format` are remembered so we do not retry it. */
const noJsonModeModels = new Set<string>();
const noJsonSchemaModels = new Set<string>();

export class LlmClient {
  private readonly budget: BudgetGuard;

  constructor(
    private readonly db: Db,
    private readonly env: Env = loadEnv(),
  ) {
    this.budget = BudgetGuard.fromEnv(db);
  }

  get configured(): boolean {
    return this.env.AI_ENABLED && this.env.FIREWORKS_API_KEY !== undefined;
  }

  modelFor(options: { tier?: 'fast' | 'deep'; model?: string }): string {
    if (options.model) return options.model;
    return options.tier === 'deep' ? this.env.FIREWORKS_MODEL_DEEP : this.env.FIREWORKS_MODEL_FAST;
  }

  /**
   * Reasoning effort per tier. Reasoning tokens are billed as output tokens, so
   * the cheap tier is told to think briefly and the deep tier moderately.
   */
  private reasoningEffort(tier: 'fast' | 'deep'): string | undefined {
    if (this.env.AI_REASONING_EFFORT) return this.env.AI_REASONING_EFFORT;
    return tier === 'deep' ? this.env.AI_REASONING_EFFORT_DEEP : 'low';
  }

  /**
   * One structured model call.
   *
   * Order of operations: cache lookup, budget pre-check (fail closed),
   * request with bounded retries, schema validation with a single repair
   * attempt, then cost accounting. Every outcome is recorded, including
   * failures, because the audit trail is what makes costs explainable.
   */
  async chatJson<T>(options: LlmCallOptions<T>): Promise<LlmResult<T>> {
    const model = this.modelFor(options);
    const maxOutputTokens = options.maxOutputTokens ?? this.env.AI_MAX_OUTPUT_TOKENS;
    const temperature = options.temperature ?? 0;
    const price = priceFor(model, this.env.AI_PRICING_OVERRIDES);
    const subject = options.subject ?? {};

    const requestFingerprint = hashObject({
      model,
      system: options.system,
      user: options.user,
      temperature,
      maxOutputTokens,
      schemaName: options.schemaName,
      promptVersion: options.promptVersion ?? 1,
      reasoningEffort: this.reasoningEffort(options.tier ?? 'fast') ?? null,
    });

    if (options.cache !== false) {
      const cached = await this.readCache(requestFingerprint);
      if (cached) {
        const parsed = options.schema.safeParse(cached.value);
        if (parsed.success) {
          await this.recordCall({
            agent: options.agent,
            model,
            taskRef: options.taskRef,
            inputHash: requestFingerprint,
            cacheHit: true,
            ok: true,
            usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedPromptTokens: 0 },
            cost: 0,
            latencyMs: 0,
          });
          log.debug('llm cache hit', { agent: options.agent, model });
          return {
            value: parsed.data,
            model,
            usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedPromptTokens: 0 },
            costUsd: 0,
            cacheHit: true,
            durationMs: 0,
            attempts: 0,
            raw: cached.raw,
          };
        }
        await this.db.llmCache.delete({ where: { key: requestFingerprint } }).catch(() => undefined);
      }
    }

    if (!this.env.AI_ENABLED) {
      throw new LlmUnavailableError('AI_ENABLED is false');
    }
    if (!this.env.FIREWORKS_API_KEY) {
      throw new LlmUnavailableError('FIREWORKS_API_KEY is not set');
    }

    const promptTokens = estimateTokens(options.system) + estimateTokens(options.user);
    const estimated = estimateCostUsd(price, promptTokens, maxOutputTokens);
    await this.budget.assertAffordable(subject, estimated);

    if (this.env.AI_DRY_RUN) {
      throw new LlmDryRunError(options.agent, model, estimated, promptTokens);
    }

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: options.system },
      {
        role: 'user',
        content: `${options.user}\n\n${JSON_INSTRUCTION}\nRequired JSON shape (JSON Schema): ${shapeHint(options.schema, options.schemaName)}`,
      },
    ];

    const started = Date.now();
    let attempts = 0;
    let lastError: Error | null = null;
    let totalUsage: Usage = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedPromptTokens: 0 };
    let totalCost = 0;

    for (let repair = 0; repair <= 1; repair += 1) {
      const outcome = await this.requestWithRetries({
        model,
        messages,
        temperature,
        maxOutputTokens,
        agent: options.agent,
        taskRef: options.taskRef,
        inputHash: requestFingerprint,
        schema: { schema: options.schema as z.ZodType<unknown>, name: options.schemaName },
        reasoningEffort: this.reasoningEffort(options.tier ?? 'fast'),
        timeoutMs: options.timeoutMs ?? this.env.AI_REQUEST_TIMEOUT_MS,
        ...(options.retries !== undefined ? { retries: options.retries } : {}),
      });
      attempts += outcome.attempts;
      totalUsage = addUsage(totalUsage, outcome.usage);
      totalCost += costUsd(price, outcome.usage);
      if (!outcome.ok) {
        lastError = outcome.error;
        break;
      }

      const content = outcome.content ?? '';

      // A response cut off by the output limit cannot be parsed; ask for a
      // shorter version of the same answer instead of failing the task.
      if (outcome.finishReason === 'length') {
        lastError = new LlmError(
          `response truncated at ${maxOutputTokens} output tokens`,
          undefined,
          false,
        );
        log.warn('llm response truncated', { agent: options.agent, model, maxOutputTokens });
        messages.push({ role: 'assistant', content: content.slice(0, 1500) });
        messages.push({
          role: 'user',
          content:
            'Your response was cut off by the output limit. Reply again with the same JSON, but shorter: at most 3 items per array, and at most 200 characters per string field. Keep the most important findings only.',
        });
        continue;
      }

      const parsedJson = extractJson(content);
      if (parsedJson === undefined) {
        lastError = new LlmError('response was not valid JSON', undefined, false);
        messages.push({ role: 'assistant', content: content.slice(0, 2000) });
        messages.push({
          role: 'user',
          content: 'That was not valid JSON. Reply with one JSON object matching the required shape.',
        });
        continue;
      }

      const validated = options.schema.safeParse(parsedJson);
      if (validated.success) {
        await this.budget.charge(subject, totalCost, 1);
        if (options.cache !== false) {
          await this.writeCache(requestFingerprint, model, { value: parsedJson, raw: content });
        }
        return {
          value: validated.data,
          model,
          usage: totalUsage,
          costUsd: roundUsd(totalCost),
          cacheHit: false,
          durationMs: Date.now() - started,
          attempts,
          raw: content,
        };
      }

      const problem = validated.error.issues
        .slice(0, 8)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      log.warn('llm output failed schema validation', { agent: options.agent, schema: options.schemaName, problem });
      lastError = new LlmError(`schema validation failed: ${problem}`, undefined, false);
      messages.push({ role: 'assistant', content: content.slice(0, 4000) });
      messages.push({
        role: 'user',
        content: `Your JSON did not match the required shape. Errors: ${problem}. Reply again with one JSON object that fixes exactly these errors. Keep the same facts.`,
      });
    }

    await this.budget.charge(subject, totalCost, 1);
    throw lastError ?? new LlmError('model call failed', undefined, false);
  }

  private async requestWithRetries(input: {
    model: string;
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    temperature: number;
    maxOutputTokens: number;
    agent: string;
    taskRef?: string;
    inputHash: string;
    schema?: { schema: z.ZodType<unknown>; name: string };
    reasoningEffort?: string | undefined;
    timeoutMs: number;
    retries?: number;
  }): Promise<
    | { ok: true; content: string | null; usage: Usage; attempts: number; finishReason: string | null }
    | { ok: false; error: Error; usage: Usage; attempts: number }
  > {
    const maxAttempts = Math.max(1, (input.retries ?? this.env.AI_MAX_RETRIES) + 1);
    let attempts = 0;
    let usage: Usage = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedPromptTokens: 0 };
    let lastError: Error = new LlmError('unknown error', undefined, true);

    while (attempts < maxAttempts) {
      attempts += 1;
      const started = Date.now();
      try {
        const useJsonSchema = !noJsonSchemaModels.has(input.model);
        const useJsonMode = !noJsonModeModels.has(input.model);
        const body: Record<string, unknown> = {
          model: input.model,
          messages: input.messages,
          temperature: input.temperature,
          max_tokens: input.maxOutputTokens,
        };
        if (useJsonSchema && input.schema) {
          body['response_format'] = jsonSchemaFor(input.schema.schema, input.schema.name);
        } else if (useJsonMode) {
          body['response_format'] = { type: 'json_object' };
        }
        if (input.reasoningEffort) body['reasoning_effort'] = input.reasoningEffort;

        const response = await fetch(`${this.env.FIREWORKS_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.env.FIREWORKS_API_KEY}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(input.timeoutMs),
        });

        const text = await response.text();
        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500;
          if (response.status === 400 && /response_format|json_schema|json_object|json mode/i.test(text)) {
            // Constrained decoding is a capability, not an assumption: when a
            // model rejects it, remember that and continue without it.
            if (useJsonSchema && input.schema) noJsonSchemaModels.add(input.model);
            else if (useJsonMode) noJsonModeModels.add(input.model);
          }
          const error = new LlmError(
            `fireworks ${response.status}: ${redact(text).slice(0, 400)}`,
            response.status,
            retryable,
          );
          if (!retryable) return { ok: false, error, usage, attempts };
          lastError = error;
          await sleep(backoffMs(attempts, response.headers.get('retry-after')));
          continue;
        }

        let payload: ChatResponse;
        try {
          payload = JSON.parse(text) as ChatResponse;
        } catch {
          return { ok: false, error: new LlmError('non-JSON HTTP body', response.status, true), usage, attempts };
        }

        usage = {
          promptTokens: payload.usage?.prompt_tokens ?? 0,
          completionTokens: payload.usage?.completion_tokens ?? 0,
          reasoningTokens: payload.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
          cachedPromptTokens: payload.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        };
        const content = payload.choices?.[0]?.message?.content ?? null;
        if (!content || content.trim().length === 0) {
          lastError = new LlmError('empty completion', undefined, true);
          await sleep(backoffMs(attempts));
          continue;
        }
        await this.recordCall({
          agent: input.agent,
          model: input.model,
          taskRef: input.taskRef,
          inputHash: input.inputHash,
          cacheHit: false,
          ok: true,
          usage,
          cost: costUsd(priceFor(input.model, this.env.AI_PRICING_OVERRIDES), usage),
          latencyMs: Date.now() - started,
        });
        return {
          ok: true,
          content,
          usage,
          attempts,
          finishReason: payload.choices?.[0]?.finish_reason ?? null,
        };
      } catch (error) {
        const isAbort = error instanceof Error && error.name === 'TimeoutError';
        lastError = new LlmError(
          isAbort ? `request timed out after ${input.timeoutMs}ms` : `request failed: ${String(error)}`,
          undefined,
          true,
        );
        await sleep(backoffMs(attempts));
      }
    }

    await this.recordCall({
      agent: input.agent,
      model: input.model,
      taskRef: input.taskRef,
      inputHash: input.inputHash,
      cacheHit: false,
      ok: false,
      usage,
      cost: costUsd(priceFor(input.model, this.env.AI_PRICING_OVERRIDES), usage),
      latencyMs: 0,
      error: lastError.message,
    });
    return { ok: false, error: lastError, usage, attempts };
  }

  private async readCache(key: string): Promise<{ value: unknown; raw: string } | null> {
    const row = await this.db.llmCache.findUnique({ where: { key } });
    if (!row) return null;
    if (row.expiresAt.getTime() < Date.now()) {
      await this.db.llmCache.delete({ where: { key } }).catch(() => undefined);
      return null;
    }
    const payload = row.response as { value?: unknown; raw?: string };
    if (payload.value === undefined) return null;
    return { value: payload.value, raw: payload.raw ?? '' };
  }

  private async writeCache(key: string, model: string, payload: { value: unknown; raw: string }): Promise<void> {
    const expiresAt = new Date(Date.now() + this.env.AI_CACHE_TTL_HOURS * 3_600_000);
    await this.db.llmCache.upsert({
      where: { key },
      create: { key, model, response: payload as never, expiresAt },
      update: { response: payload as never, expiresAt },
    });
  }

  private async recordCall(input: {
    agent: string;
    model: string;
    taskRef?: string;
    inputHash: string;
    cacheHit: boolean;
    ok: boolean;
    usage: Usage;
    cost: number;
    latencyMs: number;
    error?: string;
  }): Promise<void> {
    await this.db.llmCall.create({
      data: {
        agent: input.agent,
        model: input.model,
        taskRef: input.taskRef ?? null,
        inputHash: input.inputHash,
        cacheHit: input.cacheHit,
        ok: input.ok,
        error: input.error ? truncateBytes(redact(input.error), 1000).text : null,
        promptTokens: input.usage.promptTokens,
        completionTokens: input.usage.completionTokens,
        reasoningTokens: input.usage.reasoningTokens,
        cachedPromptTokens: input.usage.cachedPromptTokens,
        costUsd: roundUsd(input.cost),
        latencyMs: input.latencyMs,
      },
    });
  }
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    cachedPromptTokens: a.cachedPromptTokens + b.cachedPromptTokens,
  };
}

function backoffMs(attempt: number, retryAfterHeader?: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 30_000);
    const date = Date.parse(retryAfterHeader);
    if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 30_000));
  }
  const base = 750 * 2 ** (attempt - 1);
  return Math.min(base + Math.random() * 250, 15_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extract a JSON object from a completion that may include fences or prose. */
export function extractJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const direct = tryParse(candidate);
  if (direct !== undefined) return direct;
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return tryParse(candidate.slice(firstBrace, lastBrace + 1));
  }
  return undefined;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

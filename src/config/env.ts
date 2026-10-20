import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const num = (fallback: number) =>
  z.coerce.number().finite().nonnegative().default(fallback);

const int = (fallback: number) =>
  z.coerce.number().int().nonnegative().default(fallback);

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined));

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  );

const pricingOverrides = z
  .string()
  .optional()
  .transform((raw, ctx) => {
    if (!raw) return {};
    try {
      const parsed = z
        .record(
          z.string(),
          z.object({
            inputPerMTok: z.number().nonnegative(),
            outputPerMTok: z.number().nonnegative(),
            cachedInputPerMTok: z.number().nonnegative().optional(),
          }),
        )
        .parse(JSON.parse(raw));
      return parsed;
    } catch (error) {
      ctx.addIssue({ code: 'custom', message: `AI_PRICING_OVERRIDES is not valid JSON: ${error}` });
      return z.NEVER;
    }
  });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  TEST_DATABASE_URL: optionalString,

  // AI
  FIREWORKS_API_KEY: optionalString,
  FIREWORKS_BASE_URL: z.string().url().default('https://api.fireworks.ai/inference/v1'),
  FIREWORKS_MODEL_FAST: z
    .string()
    .min(1)
    .default('accounts/fireworks/models/deepseek-v4p1-flash'),
  FIREWORKS_MODEL_DEEP: z.string().min(1).default('accounts/fireworks/models/kimi-k3'),
  AI_ENABLED: bool.default(true),
  AI_DRY_RUN: bool.default(false),
  AI_DAILY_BUDGET_USD: num(5),
  AI_MONTHLY_BUDGET_USD: num(60),
  AI_CONTRIBUTION_BUDGET_USD: num(2),
  AI_CANDIDATE_BUDGET_USD: num(0.75),
  AI_BUDGET_TIMEZONE: z.string().default('UTC'),
  AI_MAX_OUTPUT_TOKENS: int(12000),
  AI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  AI_REQUEST_TIMEOUT_MS: int(240_000),
  /** Longer ceiling for calls that must return whole files (16k output tokens). */
  AI_LONG_REQUEST_TIMEOUT_MS: int(600_000),
  AI_CACHE_TTL_HOURS: num(168),
  /** Global override. When empty, the cheap tier uses 'low' and the deep tier 'medium'. */
  AI_REASONING_EFFORT: z
    .enum(['low', 'medium', 'high', ''])
    .default('')
    .transform((v) => (v === '' ? undefined : v)),
  AI_REASONING_EFFORT_DEEP: z.enum(['low', 'medium', 'high']).default('medium'),
  AI_PRICING_OVERRIDES: pricingOverrides,

  // GitHub
  GITHUB_TOKEN: optionalString,
  GITHUB_API_URL: z.string().url().default('https://api.github.com'),
  GITHUB_GRAPHQL_URL: z.string().url().default('https://api.github.com/graphql'),
  GITHUB_FORK_OWNER: optionalString,

  // Discovery
  DISCOVERY_QUERY_PACKS: csv,
  DISCOVERY_MAX_QUERIES_PER_RUN: int(12),
  DISCOVERY_RESULTS_PER_QUERY: int(40),
  DISCOVERY_MIN_STARS: int(60),
  DISCOVERY_MAX_REPO_SIZE_KB: int(250_000),
  DISCOVERY_MAX_DAYS_SINCE_PUSH: int(120),
  DISCOVERY_REQUIRE_LICENSE: bool.default(true),
  DISCOVERY_REQUIRE_TESTS: bool.default(false),
  /** Repositories younger than this are rejected: early attention is not evidence. */
  DISCOVERY_MIN_REPO_AGE_DAYS: int(14),
  /** How many repositories per run get the expensive per-repo activity calls. */
  DISCOVERY_MAX_PROJECTS_PER_RUN: int(20),
  /** How many projects are sent to analysis (and therefore to the model) per run. */
  DISCOVERY_MAX_ANALYSES_PER_RUN: int(4),
  /** Projects kept for tracking even when they are not analyzed. */
  DISCOVERY_TRACK_EXISTING_PER_RUN: int(10),
  DISCOVERY_MIN_SCORE_TO_ANALYZE: num(35),

  // Analysis
  ANALYSIS_MAX_CONTEXT_BYTES: int(120_000),
  ANALYSIS_LARGE_REPO_KB: int(150_000),
  CANDIDATE_MAX_PER_PROJECT: int(3),
  CANDIDATE_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.6),
  REPRO_MAX_ATTEMPTS: int(2),

  // Implementation and review
  WORKSPACE_ROOT: z.string().default('.workspaces'),
  MAX_REVISION_ROUNDS: int(3),
  /** Hard limits on what a single implementation may change. */
  MAX_FILES_PER_CHANGE: int(12),
  MAX_EDIT_BYTES_PER_FILE: int(400_000),
  MAX_EDIT_BYTES_TOTAL: int(1_000_000),
  MAX_REVIEWERS_PER_ROUND: int(4),
  TASK_TIMEOUT_MS: int(1_800_000),
  SANDBOX_TIMEOUT_MS: int(900_000),

  // Sandbox
  SANDBOX_MODE: z.enum(['docker', 'local_restricted', 'none']).default('docker'),
  SANDBOX_IMAGE: z.string().default('node:22-bookworm'),
  SANDBOX_MEMORY_MB: int(2048),
  SANDBOX_CPUS: num(2),
  SANDBOX_PIDS_LIMIT: int(512),
  SANDBOX_DISK_MB: int(4096),
  SANDBOX_ALLOW_NETWORK: bool.default(false),
  SANDBOX_ALLOWED_IMAGE_PREFIXES: csv,
  /** Repositories allowed to execute outside a container. Excluded by default. */
  SANDBOX_LOCAL_TRUSTED_PROJECTS: csv,

  // Git identity used for commits. Empty name means the agent's own identity.
  GIT_AUTHOR_NAME: optionalString,
  GIT_AUTHOR_EMAIL: optionalString,

  // Autonomy
  AUTONOMY_LEVEL: z
    .enum(['approval_required', 'low_risk_autonomous', 'full_autonomous'])
    .default('approval_required'),
  AUTONOMY_ALLOWED_ACTIONS: csv,
  APPROVAL_TTL_HOURS: num(72),

  // Worker
  WORKER_ID: optionalString,
  WORKER_CONCURRENCY: int(1),
  WORKER_POLL_MS: int(2000),
  WORKER_TASK_MAX_MS: int(1_800_000),
  WORKER_LEASE_MS: int(2_400_000),

  // Dashboard
  DASHBOARD_AUTH_DISABLED: bool.default(false),
  DASHBOARD_PASSWORD: optionalString,
  SESSION_SECRET: optionalString,
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${problems}`);
  }
  cached = parsed.data;
  return cached;
}

export function resetEnvCache(): void {
  cached = null;
}

/** True when a model call can actually be made. */
export function llmConfigured(env: Env = loadEnv()): boolean {
  return env.AI_ENABLED && env.FIREWORKS_API_KEY !== undefined && !env.AI_DRY_RUN;
}

/**
 * Credentials for GitHub *writes*. Read-only discovery works with any token;
 * pushing to a fork requires a token that can write to the fork owner's repos.
 */
export function githubConfigured(env: Env = loadEnv()): boolean {
  return env.GITHUB_TOKEN !== undefined;
}

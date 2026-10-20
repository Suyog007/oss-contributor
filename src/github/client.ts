import { loadEnv, type Env } from '@/config/env';
import { createLogger, redact } from '@/lib/logger';
import { truncateBytes } from '@/lib/canonical';

const log = createLogger('github');

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

export class GitHubRateLimitError extends Error {
  constructor(
    message: string,
    readonly resetAt: Date,
    readonly resource: string,
  ) {
    super(message);
    this.name = 'GitHubRateLimitError';
  }
}

export class GitHubNotFoundError extends Error {
  constructor(readonly path: string) {
    super(`not found: ${path}`);
    this.name = 'GitHubNotFoundError';
  }
}

export interface RateLimitSnapshot {
  resource: string;
  limit: number;
  remaining: number;
  resetAt: Date;
  capturedAt: Date;
}

export interface GitHubRepository {
  name: string;
  full_name: string;
  owner: { login: string };
  default_branch: string;
  private: boolean;
  fork: boolean;
  parent?: { full_name: string } | null;
}

export interface GitHubPullRequest {
  number: number;
  html_url: string;
  node_id: string;
  state: 'open' | 'closed';
  draft: boolean;
  title: string;
  body: string | null;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { ref: string };
}

export interface GitHubClientOptions {
  token: string;
  apiBaseUrl?: string;
  graphqlUrl?: string;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  accept?: string;
  /** Return the raw body instead of parsed JSON (used for file contents). */
  raw?: boolean;
  /** Disable the response cache for this request. */
  noCache?: boolean;
  maxAttempts?: number;
}

/**
 * Minimal GitHub client.
 *
 * Written directly on `fetch` instead of a client library so that rate-limit
 * accounting, ETag caching, retry policy, and the exact headers used for logs
 * are all under our control. Two behaviours matter for this system:
 *
 *  - Secondary/primary rate limits surface as `GitHubRateLimitError` with the
 *    reset time, so the workflow can park a task instead of burning retries.
 *  - GET responses are cached by ETag, so re-reading a repository that has not
 *    changed costs one conditional request and no model tokens.
 */
export class GitHubClient {
  private readonly token: string;
  private readonly apiBaseUrl: string;
  private readonly graphqlUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly etags = new Map<string, { etag: string; body: string }>();
  private readonly responseCache = new Map<string, string>();
  private lastRateLimit: RateLimitSnapshot | null = null;

  constructor(options: GitHubClientOptions) {
    this.token = options.token;
    this.apiBaseUrl = (options.apiBaseUrl ?? 'https://api.github.com').replace(/\/$/, '');
    this.graphqlUrl = options.graphqlUrl ?? 'https://api.github.com/graphql';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.userAgent = options.userAgent ?? 'oss-contributor-agent';
  }

  static fromEnv(env: Env = loadEnv(), fetchImpl?: typeof fetch): GitHubClient {
    if (!env.GITHUB_TOKEN) {
      throw new Error('GITHUB_TOKEN is not configured; set it in .env to use GitHub features');
    }
    return new GitHubClient({
      token: env.GITHUB_TOKEN,
      apiBaseUrl: env.GITHUB_API_URL,
      graphqlUrl: env.GITHUB_GRAPHQL_URL,
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  }

  get rateLimit(): RateLimitSnapshot | null {
    return this.lastRateLimit;
  }

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const url = new URL(path.startsWith('http') ? path : `${this.apiBaseUrl}${path.startsWith('/') ? '' : '/'}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private captureRateLimit(headers: Headers, resource = 'core'): void {
    const limit = Number(headers.get('x-ratelimit-limit'));
    const remaining = Number(headers.get('x-ratelimit-remaining'));
    const reset = Number(headers.get('x-ratelimit-reset'));
    if (!Number.isFinite(limit) || !Number.isFinite(remaining)) return;
    this.lastRateLimit = {
      resource,
      limit,
      remaining,
      resetAt: new Date(Number.isFinite(reset) ? reset * 1000 : Date.now() + 60_000),
      capturedAt: new Date(),
    };
  }

  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const cacheKey = `${options.method ?? 'GET'} ${this.buildUrl(path, options.query)}`;
    const useCache = (options.method ?? 'GET') === 'GET' && options.noCache !== true;

    if (useCache && this.responseCache.has(cacheKey)) {
      return JSON.parse(this.responseCache.get(cacheKey)!) as T;
    }

    const maxAttempts = options.maxAttempts ?? 3;
    let attempt = 0;
    let lastError: Error | null = null;

    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        const body = await this.execute<T>(path, options, cacheKey, useCache);
        if (useCache) this.responseCache.set(cacheKey, JSON.stringify(body));
        return body;
      } catch (error) {
        lastError = error as Error;
        if (error instanceof GitHubRateLimitError) throw error;
        if (error instanceof GitHubNotFoundError) throw error;
        if (error instanceof GitHubError && !error.retryable) throw error;
        await sleep(Math.min(1000 * 2 ** (attempt - 1), 20_000));
      }
    }
    throw lastError ?? new GitHubError('request failed', 0, false);
  }

  private async execute<T>(
    path: string,
    options: RequestOptions,
    cacheKey: string,
    useCache: boolean,
  ): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const headers: Record<string, string> = {
      accept: options.accept ?? 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': this.userAgent,
      authorization: `Bearer ${this.token}`,
    };
    const cachedEtag = useCache ? this.etags.get(cacheKey) : undefined;
    if (cachedEtag) headers['if-none-match'] = cachedEtag.etag;
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    const response = await this.fetchImpl(url, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });

    const resource = url.includes('/search/') ? 'search' : url.includes('/graphql') ? 'graphql' : 'core';
    this.captureRateLimit(response.headers, resource);

    if (response.status === 304 && cachedEtag) {
      return JSON.parse(cachedEtag.body) as T;
    }

    if (response.status === 404) {
      throw new GitHubNotFoundError(path);
    }

    if (response.status === 403 || response.status === 429) {
      const remaining = response.headers.get('x-ratelimit-remaining');
      const resetHeader = response.headers.get('x-ratelimit-reset');
      const text = redact(await response.text()).slice(0, 400);
      if (remaining === '0' || /rate limit|secondary rate/i.test(text)) {
        const resetAt = resetHeader
          ? new Date(Number(resetHeader) * 1000)
          : new Date(Date.now() + 60_000);
        throw new GitHubRateLimitError(
          `GitHub ${resource} rate limit reached; resets at ${resetAt.toISOString()}`,
          resetAt,
          resource,
        );
      }
      throw new GitHubError(`github 403: ${text}`, response.status, false);
    }

    if (!response.ok) {
      const text = redact(await response.text()).slice(0, 400);
      const retryable = response.status >= 500;
      log.warn('github request failed', { path, status: response.status, retryable });
      throw new GitHubError(`github ${response.status} for ${path}: ${text}`, response.status, retryable);
    }

    if (options.raw) {
      return (await response.text()) as T;
    }

    const text = await response.text();
    const etag = response.headers.get('etag');
    if (etag && useCache) this.etags.set(cacheKey, { etag, body: text });
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  /** Follow `Link: rel="next"` pagination with a hard page ceiling. */
  async paginate<T>(path: string, options: RequestOptions & { perPage?: number; maxPages?: number } = {}): Promise<T[]> {
    const perPage = options.perPage ?? 100;
    const maxPages = options.maxPages ?? 3;
    const results: T[] = [];
    let page = 1;
    while (page <= maxPages) {
      const url = this.buildUrl(path, { ...(options.query ?? {}), per_page: perPage, page });
      const batch = await this.request<T[]>(url, { ...options, noCache: options.noCache });
      if (!Array.isArray(batch)) break;
      results.push(...batch);
      if (batch.length < perPage) break;
      page += 1;
    }
    return results;
  }

  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const response = await this.fetchImpl(this.graphqlUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': this.userAgent,
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ query, variables }),
    });
    this.captureRateLimit(response.headers, 'graphql');
    const text = await response.text();
    if (!response.ok) {
      const remaining = response.headers.get('x-ratelimit-remaining');
      if (response.status === 403 && remaining === '0') {
        const resetAt = new Date(Number(response.headers.get('x-ratelimit-reset') ?? 0) * 1000);
        throw new GitHubRateLimitError('GitHub graphql rate limit reached', resetAt, 'graphql');
      }
      throw new GitHubError(`graphql ${response.status}: ${redact(text).slice(0, 400)}`, response.status, response.status >= 500);
    }
    const payload = JSON.parse(text) as { data?: T; errors?: Array<{ message: string }> };
    if (payload.errors && payload.errors.length > 0) {
      throw new GitHubError(
        `graphql errors: ${payload.errors.map((error) => error.message).join('; ').slice(0, 400)}`,
        200,
        false,
      );
    }
    return payload.data as T;
  }

  /** Count a collection without paging through it, using the Link header. */
  async countByLink(path: string, query?: RequestOptions['query']): Promise<number | null> {
    const url = new URL(this.buildUrl(path, { ...(query ?? {}), per_page: 1 }));
    url.searchParams.set('per_page', '1');
    const response = await this.fetchImpl(url.toString(), {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': this.userAgent,
        authorization: `Bearer ${this.token}`,
      },
    });
    this.captureRateLimit(response.headers);
    if (response.status === 404) return null;
    if (!response.ok) return null;
    await response.text();
    const link = response.headers.get('link');
    if (!link) {
      // No Link header means zero or one page of results.
      return null;
    }
    const last = link.match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/);
    if (last?.[1]) return Number(last[1]);
    return null;
  }

  /** Who does this token belong to? Used to decide fork ownership. */
  async viewer(): Promise<{ login: string; name: string | null }> {
    const data = await this.request<{ login: string; name: string | null }>('/user');
    return { login: data.login, name: data.name };
  }

  // -------------------------------------------------------------------------
  // Write operations used by the approval-gated publish workflow.
  //
  // Nothing in this section is called by discovery, investigation, or
  // implementation. The only caller is `publishContribution`, which requires a
  // human approval bound to the exact artifact hash before it runs.
  // -------------------------------------------------------------------------

  async getRepository(fullName: string): Promise<GitHubRepository | null> {
    const [owner, repo] = splitFullName(fullName);
    try {
      return await this.request<GitHubRepository>(`/repos/${owner}/${repo}`);
    } catch (error) {
      if (error instanceof GitHubNotFoundError) return null;
      throw error;
    }
  }

  /**
   * Create the fork if it does not exist and wait until GitHub serves it.
   * Fork creation is asynchronous: the API returns 202 before the repository
   * is cloneable or pushable, so callers poll rather than assuming success.
   */
  async ensureFork(
    fullName: string,
    forkOwner: string,
    options: { organization?: string; timeoutMs?: number; pollMs?: number } = {},
  ): Promise<GitHubRepository> {
    const [, repo] = splitFullName(fullName);
    const target = `${forkOwner}/${repo}`;
    const existing = await this.getRepository(target);
    if (existing) return existing;

    const [owner, sourceRepo] = splitFullName(fullName);
    await this.request(`/repos/${owner}/${sourceRepo}/forks`, {
      method: 'POST',
      body: options.organization ? { organization: options.organization } : {},
      maxAttempts: 2,
    });

    const timeoutMs = options.timeoutMs ?? 120_000;
    const pollMs = options.pollMs ?? 5_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const fork = await this.getRepository(target);
      if (fork) return fork;
      await sleep(pollMs);
    }
    throw new GitHubError(`fork ${target} was not ready after ${timeoutMs}ms`, 0, true);
  }

  async findPullRequest(args: {
    owner: string;
    repo: string;
    head: string;
    base: string;
  }): Promise<GitHubPullRequest | null> {
    const pulls = await this.request<GitHubPullRequest[]>(
      `/repos/${args.owner}/${args.repo}/pulls`,
      {
        query: { state: 'open', head: args.head, base: args.base },
        noCache: true,
      },
    );
    return pulls[0] ?? null;
  }

  /**
   * Open a pull request. A 422 "already exists" response is resolved by
   * returning the existing open PR, which makes a retry after a crash safe.
   */
  async createPullRequest(args: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    head: string;
    base: string;
    draft?: boolean;
  }): Promise<GitHubPullRequest> {
    try {
      return await this.request<GitHubPullRequest>(`/repos/${args.owner}/${args.repo}/pulls`, {
        method: 'POST',
        body: {
          title: args.title,
          body: args.body,
          head: args.head,
          base: args.base,
          draft: args.draft ?? false,
        },
        maxAttempts: 2,
      });
    } catch (error) {
      if (error instanceof GitHubError && error.status === 422) {
        const existing = await this.findPullRequest({
          owner: args.owner,
          repo: args.repo,
          head: args.head,
          base: args.base,
        });
        if (existing) return existing;
      }
      throw error;
    }
  }

  /** Head commit of a branch, or null when the branch does not exist. */
  async branchHead(fullName: string, branch: string): Promise<string | null> {
    const [owner, repo] = splitFullName(fullName);
    try {
      const ref = await this.request<{ object: { sha: string } }>(
        `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
        { noCache: true },
      );
      return ref.object.sha;
    } catch (error) {
      if (error instanceof GitHubNotFoundError) return null;
      throw error;
    }
  }

  async createIssueComment(args: {
    owner: string;
    repo: string;
    issueNumber: number;
    body: string;
  }): Promise<{ id: number; html_url: string }> {
    return this.request<{ id: number; html_url: string }>(
      `/repos/${args.owner}/${args.repo}/issues/${args.issueNumber}/comments`,
      { method: 'POST', body: { body: args.body }, maxAttempts: 2 },
    );
  }

  async rateLimitStatus(): Promise<Record<string, { limit: number; remaining: number; resetAt: string }>> {
    const data = await this.request<{
      resources: Record<string, { limit: number; remaining: number; reset: number }>;
    }>('/rate_limit', { noCache: true });
    return Object.fromEntries(
      Object.entries(data.resources).map(([key, value]) => [
        key,
        { limit: value.limit, remaining: value.remaining, resetAt: new Date(value.reset * 1000).toISOString() },
      ]),
    );
  }
}

/** Redact-and-truncate helper used by callers that store GitHub text. */
export function safeExcerpt(text: string, maxBytes = 2000): string {
  return truncateBytes(redact(text), maxBytes).text;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitFullName(fullName: string): [string, string] {
  const parts = fullName.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`invalid repository name: ${fullName}`);
  }
  return [parts[0], parts[1]];
}

import type { GitHubClient } from './client';
import { boundText } from '@/llm/context';
import type { IssueSummary, PullSummary, RepoRef } from './repo';

export interface SearchRepoResult {
  githubId: number;
  fullName: string;
  owner: string;
  name: string;
  description: string | null;
  language: string | null;
  license: string | null;
  stars: number;
  forks: number;
  openIssues: number;
  sizeKb: number;
  createdAt: Date;
  pushedAt: Date;
  archived: boolean;
  fork: boolean;
  topics: string[];
  hasIssues: boolean;
  defaultBranch: string;
}

interface SearchRepoApiItem {
  id: number;
  full_name: string;
  owner: { login: string };
  name: string;
  description: string | null;
  language: string | null;
  license: { spdx_id?: string | null; name?: string } | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  size: number;
  created_at: string;
  pushed_at: string;
  archived: boolean;
  fork: boolean;
  topics?: string[];
  has_issues: boolean;
  default_branch: string;
}

/**
 * Discovery query packs.
 *
 * Queries are parameterised by the current date and by the configured floors so
 * the same run is reproducible, and they are written to surface *both* kinds of
 * project the specification asks for: young repositories that are gaining
 * attention, and mature ones that are actively maintained.
 */
export interface QueryPack {
  name: string;
  purpose: string;
  /** How the API should order results; affects which slice of the pack we see. */
  sort: 'stars' | 'updated';
  build: (ctx: { today: string; thirtyDaysAgo: string; yearAgo: string }) => string[];
}

export const QUERY_PACKS: QueryPack[] = [
  {
    name: 'emerging',
    purpose: 'Projects created in the last year that are growing and still changing quickly.',
    sort: 'updated',
    build: ({ yearAgo, thirtyDaysAgo }) => [
      `created:>${yearAgo} stars:>=150 pushed:>${thirtyDaysAgo} archived:false fork:false`,
      `created:>${yearAgo} stars:>=400 pushed:>${thirtyDaysAgo} archived:false fork:false language:TypeScript`,
      `created:>${yearAgo} stars:>=400 pushed:>${thirtyDaysAgo} archived:false fork:false language:Python`,
      `created:>${yearAgo} stars:>=200 pushed:>${thirtyDaysAgo} archived:false fork:false language:Go`,
      `created:>${yearAgo} stars:>=200 pushed:>${thirtyDaysAgo} archived:false fork:false language:Rust`,
      `created:>${yearAgo} stars:>=300 pushed:>${thirtyDaysAgo} archived:false fork:false topic:developer-tools`,
      `created:>${yearAgo} stars:>=300 pushed:>${thirtyDaysAgo} archived:false fork:false topic:cli`,
    ],
  },
  {
    name: 'established',
    purpose: 'Mature, actively maintained projects with open bug reports and steady activity.',
    sort: 'stars',
    build: ({ thirtyDaysAgo, today }) => [
      `stars:>=3000 pushed:>=${thirtyDaysAgo} archived:false fork:false good-first-issue:>=1`,
      `stars:>=2000 pushed:>=${thirtyDaysAgo} archived:false fork:false help-wanted:>=1 language:TypeScript`,
      `stars:>=2000 pushed:>=${thirtyDaysAgo} archived:false fork:false help-wanted:>=1 language:Python`,
      `stars:>=1500 pushed:>=${thirtyDaysAgo} archived:false fork:false help-wanted:>=1 language:Go`,
      `stars:>=1500 pushed:>=${thirtyDaysAgo} archived:false fork:false help-wanted:>=1 language:Rust`,
      `stars:>=1000 pushed:>=${thirtyDaysAgo} archived:false fork:false topic:testing created:<${today.slice(0, 4)}-01-01`,
    ],
  },
];

export interface SearchOptions {
  sort?: 'stars' | 'updated' | 'best-match';
  order?: 'desc' | 'asc';
  perPage?: number;
  maxPages?: number;
}

export function repoSearchQuery(
  params: Partial<{ pushed: string; language: string; topic: string; text: string }> = {},
): string {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}:${value}`)
    .join(' ');
}

export async function searchRepositories(
  client: GitHubClient,
  query: string,
  options: SearchOptions = {},
): Promise<SearchRepoResult[]> {
  const sort = options.sort ?? 'stars';
  const perPage = options.perPage ?? 50;
  const maxPages = options.maxPages ?? 2;
  const items: SearchRepoApiItem[] = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const data = await client.request<{ total_count: number; items: SearchRepoApiItem[] }>(
      '/search/repositories',
      {
        query: {
          q: query,
          sort,
          order: options.order ?? 'desc',
          per_page: perPage,
          page,
        },
        // Search results are volatile; caching them hides growth deltas.
        noCache: true,
      },
    );
    const batch = Array.isArray(data.items) ? data.items : [];
    items.push(...batch);
    if (batch.length < perPage) break;
  }

  return items.map((item) => ({
    githubId: item.id,
    fullName: item.full_name,
    owner: item.owner.login,
    name: item.name,
    description: item.description,
    language: item.language,
    license:
      item.license?.spdx_id && item.license.spdx_id !== 'NOASSERTION'
        ? item.license.spdx_id
        : (item.license?.name ?? null),
    stars: item.stargazers_count,
    forks: item.forks_count,
    openIssues: item.open_issues_count,
    sizeKb: item.size,
    createdAt: new Date(item.created_at),
    pushedAt: new Date(item.pushed_at),
    archived: item.archived,
    fork: item.fork,
    topics: item.topics ?? [],
    hasIssues: item.has_issues,
    defaultBranch: item.default_branch,
  }));
}

export interface SearchIssueItem {
  number: number;
  title: string;
  bodyExcerpt: string;
  state: string;
  url: string;
  isPullRequest: boolean;
  updatedAt: Date;
  createdAt: Date;
  comments: number;
  labels: string[];
  authorLogin: string | null;
  authorAssociation: string | null;
  repoFullName: string;
  pullRequestMergedAt: Date | null;
}

interface SearchIssueApiItem {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  comments: number;
  labels: Array<{ name: string } | string>;
  user: { login: string } | null;
  author_association: string | null;
  repository_url: string;
  pull_request?: { merged_at?: string | null };
}

/** Search issues and pull requests across a repository (or globally). */
export async function searchIssues(
  client: GitHubClient,
  query: string,
  options: SearchOptions & { sort?: 'updated' | 'created' | 'comments' | 'best-match' } = {},
): Promise<SearchIssueItem[]> {
  const perPage = options.perPage ?? 30;
  const maxPages = options.maxPages ?? 1;
  const collected: SearchIssueApiItem[] = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const data = await client.request<{ total_count: number; items: SearchIssueApiItem[] }>(
      '/search/issues', {
      query: { q: query, sort: options.sort ?? 'updated', order: 'desc', per_page: perPage, page },
      noCache: true,
    });
    const batch = Array.isArray(data.items) ? data.items : [];
    collected.push(...batch);
    if (batch.length < perPage) break;
  }

  return collected.map((item) => ({
    number: item.number,
    title: item.title,
    bodyExcerpt: boundText(item.body ?? '', 1500).text,
    state: item.state,
    url: item.html_url,
    isPullRequest: item.pull_request !== undefined,
    createdAt: new Date(item.created_at),
    updatedAt: new Date(item.updated_at),
    comments: item.comments,
    labels: (item.labels ?? []).map((label) => (typeof label === 'string' ? label : label.name)),
    authorLogin: item.user?.login ?? null,
    authorAssociation: item.author_association ?? null,
    repoFullName: item.repository_url.replace('https://api.github.com/repos/', ''),
    pullRequestMergedAt: item.pull_request?.merged_at ? new Date(item.pull_request.merged_at) : null,
  }));
}

/**
 * Repository-scoped search used by the duplicate agent. Keywords are derived
 * from the hypothesis text by the caller; this function never invents them.
 */
export function issueSearchQuery(
  repoFullName: string,
  keywords: string[],
  extra: { inTitle?: boolean; state?: 'open' | 'closed' } = {},
): string {
  const terms = keywords
    .map((keyword) => keyword.replace(/["':]/g, ' ').trim())
    .filter((keyword) => keyword.length >= 3)
    .slice(0, 6)
    .map((keyword) => (extra.inTitle ? `${keyword} in:title` : keyword));
  const parts = [`repo:${repoFullName}`, ...terms];
  if (extra.state) parts.push(`state:${extra.state}`);
  return parts.join(' ');
}

export interface HistoryBundle {
  openIssues: IssueSummary[];
  closedIssues: IssueSummary[];
  openPullRequests: PullSummary[];
  closedPullRequests: PullSummary[];
  relatedSearchResults: SearchIssueItem[];
}

export function toRepoRef(fullName: string): RepoRef {
  const [owner, name] = fullName.split('/');
  if (!owner || !name) throw new Error(`invalid repository: ${fullName}`);
  return { owner, name, fullName };
}

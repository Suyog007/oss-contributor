import { GitHubClient, GitHubNotFoundError } from './client';
import { boundText } from '@/llm/context';
import { loadEnv } from '@/config/env';

export interface RepoRef {
  owner: string;
  name: string;
  fullName: string;
}

export interface RepoMetadata {
  githubId: number;
  fullName: string;
  owner: string;
  name: string;
  defaultBranch: string;
  description: string | null;
  topics: string[];
  language: string | null;
  license: string | null;
  isFork: boolean;
  archived: boolean;
  sizeKb: number;
  stars: number;
  forks: number;
  watchers: number;
  openIssues: number;
  createdAt: Date;
  pushedAt: Date;
  hasIssues: boolean;
  canPush: boolean;
}

export interface TreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  size: number;
  sha: string;
}

export interface CommitSummary {
  sha: string;
  message: string;
  authorLogin: string | null;
  date: Date;
}

export interface ReleaseSummary {
  tag: string;
  name: string;
  publishedAt: Date;
  bodyExcerpt: string;
}

export interface IssueSummary {
  number: number;
  title: string;
  bodyExcerpt: string;
  labels: string[];
  state: string;
  authorLogin: string | null;
  /** Logins currently assigned. Assigned issues are rarely open for a newcomer. */
  assignees: string[];
  comments: number;
  createdAt: Date;
  updatedAt: Date;
  url: string;
}

export interface PullSummary {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  mergedAt: Date | null;
  authorLogin: string | null;
  createdAt: Date;
  updatedAt: Date;
  url: string;
  bodyExcerpt: string;
}

interface RepoApiResponse {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string };
  default_branch: string;
  description: string | null;
  topics?: string[];
  language: string | null;
  license: { spdx_id?: string | null; name?: string } | null;
  fork: boolean;
  archived: boolean;
  size: number;
  stargazers_count: number;
  forks_count: number;
  subscribers_count?: number;
  open_issues_count: number;
  created_at: string;
  pushed_at: string;
  has_issues: boolean;
  permissions?: { push?: boolean };
}

export function splitFullName(fullName: string): RepoRef {
  const [owner, name] = fullName.split('/');
  if (!owner || !name) throw new Error(`invalid repository name: ${fullName}`);
  return { owner, name, fullName };
}

export async function fetchRepoMetadata(client: GitHubClient, ref: RepoRef): Promise<RepoMetadata> {
  const data = await client.request<RepoApiResponse>(`/repos/${ref.fullName}`);
  return {
    githubId: data.id,
    fullName: data.full_name,
    owner: data.owner.login,
    name: data.name,
    defaultBranch: data.default_branch,
    description: data.description,
    topics: data.topics ?? [],
    language: data.language,
    license: data.license?.spdx_id && data.license.spdx_id !== 'NOASSERTION' ? data.license.spdx_id : (data.license?.name ?? null),
    isFork: data.fork,
    archived: data.archived,
    sizeKb: data.size,
    stars: data.stargazers_count,
    forks: data.forks_count,
    watchers: data.subscribers_count ?? 0,
    openIssues: data.open_issues_count,
    createdAt: new Date(data.created_at),
    pushedAt: new Date(data.pushed_at),
    hasIssues: data.has_issues,
    canPush: data.permissions?.push ?? false,
  };
}

export async function resolveHeadSha(
  client: GitHubClient,
  ref: RepoRef,
  branch = 'HEAD',
): Promise<string> {
  const encoded = encodeURIComponent(branch);
  const data = await client.request<{ object?: { sha: string }; sha?: string }>(
    `/repos/${ref.fullName}/git/ref/heads/${encoded}`,
  );
  const sha = data.object?.sha ?? data.sha;
  if (!sha) throw new Error(`could not resolve head sha for ${ref.fullName} (${branch})`);
  return sha;
}

export async function fetchTree(
  client: GitHubClient,
  ref: RepoRef,
  sha: string,
): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
  const data = await client.request<{
    sha: string;
    truncated: boolean;
    tree: Array<{ path: string; type: string; size?: number; sha: string }>;
  }>(`/repos/${ref.fullName}/git/trees/${sha}`, { query: { recursive: true } });
  return {
    truncated: data.truncated,
    entries: data.tree
      .filter((entry) => entry.type === 'blob' || entry.type === 'tree')
      .map((entry) => ({
        path: entry.path,
        type: entry.type as TreeEntry['type'],
        size: entry.size ?? 0,
        sha: entry.sha,
      })),
  };
}

const MAX_FILE_BYTES = 200_000;

export async function fetchFileText(
  client: GitHubClient,
  ref: RepoRef,
  path: string,
  sha?: string,
): Promise<string | null> {
  try {
    const text = await client.request<string>(
      `/repos/${ref.fullName}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
      {
        accept: 'application/vnd.github.raw',
        raw: true,
        ...(sha ? { query: { ref: sha } } : {}),
      },
    );
    if (typeof text !== 'string') return null;
    return boundText(text, MAX_FILE_BYTES).text;
  } catch (error) {
    if (error instanceof GitHubNotFoundError) return null;
    throw error;
  }
}

export async function fetchCommits(
  client: GitHubClient,
  ref: RepoRef,
  options: { sinceDays?: number; limit?: number; sha?: string } = {},
): Promise<CommitSummary[]> {
  const query: Record<string, string | number> = { per_page: options.limit ?? 50 };
  if (options.sinceDays) {
    query['since'] = new Date(Date.now() - options.sinceDays * 86_400_000).toISOString();
  }
  if (options.sha) query['sha'] = options.sha;
  const data = await client.request<
    Array<{
      sha: string;
      commit: { message: string; author: { date: string } | null };
      author: { login: string } | null;
    }>
  >(`/repos/${ref.fullName}/commits`, { query });
  return (Array.isArray(data) ? data : []).map((item) => ({
    sha: item.sha,
    message: item.commit.message.split('\n')[0] ?? '',
    authorLogin: item.author?.login ?? null,
    date: new Date(item.commit.author?.date ?? Date.now()),
  }));
}

export async function fetchReleases(client: GitHubClient, ref: RepoRef, limit = 5): Promise<ReleaseSummary[]> {
  const data = await client.request<
    Array<{ tag_name: string; name: string | null; published_at: string | null; body: string | null }>
  >(`/repos/${ref.fullName}/releases`, { query: { per_page: limit } });
  return (Array.isArray(data) ? data : []).map((release) => ({
    tag: release.tag_name,
    name: release.name ?? release.tag_name,
    publishedAt: new Date(release.published_at ?? Date.now()),
    bodyExcerpt: boundText(release.body ?? '', 800).text,
  }));
}

interface IssueApiResponse {
  number: number;
  title: string;
  body: string | null;
  labels: Array<{ name: string } | string>;
  state: string;
  user: { login: string } | null;
  assignees?: Array<{ login: string }> | null;
  comments: number;
  created_at: string;
  updated_at: string;
  html_url: string;
  pull_request?: unknown;
}

function toIssueSummary(issue: IssueApiResponse): IssueSummary {
  return {
    number: issue.number,
    title: issue.title,
    bodyExcerpt: boundText(issue.body ?? '', 1200).text,
    labels: (issue.labels ?? []).map((label) => (typeof label === 'string' ? label : label.name)),
    state: issue.state,
    authorLogin: issue.user?.login ?? null,
    assignees: (issue.assignees ?? []).map((assignee) => assignee.login),
    comments: issue.comments,
    createdAt: new Date(issue.created_at),
    updatedAt: new Date(issue.updated_at),
    url: issue.html_url,
  };
}

/** Open issues only, excluding pull requests (GitHub's issues endpoint includes them). */
export async function fetchIssues(
  client: GitHubClient,
  ref: RepoRef,
  options: { state?: 'open' | 'closed' | 'all'; limit?: number; sort?: 'updated' | 'created' | 'comments' } = {},
): Promise<IssueSummary[]> {
  const data = await client.request<IssueApiResponse[]>(`/repos/${ref.fullName}/issues`, {
    query: {
      state: options.state ?? 'open',
      per_page: options.limit ?? 50,
      sort: options.sort ?? 'updated',
      direction: 'desc',
    },
  });
  return (Array.isArray(data) ? data : [])
    .filter((issue) => issue.pull_request === undefined)
    .map(toIssueSummary);
}

export async function fetchIssue(
  client: GitHubClient,
  ref: RepoRef,
  number: number,
): Promise<IssueSummary | null> {
  try {
    const data = await client.request<IssueApiResponse>(`/repos/${ref.fullName}/issues/${number}`);
    return toIssueSummary(data);
  } catch (error) {
    if (error instanceof GitHubNotFoundError) return null;
    throw error;
  }
}

export interface CommentSummary {
  id: number;
  authorLogin: string | null;
  authorAssociation: string | null;
  body: string;
  createdAt: Date;
  url: string | null;
}

export async function fetchIssueComments(
  client: GitHubClient,
  ref: RepoRef,
  number: number,
  limit = 50,
): Promise<CommentSummary[]> {
  const data = await client.request<
    Array<{
      id: number;
      user: { login: string } | null;
      author_association: string | null;
      body: string;
      created_at: string;
      html_url: string | null;
    }>
  >(`/repos/${ref.fullName}/issues/${number}/comments`, { query: { per_page: limit } });
  return (Array.isArray(data) ? data : []).map((comment) => ({
    id: comment.id,
    authorLogin: comment.user?.login ?? null,
    authorAssociation: comment.author_association ?? null,
    body: boundText(comment.body ?? '', 4000).text,
    createdAt: new Date(comment.created_at),
    url: comment.html_url,
  }));
}

export async function fetchPullRequests(
  client: GitHubClient,
  ref: RepoRef,
  options: { state?: 'open' | 'closed' | 'all'; limit?: number } = {},
): Promise<PullSummary[]> {
  const data = await client.request<
    Array<{
      number: number;
      title: string;
      body: string | null;
      state: string;
      draft: boolean;
      merged_at: string | null;
      user: { login: string } | null;
      created_at: string;
      updated_at: string;
      html_url: string;
    }>
  >(`/repos/${ref.fullName}/pulls`, {
    query: {
      state: options.state ?? 'open',
      per_page: options.limit ?? 30,
      sort: 'updated',
      direction: 'desc',
    },
  });
  return (Array.isArray(data) ? data : []).map((pr) => ({
    number: pr.number,
    title: pr.title,
    state: pr.state,
    draft: pr.draft,
    mergedAt: pr.merged_at ? new Date(pr.merged_at) : null,
    authorLogin: pr.user?.login ?? null,
    createdAt: new Date(pr.created_at),
    updatedAt: new Date(pr.updated_at),
    url: pr.html_url,
    bodyExcerpt: boundText(pr.body ?? '', 800).text,
  }));
}

function toDigestIssue(issue: IssueSummary): DigestIssue {
  return {
    number: issue.number,
    title: issue.title,
    bodyExcerpt: issue.bodyExcerpt,
    labels: issue.labels,
    state: issue.state,
    authorLogin: issue.authorLogin,
    assignees: issue.assignees,
    comments: issue.comments,
    createdAt: issue.createdAt.toISOString(),
    updatedAt: issue.updatedAt.toISOString(),
    url: issue.url,
  };
}

function toDigestPull(pr: PullSummary): DigestPull {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    draft: pr.draft,
    mergedAt: pr.mergedAt ? pr.mergedAt.toISOString() : null,
    authorLogin: pr.authorLogin,
    createdAt: pr.createdAt.toISOString(),
    updatedAt: pr.updatedAt.toISOString(),
    url: pr.url,
    bodyExcerpt: pr.bodyExcerpt,
  };
}

/** Raw file -> text map for the files we deliberately read. */
export interface FetchedFile {
  path: string;
  bytes: number;
  why: FileReason;
  text: string;
}

export type FileReason =
  | 'readme'
  | 'contributing'
  | 'code_of_conduct'
  | 'security'
  | 'license'
  | 'pr_template'
  | 'issue_template'
  | 'manifest'
  | 'ci'
  | 'test_config'
  | 'docs'
  | 'source_sample'
  | 'changelog';

/**
 * Issue and pull request shapes as they are stored in the digest. Dates are
 * ISO strings because the digest round-trips through a JSON column.
 */
export interface DigestIssue {
  number: number;
  title: string;
  bodyExcerpt: string;
  labels: string[];
  state: string;
  authorLogin: string | null;
  assignees: string[];
  comments: number;
  createdAt: string;
  updatedAt: string;
  url: string;
}

export interface DigestPull {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  mergedAt: string | null;
  authorLogin: string | null;
  createdAt: string;
  updatedAt: string;
  url: string;
  bodyExcerpt: string;
}

/**
 * Bumped whenever the digest shape changes. Cached digests with an older
 * version are rebuilt instead of being trusted, which keeps a shape change from
 * silently breaking every downstream agent.
 */
export const DIGEST_VERSION = 2;

export interface RepoDigest {
  digestVersion: number;
  repo: {
    fullName: string;
    description: string | null;
    topics: string[];
    language: string | null;
    license: string | null;
    stars: number;
    forks: number;
    watchers: number;
    openIssues: number;
    sizeKb: number;
    createdAt: string;
    pushedAt: string;
    defaultBranch: string;
    archived: boolean;
  };
  headSha: string;
  tree: {
    totalFiles: number;
    truncated: boolean;
    byExtension: Record<string, number>;
    topLevelDirectories: string[];
    testFiles: string[];
    testDirectories: string[];
    ciWorkflows: string[];
    manifests: string[];
    docs: string[];
    hasDockerfile: boolean;
    hasMakefile: boolean;
  };
  files: FetchedFile[];
  commits: Array<{ sha: string; subject: string; author: string | null; date: string }>;
  commitConventions: {
    sampleSubjects: string[];
    conventionalCommits: boolean;
    referencesIssues: boolean;
    dominantPrefix: string | null;
  };
  releases: Array<{ tag: string; name: string; publishedAt: string; bodyExcerpt: string }>;
  issues: DigestIssue[];
  pullRequests: DigestPull[];
  recentMergedPullRequests: DigestPull[];
  derivedTestCommands: string[];
  notes: string[];
}

const MANIFEST_NAMES = new Set([
  'package.json',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'requirements.txt',
  'requirements-dev.txt',
  'cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'gemfile',
  'composer.json',
  'cmakelists.txt',
  'makefile',
  'dockerfile',
  'deno.json',
  'bun.lockb',
  'mix.exs',
  'pubspec.yaml',
  'build.sbt',
]);

const TEST_CONFIG_NAMES = [
  /(^|\/)vitest\.config\.(ts|js|mts|mjs)$/,
  /(^|\/)jest\.config\.(ts|js|mjs|cjs|json)$/,
  /(^|\/)pytest\.ini$/,
  /(^|\/)tox\.ini$/,
  /(^|\/)phpunit\.xml(\.dist)?$/,
  /(^|\/)\.mocharc\.(json|js|cjs|yml)$/,
  /(^|\/)karma\.conf\.js$/,
  /(^|\/)playwright\.config\.(ts|js)$/,
  /(^|\/)cypress\.config\.(ts|js)$/,
  /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/,
];

const DOC_EXTS = new Set(['.md', '.mdx', '.rst', '.txt']);

const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tgz', '.jar', '.woff',
  '.woff2', '.ttf', '.eot', '.mp4', '.mov', '.webm', '.so', '.dylib', '.dll', '.exe', '.pyc', '.bin',
  '.lock', '.min.js', '.min.css',
]);

export function extensionOf(path: string): string {
  const base = path.split('/').pop() ?? path;
  const index = base.lastIndexOf('.');
  if (index <= 0) return '';
  return base.slice(index).toLowerCase();
}

export const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt', '.kts', '.rb',
  '.php', '.cs', '.c', '.h', '.cc', '.cpp', '.hpp', '.swift', '.scala', '.sh', '.bash', '.lua',
  '.ex', '.exs', '.erl', '.hs', '.ml', '.dart', '.vue', '.svelte', '.sql', '.proto',
]);

function isProbablyBinary(path: string): boolean {
  const ext = extensionOf(path);
  if (BINARY_EXTS.has(ext)) return true;
  return path.endsWith('.min.js') || path.endsWith('.min.css');
}

function isTestPath(path: string): boolean {
  const lower = path.toLowerCase();
  if (/(^|\/)(tests?|__tests__|spec|specs|e2e|integration-tests)\//.test(lower)) return true;
  if (/\.(test|spec)\.[a-z0-9]+$/.test(lower)) return true;
  if (/(^|\/)test_[^/]+\.py$/.test(lower)) return true;
  if (/_test\.go$/.test(lower)) return true;
  return false;
}

/**
 * Choose which files to read. Selection is deterministic and bounded so the
 * same repository always produces the same digest, and so a huge repository
 * costs the same as a small one.
 */
export function selectFilesToRead(entries: TreeEntry[], maxSourceSamples = 14): Array<{ path: string; why: FileReason }> {
  const files = entries.filter((entry) => entry.type === 'blob');
  const selected: Array<{ path: string; why: FileReason }> = [];
  const seen = new Set<string>();

  const push = (path: string, why: FileReason) => {
    if (seen.has(path)) return;
    seen.add(path);
    selected.push({ path, why });
  };

  const byPriority: Array<{ test: (path: string, lower: string) => boolean; why: FileReason }> = [
    { test: (_p, lower) => /^readme(\.[a-z]+)?$/.test(lower) || lower === 'readme.md', why: 'readme' },
    { test: (_p, lower) => /^docs?\/readme(\.[a-z]+)?$/.test(lower), why: 'readme' },
    { test: (_p, lower) => lower.startsWith('contributing') || lower === '.github/contributing.md' || lower === 'docs/contributing.md', why: 'contributing' },
    { test: (_p, lower) => lower.startsWith('code_of_conduct'), why: 'code_of_conduct' },
    { test: (_p, lower) => lower.startsWith('security.md') || lower === '.github/security.md', why: 'security' },
    { test: (_p, lower) => lower.startsWith('license'), why: 'license' },
    { test: (_p, lower) => lower.startsWith('changelog') || lower.startsWith('changes.md') || lower === 'history.md', why: 'changelog' },
    { test: (_p, lower) => lower.startsWith('.github/pull_request_template'), why: 'pr_template' },
    { test: (_p, lower) => lower.startsWith('.github/issue_template'), why: 'issue_template' },
  ];

  for (const { test, why } of byPriority) {
    const match = files
      .filter((entry) => test(entry.path, entry.path.toLowerCase()))
      .sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path))[0];
    if (match) push(match.path, why);
  }

  // Manifests anywhere in the tree, shallowest first.
  const manifests = files
    .filter((entry) => MANIFEST_NAMES.has((entry.path.split('/').pop() ?? '').toLowerCase()))
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path))
    .slice(0, 6);
  for (const manifest of manifests) push(manifest.path, 'manifest');

  // CI workflows: at most three, smallest first (usually the informative ones).
  const workflows = files
    .filter((entry) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(entry.path))
    .sort((a, b) => a.size - b.size || a.path.localeCompare(b.path))
    .slice(0, 3);
  for (const workflow of workflows) push(workflow.path, 'ci');

  const testConfigs = files
    .filter((entry) => TEST_CONFIG_NAMES.some((pattern) => pattern.test(entry.path)))
    .filter((entry) => !entry.path.startsWith('.github/workflows/'))
    .slice(0, 3);
  for (const config of testConfigs) push(config.path, 'test_config');

  // Documentation, shallowest first.
  const docs = files
    .filter(
      (entry) =>
        DOC_EXTS.has(extensionOf(entry.path)) &&
        !seen.has(entry.path) &&
        entry.size < 60_000 &&
        (entry.path.startsWith('docs/') || entry.path.split('/').length <= 2),
    )
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path))
    .slice(0, 6);
  for (const doc of docs) push(doc.path, 'docs');

  // Source samples spread across top-level directories so architecture is visible.
  const sources = files
    .filter((entry) => !seen.has(entry.path))
    .filter((entry) => !isProbablyBinary(entry.path))
    .filter((entry) => !isTestPath(entry.path))
    .filter((entry) => CODE_EXTENSIONS.has(extensionOf(entry.path)))
    .filter((entry) => entry.size > 200 && entry.size < 80_000);
  const byTopLevel = new Map<string, TreeEntry[]>();
  for (const source of sources) {
    const top = source.path.split('/')[0] ?? '';
    const list = byTopLevel.get(top) ?? [];
    list.push(source);
    byTopLevel.set(top, list);
  }
  const rankedSources = [...byTopLevel.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .flatMap(([, list]) =>
      list
        .sort((a, b) => importanceScore(b.path) - importanceScore(a.path) || a.path.localeCompare(b.path))
        .slice(0, 2),
    )
    .slice(0, maxSourceSamples);
  for (const source of rankedSources) push(source.path, 'source_sample');

  return selected;
}

function importanceScore(path: string): number {
  const base = (path.split('/').pop() ?? '').toLowerCase();
  let score = 0;
  if (/^(index|main|app|server|client|core|cli|lib|agent|worker)\./.test(base)) score += 5;
  if (path.split('/').length <= 3) score += 2;
  if (/\.(ts|js|py|go|rs|java|rb|php|cs|c|cpp|swift|kt)$/.test(base)) score += 2;
  if (base.includes('test')) score -= 5;
  return score;
}

export function deriveTestCommands(files: FetchedFile[]): string[] {
  const commands = new Set<string>();
  const byPath = new Map(files.map((file) => [file.path, file.text]));

  for (const [path, text] of byPath) {
    const lower = path.toLowerCase();
    if (lower.endsWith('package.json')) {
      try {
        const pkg = JSON.parse(text) as {
          scripts?: Record<string, string>;
          packageManager?: string;
        };
        const scripts = pkg.scripts ?? {};
        const pm = pkg.packageManager?.split('@')[0] ?? 'npm';
        const run = pm === 'npm' ? 'npm run' : `${pm} run`;
        for (const name of ['test', 'test:unit', 'lint', 'typecheck', 'type-check', 'build']) {
          if (scripts[name]) commands.add(name === 'test' ? `${pm} test` : `${run} ${name}`);
        }
      } catch {
        // Ignore malformed manifests; the agent can still read them.
      }
    }
    if (lower.endsWith('pyproject.toml') || lower.endsWith('pytest.ini') || lower.endsWith('tox.ini')) {
      if (/pytest/.test(text)) commands.add('pytest -q');
    }
    if (lower.endsWith('cargo.toml')) {
      commands.add('cargo test');
    }
    if (lower.endsWith('go.mod')) {
      commands.add('go test ./...');
    }
    if (lower.endsWith('makefile')) {
      if (/^test:/m.test(text)) commands.add('make test');
      if (/^lint:/m.test(text)) commands.add('make lint');
    }
    if (lower.endsWith('pom.xml')) {
      commands.add('mvn -q test');
    }
    if (lower.endsWith('gradle') || lower.endsWith('gradle.kts')) {
      commands.add('./gradlew test');
    }
    if (lower.endsWith('gemfile')) {
      commands.add('bundle exec rspec');
    }
  }

  // CI workflow `run:` steps are the most reliable statement of what the
  // project actually runs on a pull request.
  for (const [, text] of byPath) {
    if (!/^(on|true):|jobs:/m.test(text)) continue;
    for (const match of text.matchAll(/^\s*run:\s*(.+)$/gm)) {
      const command = match[1]?.trim().replace(/^['"]|['"]$/g, '');
      if (!command) continue;
      if (/\|\s*$/.test(command)) continue;
      if (/(npm|pnpm|yarn|pytest|cargo|go test|make|mvn|gradle|bundle|dotnet|composer|mix|swift)/.test(command)) {
        commands.add(command.slice(0, 200));
      }
    }
  }

  return [...commands].slice(0, 12);
}

export function analyzeCommitConventions(commits: CommitSummary[]): RepoDigest['commitConventions'] {
  const subjects = commits.map((commit) => commit.message).filter((subject) => subject.length > 0);
  const conventional = subjects.filter((subject) => /^(feat|fix|chore|docs|test|refactor|perf|build|ci|style|revert)(\(.+\))?!?:/.test(subject));
  const prefixes = new Map<string, number>();
  for (const subject of subjects) {
    const match = subject.match(/^([a-z]+)(\(.+\))?!?:/);
    if (match?.[1]) prefixes.set(match[1], (prefixes.get(match[1]) ?? 0) + 1);
  }
  const dominant = [...prefixes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return {
    sampleSubjects: subjects.slice(0, 20),
    conventionalCommits: subjects.length > 0 && conventional.length / subjects.length >= 0.4,
    referencesIssues: subjects.some((subject) => /#\d+/.test(subject)),
    dominantPrefix: dominant,
  };
}

export interface BuildDigestOptions {
  /** Total byte budget for file contents inside the digest. */
  maxBytes?: number;
  issuesLimit?: number;
  prsLimit?: number;
}

/**
 * Build the deterministic repository digest. Everything downstream (analysis,
 * hypothesis generation, planning, review) reads this instead of cloning the
 * repository, which is what keeps token usage bounded and reproducible.
 */
export async function buildRepoDigest(
  client: GitHubClient,
  metadata: RepoMetadata,
  headSha: string,
  options: BuildDigestOptions = {},
): Promise<{ digest: RepoDigest; bytes: number }> {
  const env = loadEnv();
  const maxBytes = options.maxBytes ?? env.ANALYSIS_MAX_CONTEXT_BYTES;
  const ref: RepoRef = { owner: metadata.owner, name: metadata.name, fullName: metadata.fullName };
  const notes: string[] = [];

  const { entries, truncated } = await fetchTree(client, ref, headSha);
  if (truncated) notes.push('GitHub truncated the file tree; the file inventory is partial.');

  const selection = selectFilesToRead(entries, metadata.sizeKb >= env.ANALYSIS_LARGE_REPO_KB ? 8 : 14);

  // Byte budget per file category so one huge README cannot starve the rest.
  const budgetFor = (why: FileReason): number => {
    switch (why) {
      case 'readme':
        return 24_000;
      case 'contributing':
        return 12_000;
      case 'manifest':
        return 12_000;
      case 'ci':
        return 14_000;
      case 'docs':
        return 8_000;
      case 'changelog':
        return 6_000;
      case 'test_config':
        return 6_000;
      case 'pr_template':
      case 'issue_template':
        return 4_000;
      case 'code_of_conduct':
      case 'security':
        return 6_000;
      case 'license':
        return 2_000;
      default:
        return 16_000;
    }
  };

  const files: FetchedFile[] = [];
  let usedBytes = 0;
  for (const { path, why } of selection) {
    if (usedBytes >= maxBytes) {
      notes.push(`Byte budget (${maxBytes}) reached before reading every selected file.`);
      break;
    }
    const text = await fetchFileText(client, ref, path, headSha);
    if (text === null || text.trim().length === 0) continue;
    const bounded = boundText(text, Math.min(budgetFor(why), maxBytes - usedBytes));
    const bytes = Buffer.byteLength(bounded.text, 'utf8');
    usedBytes += bytes;
    files.push({ path, why, bytes, text: bounded.text });
  }

  const [commits, releases, issues, pullRequests, mergedPullRequests] = await Promise.all([
    fetchCommits(client, ref, { limit: 40, sha: headSha }).catch(() => []),
    fetchReleases(client, ref, 5).catch(() => []),
    fetchIssues(client, ref, { limit: options.issuesLimit ?? 40, state: 'open' }).catch(() => []),
    fetchPullRequests(client, ref, { state: 'open', limit: options.prsLimit ?? 25 }).catch(() => []),
    fetchPullRequests(client, ref, { state: 'closed', limit: 15 }).catch(() => []),
  ]);

  const byExtension: Record<string, number> = {};
  const testFiles: string[] = [];
  const testDirectories = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== 'blob') continue;
    const ext = extensionOf(entry.path) || '(none)';
    byExtension[ext] = (byExtension[ext] ?? 0) + 1;
    if (isTestPath(entry.path)) {
      testFiles.push(entry.path);
      const dir = entry.path.split('/').slice(0, -1).join('/');
      if (dir) testDirectories.add(dir);
    }
  }

  const digest: RepoDigest = {
    digestVersion: DIGEST_VERSION,
    repo: {
      fullName: metadata.fullName,
      description: metadata.description,
      topics: metadata.topics,
      language: metadata.language,
      license: metadata.license,
      stars: metadata.stars,
      forks: metadata.forks,
      watchers: metadata.watchers,
      openIssues: metadata.openIssues,
      sizeKb: metadata.sizeKb,
      createdAt: metadata.createdAt.toISOString(),
      pushedAt: metadata.pushedAt.toISOString(),
      defaultBranch: metadata.defaultBranch,
      archived: metadata.archived,
    },
    headSha,
    tree: {
      totalFiles: entries.filter((entry) => entry.type === 'blob').length,
      truncated,
      byExtension,
      topLevelDirectories: [
        ...new Set(entries.filter((entry) => entry.type === 'tree').map((entry) => entry.path.split('/')[0]!)),
      ].sort(),
      testFiles: testFiles.slice(0, 60),
      testDirectories: [...testDirectories].slice(0, 20),
      ciWorkflows: entries
        .filter((entry) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(entry.path))
        .map((entry) => entry.path),
      manifests: entries
        .filter((entry) => MANIFEST_NAMES.has((entry.path.split('/').pop() ?? '').toLowerCase()))
        .map((entry) => entry.path)
        .slice(0, 20),
      docs: entries
        .filter((entry) => DOC_EXTS.has(extensionOf(entry.path)) && entry.path.split('/').length <= 3)
        .map((entry) => entry.path)
        .slice(0, 60),
      hasDockerfile: entries.some((entry) => /(^|\/)dockerfile$/i.test(entry.path)),
      hasMakefile: entries.some((entry) => /(^|\/)makefile$/i.test(entry.path)),
    },
    files,
    commits: commits.map((commit) => ({
      sha: commit.sha.slice(0, 12),
      subject: commit.message,
      author: commit.authorLogin,
      date: commit.date.toISOString(),
    })),
    commitConventions: analyzeCommitConventions(commits),
    releases: releases.map((release) => ({
      tag: release.tag,
      name: release.name,
      publishedAt: release.publishedAt.toISOString(),
      bodyExcerpt: release.bodyExcerpt,
    })),
    issues: issues.map(toDigestIssue),
    pullRequests: pullRequests.map(toDigestPull),
    recentMergedPullRequests: mergedPullRequests.filter((pr) => pr.mergedAt !== null).map(toDigestPull),
    derivedTestCommands: deriveTestCommands(files),
    notes,
  };

  const bytes = Buffer.byteLength(JSON.stringify(digest), 'utf8');
  return { digest, bytes };
}

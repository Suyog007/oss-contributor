import { duplicateSchema, type DuplicateCheck, type Hypothesis } from '@/domain/schemas';
import { buildSystemPrompt, wrapUntrusted, boundText } from '@/llm/context';
import type { GitHubClient } from '@/github/client';
import { SearchPacer } from '@/github/pacing';
import { issueSearchQuery, searchIssues, type SearchIssueItem } from '@/github/search';
import { fetchIssueComments, splitFullName, type RepoDigest } from '@/github/repo';
import type { AgentContext, AgentOutcome } from './runner';

export const DUPLICATE_PROMPT_VERSION = 1;

const SYSTEM = buildSystemPrompt({
  role: 'a maintainer who remembers everything that has already been proposed in this repository',
  objective:
    'Decide whether the proposed work already exists, was already attempted, was deliberately declined, or is genuinely new. Report references a maintainer would recognise.',
  rules: [
    'Judge only from the references provided. Do not assume history that is not shown.',
    'A closed pull request that implements the same fix is a duplicate, even if it was closed for unrelated reasons; say so and cite it.',
    'An issue that describes the same problem but is unanswered is RELATED, not DUPLICATE.',
    'An explicit maintainer statement that the behavior is intended, or a rejected approach with a stated reason, is decisive: surface it in previouslyRejectedApproaches and set STOP_DUPLICATE or ASK_MAINTAINER.',
    'If the references do not cover the claim, verdict is NEW and recommendation is PROCEED.',
    'Never invent issue or pull request numbers. If a reference is not in the input, it does not exist.',
  ],
});

/**
 * Keywords used for the deterministic search.
 *
 * Derived from the hypothesis text only. The search is deliberately naive
 * (GitHub's own matching does the work); the model's role is judging relevance,
 * not finding references.
 */
export function duplicateKeywords(hypothesis: Hypothesis): string[] {
  const stop = new Set([
    'the',
    'and',
    'for',
    'with',
    'that',
    'this',
    'when',
    'not',
    'but',
    'from',
    'into',
    'than',
    'then',
    'does',
    'should',
    'would',
    'could',
    'there',
    'their',
    'have',
    'has',
    'was',
    'are',
    'its',
    'it',
    'bug',
    'issue',
    'problem',
    'error',
    'wrong',
    'instead',
    'expected',
    'actual',
    'however',
    'because',
    'returns',
    'returned',
    'using',
    'used',
    'use',
    'via',
    'per',
    'all',
    'any',
    'only',
    'also',
    'more',
    'less',
    'same',
    'different',
    'missing',
    'incorrect',
    'fails',
    'failure',
    'failing',
  ]);
  const tokens: string[] = [];
  for (const text of [
    hypothesis.title,
    hypothesis.claimedBehavior,
    ...hypothesis.files.map((path) => path.split('/').pop() ?? ''),
  ]) {
    for (const raw of text.split(/[^A-Za-z0-9_./-]+/)) {
      const token = raw.replace(/^[.-]+|[.-]+$/g, '').trim();
      if (token.length < 3) continue;
      const lower = token.toLowerCase();
      if (stop.has(lower)) continue;
      tokens.push(token);
    }
  }
  // Keep the first occurrence order: titles are the strongest signal and the
  // query builder slices from the front.
  return [...new Set(tokens)].slice(0, 24);
}

/**
 * The three searches that answer "has this been proposed before?" for one
 * repository: the same problem in an open issue, the same problem anywhere
 * (including closed), and the same fix in a pull request.
 */
export function buildDuplicateSearches(
  fullName: string,
  keywords: string[],
): Array<{ query: string; label: string }> {
  const primary = keywords.slice(0, 6);
  const secondary = keywords.slice(0, 4);
  if (primary.length === 0) {
    return [{ query: issueSearchQuery(fullName, ['fix']), label: 'open-issues' }];
  }
  return [
    { query: issueSearchQuery(fullName, primary, { inTitle: true }), label: 'titles' },
    { query: issueSearchQuery(fullName, secondary), label: 'open-issues' },
    {
      query: `repo:${fullName} ${secondary.slice(0, 3).join(' ')} type:pr`,
      label: 'pull-requests',
    },
  ];
}

export interface DuplicateReference {
  kind: 'issue' | 'pull_request';
  number: number;
  title: string;
  state: string;
  url: string;
  repoFullName: string;
  bodyExcerpt: string;
  labels: string[];
  authorLogin: string | null;
  authorAssociation: string | null;
  updatedAt: string;
  mergedAt: string | null;
  /** Deterministic keyword-overlap score; higher means more likely relevant. */
  relevance: number;
  comments: Array<{ authorLogin: string | null; authorAssociation: string | null; body: string }>;
}

export interface DuplicateSearchBundle {
  queries: string[];
  references: DuplicateReference[];
  /** Per-query failure notes. A failed search is reported, never hidden. */
  errors: string[];
}

function relevanceOf(
  reference: { title: string; bodyExcerpt: string },
  keywords: string[],
): number {
  const title = reference.title.toLowerCase();
  const body = reference.bodyExcerpt.toLowerCase();
  let score = 0;
  for (const keyword of keywords) {
    const lower = keyword.toLowerCase();
    if (title.includes(lower)) score += 3;
    if (body.includes(lower)) score += 1;
  }
  return score;
}

/**
 * Run the deterministic searches and rank what comes back.
 *
 * Everything here is reproducible: the same hypothesis and the same repository
 * state produce the same reference list. Comments are fetched only for the two
 * most relevant issues, and only from people GitHub associates with the
 * repository, because those are the statements that can be decisive.
 */
export async function collectDuplicateEvidence(
  client: GitHubClient,
  hypothesis: Hypothesis,
  options: { digest?: RepoDigest; maxReferences?: number; pacer?: SearchPacer } = {},
): Promise<DuplicateSearchBundle> {
  const fullName = options.digest?.repo.fullName;
  const keywords = duplicateKeywords(hypothesis);
  const queries = fullName
    ? buildDuplicateSearches(fullName, keywords)
    : keywords.length > 0
      ? [{ query: keywords.slice(0, 6).join(' '), label: 'global' }]
      : [];
  const pacer = options.pacer ?? new SearchPacer(client);
  const maxReferences = options.maxReferences ?? 10;
  const errors: string[] = [];

  const byReference = new Map<string, DuplicateReference>();
  const add = (item: SearchIssueItem) => {
    const key = `${item.repoFullName}#${item.number}`;
    if (byReference.has(key)) return;
    byReference.set(key, {
      kind: item.isPullRequest ? 'pull_request' : 'issue',
      number: item.number,
      title: item.title,
      state: item.isPullRequest ? (item.pullRequestMergedAt ? 'merged' : item.state) : item.state,
      url: item.url,
      repoFullName: item.repoFullName,
      bodyExcerpt: boundText(item.bodyExcerpt, 1200).text,
      labels: item.labels,
      authorLogin: item.authorLogin,
      authorAssociation: item.authorAssociation,
      updatedAt: item.updatedAt.toISOString().slice(0, 10),
      mergedAt: item.pullRequestMergedAt
        ? item.pullRequestMergedAt.toISOString().slice(0, 10)
        : null,
      relevance: 0,
      comments: [],
    });
  };

  for (const { query, label } of queries) {
    try {
      await pacer.beforeSearch();
      const results = await searchIssues(client, query, { perPage: 20, sort: 'updated' });
      for (const item of results) add(item);
    } catch (error) {
      errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Open issues and pull requests the digest already knows about are free
  // references: they cost no search request and cover the most recent state.
  for (const issue of options.digest?.issues ?? []) {
    add({
      number: issue.number,
      title: issue.title,
      bodyExcerpt: issue.bodyExcerpt,
      state: issue.state,
      url: issue.url,
      isPullRequest: false,
      updatedAt: new Date(issue.updatedAt),
      createdAt: new Date(issue.createdAt),
      comments: issue.comments,
      labels: issue.labels,
      authorLogin: issue.authorLogin,
      authorAssociation: null,
      repoFullName: options.digest?.repo.fullName ?? '',
      pullRequestMergedAt: null,
    });
  }

  const ranked = [...byReference.values()]
    .map((reference) => ({ ...reference, relevance: relevanceOf(reference, keywords) }))
    .sort((a, b) => b.relevance - a.relevance || b.number - a.number)
    .slice(0, maxReferences);

  // Comments decide whether a maintainer already ruled on this. Fetch them for
  // the top candidates only, oldest-to-newest, maintainer comments first.
  const withComments = ranked.filter((reference) => reference.kind === 'issue').slice(0, 2);
  for (const reference of withComments) {
    if (reference.repoFullName.split('/').length !== 2) continue;
    try {
      const ref = splitFullName(reference.repoFullName);
      const comments = await fetchIssueComments(client, ref, reference.number, 40);
      const maintainerish = comments.filter((comment) =>
        ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(comment.authorAssociation ?? ''),
      );
      reference.comments = (maintainerish.length > 0 ? maintainerish : comments.slice(-5))
        .slice(-6)
        .map((comment) => ({
          authorLogin: comment.authorLogin,
          authorAssociation: comment.authorAssociation,
          body: boundText(comment.body, 1500).text,
        }));
    } catch (error) {
      errors.push(
        `comments #${reference.number}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { queries: queries.map((entry) => entry.query), references: ranked, errors };
}

export interface DuplicateInput {
  digest: RepoDigest;
  hypothesis: Hypothesis;
  bundle: DuplicateSearchBundle;
}

export function buildDuplicatePrompt(input: DuplicateInput): { system: string; user: string } {
  const referenceText =
    input.bundle.references.length === 0
      ? 'No matching issues or pull requests were found.'
      : input.bundle.references
          .map((reference) => {
            const lines = [
              `### ${reference.kind === 'pull_request' ? 'PR' : 'issue'} #${reference.number}: ${reference.title}`,
              `state: ${reference.state}${reference.mergedAt ? ` (merged ${reference.mergedAt})` : ''} | labels: ${reference.labels.join(', ') || 'none'} | author: ${reference.authorLogin ?? 'unknown'} (${reference.authorAssociation ?? 'association unknown'}) | updated: ${reference.updatedAt}`,
              `url: ${reference.url}`,
              wrapUntrusted(`reference-${reference.number}-body`, reference.bodyExcerpt),
            ];
            for (const comment of reference.comments) {
              lines.push(
                wrapUntrusted(
                  `reference-${reference.number}-comment-${comment.authorLogin ?? 'unknown'}`,
                  `${comment.authorLogin ?? 'unknown'} (${comment.authorAssociation ?? 'association unknown'}): ${comment.body}`,
                ),
              );
            }
            return lines.join('\n');
          })
          .join('\n\n');

  const user = [
    '## The work being proposed',
    wrapUntrusted(
      'hypothesis',
      [
        `title: ${input.hypothesis.title}`,
        `claim: ${input.hypothesis.claimedBehavior}`,
        `expected: ${input.hypothesis.expectedBehavior}`,
        `files: ${input.hypothesis.files.join(', ') || 'none named'}`,
        `origin: ${input.hypothesis.origin}${input.hypothesis.originIssueNumber ? ` (from issue #${input.hypothesis.originIssueNumber})` : ''}`,
      ].join('\n'),
    ),
    '',
    `## Repository: ${input.digest.repo.fullName} (${input.digest.repo.stars} stars, ${input.digest.issues.length} open issues sampled)`,
    `Search queries used: ${input.bundle.queries.join(' | ') || 'none'}`,
    input.bundle.errors.length > 0
      ? `Searches that failed (treat coverage as incomplete): ${input.bundle.errors.join('; ')}`
      : '',
    '',
    '## References found',
    referenceText,
    '',
    'Judge overlap against these references and return the structured result.',
  ]
    .filter((section) => section !== '')
    .join('\n');

  return { system: SYSTEM, user };
}

export async function runDuplicateCheck(
  ctx: AgentContext,
  args: DuplicateInput & { candidateId: string; taskRef?: string },
): Promise<AgentOutcome<DuplicateCheck>> {
  const prompt = buildDuplicatePrompt(args);
  return ctx.runtime.run({
    agent: 'duplicate-checker',
    kind: 'DUPLICATE_SEARCH',
    tier: 'fast',
    system: prompt.system,
    user: prompt.user,
    schema: duplicateSchema,
    schemaName: 'duplicateCheck',
    promptVersion: DUPLICATE_PROMPT_VERSION,
    candidateId: args.candidateId,
    subject: { candidateId: args.candidateId },
    maxOutputTokens: 4000,
    ...(args.taskRef ? { taskRef: args.taskRef } : {}),
    interpret: (output) => ({
      // The verdict is read from the duplicate question: DUPLICATE means the
      // evidence contradicts doing the work, NEW means nothing opposes it.
      verdict:
        output.verdict === 'DUPLICATE'
          ? 'CONTRADICTS'
          : output.verdict === 'NEW'
            ? 'SUPPORTS'
            : 'INCONCLUSIVE',
      confidence: output.confidence,
      rationale: `${output.verdict} (${output.matches.length} reference(s)): ${output.notes.slice(0, 180)}`,
    }),
  });
}

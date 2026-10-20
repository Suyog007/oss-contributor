import { describe, expect, it } from 'vitest';
import { buildDuplicateSearches, collectDuplicateEvidence, duplicateKeywords } from '@/agents/duplicate';
import type { GitHubClient } from '@/github/client';
import type { Hypothesis } from '@/domain/schemas';

const hypothesis: Hypothesis = {
  title: 'parseDuration truncates sub-second values on config reload',
  summary: 'Values below one second round down to zero.',
  origin: 'CODE_INSPECTION',
  files: ['src/config/parse.ts'],
  claimedBehavior: 'parseDuration("500ms") returns 0',
  expectedBehavior: 'parseDuration("500ms") returns 500',
  evidence: [{ kind: 'file', ref: 'src/config/parse.ts:42', detail: 'floor' }],
  severity: 'medium',
  verificationSteps: [],
  verificationCommands: [],
  proposedTest: 'expect(500)',
  confidence: 0.7,
  openQuestions: [],
};

/** Minimal stand-in for the GitHub client, keyed by request path. */
function fakeClient(routes: Record<string, unknown>): GitHubClient {
  return {
    rateLimit: null,
    request: async (path: string) => {
      for (const [key, value] of Object.entries(routes)) {
        if (path.includes(key)) return value;
      }
      return [];
    },
  } as unknown as GitHubClient;
}

const issueItem = (overrides: Record<string, unknown> = {}) => ({
  number: 41,
  title: 'parseDuration drops milliseconds',
  body: 'calling parseDuration("500ms") yields 0',
  state: 'open',
  html_url: 'https://github.com/example/project/issues/41',
  created_at: '2026-01-05T00:00:00Z',
  updated_at: '2026-02-01T00:00:00Z',
  comments: 3,
  labels: [{ name: 'bug' }],
  user: { login: 'reporter' },
  author_association: 'NONE',
  repository_url: 'https://api.github.com/repos/example/project',
  ...overrides,
});

describe('duplicate search derivation', () => {
  it('drops stopwords and de-duplicates keywords', () => {
    const keywords = duplicateKeywords(hypothesis);
    expect(keywords).toContain('parseDuration');
    expect(keywords).toContain('config');
    expect(keywords).not.toContain('the');
    expect(keywords).not.toContain('returns');
    expect(new Set(keywords).size).toBe(keywords.length);
  });

  it('searches titles, all issues, and pull requests for the repository', () => {
    const searches = buildDuplicateSearches('example/project', ['parseDuration', 'truncates', 'config']);
    expect(searches).toHaveLength(3);
    expect(searches[0]?.query).toContain('repo:example/project');
    expect(searches[0]?.query).toContain('in:title');
    expect(searches[2]?.query).toContain('type:pr');
  });

  it('ranks results by keyword overlap and keeps maintainer comments', async () => {
    const client = fakeClient({
      '/search/issues': {
        total_count: 2,
        items: [
          issueItem(),
          issueItem({
            number: 77,
            title: 'unrelated documentation typo',
            body: 'nothing to do with durations',
            html_url: 'https://github.com/example/project/issues/77',
          }),
        ],
      },
      '/issues/41/comments': [
        {
          id: 1,
          user: { login: 'maintainer' },
          author_association: 'OWNER',
          body: 'This is intended: sub-second durations are out of scope for the reload path.',
          created_at: '2026-02-02T00:00:00Z',
          html_url: null,
        },
        {
          id: 2,
          user: { login: 'passerby' },
          author_association: 'NONE',
          body: 'same here',
          created_at: '2026-02-03T00:00:00Z',
          html_url: null,
        },
      ],
    });

    const bundle = await collectDuplicateEvidence(client, hypothesis, {
      digest: undefined,
      maxReferences: 10,
    });

    expect(bundle.queries.length).toBeGreaterThan(0);
    expect(bundle.references[0]?.number).toBe(41);
    expect(bundle.references[0]?.relevance ?? 0).toBeGreaterThan(bundle.references[1]?.relevance ?? 0);
    expect(bundle.references[0]?.comments).toHaveLength(1);
    expect(bundle.references[0]?.comments[0]?.authorLogin).toBe('maintainer');
    expect(bundle.errors).toEqual([]);
  });

  it('reports failed searches instead of pretending coverage', async () => {
    const client = {
      rateLimit: null,
      request: async () => {
        throw new Error('rate limit reached');
      },
    } as unknown as GitHubClient;

    const bundle = await collectDuplicateEvidence(client, hypothesis, {});
    expect(bundle.references).toEqual([]);
    expect(bundle.errors.length).toBeGreaterThan(0);
    expect(bundle.errors[0]).toContain('rate limit reached');
  });
});

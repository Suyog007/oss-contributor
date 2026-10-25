import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPrismaClient } from '@/db/client';
import { GitHubClient } from '@/github/client';
import { addProject } from '@/workflows/addProject';

const url = process.env['TEST_DATABASE_URL'];
const describeDb = url ? describe : describe.skip;
const db = url ? createPrismaClient(url) : null;
const created: string[] = [];

afterAll(async () => {
  if (db) {
    for (const id of created) {
      await db.workflowEvent.deleteMany({ where: { projectId: id } });
      await db.project.delete({ where: { id } }).catch(() => undefined);
    }
    await db.$disconnect();
  }
});

/** A GitHub stand-in: one repository with the given traits, empty lists elsewhere. */
function fakeGitHub(overrides: Record<string, unknown> = {}): { client: GitHubClient; fullName: string } {
  const suffix = randomUUID().slice(0, 8);
  const fullName = `owner-${suffix}/repo-${suffix}`;
  const repo = {
    id: Number.parseInt(suffix, 16),
    full_name: fullName,
    name: `repo-${suffix}`,
    owner: { login: `owner-${suffix}` },
    default_branch: 'main',
    description: 'a tiny library',
    topics: [],
    language: 'TypeScript',
    license: { spdx_id: 'MIT', name: 'MIT License' },
    fork: false,
    archived: false,
    size: 120,
    stargazers_count: 3,
    forks_count: 0,
    subscribers_count: 1,
    open_issues_count: 2,
    created_at: '2026-10-20T00:00:00Z',
    pushed_at: '2025-01-01T00:00:00Z',
    has_issues: true,
    ...overrides,
  };
  const fetchImpl: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    const body = path === `/repos/${fullName}` ? repo : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { client: new GitHubClient({ token: 'test', fetchImpl }), fullName };
}

describeDb('addProject', () => {
  it('accepts a small, quiet, brand-new repo that discovery would reject, and queues analysis', async () => {
    const { client, fullName } = fakeGitHub();
    const result = await addProject(db!, client, `https://github.com/${fullName}.git`, 'test');
    created.push(result.projectId);
    expect(result.fullName).toBe(fullName);
    expect(result.state).toBe('ACTIVE');
    expect(result.analysisQueued).toBe(true);

    const project = await db!.project.findUniqueOrThrow({ where: { id: result.projectId } });
    expect(project.discoveredVia).toBe('MANUAL');
    const task = await db!.task.findFirstOrThrow({ where: { projectId: result.projectId, kind: 'ANALYZE_PROJECT' } });
    expect(task.status).toBe('PENDING');
    const event = await db!.workflowEvent.findFirst({
      where: { projectId: result.projectId, eventType: 'project_added_manually' },
    });
    expect(event?.actor).toBe('test');

    // Adding it again the same day does not queue a second analysis.
    const again = await addProject(db!, client, fullName, 'test');
    expect(again.analysisQueued).toBe(false);
  });

  it('still blocks archived repositories and does not queue analysis', async () => {
    const { client, fullName } = fakeGitHub({ archived: true });
    const result = await addProject(db!, client, fullName, 'test');
    created.push(result.projectId);
    expect(result.state).toBe('BLOCKED');
    expect(result.reason).toContain('archived');
    expect(result.analysisQueued).toBe(false);
  });

  it('still requires a license', async () => {
    const { client, fullName } = fakeGitHub({ license: null });
    const result = await addProject(db!, client, fullName, 'test');
    created.push(result.projectId);
    expect(result.state).toBe('BLOCKED');
    expect(result.reason).toContain('license');
  });
});

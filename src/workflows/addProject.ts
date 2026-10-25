import type { Db } from '@/db/client';
import type { GitHubClient } from '@/github/client';
import { enqueue } from '@/workflow/queue';
import { recordEvent } from '@/workflow/events';
import { evaluateRepository } from './discover';

const SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/;

export class InvalidRepoError extends Error {}

/**
 * Accepts `owner/name` or a github.com URL (with .git or extra path) and
 * returns `owner/name`. Anything else is rejected, so user input can never
 * shape a request path to somewhere other than a repository.
 */
export function parseRepoInput(input: string): string {
  let text = input.trim();
  const url = text.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i);
  if (url?.[1]) text = url[1];
  const parts = text.split(/[/?#]/).filter(Boolean);
  const owner = parts[0];
  const name = parts[1]?.replace(/\.git$/i, '');
  if (!owner || !name || !SEGMENT.test(owner) || !SEGMENT.test(name) || owner === '.' || name === '.' || owner === '..' || name === '..') {
    throw new InvalidRepoError('Enter a repository as owner/name or a github.com URL.');
  }
  return `${owner}/${name}`;
}

export interface AddProjectResult {
  fullName: string;
  projectId: string;
  state: 'ACTIVE' | 'BLOCKED';
  reason: string | null;
  score: number;
  analysisQueued: boolean;
}

/**
 * Add a repository by name and queue it for analysis, so it goes through the
 * same selection, bug-finding and verification stages as discovered projects.
 */
export async function addProject(
  db: Db,
  client: GitHubClient,
  input: string,
  requestedBy = 'dashboard',
): Promise<AddProjectResult> {
  const fullName = parseRepoInput(input);
  const outcome = await evaluateRepository(
    db,
    client,
    { fullName, pack: 'manual', query: `manual:${fullName}` },
    new Date(),
    { manual: true },
  );
  const project = await db.project.findUniqueOrThrow({
    where: { id: outcome.projectId },
    select: { stateReason: true },
  });

  let analysisQueued = false;
  if (outcome.state === 'ACTIVE') {
    const day = new Date().toISOString().slice(0, 10);
    const queued = await enqueue(db, {
      kind: 'ANALYZE_PROJECT',
      dedupeKey: `analyze:${outcome.projectId}:manual:${day}`,
      payload: { projectId: outcome.projectId },
      priority: 5,
      projectId: outcome.projectId,
    });
    analysisQueued = queued.created;
  }

  await recordEvent(db, {
    eventType: 'project_added_manually',
    reason: `${requestedBy} added ${fullName}: ${outcome.state === 'ACTIVE' ? 'accepted' : `blocked (${project.stateReason ?? 'unknown'})`}`,
    projectId: outcome.projectId,
    actorKind: 'HUMAN',
    actor: requestedBy,
  });

  return {
    fullName,
    projectId: outcome.projectId,
    state: outcome.state,
    reason: project.stateReason,
    score: outcome.score,
    analysisQueued,
  };
}

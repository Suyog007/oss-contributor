import type { Db } from '@/db/client';
import type { RepoDigest } from '@/github/repo';
import {
  duplicateSchema,
  hypothesisItemSchema,
  hypothesisSchema,
  maintainerContextSchema,
  reproductionSchema,
  validationSchema,
  type DuplicateCheck,
  type Hypothesis,
  type MaintainerContext,
  type Reproduction,
  type Validation,
} from '@/domain/schemas';

/**
 * Read the persisted investigation outputs that later stages depend on.
 *
 * Every agent output is already in the `Investigation` log; this module is the
 * single place that knows how to find and validate it, so implementation and
 * review cannot disagree about what the evidence was.
 */

export interface EvidenceBundle {
  hypothesis: Hypothesis | null;
  validation: Validation | null;
  reproduction: Reproduction | null;
  duplicate: DuplicateCheck | null;
  maintainer: MaintainerContext | null;
}

async function latestParsed<T>(
  db: Db,
  candidateId: string,
  kind: 'VALIDATION' | 'REPRODUCTION' | 'DUPLICATE_SEARCH' | 'MAINTAINER_CONTEXT',
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
): Promise<T | null> {
  const rows = await db.investigation.findMany({
    where: { candidateId, kind },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { outputJson: true },
  });
  for (const row of rows) {
    const parsed = schema.safeParse(row.outputJson);
    if (parsed.success && parsed.data !== undefined) return parsed.data;
  }
  return null;
}

export async function findHypothesis(
  db: Db,
  candidateId: string,
  title: string,
): Promise<Hypothesis | null> {
  const rows = await db.investigation.findMany({
    where: { candidateId, kind: 'HYPOTHESIS' },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { outputJson: true },
  });
  // Per-candidate rows are the precise source; the batch output is a fallback.
  const singular: Hypothesis[] = [];
  const bundles: Hypothesis[] = [];
  for (const row of rows) {
    const item = hypothesisItemSchema.safeParse(row.outputJson);
    if (item.success) {
      singular.push(item.data);
      continue;
    }
    const bundle = hypothesisSchema.safeParse(row.outputJson);
    if (bundle.success) bundles.push(...bundle.data.hypotheses);
  }
  return (
    singular.find((item) => item.title === title) ??
    bundles.find((item) => item.title === title) ??
    singular[0] ??
    null
  );
}

export async function loadEvidence(db: Db, candidateId: string, title: string): Promise<EvidenceBundle> {
  const [hypothesis, validation, reproduction, duplicate, maintainer] = await Promise.all([
    findHypothesis(db, candidateId, title),
    latestParsed<Validation>(db, candidateId, 'VALIDATION', validationSchema),
    latestParsed<Reproduction>(db, candidateId, 'REPRODUCTION', reproductionSchema),
    latestParsed<DuplicateCheck>(db, candidateId, 'DUPLICATE_SEARCH', duplicateSchema),
    latestParsed<MaintainerContext>(db, candidateId, 'MAINTAINER_CONTEXT', maintainerContextSchema),
  ]);
  return { hypothesis, validation, reproduction, duplicate, maintainer };
}

export async function loadDigest(
  db: Db,
  projectId: string,
  headSha: string,
): Promise<RepoDigest | null> {
  const row = await db.repoDigest.findUnique({
    where: { projectId_headSha: { projectId, headSha } },
  });
  return row ? (row.json as unknown as RepoDigest) : null;
}

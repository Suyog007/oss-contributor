import { redirect } from 'next/navigation';
import { loadEnv } from '@/config/env';
import { requireAuth } from '@/dashboard/auth';
import { manuallyAdded } from '@/dashboard/queries';
import Link from 'next/link';
import { AutoRefresh } from '@/dashboard/AutoRefresh';
import { Page, Pill, Table, ago } from '@/dashboard/ui';
import { getDb } from '@/db/client';
import { GitHubClient, GitHubNotFoundError, GitHubRateLimitError } from '@/github/client';
import { addProject, InvalidRepoError } from '@/workflows/addProject';
import { pokeWorker } from '@/worker/trigger';

export const dynamic = 'force-dynamic';

async function submit(form: FormData) {
  'use server';
  await requireAuth();
  const input = String(form.get('repo') ?? '');
  let target: string;
  try {
    const env = loadEnv();
    if (!env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is not set on the server.');
    const result = await addProject(getDb(), GitHubClient.fromEnv(env), input);
    const poked = await pokeWorker(process.env['URL'], env.SESSION_SECRET);
    const note = result.state === 'ACTIVE' ? (poked ? 'started' : 'queued') : `blocked:${result.reason ?? ''}`;
    target = `/add?repo=${encodeURIComponent(result.fullName)}&result=${encodeURIComponent(note)}`;
  } catch (error) {
    const message =
      error instanceof InvalidRepoError
        ? error.message
        : error instanceof GitHubNotFoundError
          ? 'GitHub could not find that repository (or it is private).'
          : error instanceof GitHubRateLimitError
            ? 'GitHub rate limit reached. Try again in a few minutes.'
            : error instanceof Error
              ? error.message
              : 'Something went wrong.';
    target = `/add?error=${encodeURIComponent(message)}`;
  }
  redirect(target);
}

export default async function AddRepo({
  searchParams,
}: {
  searchParams: Promise<{ repo?: string; result?: string; error?: string }>;
}) {
  await requireAuth();
  const { repo, result, error } = await searchParams;
  const added = await manuallyAdded();
  const llm = Boolean(loadEnv().FIREWORKS_API_KEY);

  return (
    <Page
      title="Add a repository"
      subtitle="Give a GitHub repo and it goes through the same steps as discovered ones: analyze, find bugs, verify."
    >
      <AutoRefresh seconds={15} />
      <form action={submit} className="card" style={{ maxWidth: 560 }}>
        <label htmlFor="repo">Repository</label>
        <input id="repo" name="repo" placeholder="owner/name or https://github.com/owner/name" required autoFocus />
        <button>Add and analyze</button>
        {error ? <p className="err">{error}</p> : null}
        {result && repo ? (
          <p>
            {result.startsWith('blocked:') ? (
              <span className="err">
                {repo} can&apos;t be used: {result.slice(8) || 'it failed a safety check'}.
              </span>
            ) : (
              <>
                Added <strong>{repo}</strong> (<Link href={`/projects/${repo}`}>follow progress</Link>). Analysis {result === 'started' ? 'has started' : 'is queued and runs within 15 minutes'}.
              </>
            )}
          </p>
        ) : null}
        {!llm ? (
          <p className="muted">
            No model key is configured, so the repo will be recorded and scored but not analyzed until
            FIREWORKS_API_KEY is set.
          </p>
        ) : null}
      </form>

      <h2>Added by you</h2>
      <Table
        head={['Repository', 'State', 'Analyzed', 'Bug candidates', 'Tasks', 'Added']}
        empty="Nothing added yet."
        rows={added.map((row) => [
          <Link key="n" href={`/projects/${row.fullName}`}>
            {row.fullName}
          </Link>,
          <span key="s">
            <Pill value={row.state} />
            {row.stateReason ? <div className="muted">{row.stateReason}</div> : null}
          </span>,
          row.analyzed ? 'yes' : 'not yet',
          row.candidates.length === 0
            ? '—'
            : row.candidates.map((c) => `${c.status.toLowerCase().replaceAll('_', ' ')}: ${c._count}`).join(', '),
          row.tasks.length === 0 ? '—' : row.tasks.map((t) => `${t.status.toLowerCase()}: ${t._count}`).join(', '),
          ago(row.addedAt),
        ])}
      />
    </Page>
  );
}

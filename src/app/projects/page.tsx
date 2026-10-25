import { requireAuth } from '@/dashboard/auth';
import Link from 'next/link';
import { Page, Pill, Table, ago } from '@/dashboard/ui';
import { listProjects } from '@/dashboard/queries';

export const dynamic = 'force-dynamic';

export default async function Projects() {
  await requireAuth();
  const projects = await listProjects();
  return (
    <Page title="Projects" subtitle="Role 1: repositories found by discovery, ranked by the deterministic score.">
      <Table
        head={['Repository', 'Score', 'Stars', 'Language', 'License', 'State', 'Analyzed', 'Last push']}
        empty="No projects yet."
        rows={projects.map((p) => [
          <Link key="n" href={`/projects/${p.fullName}`}>
            {p.fullName}
          </Link>,
          p.discoveryScore.toFixed(1),
          p.stars.toLocaleString(),
          p.language ?? '—',
          p.license ?? '—',
          <span key="s">
            <Pill value={p.state} />
            {p.stateReason ? <div className="muted">{p.stateReason}</div> : null}
          </span>,
          p.analysisHeadSha ? 'yes' : 'no',
          ago(p.repoPushedAt),
        ])}
      />
    </Page>
  );
}

import { Page, Pill, Table, ago } from '@/dashboard/ui';
import { listProjects } from '@/dashboard/queries';

export const dynamic = 'force-dynamic';

export default async function Projects() {
  const projects = await listProjects();
  return (
    <Page title="Projects" subtitle="Role 1: repositories found by discovery, ranked by the deterministic score.">
      <Table
        head={['Repository', 'Score', 'Stars', 'Language', 'License', 'State', 'Analyzed', 'Last push']}
        empty="No projects yet."
        rows={projects.map((p) => [
          <a key="n" href={`https://github.com/${p.fullName}`} target="_blank" rel="noreferrer">
            {p.fullName}
          </a>,
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

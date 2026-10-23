import { requireAuth } from '@/dashboard/auth';
import { Page, Pill, Table, ago } from '@/dashboard/ui';
import { listContributions } from '@/dashboard/queries';

export const dynamic = 'force-dynamic';

export default async function Contributions() {
  await requireAuth();
  const rows = await listContributions();
  return (
    <Page
      title="Contributions"
      subtitle="Fixes the agent is writing or has written. Pull requests only open after human approval."
    >
      <Table
        head={['Project', 'Change', 'State', 'Cost', 'Pull request', 'Updated']}
        empty="No contributions yet. Only candidates the verifier marks IMPLEMENT get here."
        rows={rows.map((c) => [
          c.project.fullName,
          <span key="c">
            {c.candidate.title}
            {c.blockedReason ? <div className="muted">{c.blockedReason}</div> : null}
          </span>,
          <Pill key="s" value={c.state} />,
          `$${Number(c.costUsd).toFixed(3)}`,
          c.pullRequests.length === 0
            ? '—'
            : c.pullRequests.map((pr) => (
                <a key={pr.number} href={pr.url} target="_blank" rel="noreferrer">
                  #{pr.number} ({pr.state.toLowerCase()})
                </a>
              )),
          ago(c.updatedAt),
        ])}
      />
    </Page>
  );
}

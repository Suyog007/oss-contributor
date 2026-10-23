import { requireAuth } from '@/dashboard/auth';
import { Page, Table } from '@/dashboard/ui';
import { shortlist } from '@/dashboard/queries';

export const dynamic = 'force-dynamic';

export default async function Shortlist() {
  await requireAuth();
  const entries = await shortlist();
  return (
    <Page
      title="Shortlist"
      subtitle="Role 2: analyzed projects ranked by where investigation budget is best spent."
    >
      <Table
        head={['#', 'Repository', 'Score', 'Why']}
        empty="No analyzed projects yet. Analysis needs a Fireworks API key on the worker."
        rows={entries.map((entry, index) => [
          index + 1,
          entry.fullName,
          entry.score.toFixed(1),
          <ul key="r" className="reasons">
            {entry.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>,
        ])}
      />
    </Page>
  );
}

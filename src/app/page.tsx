import { requireAuth } from '@/dashboard/auth';
import { Page, Pill, Stat } from '@/dashboard/ui';
import { overview } from '@/dashboard/queries';

export const dynamic = 'force-dynamic';

function Group({ title, rows, name }: { title: string; name: string; rows: Array<Record<string, unknown> & { _count: number }> }) {
  return (
    <div className="card">
      <strong>{title}</strong>
      {rows.length === 0 ? (
        <p className="muted">Nothing yet.</p>
      ) : (
        rows.map((row) => (
          <div key={String(row[name])} style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
            <Pill value={String(row[name])} />
            <span>{row._count}</span>
          </div>
        ))
      )}
    </div>
  );
}

export default async function Home() {
  await requireAuth();
  const data = await overview();
  const idle = data.projects === 0;
  return (
    <Page title="Overview" subtitle="The four roles: find projects, pick the best, find bugs, verify them.">
      {idle ? (
        <p className="note">
          No data yet. Run <code>pnpm discover</code> against this database, then <code>pnpm worker</code> to
          analyze projects and investigate candidates.
        </p>
      ) : null}
      <div className="grid">
        <Stat label="1 · Projects discovered" value={data.projects} />
        <Stat label="2 · Projects analyzed (selector)" value={data.analyzed} />
        <Stat
          label="3 · Bug candidates found"
          value={data.candidates.reduce((sum, row) => sum + row._count, 0)}
        />
        <Stat
          label="4 · Candidates verified"
          value={data.decisions.reduce((sum, row) => sum + row._count, 0)}
        />
      </div>
      <h2>Breakdown</h2>
      <div className="grid">
        <Group title="Candidate status" name="status" rows={data.candidates} />
        <Group title="Verifier decisions" name="outcome" rows={data.decisions} />
        <Group title="Contributions" name="state" rows={data.contributions} />
        <Group title="Task queue" name="status" rows={data.tasks} />
      </div>
      <h2>AI spend</h2>
      <div className="grid">
        <Stat
          label={`Today of $${data.budget.dailyLimitUsd.toFixed(2)}`}
          value={`$${data.budget.dailySpentUsd.toFixed(4)}`}
        />
        <Stat
          label={`This month of $${data.budget.monthlyLimitUsd.toFixed(2)}`}
          value={`$${data.budget.monthlySpentUsd.toFixed(4)}`}
        />
      </div>
    </Page>
  );
}

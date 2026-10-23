import { requireAuth } from '@/dashboard/auth';
import { Page, Pill, Table, ago } from '@/dashboard/ui';
import { listCandidates } from '@/dashboard/queries';

export const dynamic = 'force-dynamic';

export default async function Candidates() {
  await requireAuth();
  const candidates = await listCandidates();
  return (
    <Page
      title="Candidates"
      subtitle="Roles 3 and 4: bugs the finder proposed, and what the verifier concluded."
    >
      <Table
        head={['Project', 'Candidate', 'Severity', 'Status', 'Verifier decision', 'Found']}
        empty="No candidates yet."
        rows={candidates.map((c) => [
          c.project.fullName,
          <span key="t">
            {c.title}
            <div className="muted">{c.summary.slice(0, 220)}</div>
          </span>,
          c.severity,
          <Pill key="s" value={c.status} />,
          c.decision ? (
            <span key="d">
              <Pill value={c.decision.outcome} />
              {c.decision.escalated ? <span className="pill warn">needs human</span> : null}
              <div className="muted">{c.decision.rationale.slice(0, 260)}</div>
            </span>
          ) : (
            <span key="d" className="muted">
              not yet verified
            </span>
          ),
          ago(c.createdAt),
        ])}
      />
    </Page>
  );
}

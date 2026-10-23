import { Page, Table, ago } from '@/dashboard/ui';
import { activity } from '@/dashboard/queries';

export const dynamic = 'force-dynamic';

export default async function Activity() {
  const { events, failing } = await activity();
  return (
    <Page title="Activity" subtitle="Audit log of everything the agents did, and why.">
      {failing.length > 0 ? (
        <>
          <h2>Failed tasks</h2>
          <Table
            head={['Kind', 'Status', 'Attempts', 'Error']}
            empty=""
            rows={failing.map((t) => [t.kind, t.status, t.attempts, t.lastError?.slice(0, 240) ?? '—'])}
          />
        </>
      ) : null}
      <h2>Recent events</h2>
      <Table
        head={['When', 'Event', 'Actor', 'Reason']}
        empty="No events yet."
        rows={events.map((e) => [
          ago(e.createdAt),
          <span key="e">
            {e.eventType}
            {e.securityRelevant ? <span className="pill bad">security</span> : null}
          </span>,
          `${e.actorKind.toLowerCase()}: ${e.actor}`,
          e.reason.slice(0, 280),
        ])}
      />
    </Page>
  );
}

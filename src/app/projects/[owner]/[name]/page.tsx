import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAuth } from '@/dashboard/auth';
import { AutoRefresh } from '@/dashboard/AutoRefresh';
import { projectDetail } from '@/dashboard/queries';
import { Page, Pill, Table, ago } from '@/dashboard/ui';

export const dynamic = 'force-dynamic';

function Step({ done, active, label, detail }: { done: boolean; active: boolean; label: string; detail?: string }) {
  const mark = done ? '✓' : active ? '…' : '○';
  return (
    <div className="card">
      <div className="n" style={{ fontSize: 20 }}>
        {mark} {label}
      </div>
      <div className="l">{detail ?? (done ? 'done' : active ? 'in progress' : 'waiting')}</div>
    </div>
  );
}

export default async function ProjectPage({ params }: { params: Promise<{ owner: string; name: string }> }) {
  await requireAuth();
  const { owner, name } = await params;
  const detail = await projectDetail(`${decodeURIComponent(owner)}/${decodeURIComponent(name)}`);
  if (!detail) notFound();
  const { project, tasks, events, candidates } = detail;

  const taskOf = (kind: string) => tasks.filter((task) => task.kind === kind);
  const running = (kind: string) => taskOf(kind).some((task) => task.status === 'PENDING' || task.status === 'RUNNING');
  const analyzed = project.analysisHeadSha !== null;
  const hypothesesRan = taskOf('GENERATE_HYPOTHESES').some((task) => task.status === 'SUCCEEDED');
  const decided = candidates.filter((candidate) => candidate.decision).length;
  const failed = tasks.filter((task) => task.lastError && (task.status === 'FAILED' || task.status === 'DEAD' || task.status === 'PENDING'));

  return (
    <Page title={project.fullName} subtitle={project.description ?? undefined}>
      <AutoRefresh seconds={10} />
      <p>
        <Pill value={project.state} /> {project.stateReason ? <span className="muted">{project.stateReason} · </span> : null}
        <a href={`https://github.com/${project.fullName}`} target="_blank" rel="noreferrer">
          GitHub
        </a>{' '}
        · <Link href="/add">Add another</Link> · refreshes every 10 seconds
      </p>

      <div className="grid">
        <Step done label="1 · Added" detail={`score ${project.discoveryScore.toFixed(1)}`} active={false} />
        <Step done={analyzed} active={running('ANALYZE_PROJECT')} label="2 · Analyzed" />
        <Step
          done={hypothesesRan}
          active={running('GENERATE_HYPOTHESES')}
          label="3 · Bugs proposed"
          detail={hypothesesRan ? `${candidates.length} candidate(s)` : undefined}
        />
        <Step
          done={candidates.length > 0 && decided === candidates.length}
          active={running('INVESTIGATE_CANDIDATE') || (candidates.length > 0 && decided < candidates.length)}
          label="4 · Verified"
          detail={candidates.length > 0 ? `${decided} of ${candidates.length} decided` : undefined}
        />
      </div>

      {failed.length > 0 ? (
        <>
          <h2>Problems</h2>
          <Table
            head={['Task', 'Status', 'Tries', 'Error']}
            empty=""
            rows={failed.map((task) => [task.kind, <Pill key="s" value={task.status} />, task.attempts, task.lastError?.slice(0, 400) ?? ''])}
          />
        </>
      ) : null}

      <h2>Bug candidates</h2>
      <Table
        head={['Candidate', 'Severity', 'Status', 'Verifier decision']}
        empty="None yet. They appear after the project is analyzed."
        rows={candidates.map((candidate) => [
          <span key="t">
            {candidate.title}
            <div className="muted">{candidate.summary.slice(0, 240)}</div>
          </span>,
          candidate.severity,
          <Pill key="s" value={candidate.status} />,
          candidate.decision ? (
            <span key="d">
              <Pill value={candidate.decision.outcome} />
              <div className="muted">{candidate.decision.rationale.slice(0, 300)}</div>
            </span>
          ) : (
            <span key="d" className="muted">
              not yet verified
            </span>
          ),
        ])}
      />

      <h2>Tasks</h2>
      <Table
        head={['Task', 'Status', 'Tries', 'Updated', 'Note']}
        empty="No tasks."
        rows={tasks.map((task) => [
          task.kind,
          <Pill key="s" value={task.status} />,
          `${task.attempts}/${task.maxAttempts}`,
          ago(task.updatedAt),
          task.lastError ? task.lastError.slice(0, 200) : task.status === 'PENDING' ? 'waiting for the next worker run (every 15 minutes)' : '',
        ])}
      />

      <h2>Log</h2>
      <Table
        head={['When', 'Event', 'Actor', 'What happened']}
        empty="No events."
        rows={events.map((event) => [
          ago(event.createdAt),
          event.eventType,
          `${event.actorKind.toLowerCase()}: ${event.actor}`,
          event.reason.slice(0, 300),
        ])}
      />
    </Page>
  );
}

import Link from 'next/link';
import { logout, requireAuth } from './auth';

const LINKS = [
  ['/', 'Overview'],
  ['/projects', 'Projects'],
  ['/shortlist', 'Shortlist'],
  ['/candidates', 'Candidates'],
  ['/contributions', 'Contributions'],
  ['/activity', 'Activity'],
] as const;

export async function Page({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  await requireAuth();
  async function signOut() {
    'use server';
    await logout();
  }
  return (
    <>
      <nav>
        <strong>OSS Contributor</strong>
        {LINKS.map(([href, label]) => (
          <Link key={href} href={href}>
            {label}
          </Link>
        ))}
        <form action={signOut}>
          <button className="link">Sign out</button>
        </form>
      </nav>
      <main>
        <h1>{title}</h1>
        {subtitle ? <p className="sub">{subtitle}</p> : null}
        {children}
      </main>
    </>
  );
}

const GOOD = new Set(['ACTIVE', 'VALIDATED', 'IMPLEMENT', 'MERGED', 'SUCCEEDED', 'PROMOTED', 'GRANTED']);
const BAD = new Set(['BLOCKED', 'REJECTED', 'FAILED', 'NOT_A_PROBLEM', 'DUPLICATE', 'TOO_RISKY', 'DENIED']);
const WARN = new Set(['COOLDOWN', 'NEEDS_INVESTIGATION', 'NEEDS_MAINTAINER_INPUT', 'PENDING', 'RETRYABLE_ERROR']);

export function Pill({ value }: { value: string }) {
  const tone = GOOD.has(value) ? 'ok' : BAD.has(value) ? 'bad' : WARN.has(value) ? 'warn' : '';
  return <span className={`pill ${tone}`}>{value.replaceAll('_', ' ').toLowerCase()}</span>;
}

export function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="card">
      <div className="n">{value}</div>
      <div className="l">{label}</div>
    </div>
  );
}

export function Table({
  head,
  rows,
  empty,
}: {
  head: string[];
  rows: React.ReactNode[][];
  empty: string;
}) {
  if (rows.length === 0) return <div className="card empty">{empty}</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ago(date: Date | null | undefined): string {
  if (!date) return '—';
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 48) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

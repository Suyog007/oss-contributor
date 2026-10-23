import { redirect } from 'next/navigation';
import { authConfigured, login } from '@/dashboard/auth';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const configured = authConfigured();

  async function submit(form: FormData) {
    'use server';
    const ok = await login(String(form.get('password') ?? ''));
    redirect(ok ? '/' : '/login?error=1');
  }

  return (
    <form className="login card" action={submit}>
      <h1>OSS Contributor</h1>
      {configured ? (
        <>
          <input type="password" name="password" placeholder="Password" autoFocus required />
          {error ? <div className="err">Wrong password.</div> : null}
          <button>Sign in</button>
        </>
      ) : (
        <p className="err">
          DASHBOARD_PASSWORD and SESSION_SECRET are not set, so sign-in is disabled.
        </p>
      )}
    </form>
  );
}

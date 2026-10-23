import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { loadEnv } from '@/config/env';

const COOKIE = 'oss_session';
const MAX_AGE_SECONDS = 60 * 60 * 12;

function sign(secret: string): string {
  return createHmac('sha256', secret).update('oss-contributor-dashboard').digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The dashboard fails closed: with no password configured nobody gets in. */
export function authConfigured(): boolean {
  const env = loadEnv();
  return env.DASHBOARD_AUTH_DISABLED || Boolean(env.DASHBOARD_PASSWORD && env.SESSION_SECRET);
}

export async function requireAuth(): Promise<void> {
  const env = loadEnv();
  if (env.DASHBOARD_AUTH_DISABLED) return;
  if (!env.DASHBOARD_PASSWORD || !env.SESSION_SECRET) redirect('/login');
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token || !safeEqual(token, sign(env.SESSION_SECRET))) redirect('/login');
}

export async function login(password: string): Promise<boolean> {
  const env = loadEnv();
  if (!env.DASHBOARD_PASSWORD || !env.SESSION_SECRET) return false;
  if (!safeEqual(password, env.DASHBOARD_PASSWORD)) return false;
  (await cookies()).set(COOKIE, sign(env.SESSION_SECRET), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
  return true;
}

export async function logout(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

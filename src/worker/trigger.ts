import { createHmac } from 'node:crypto';

/** Signed header value that authorizes a call to the background worker function. */
export function triggerToken(secret: string): string {
  return createHmac('sha256', secret).update('worker-trigger').digest('hex');
}

/** Ask the background worker to run now. Best effort: the scheduler is the fallback. */
export async function pokeWorker(baseUrl: string | undefined, secret: string | undefined): Promise<boolean> {
  if (!baseUrl || !secret) return false;
  try {
    const response = await fetch(`${baseUrl}/.netlify/functions/worker-background`, {
      method: 'POST',
      headers: { 'x-worker-token': triggerToken(secret), 'content-type': 'application/json' },
      body: JSON.stringify({ token: triggerToken(secret) }),
      signal: AbortSignal.timeout(5_000),
    });
    return response.status === 202 || response.ok;
  } catch {
    return false;
  }
}

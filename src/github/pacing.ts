import { createLogger } from '@/lib/logger';
import type { GitHubClient } from './client';

const log = createLogger('github-pacing');

/**
 * GitHub search has its own rate limit (30 requests/minute for authenticated
 * users as observed on the live API). The pacer keeps callers inside it rather
 * than discovering the limit by being rejected.
 *
 * It is a no-op until the client has seen a search response, and it only ever
 * waits when the remaining headroom is nearly gone and the reset is close.
 */
export class SearchPacer {
  constructor(private readonly client: GitHubClient) {}

  async beforeSearch(): Promise<void> {
    const snapshot = this.client.rateLimit;
    if (!snapshot || snapshot.resource !== 'search') return;
    const remainingMs = snapshot.resetAt.getTime() - Date.now();
    if (snapshot.remaining <= 2 && remainingMs > 0) {
      const waitMs = Math.min(remainingMs + 1000, 60_000);
      log.info('pacing search requests', { remaining: snapshot.remaining, waitMs });
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

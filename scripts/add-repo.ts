/**
 * Add a repository by name and queue it for analysis.
 *
 *   pnpm add-repo owner/name
 *   pnpm add-repo https://github.com/owner/name
 */
import 'dotenv/config';
import { createDb } from '@/db/client';
import { GitHubClient } from '@/github/client';
import { addProject } from '@/workflows/addProject';

async function main(): Promise<void> {
  const input = process.argv[2];
  if (!input) {
    console.error('usage: pnpm add-repo <owner/name | github url>');
    process.exit(1);
  }
  const db = createDb();
  try {
    const result = await addProject(db, GitHubClient.fromEnv(), input, 'cli');
    console.log(`${result.fullName}: ${result.state} (score ${result.score.toFixed(1)})`);
    if (result.state === 'BLOCKED') console.log(`  blocked: ${result.reason}`);
    else console.log(result.analysisQueued ? '  analysis queued; run `pnpm worker`' : '  analysis already queued today');
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

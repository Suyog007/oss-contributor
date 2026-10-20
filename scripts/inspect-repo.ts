/**
 * Print the deterministic repository digest for a repository.
 *
 *   pnpm tsx scripts/inspect-repo.ts owner/name [--json]
 *
 * The digest is the exact input every downstream agent receives, so this is the
 * fastest way to see what the system "knows" about a project before spending
 * tokens on it.
 */
import 'dotenv/config';
import { GitHubClient } from '@/github/client';
import { buildRepoDigest, fetchRepoMetadata, splitFullName } from '@/github/repo';

async function main(): Promise<void> {
  const fullName = process.argv[2];
  if (!fullName || !fullName.includes('/')) {
    console.error('usage: pnpm tsx scripts/inspect-repo.ts owner/name [--json]');
    process.exit(1);
  }
  const asJson = process.argv.includes('--json');

  const client = GitHubClient.fromEnv();
  const ref = splitFullName(fullName);
  const metadata = await fetchRepoMetadata(client, ref);
  const started = Date.now();
  const { digest, bytes } = await buildRepoDigest(client, metadata, await headSha(client, ref, metadata.defaultBranch));
  const elapsed = Date.now() - started;

  if (asJson) {
    console.log(JSON.stringify(digest, null, 2));
    return;
  }

  console.log(`\n${metadata.fullName}  [${metadata.language ?? 'unknown'}]  ${metadata.license ?? 'no license'}`);
  console.log(`  ${metadata.description ?? ''}`);
  console.log(
    `  stars=${metadata.stars} forks=${metadata.forks} openIssues=${metadata.openIssues} size=${metadata.sizeKb}KB pushed=${metadata.pushedAt.toISOString().slice(0, 10)}`,
  );
  console.log(`  head=${digest.headSha.slice(0, 12)} files=${digest.tree.totalFiles} digest=${(bytes / 1024).toFixed(1)}KB in ${elapsed}ms`);
  console.log(`  tests: ${digest.tree.testFiles.length} test files in ${digest.tree.testDirectories.slice(0, 4).join(', ') || 'none'}`);
  console.log(`  ci: ${digest.tree.ciWorkflows.join(', ') || 'none'}`);
  console.log(`  manifests: ${digest.tree.manifests.slice(0, 6).join(', ') || 'none'}`);
  console.log(`  derived test commands: ${digest.derivedTestCommands.join(' | ') || 'none'}`);
  console.log(`  commit style: conventional=${digest.commitConventions.conventionalCommits} dominant=${digest.commitConventions.dominantPrefix ?? 'n/a'}`);
  console.log(`  read files (${digest.files.length}):`);
  for (const file of digest.files) console.log(`    - ${file.path} (${file.why}, ${file.bytes}B)`);
  console.log(`  open issues sampled: ${digest.issues.length}, open PRs: ${digest.pullRequests.length}`);
  if (digest.notes.length > 0) console.log(`  notes: ${digest.notes.join('; ')}`);
}

async function headSha(client: GitHubClient, ref: { owner: string; name: string; fullName: string }, branch: string) {
  const data = await client.request<{ object: { sha: string } }>(
    `/repos/${ref.fullName}/git/ref/heads/${branch}`,
  );
  return data.object.sha;
}

main().catch((error) => {
  console.error(error instanceof Error ? (process.env['DEBUG'] ? error.stack : error.message) : error);
  process.exit(1);
});

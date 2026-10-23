import {
  mkdir,
  writeFile,
  rm,
  chmod,
  access,
  mkdtemp,
  readFile as readFileFs,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import type { Db } from '@/db/client';
import { loadEnv, type Env } from '@/config/env';
import { createLogger } from '@/lib/logger';
import { runProcess, type EnvVars } from '@/lib/process';
import { sha256, slugify } from '@/lib/canonical';
import { recordSecurityEvent } from '@/workflow/events';

const log = createLogger('workspace');

export class WorkspaceError extends Error {
  constructor(
    message: string,
    readonly kind: 'not-found' | 'git' | 'unsafe-path' | 'no-credentials',
  ) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

export interface FileEdit {
  path: string;
  content: string;
  isTest?: boolean;
}

export interface WorkspaceOptions {
  /** Contribution id, used to make the directory unique and resumable. */
  contributionId: string;
  projectId: string;
  fullName: string;
  defaultBranch: string;
  /** Commit the work must be based on. */
  baseSha: string;
  branchName: string;
}

export interface DiffResult {
  diff: string;
  stat: string;
  files: string[];
  hash: string;
}

/**
 * One isolated git workspace per contribution.
 *
 * The workspace is a plain clone on the host: repository code is never executed
 * here, only read and written. Execution happens in the sandbox container with
 * this directory mounted, which is why the directory contains no credentials
 * and no configuration the tooling reads from the host.
 */
export class Workspace {
  private readonly env: Env;

  private constructor(
    private readonly db: Db,
    readonly path: string,
    private readonly options: WorkspaceOptions,
    env: Env,
  ) {
    this.env = env;
  }

  static forContribution(db: Db, options: WorkspaceOptions, env: Env = loadEnv()): Workspace {
    const root = resolve(process.cwd(), env.WORKSPACE_ROOT);
    const directory = `${slugify(options.fullName.replace('/', '-'))}-${options.contributionId.slice(-8)}`;
    return new Workspace(db, join(root, directory), options, env);
  }

  static attach(db: Db, path: string, options: WorkspaceOptions): Workspace {
    return new Workspace(db, path, options, loadEnv());
  }

  get repositoryUrl(): string {
    return `https://github.com/${this.options.fullName}.git`;
  }

  get forkOwnerName(): string {
    return this.forkOwner;
  }

  private get forkOwner(): string {
    return this.env.GITHUB_FORK_OWNER ?? '';
  }

  private gitEnv(extraEnv: EnvVars = {}): EnvVars {
    return {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      // Environment-provided credentials are removed; only GIT_ASKPASS carries them.
      ...extraEnv,
    };
  }

  private identityArgs(): string[] {
    return [
      '-c',
      `user.name=${this.env.GIT_AUTHOR_NAME || 'oss-contributor agent'}`,
      '-c',
      `user.email=${this.env.GIT_AUTHOR_EMAIL || 'oss-contributor@users.noreply.github.com'}`,
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'advice.detachedHead=false',
    ];
  }

  private async git(
    args: string[],
    options: { timeoutMs?: number; allowFailure?: boolean; env?: EnvVars } = {},
  ): Promise<{ code: number | null; stdout: string; output: string }> {
    const result = await runProcess('git', [...this.identityArgs(), ...args], {
      cwd: this.path,
      timeoutMs: options.timeoutMs ?? 15 * 60_000,
      maxOutputBytes: 400_000,
      secrets: [this.env.GITHUB_TOKEN],
      env: this.gitEnv(options.env),
    });
    if (result.exitCode !== 0 && !options.allowFailure) {
      throw new WorkspaceError(`git ${args.join(' ')} failed: ${result.output.slice(-500)}`, 'git');
    }
    return { code: result.exitCode, stdout: result.stdout, output: result.output };
  }

  async ensureCloned(): Promise<void> {
    if (await this.exists()) {
      await this.git(['fetch', '--prune', 'origin'], {
        timeoutMs: 10 * 60_000,
        allowFailure: true,
      });
      return;
    }
    await mkdir(dirname(this.path), { recursive: true });
    const clone = await runProcess(
      'git',
      [
        ...this.identityArgs(),
        'clone',
        '--depth',
        '80',
        '--single-branch',
        '--branch',
        this.options.defaultBranch,
        this.repositoryUrl,
        this.path,
      ],
      {
        timeoutMs: 20 * 60_000,
        maxOutputBytes: 200_000,
        secrets: [this.env.GITHUB_TOKEN],
        env: this.gitEnv(),
      },
    );
    if (clone.exitCode !== 0) {
      throw new WorkspaceError(
        `could not clone ${this.options.fullName}: ${clone.output.slice(-500)}`,
        'git',
      );
    }
    log.info('workspace cloned', { fullName: this.options.fullName, path: this.path });
  }

  private async exists(): Promise<boolean> {
    try {
      await access(join(this.path, '.git'), constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** Reset the working tree to the recorded base commit and recreate the branch. */
  async startFromBase(): Promise<void> {
    await this.ensureCloned();
    await this.ensureBaseCommit();
    await this.git(['checkout', '--force', this.options.baseSha]);
    await this.git(['checkout', '-B', this.options.branchName, this.options.baseSha]);
    await this.git(['clean', '-fdx']);
    await this.excludeAgentScratch();
    log.info('workspace prepared', {
      branch: this.options.branchName,
      baseSha: this.options.baseSha.slice(0, 12),
    });
  }

  /**
   * Keep agent scratch out of the change set.
   *
   * The sandbox writes tool caches into the workspace so they survive between
   * containers. Those paths are added to `.git/info/exclude` (local, never
   * committed, never pushed) so `git add -A` can never turn them into part of
   * a contribution.
   */
  private async excludeAgentScratch(): Promise<void> {
    const excludePath = join(this.path, '.git', 'info', 'exclude');
    const entries = ['.oss-cache/', '.oss-sandbox-script.sh'];
    try {
      const existing = await readFileFs(excludePath, 'utf8').catch(() => '');
      const missing = entries.filter((entry) => !existing.split('\n').includes(entry));
      if (missing.length === 0) return;
      await mkdir(dirname(excludePath), { recursive: true });
      await writeFile(
        excludePath,
        `${existing}${existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`,
        'utf8',
      );
    } catch (error) {
      log.warn('could not write .git/info/exclude', { error: String(error) });
    }
  }

  /** Make sure the base commit is present even if the shallow clone predates it. */
  private async ensureBaseCommit(): Promise<void> {
    const has = await this.git(['cat-file', '-e', `${this.options.baseSha}^{commit}`], {
      allowFailure: true,
    });
    if (has.code === 0) return;
    await this.git(['fetch', '--depth', '1', 'origin', this.options.baseSha], {
      allowFailure: true,
    });
    const stillMissing = await this.git(['cat-file', '-e', `${this.options.baseSha}^{commit}`], {
      allowFailure: true,
    });
    if (stillMissing.code !== 0) {
      await this.git(['fetch', '--deepen', '200', 'origin'], {
        allowFailure: true,
        timeoutMs: 10 * 60_000,
      });
    }
  }

  /** Write edits, refusing anything that escapes the workspace. */
  async writeFiles(edits: FileEdit[]): Promise<void> {
    for (const edit of edits) {
      const target = this.resolveInside(edit.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, edit.content, 'utf8');
    }
  }

  async deleteFile(relativePath: string): Promise<void> {
    const target = this.resolveInside(relativePath);
    await rm(target, { force: true });
  }

  resolveInside(relativePath: string): string {
    if (relativePath.startsWith('/') || relativePath.includes('\0')) {
      throw new WorkspaceError(
        `refusing absolute or malformed path: ${relativePath}`,
        'unsafe-path',
      );
    }
    const target = resolve(this.path, relativePath);
    if (!target.startsWith(this.path + sep) && target !== this.path) {
      throw new WorkspaceError(
        `refusing path outside the workspace: ${relativePath}`,
        'unsafe-path',
      );
    }
    return target;
  }

  /** Read a file from the workspace (used to give agents the current content). */
  async readFile(relativePath: string): Promise<string | null> {
    const target = this.resolveInside(relativePath);
    try {
      return await readFileFs(target, 'utf8');
    } catch {
      return null;
    }
  }

  async stageAll(): Promise<void> {
    await this.git(['add', '-A']);
  }

  async diff(): Promise<DiffResult> {
    await this.stageAll();
    const diff = await this.git([
      'diff',
      '--cached',
      '--no-color',
      '--src-prefix=a/',
      '--dst-prefix=b/',
    ]);
    const stat = await this.git(['diff', '--cached', '--stat', '--no-color']);
    const nameOnly = await this.git(['diff', '--cached', '--name-only']);
    const files = nameOnly.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return {
      diff: diff.stdout,
      stat: stat.stdout.trim(),
      files,
      hash: sha256(diff.stdout),
    };
  }

  /** Convenience for the audit trail: the hash of the current change set. */
  async diffHash(): Promise<string> {
    return (await this.diff()).hash;
  }

  async hasChanges(): Promise<boolean> {
    const status = await this.git(['status', '--porcelain']);
    return status.stdout.trim().length > 0;
  }

  async commit(message: string, options: { amend?: boolean } = {}): Promise<string> {
    await this.stageAll();
    const hasStaged = await this.git(['diff', '--cached', '--quiet'], { allowFailure: true });
    if (hasStaged.code === 0) {
      throw new WorkspaceError('refusing to commit: there are no staged changes', 'git');
    }
    const args = options.amend ? ['commit', '--amend', '-m', message] : ['commit', '-m', message];
    await this.git(args);
    const sha = await this.git(['rev-parse', 'HEAD']);
    return sha.stdout.trim();
  }

  async headSha(): Promise<string> {
    const sha = await this.git(['rev-parse', 'HEAD']);
    return sha.stdout.trim();
  }

  async logSubjects(limit = 30): Promise<string[]> {
    const result = await this.git(['log', `-n`, String(limit), '--pretty=format:%s'], {
      allowFailure: true,
    });
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  async recentCommitBodies(limit = 5): Promise<string[]> {
    const result = await this.git(['log', '-n', String(limit), '--pretty=format:%B%n---'], {
      allowFailure: true,
    });
    return result.stdout
      .split('\n---')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  async baseDiffSummary(): Promise<string> {
    const result = await this.git(['log', '--oneline', `${this.options.baseSha}..HEAD`], {
      allowFailure: true,
    });
    return result.stdout.trim();
  }

  /** Paths changed between two commits, used to verify an approved revision. */
  async changedFilesBetween(baseSha: string, headSha: string): Promise<string[]> {
    const result = await this.git(['diff', '--name-only', baseSha, headSha], {
      allowFailure: false,
    });
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  /** Write the credential helper script. Kept in a private temp file, never in the repo. */
  private async askPassPath(): Promise<string> {
    if (!this.env.GITHUB_TOKEN) {
      throw new WorkspaceError('GITHUB_TOKEN is required to push branches', 'no-credentials');
    }
    const dir = await mkdtemp(join(tmpdir(), 'oss-contrib-git-'));
    const path = join(dir, 'askpass.sh');
    await writeFile(path, '#!/bin/sh\nprintf %s "$OSS_GIT_TOKEN"\n', { mode: 0o700 });
    await chmod(path, 0o700);
    return path;
  }

  /**
   * Push the contribution branch.
   *
   * The token is passed through GIT_ASKPASS so it never appears in the process
   * arguments, and the helper file is removed immediately afterwards.
   */
  async pushBranch(options: {
    remote: 'origin' | 'fork';
    branch: string;
    force?: boolean;
    /** Required with force on a retry: the remote head this push replaces. */
    expectedRemoteSha?: string;
    /** Push to the fork owner the approval was bound to, not the current env. */
    forkOwner?: string;
  }): Promise<void> {
    const askPass = await this.askPassPath();
    try {
      if (options.remote === 'fork') {
        const forkOwner = options.forkOwner ?? this.forkOwner;
        if (!forkOwner) {
          throw new WorkspaceError(
            'GITHUB_FORK_OWNER is not configured, cannot push to a fork',
            'no-credentials',
          );
        }
        const forkUrl = `https://github.com/${forkOwner}/${this.options.fullName.split('/')[1]}.git`;
        const existing = await this.git(['remote', 'get-url', 'fork'], { allowFailure: true });
        if (existing.code === 0) {
          await this.git(['remote', 'set-url', 'fork', forkUrl]);
        } else {
          await this.git(['remote', 'add', 'fork', forkUrl]);
        }
      }
      const args = ['push', options.remote, `HEAD:refs/heads/${options.branch}`];
      if (options.force) {
        args.push(
          options.expectedRemoteSha
            ? `--force-with-lease=refs/heads/${options.branch}:${options.expectedRemoteSha}`
            : '--force-with-lease',
        );
      }
      await this.git(args, {
        timeoutMs: 10 * 60_000,
        env: { GIT_ASKPASS: askPass, OSS_GIT_TOKEN: this.env.GITHUB_TOKEN ?? '' },
      });
      log.info('branch pushed', {
        remote: options.remote,
        branch: options.branch,
        force: options.force ?? false,
      });
    } catch (error) {
      if (error instanceof WorkspaceError) {
        await recordSecurityEvent(this.db, {
          reason: 'branch push failed',
          detail: error.message.slice(0, 400),
          contributionId: this.options.contributionId,
        });
      }
      throw error;
    } finally {
      await rm(dirname(askPass), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async resetHard(): Promise<void> {
    await this.git(['reset', '--hard', 'HEAD']);
    await this.git(['clean', '-fdx']);
  }

  async cleanUntracked(): Promise<void> {
    await this.git(['clean', '-fd']);
  }

  /** Files the project itself installed (node_modules, venv) are not part of a change. */
  async untrackedIgnored(): Promise<string[]> {
    const result = await this.git(['status', '--porcelain', '--ignored=no'], {
      allowFailure: true,
    });
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('??'))
      .map((line) => line.slice(3));
  }
}

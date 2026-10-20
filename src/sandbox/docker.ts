import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '@/db/client';
import { loadEnv, type Env } from '@/config/env';
import { createLogger } from '@/lib/logger';
import { runProcess, type ProcessResult } from '@/lib/process';
import { validateCommand, type Ecosystem } from './policy';
import { recordSecurityEvent } from '@/workflow/events';
import { createHash } from 'node:crypto';

const log = createLogger('sandbox');

export class SandboxError extends Error {
  constructor(
    message: string,
    readonly kind: 'policy' | 'unavailable' | 'timeout' | 'execution',
  ) {
    super(message);
    this.name = 'SandboxError';
  }
}

export interface SandboxResult {
  command: string;
  exitCode: number | null;
  output: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  sandboxKind: 'docker' | 'local_restricted' | 'none';
  /** Set when the command was refused before execution. */
  refusedReason?: string;
  network: boolean;
}

export interface SandboxRunOptions {
  workspacePath: string;
  command: string;
  timeoutMs?: number;
  /** Allow network for this command (dependency installation only). */
  allowNetwork?: boolean;
  ecosystem?: Ecosystem;
  /**
   * Directory inside the workspace to run in, relative to the workspace root.
   * Needed for monorepos, where the toolchain must run next to its manifest
   * (`server`, `backend`, ...). Refused if it tries to escape the workspace.
   */
  workingDirectory?: string;
  projectId?: string;
  contributionId?: string;
  /** Human-readable label used in the audit trail. */
  label?: string;
}

/**
 * Validate a requested working directory. Anything absolute, containing `..`,
 * or otherwise suspicious is refused rather than executed.
 */
export function resolveWorkingDirectory(
  directory: string | undefined,
): { ok: true; relative: string | null } | { ok: false; reason: string } {
  if (directory === undefined || directory.trim().length === 0) return { ok: true, relative: null };
  const trimmed = directory.trim().replace(/^\.\//, '').replace(/\/+$/, '');
  if (trimmed.length === 0 || trimmed === '.') return { ok: true, relative: null };
  if (trimmed.startsWith('/') || trimmed.includes('\0')) {
    return { ok: false, reason: 'working directory must be relative to the workspace' };
  }
  if (trimmed.split('/').some((segment) => segment === '..')) {
    return { ok: false, reason: 'working directory must not escape the workspace' };
  }
  return { ok: true, relative: trimmed };
}

const ECOSYSTEM_IMAGES: Record<Ecosystem, string> = {
  node: 'node:22-bookworm',
  python: 'python:3.13-bookworm',
  go: 'golang:1.26-bookworm',
  rust: 'rust:1.83-bookworm',
  java: 'eclipse-temurin:21-jdk',
  ruby: 'ruby:3.3-bookworm',
  php: 'php:8.3-cli-bookworm',
  dotnet: 'mcr.microsoft.com/dotnet/sdk:8.0',
  elixir: 'hexpm/elixir:1.17.3-erlang-27.1-debian-bookworm-20241016',
  unknown: 'debian:bookworm-slim',
};

/**
 * Container-based execution.
 *
 * Containment properties of every run:
 *  - the repository workspace is the only writable host path mounted;
 *  - no host environment variables, and specifically no credentials, are passed in;
 *  - capabilities are dropped, `no-new-privileges` is set, and the root
 *    filesystem is read-only with small tmpfs mounts for build scratch;
 *  - memory, CPU, PID, and wall-clock limits are enforced by the runtime;
 *  - network access is off unless a command explicitly asked for it during the
 *    dependency-preparation phase.
 *
 * The system therefore treats "run the project's test suite" as untrusted code
 * execution, which is what it is.
 */
export class DockerSandbox {
  private constructor(
    private readonly env: Env,
    private readonly db: Db,
  ) {}

  static fromEnv(db: Db, env: Env = loadEnv()): DockerSandbox {
    return new DockerSandbox(env, db);
  }

  get available(): boolean {
    return this.env.SANDBOX_MODE === 'docker';
  }

  imageFor(ecosystem: Ecosystem): string {
    if (this.env.SANDBOX_IMAGE && this.env.SANDBOX_IMAGE !== 'node:22-bookworm') {
      return this.env.SANDBOX_IMAGE;
    }
    return ECOSYSTEM_IMAGES[ecosystem] ?? this.env.SANDBOX_IMAGE;
  }

  /** Ensure the image is present locally; pulling is an operator-approved action. */
  async ensureImage(image: string): Promise<void> {
    const inspect = await runProcess('docker', ['image', 'inspect', image], { timeoutMs: 30_000 });
    if (inspect.exitCode === 0) return;
    const allowed = this.env.SANDBOX_ALLOWED_IMAGE_PREFIXES;
    if (allowed.length > 0 && !allowed.some((prefix) => image.startsWith(prefix))) {
      throw new SandboxError(
        `image ${image} is not in SANDBOX_ALLOWED_IMAGE_PREFIXES; refusing to pull it`,
        'policy',
      );
    }
    log.info('pulling sandbox image', { image });
    const pull = await runProcess('docker', ['pull', image], {
      timeoutMs: 30 * 60_000,
      maxOutputBytes: 64_000,
    });
    if (pull.exitCode !== 0) {
      throw new SandboxError(
        `could not pull sandbox image ${image}: ${pull.output.slice(-300)}`,
        'unavailable',
      );
    }
  }

  async run(options: SandboxRunOptions): Promise<SandboxResult> {
    const env = this.env;
    const timeoutMs = options.timeoutMs ?? env.SANDBOX_TIMEOUT_MS;
    const ecosystem = options.ecosystem ?? 'unknown';
    const allowNetwork = options.allowNetwork ?? env.SANDBOX_ALLOW_NETWORK;

    if (env.SANDBOX_MODE === 'none') {
      return {
        command: options.command,
        exitCode: null,
        output: '',
        durationMs: 0,
        timedOut: false,
        truncated: false,
        sandboxKind: 'none',
        refusedReason: 'SANDBOX_MODE=none: command execution is disabled',
        network: false,
      };
    }

    const verdict = validateCommand(options.command, { allowNetwork });
    if (!verdict.allowed) {
      await recordSecurityEvent(this.db, {
        reason: 'sandbox command refused by policy',
        detail: `${verdict.reason}: ${verdict.normalized.slice(0, 300)}`,
        projectId: options.projectId ?? null,
        contributionId: options.contributionId ?? null,
      });
      return {
        command: options.command,
        exitCode: null,
        output: `refused by sandbox policy: ${verdict.reason}`,
        durationMs: 0,
        timedOut: false,
        truncated: false,
        sandboxKind: env.SANDBOX_MODE === 'docker' ? 'docker' : 'local_restricted',
        refusedReason: verdict.reason,
        network: false,
      };
    }

    const workdir = resolveWorkingDirectory(options.workingDirectory);
    if (!workdir.ok) {
      await recordSecurityEvent(this.db, {
        reason: 'sandbox working directory refused by policy',
        detail: `${workdir.reason}: ${options.workingDirectory?.slice(0, 200) ?? ''}`,
        projectId: options.projectId ?? null,
        contributionId: options.contributionId ?? null,
      });
      return {
        command: options.command,
        exitCode: null,
        output: `refused by sandbox policy: ${workdir.reason}`,
        durationMs: 0,
        timedOut: false,
        truncated: false,
        sandboxKind: env.SANDBOX_MODE === 'docker' ? 'docker' : 'local_restricted',
        refusedReason: workdir.reason,
        network: false,
      };
    }

    if (env.SANDBOX_MODE === 'local_restricted') {
      return this.runLocally(options, timeoutMs, workdir.relative);
    }

    const image = this.imageFor(ecosystem);
    await this.ensureImage(image);

    const containerName = `oss-contrib-${createHash('sha1').update(`${options.workspacePath}${Date.now()}`).digest('hex').slice(0, 12)}`;
    const args = [
      'run',
      '--rm',
      '--name',
      containerName,
      '--network',
      allowNetwork ? 'bridge' : 'none',
      '--memory',
      `${env.SANDBOX_MEMORY_MB}m`,
      '--memory-swap',
      `${env.SANDBOX_MEMORY_MB}m`,
      '--cpus',
      String(env.SANDBOX_CPUS),
      '--pids-limit',
      String(env.SANDBOX_PIDS_LIMIT),
      '--read-only',
      '--tmpfs',
      '/tmp:rw,exec,size=1g,mode=1777',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--workdir',
      workdir.relative ? `/work/${workdir.relative}` : '/work',
      '-v',
      `${options.workspacePath}:/work`,
      // No host environment is inherited: only what is listed here exists.
      '--env',
      'HOME=/tmp',
      '--env',
      'CI=1',
      // Tool caches live inside the mounted workspace, not in the container's
      // tmpfs: dependency preparation and the commands that follow it run in
      // separate containers, so a cache in /tmp would be thrown away and the
      // offline phase would fail. `.oss-cache/` is excluded from git.
      '--env',
      'npm_config_cache=/work/.oss-cache/npm',
      '--env',
      'npm_config_store_dir=/work/.oss-cache/pnpm-store',
      '--env',
      'PNPM_HOME=/work/.oss-cache/pnpm-home',
      '--env',
      'GOPATH=/work/.oss-cache/go',
      '--env',
      'GOCACHE=/work/.oss-cache/go-build',
      '--env',
      'GOMODCACHE=/work/.oss-cache/go-mod',
      '--env',
      // Repositories may declare a newer toolchain than the image ships. The
      // preparation phase has network and stores the toolchain in the mounted
      // GOPATH, so the offline test phase can reuse it.
      'GOTOOLCHAIN=auto',
      '--env',
      'CARGO_HOME=/work/.oss-cache/cargo',
      '--env',
      'PIP_CACHE_DIR=/work/.oss-cache/pip',
      image,
      'bash',
      '-c',
      options.command,
    ];

    const started = Date.now();
    let result: ProcessResult;
    try {
      result = await runProcess('docker', args, {
        timeoutMs: timeoutMs + 15_000,
        maxOutputBytes: 500_000,
        secrets: [env.GITHUB_TOKEN, env.FIREWORKS_API_KEY],
      });
    } catch (error) {
      throw new SandboxError(`docker run failed: ${String(error)}`, 'unavailable');
    }

    if (result.timedOut) {
      await runProcess('docker', ['kill', containerName], { timeoutMs: 30_000 }).catch(
        () => undefined,
      );
    }

    if (result.timedOut) {
      log.warn('sandbox command timed out', { label: options.label, timeoutMs });
    }

    return {
      command: options.command,
      exitCode: result.exitCode,
      output: result.output,
      durationMs: Date.now() - started,
      timedOut: result.timedOut,
      truncated: result.truncated,
      sandboxKind: 'docker',
      network: allowNetwork,
    };
  }

  /**
   * Fallback mode for trusted repositories on a developer machine.
   *
   * This is explicitly *not* a security boundary: it runs commands as the
   * current user with network access. It is therefore limited to repositories
   * the operator has listed in SANDBOX_LOCAL_TRUSTED_PROJECTS, and every use is
   * recorded as a security-relevant event.
   */
  private async runLocally(
    options: SandboxRunOptions,
    timeoutMs: number,
    workingDirectory: string | null,
  ): Promise<SandboxResult> {
    const trusted = (process.env['SANDBOX_LOCAL_TRUSTED_PROJECTS'] ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    const project = options.projectId
      ? await this.db.project.findUnique({
          where: { id: options.projectId },
          select: { fullName: true },
        })
      : null;
    const fullName = project?.fullName ?? '';

    if (trusted.length === 0 || !trusted.includes(fullName)) {
      await recordSecurityEvent(this.db, {
        reason: 'local_restricted execution refused for an untrusted repository',
        detail: `${fullName || options.workspacePath} is not listed in SANDBOX_LOCAL_TRUSTED_PROJECTS`,
        projectId: options.projectId ?? null,
        contributionId: options.contributionId ?? null,
      });
      return {
        command: options.command,
        exitCode: null,
        output:
          'refused: local_restricted mode requires the repository to be listed in SANDBOX_LOCAL_TRUSTED_PROJECTS',
        durationMs: 0,
        timedOut: false,
        truncated: false,
        sandboxKind: 'local_restricted',
        refusedReason: 'repository not trusted for local execution',
        network: true,
      };
    }

    await recordSecurityEvent(this.db, {
      reason: 'repository code executed without container isolation',
      detail: `local_restricted mode used for ${fullName} (${options.label ?? 'unnamed command'})`,
      projectId: options.projectId ?? null,
      contributionId: options.contributionId ?? null,
    });

    const started = Date.now();
    const result = await runProcess(
      '/bin/bash',
      ['-lc', `ulimit -t 600 -f 2097152; ${options.command}`],
      {
        cwd: workingDirectory
          ? join(options.workspacePath, workingDirectory)
          : options.workspacePath,
        timeoutMs,
        maxOutputBytes: 500_000,
        secrets: [this.env.GITHUB_TOKEN, this.env.FIREWORKS_API_KEY],
      },
    );
    return {
      command: options.command,
      exitCode: result.exitCode,
      output: result.output,
      durationMs: Date.now() - started,
      timedOut: result.timedOut,
      truncated: result.truncated,
      sandboxKind: 'local_restricted',
      network: true,
    };
  }

  /**
   * Dependency preparation: the one phase that may need the network. Scripts
   * are disabled where the tooling supports it, because `npm install` will
   * otherwise happily run arbitrary code from a dependency.
   */
  async prepare(options: {
    workspacePath: string;
    commands: string[];
    ecosystem: Ecosystem;
    workingDirectory?: string;
    projectId?: string;
    contributionId?: string;
  }): Promise<SandboxResult[]> {
    const results: SandboxResult[] = [];
    for (const command of options.commands) {
      const result = await this.run({
        workspacePath: options.workspacePath,
        command,
        ecosystem: options.ecosystem,
        ...(options.workingDirectory ? { workingDirectory: options.workingDirectory } : {}),
        allowNetwork: true,
        timeoutMs: 12 * 60_000,
        projectId: options.projectId,
        contributionId: options.contributionId,
        label: `prepare: ${command}`,
      });
      results.push(result);
      if (result.exitCode !== 0) break;
    }
    return results;
  }

  /** Write a script into a temp file and run it, for multi-line command sets. */
  async runScript(options: SandboxRunOptions & { script: string }): Promise<SandboxResult> {
    const dir = await mkdtemp(join(tmpdir(), 'oss-contrib-script-'));
    const path = join(dir, 'run.sh');
    await writeFile(path, options.script, { mode: 0o700 });
    await chmod(path, 0o700);
    try {
      return await this.run({ ...options, command: 'bash /work/.oss-sandbox-script.sh' });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export function summarizeSandboxResult(result: SandboxResult): string {
  const status = result.refusedReason
    ? `refused (${result.refusedReason})`
    : result.timedOut
      ? 'timed out'
      : result.exitCode === 0
        ? 'ok'
        : `failed with exit code ${result.exitCode}`;
  return `${result.command} -> ${status} in ${(result.durationMs / 1000).toFixed(1)}s`;
}

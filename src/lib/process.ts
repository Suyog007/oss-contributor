import { spawn } from 'node:child_process';
import { tailBytes } from './canonical';
import { redact } from './logger';

export interface ProcessResult {
  command: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  output: string;
  truncated: boolean;
  durationMs: number;
  timedOut: boolean;
}

export interface RunProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Maximum bytes of combined output kept in memory. */
  maxOutputBytes?: number;
  /** Extra secrets to scrub from the captured output. */
  secrets?: Array<string | undefined>;
  stdin?: string;
  onOutput?: (chunk: string) => void;
}

/**
 * Run a process with bounded output, a hard timeout, and secret scrubbing.
 *
 * Every external command in this system goes through here so that no code path
 * can accidentally buffer a gigabyte of output or leak a token into a log.
 */
export async function runProcess(
  command: string,
  args: string[],
  options: RunProcessOptions = {},
): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  const maxOutputBytes = options.maxOutputBytes ?? 512_000;
  const started = Date.now();

  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const capture = (target: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      options.onOutput?.(text);
      if (stdout.length + stderr.length < maxOutputBytes) {
        if (target === 'stdout') stdout += text;
        else stderr += text;
      } else {
        truncated = true;
      }
    };

    child.stdout.on('data', capture('stdout'));
    child.stderr.on('data', capture('stderr'));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const combined = tailBytes(`${stdout}\n${stderr}`.trim(), maxOutputBytes);
      resolve({
        command: [command, ...args].join(' '),
        exitCode,
        signal,
        stdout: scrub(stdout, options),
        stderr: scrub(stderr, options),
        output: scrub(combined.text, options),
        truncated: truncated || combined.truncated,
        durationMs: Date.now() - started,
        timedOut,
      });
    };

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}

function scrub(text: string, options: RunProcessOptions): string {
  let output = redact(text);
  for (const secret of options.secrets ?? []) {
    if (!secret || secret.length < 8) continue;
    output = output.split(secret).join('[REDACTED]');
  }
  return output;
}

/** Does this executable exist on PATH? */
export async function commandExists(name: string): Promise<boolean> {
  try {
    const result = await runProcess('sh', ['-c', `command -v ${JSON.stringify(name)}`], { timeoutMs: 10_000 });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

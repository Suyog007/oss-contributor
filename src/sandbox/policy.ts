/**
 * Command policy for the execution sandbox.
 *
 * Repository content is untrusted and often instructs the reader to do things
 * (READMEs, test fixtures, CI configs, doc comments). The sandbox is the real
 * boundary, but command validation is a second, cheap layer: it rejects
 * commands that could not plausibly be part of building or testing a project,
 * and it rejects shapes that are only useful for escaping the sandbox.
 *
 * Failing closed is deliberate: a blocked command produces a clear error the
 * workflow can act on, while a permitted dangerous command cannot be undone.
 */

export interface CommandVerdict {
  allowed: boolean;
  reason: string;
  /** Normalized command that will actually be executed. */
  normalized: string;
}

/** Executables that are expected in a build/test workflow. */
const ALLOWED_EXECUTABLES = new Set([
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'bun',
  'deno',
  'node',
  'tsc',
  'tsx',
  'esbuild',
  'vite',
  'vitest',
  'jest',
  'mocha',
  'ava',
  'pytest',
  'python',
  'python3',
  'pip',
  'pip3',
  'uv',
  'poetry',
  'hatch',
  'tox',
  'ruff',
  'mypy',
  'black',
  'go',
  'gofmt',
  'golangci-lint',
  'staticcheck',
  'cargo',
  'rustc',
  'clippy-driver',
  'rustup',
  'mvn',
  'gradle',
  './gradlew',
  'java',
  'javac',
  'ant',
  'bazel',
  'buck',
  'bundle',
  'rake',
  'rspec',
  'ruby',
  'gem',
  'composer',
  'php',
  'phpunit',
  'artisan',
  'dotnet',
  'msbuild',
  'nuget',
  'make',
  'cmake',
  'ninja',
  'meson',
  'gcc',
  'g++',
  'clang',
  'clang++',
  'cabal',
  'stack',
  'ghc',
  'mix',
  'elixir',
  'swift',
  'swiftc',
  'dart',
  'flutter',
  'pub',
  'sbt',
  'scala',
  'sh',
  'bash',
  'zsh',
  'env',
  'test',
  'true',
  'false',
  'echo',
  'printf',
  'cat',
  'ls',
  'find',
  'grep',
  'egrep',
  'fgrep',
  'sed',
  'awk',
  'head',
  'tail',
  'sort',
  'uniq',
  'wc',
  'cut',
  'tr',
  'xargs',
  'diff',
  'cp',
  'mv',
  'mkdir',
  'rmdir',
  'touch',
  'rm',
  'git',
  'jq',
  'date',
  'sleep',
  'which',
  'command',
  'type',
  'file',
  'stat',
  'du',
  'df',
  'pwd',
  'chmod',
  'ln',
  'tee',
  'timeout',
  'seq',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'unzip',
  'tar',
  'gzip',
  'gunzip',
  'python3.13',
]);

/** Patterns that are never legitimate inside the sandbox. */
const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\bsudo\b|\bdoas\b|\bsu\s+-|\bpkexec\b/,
    reason: 'privilege escalation is not permitted',
  },
  {
    pattern: /\/dev\/(sd|nvme|disk)|mkfs|\bdd\s+if=/,
    reason: 'raw device access is not permitted',
  },
  {
    pattern: /docker\s+(run|exec|build|ps|kill)|\bpodman\b/,
    reason: 'nested container control is not permitted',
  },
  {
    pattern: /\/var\/run\/docker\.sock|docker\.sock/,
    reason: 'container socket access is not permitted',
  },
  {
    pattern: /ssh-keygen|\bsocat\b|\bnc\s+-l|\bncat\b/,
    reason: 'creating listeners or tunnels is not permitted',
  },
  {
    pattern: /curl[^\n|]*\|\s*(ba)?sh|wget[^\n|]*\|\s*(ba)?sh/,
    reason: 'piping remote content into a shell is not permitted',
  },
  {
    pattern: /\b(base64|xxd|openssl)\s+-d[^\n]*\|/,
    reason: 'decoding content into a shell is not permitted',
  },
  {
    pattern:
      /(^|\s)(cat|less|more|tail|head|grep)\s[^\n]*(\/etc\/passwd|\/etc\/shadow|\.ssh\/|\.aws\/|\.netrc|\/proc\/self\/environ)/,
    reason: 'reading host credential paths is not permitted',
  },
  {
    pattern: /\${?(AWS_|GITHUB_TOKEN|FIREWORKS_|NPM_TOKEN|CI_JOB_TOKEN)/,
    reason: 'referencing credential environment variables is not permitted',
  },
  {
    pattern: /\bprintenv\b|\benv\s*$|\benv\s*\|/,
    reason: 'dumping the environment is not permitted',
  },
  {
    pattern: /\bgit\s+(push|remote\s+add|config\s+--global|credential)/,
    reason: 'git remote operations run on the host, not in the sandbox',
  },
  { pattern: /:\(\)\s*\{.*\};\s*:/, reason: 'fork bombs are not permitted' },
  { pattern: /\bchmod\s+(777|a\+rwx)|\bchown\b/, reason: 'permission changes are not permitted' },
  { pattern: /\bhistory\b|\bbash_history\b/, reason: 'shell history access is not permitted' },
  {
    pattern: /\b(reboot|shutdown|halt|systemctl|launchctl|service)\b/,
    reason: 'host service control is not permitted',
  },
  { pattern: /\bkill(all)?\s+-9\s+1\b/, reason: 'killing init is not permitted' },
  {
    pattern: /\/Users\/|\/home\/[a-z]+\/(?!work)/,
    reason: 'host paths outside the workspace are not permitted',
  },
  {
    pattern:
      /\bnpm\s+(publish|login|token)|\byarn\s+publish|\bpnpm\s+publish|\btwine\b|\bturbo\s+release/,
    reason: 'publishing from the sandbox is not permitted',
  },
];

const MAX_COMMAND_LENGTH = 4000;

/**
 * Validate a command before it is executed. `allowNetwork` reflects the sandbox
 * configuration: when the sandbox has no network, commands that clearly need it
 * are rejected with an explanation rather than failing obscurely.
 */
export function validateCommand(
  command: string,
  options: { allowNetwork?: boolean } = {},
): CommandVerdict {
  const normalized = command.replace(/\s+/g, ' ').trim();

  if (normalized.length === 0) {
    return { allowed: false, reason: 'empty command', normalized };
  }
  if (normalized.length > MAX_COMMAND_LENGTH) {
    return {
      allowed: false,
      reason: 'command is longer than the policy limit',
      normalized: normalized.slice(0, 200),
    };
  }
  if (/[\n\r]/.test(command) && command.split(/[\n\r]/).length > 6) {
    return {
      allowed: false,
      reason: 'multi-line scripts with more than six lines are evaluated individually',
      normalized,
    };
  }

  for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
    if (pattern.test(normalized)) {
      return { allowed: false, reason, normalized };
    }
  }

  // Evaluate each command segment (pipes, &&, ||, ;) so `npm test && rm -rf /`
  // cannot hide a forbidden segment behind an allowed one.
  const segments = splitSegments(normalized);
  for (const segment of segments) {
    const executable = firstToken(segment);
    if (!executable) continue;
    const bare = executable.replace(/^\.\//, '').replace(/^-/, '');
    if (
      !ALLOWED_EXECUTABLES.has(bare) &&
      !executable.startsWith('./') &&
      !executable.startsWith('.')
    ) {
      return {
        allowed: false,
        reason: `executable "${executable}" is not on the sandbox allowlist`,
        normalized,
      };
    }
  }

  if (options.allowNetwork === false) {
    const networkHint =
      /\b(npm\s+(ci|install|i|add)|yarn\s+(install|add)|pnpm\s+(install|i|add)|bun\s+install|pip\s+install|pip3\s+install|poetry\s+install|uv\s+(pip\s+)?(install|sync)|go\s+(get|mod\s+download)|cargo\s+(fetch|install)|bundle\s+install|composer\s+(install|require)|dotnet\s+restore|gem\s+install)\b/;
    if (networkHint.test(normalized)) {
      return {
        allowed: false,
        reason:
          'command needs network access to download dependencies, and the sandbox is offline; run it in the preparation phase',
        normalized,
      };
    }
  }

  return { allowed: true, reason: 'allowed', normalized };
}

/**
 * Remove a `cd <dir> &&` prefix that only repeats the sandbox working
 * directory. Models often write `cd server && go test ./...`; the runner
 * already starts in `server`, and `cd` is deliberately not an allowlisted
 * executable. Only an exact duplicate is removed: a `cd` elsewhere still goes
 * through policy and is usually refused.
 */
export function stripRedundantCd(
  command: string,
  workingDirectory: string | null | undefined,
): string {
  const match = command.match(/^\s*cd\s+([^\s;&|]+)\s*&&\s*([\s\S]+)$/);
  if (!match) return command;
  const normalize = (value: string | null | undefined): string =>
    (value ?? '').replace(/^\.\//, '').replace(/\/+$/, '') || '.';
  if (normalize(match[1]) !== normalize(workingDirectory)) return command;
  return match[2]?.trim() ?? command;
}

function splitSegments(command: string): string[] {  return command
    .split(/\|\||&&|;|\||\n/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function firstToken(segment: string): string | null {  const cleaned = segment.replace(/^\(+|\)+$/g, '').trim();
  if (cleaned.length === 0) return null;
  // Skip leading shell keywords and environment assignments.
  const tokens = cleaned.split(' ').filter((token) => token.length > 0);
  for (const token of tokens) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    if (
      token === 'if' ||
      token === 'then' ||
      token === 'else' ||
      token === 'fi' ||
      token === 'do' ||
      token === 'done'
    )
      continue;
    return token;
  }
  return null;
}

/** Commands that prepare a workspace, chosen per ecosystem. */
export function installCommandsFor(ecosystem: Ecosystem, manifests: string[]): string[] {
  switch (ecosystem) {
    case 'node':
      if (manifests.some((path) => path.endsWith('pnpm-lock.yaml')))
        return ['pnpm install --frozen-lockfile --ignore-scripts'];
      if (manifests.some((path) => path.endsWith('yarn.lock')))
        return ['yarn install --frozen-lockfile --ignore-scripts'];
      if (manifests.some((path) => path.endsWith('bun.lockb'))) return ['bun install --no-save'];
      if (manifests.some((path) => path.endsWith('package-lock.json')))
        return ['npm ci --ignore-scripts'];
      return ['npm install --no-audit --no-fund --ignore-scripts'];
    case 'python':
      return [
        'python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt',
        '.venv/bin/python -m pip install -q -e .',
      ];
    case 'go':
      return ['go mod download'];
    case 'rust':
      return ['cargo fetch'];
    case 'java':
      return ['./gradlew --no-daemon dependencies || mvn -q -B -DskipTests dependency:go-offline'];
    case 'ruby':
      return ['bundle install'];
    case 'php':
      return ['composer install --no-interaction --no-progress'];
    case 'dotnet':
      return ['dotnet restore'];
    case 'elixir':
      return ['mix deps.get'];
    default:
      return [];
  }
}

export type Ecosystem =
  'node' | 'python' | 'go' | 'rust' | 'java' | 'ruby' | 'php' | 'dotnet' | 'elixir' | 'unknown';

export function ecosystemFor(language: string | null, manifests: string[]): Ecosystem {
  const manifestText = manifests.join(' ').toLowerCase();
  if (
    manifestText.includes('package.json') ||
    language === 'JavaScript' ||
    language === 'TypeScript'
  )
    return 'node';
  if (
    manifestText.includes('pyproject.toml') ||
    manifestText.includes('requirements.txt') ||
    language === 'Python'
  )
    return 'python';
  if (manifestText.includes('go.mod') || language === 'Go') return 'go';
  if (manifestText.includes('cargo.toml') || language === 'Rust') return 'rust';
  if (
    manifestText.includes('pom.xml') ||
    manifestText.includes('build.gradle') ||
    language === 'Java' ||
    language === 'Kotlin'
  )
    return 'java';
  if (manifestText.includes('gemfile') || language === 'Ruby') return 'ruby';
  if (manifestText.includes('composer.json') || language === 'PHP') return 'php';
  if (manifestText.includes('.csproj') || language === 'C#') return 'dotnet';
  if (manifestText.includes('mix.exs') || language === 'Elixir') return 'elixir';
  return 'unknown';
}

const ECOSYSTEM_BY_EXTENSION: Record<string, Ecosystem> = {
  '.go': 'go',
  '.py': 'python',
  '.ts': 'node',
  '.tsx': 'node',
  '.js': 'node',
  '.jsx': 'node',
  '.mjs': 'node',
  '.cjs': 'node',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'java',
  '.kts': 'java',
  '.rb': 'ruby',
  '.php': 'php',
  '.cs': 'dotnet',
  '.ex': 'elixir',
  '.exs': 'elixir',
};

function extensionOf(path: string): string {
  const base = path.split('/').pop() ?? path;
  const index = base.lastIndexOf('.');
  return index <= 0 ? '' : base.slice(index).toLowerCase();
}

/**
 * Ecosystem for one investigation, decided by the files the work is about.
 *
 * A monorepo is often both a Go server and a Node frontend; the toolchain that
 * matters is the one belonging to the files in question, not the first manifest
 * that happens to be in the repository root. Falls back to the repository-level
 * answer when the referenced files are language-neutral (docs, configs).
 */
export function ecosystemForInvestigation(
  paths: string[],
  language: string | null,
  manifests: string[],
): Ecosystem {
  const votes = new Map<Ecosystem, number>();
  for (const path of paths) {
    const ecosystem = ECOSYSTEM_BY_EXTENSION[extensionOf(path)];
    if (!ecosystem) continue;
    votes.set(ecosystem, (votes.get(ecosystem) ?? 0) + 1);
  }
  if (votes.size === 0) return ecosystemFor(language, manifests);

  const fallback = ecosystemFor(language, manifests);
  const ranked = [...votes.entries()].sort(
    (a, b) => b[1] - a[1] || (a[0] === fallback ? -1 : b[0] === fallback ? 1 : 0),
  );
  return ranked[0]?.[0] ?? fallback;
}

/** Manifest file names that identify the root of a given ecosystem's project. */
const MANIFESTS_BY_ECOSYSTEM: Partial<Record<Ecosystem, string[]>> = {
  node: ['package.json', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'],
  python: ['pyproject.toml', 'requirements.txt', 'requirements-dev.txt', 'setup.py', 'setup.cfg'],
  go: ['go.mod'],
  rust: ['cargo.toml'],
  java: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
  ruby: ['gemfile'],
  php: ['composer.json'],
  elixir: ['mix.exs'],
};

/**
 * Directory the ecosystem's tooling must run in, e.g. `server` for
 * `server/go.mod`. Returns undefined when the project lives at the repository
 * root or when no manifest for this ecosystem was seen.
 */
export function manifestDirectoryFor(
  ecosystem: Ecosystem,
  manifests: string[],
): string | undefined {
  for (const name of MANIFESTS_BY_ECOSYSTEM[ecosystem] ?? []) {
    const match = manifests.find((path) => (path.split('/').pop() ?? '').toLowerCase() === name);
    if (!match) continue;
    const directory = match.split('/').slice(0, -1).join('/');
    if (directory.length > 0) return directory;
  }
  return undefined;
}

/** Directories worth naming to the reproduction planner in a monorepo. */
export function projectDirectories(manifests: string[]): string[] {
  const directories = new Set<string>();
  for (const manifest of manifests) {
    const directory = manifest.split('/').slice(0, -1).join('/');
    if (directory.length > 0) directories.add(directory);
  }
  return [...directories].sort().slice(0, 12);
}

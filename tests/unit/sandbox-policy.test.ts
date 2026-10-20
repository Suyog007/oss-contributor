import { describe, expect, it } from 'vitest';
import { resolveWorkingDirectory } from '@/sandbox/docker';
import {
  ecosystemFor,
  ecosystemForInvestigation,
  installCommandsFor,
  manifestDirectoryFor,
  projectDirectories,
  stripRedundantCd,
} from '@/sandbox/policy';

describe('ecosystem detection', () => {
  it('reads the repository language and manifests when no files are named', () => {
    expect(ecosystemFor('Go', ['backend/go.mod'])).toBe('go');
    expect(ecosystemFor(null, ['package.json'])).toBe('node');
    expect(ecosystemFor('Python', [])).toBe('python');
  });

  it('picks the ecosystem of the files under investigation in a monorepo', () => {
    const manifests = ['package.json', 'backend/go.mod', 'frontend/package.json'];
    expect(ecosystemForInvestigation(['server/pkg/agent/reasonix.go'], 'Go', manifests)).toBe('go');
    expect(
      ecosystemForInvestigation(['apps/web/src/index.tsx', 'apps/web/src/app.ts'], 'Go', manifests),
    ).toBe('node');
  });

  it('falls back to the repository-level answer for language-neutral files', () => {
    expect(ecosystemForInvestigation(['docs/PAYMENT.md'], 'Go', ['frontend/package.json'])).toBe(
      'node',
    );
  });

  it('does not let a single stray file outvote a clear majority', () => {
    expect(
      ecosystemForInvestigation(['server/a.go', 'server/b.go', 'tools/check.sh'], 'Go', [
        'server/go.mod',
      ]),
    ).toBe('go');
  });
});

describe('manifest directories', () => {
  it('finds the directory the toolchain must run in', () => {
    expect(manifestDirectoryFor('go', ['Dockerfile', 'backend/go.mod'])).toBe('backend');
    expect(manifestDirectoryFor('python', ['pyproject.toml'])).toBeUndefined();
    expect(
      manifestDirectoryFor('node', ['package.json', 'packages/ui/package.json']),
    ).toBeUndefined();
    expect(manifestDirectoryFor('rust', ['crates/core/Cargo.toml', 'crates/cli/Cargo.toml'])).toBe(
      'crates/core',
    );
    expect(manifestDirectoryFor('go', ['package.json'])).toBeUndefined();
  });

  it('lists monorepo project directories for the planner', () => {
    expect(projectDirectories(['package.json', 'server/go.mod', 'apps/web/package.json'])).toEqual([
      'apps/web',
      'server',
    ]);
  });

  it('installs dependencies with the package manager the project declared', () => {
    expect(installCommandsFor('node', ['pnpm-lock.yaml'])).toEqual([
      'pnpm install --frozen-lockfile --ignore-scripts',
    ]);
    expect(installCommandsFor('node', ['package-lock.json'])).toEqual(['npm ci --ignore-scripts']);
    expect(installCommandsFor('go', ['server/go.mod'])).toEqual(['go mod download']);
  });
});

describe('sandbox working directory policy', () => {
  it('accepts a directory inside the workspace', () => {
    expect(resolveWorkingDirectory('server')).toEqual({ ok: true, relative: 'server' });
    expect(resolveWorkingDirectory('./server/pkg')).toEqual({ ok: true, relative: 'server/pkg' });
    expect(resolveWorkingDirectory('')).toEqual({ ok: true, relative: null });
    expect(resolveWorkingDirectory(undefined)).toEqual({ ok: true, relative: null });
  });

  it('refuses absolute paths and traversal', () => {
    expect(resolveWorkingDirectory('/etc').ok).toBe(false);
    expect(resolveWorkingDirectory('../../repo').ok).toBe(false);
    expect(resolveWorkingDirectory('server/../../etc').ok).toBe(false);
  });
});

describe('stripRedundantCd', () => {
  it('removes a cd that only repeats the sandbox working directory', () => {
    expect(stripRedundantCd('cd server && go test ./...', 'server')).toBe('go test ./...');
    expect(stripRedundantCd('cd ./server/ && go test ./...', 'server')).toBe('go test ./...');
    expect(stripRedundantCd('cd . && go test ./...', null)).toBe('go test ./...');
  });

  it('leaves a cd elsewhere for the command policy to evaluate', () => {
    expect(stripRedundantCd('cd other && go test ./...', 'server')).toBe(
      'cd other && go test ./...',
    );
    expect(stripRedundantCd('cd server && go test ./...', null)).toBe(
      'cd server && go test ./...',
    );
    expect(stripRedundantCd('go test ./...', 'server')).toBe('go test ./...');
  });
});

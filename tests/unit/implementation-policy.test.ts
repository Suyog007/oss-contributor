import { describe, expect, it } from 'vitest';
import type { RepoDigest } from '@/github/repo';
import {
  cleanRelativePath,
  forbiddenPathReason,
  isTestPath,
  relatedTestFiles,
  slugify,
} from '@/workflows/implementation-policy';

const digest = {
  tree: {
    testFiles: ['src/utils/date.test.ts', 'server/pkg/agent/agent_test.go', 'tests/test_parse.py'],
  },
} as unknown as RepoDigest;

describe('cleanRelativePath', () => {
  it('accepts ordinary relative paths and strips a leading ./', () => {
    expect(cleanRelativePath('src/index.ts')).toBe('src/index.ts');
    expect(cleanRelativePath('./src/index.ts')).toBe('src/index.ts');
    expect(cleanRelativePath('  docs/PAYMENT.md  ')).toBe('docs/PAYMENT.md');
  });

  it('rejects absolute paths, traversal, backslashes, and empty segments', () => {
    expect(cleanRelativePath('/etc/passwd')).toBeNull();
    expect(cleanRelativePath('../outside.ts')).toBeNull();
    expect(cleanRelativePath('src/../../outside.ts')).toBeNull();
    expect(cleanRelativePath('src\\index.ts')).toBeNull();
    expect(cleanRelativePath('src//index.ts')).toBeNull();
    expect(cleanRelativePath('src/./index.ts')).toBeNull();
    expect(cleanRelativePath('')).toBeNull();
    expect(cleanRelativePath('a'.repeat(301))).toBeNull();
  });
});

describe('forbiddenPathReason', () => {
  it('refuses lockfiles and dependency pins', () => {
    expect(forbiddenPathReason('package-lock.json')).toContain('lockfiles');
    expect(forbiddenPathReason('server/go.sum')).toContain('lockfiles');
    expect(forbiddenPathReason('Cargo.lock')).toContain('lockfiles');
  });

  it('refuses CI, vendored, generated, and environment files', () => {
    expect(forbiddenPathReason('.github/workflows/ci.yml')).toBeTruthy();
    expect(forbiddenPathReason('node_modules/left-pad/index.js')).toBeTruthy();
    expect(forbiddenPathReason('vendor/github.com/x/y.go')).toBeTruthy();
    expect(forbiddenPathReason('dist/bundle.js')).toBeTruthy();
    expect(forbiddenPathReason('.env')).toContain('environment');
    expect(forbiddenPathReason('config/.env.local')).toContain('environment');
  });

  it('refuses binary and minified assets', () => {
    expect(forbiddenPathReason('assets/logo.png')).toContain('binary');
    expect(forbiddenPathReason('public/app.min.js')).toContain('binary');
  });

  it('allows ordinary source, test, and documentation files', () => {
    expect(forbiddenPathReason('src/index.ts')).toBeNull();
    expect(forbiddenPathReason('backend/handler.go')).toBeNull();
    expect(forbiddenPathReason('docs/PAYMENT.md')).toBeNull();
    expect(forbiddenPathReason('server/pkg/agent/agent_test.go')).toBeNull();
  });
});

describe('isTestPath', () => {
  it('recognizes test files from the digest', () => {
    expect(isTestPath('src/utils/date.test.ts', digest)).toBe(true);
    expect(isTestPath('server/pkg/agent/agent_test.go', digest)).toBe(true);
  });

  it('recognizes common test layouts even when absent from the digest sample', () => {
    expect(isTestPath('src/__tests__/payment.ts', digest)).toBe(true);
    expect(isTestPath('pkg/foo_spec.rb', digest)).toBe(true);
    expect(isTestPath('tests/test_handler.py', digest)).toBe(true);
  });

  it('does not mistake production files for tests', () => {
    expect(isTestPath('src/payments/handler.ts', digest)).toBe(false);
    expect(isTestPath('server/pkg/agent/agent.go', digest)).toBe(false);
  });
});

describe('relatedTestFiles', () => {
  it('prefers tests whose names match the hypothesis files, then falls back', () => {
    const files = relatedTestFiles(digest, ['src/utils/date.ts']);
    expect(files[0]).toBe('src/utils/date.test.ts');
    expect(files).toContain('server/pkg/agent/agent_test.go');
  });

  it('deduplicates and caps the sample', () => {
    const files = relatedTestFiles(digest, [
      'src/utils/date.ts',
      'src/utils/date.ts',
    ]);
    expect(new Set(files).size).toBe(files.length);
    expect(files.length).toBeLessThanOrEqual(5);
  });
});

describe('slugify', () => {
  it('produces branch-safe slugs', () => {
    expect(slugify('Fix Payment.Retry on 429!')).toBe('fix-payment-retry-on-429');
    expect(slugify('')).toBe('');
    expect(slugify('---')).toBe('');
  });
});

import { describe, expect, it } from 'vitest';
import { InvalidRepoError, parseRepoInput } from '@/workflows/addProject';

describe('parseRepoInput', () => {
  it('accepts owner/name and github urls', () => {
    expect(parseRepoInput('vercel/next.js')).toBe('vercel/next.js');
    expect(parseRepoInput('  https://github.com/vercel/next.js  ')).toBe('vercel/next.js');
    expect(parseRepoInput('https://github.com/vercel/next.js.git')).toBe('vercel/next.js');
    expect(parseRepoInput('github.com/vercel/next.js/issues/12')).toBe('vercel/next.js');
    expect(parseRepoInput('http://www.github.com/a/b?tab=readme')).toBe('a/b');
  });

  it('rejects anything that is not a repository', () => {
    for (const bad of ['', 'justaname', 'a/', '/b', '../etc/passwd', 'a/..', 'a b/c', 'a/b c', 'https://evil.example/a/b/c', 'a/b%2f..']) {
      expect(() => parseRepoInput(bad), bad).toThrow(InvalidRepoError);
    }
  });
});

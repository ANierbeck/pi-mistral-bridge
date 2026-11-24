import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FORBIDDEN, SKIP_PATHS } from '../scripts/forbidden-patterns.ts';

describe('scripts/forbidden-patterns.ts', () => {
  it('defines a meaningful pattern list (>= 3 named patterns)', () => {
    expect(FORBIDDEN.length).toBeGreaterThanOrEqual(3);
    for (const pattern of FORBIDDEN) {
      expect(pattern.name.length).toBeGreaterThan(0);
      expect(pattern.re).toBeInstanceOf(RegExp);
      expect(pattern.re.source.length).toBeGreaterThan(0);
    }
  });

  it('matches representative forbidden content', () => {
    // Fragments are joined so this test file does not trip the pre-push scan
    // over its own source.
    const homePath = ['/Users', '/alice'].join('');
    const apiKey = ['sk-', 'a'.repeat(24)].join('');
    const bearer = ['Bearer ', 'aB3'.repeat(8)].join('');
    expect(FORBIDDEN.some((p) => p.re.test(homePath))).toBe(true);
    expect(FORBIDDEN.some((p) => p.re.test(apiKey))).toBe(true);
    expect(FORBIDDEN.some((p) => p.re.test(bearer))).toBe(true);
  });

  it('does not match ordinary source lines', () => {
    const line = "import { spawn } from 'node:child_process'; // task-1 done";
    expect(FORBIDDEN.some((p) => p.re.test(line))).toBe(false);
  });

  it('never matches its own source file (patterns are fragment-assembled)', () => {
    const self = readFileSync(
      new URL('../scripts/forbidden-patterns.ts', import.meta.url),
      'utf-8'
    );
    const selfHits = FORBIDDEN.filter((p) => p.re.test(self)).map((p) => p.name);
    expect(selfHits).toEqual([]);
  });

  it('skips generated lockfiles in the scanner', () => {
    expect(SKIP_PATHS.has('package-lock.json')).toBe(true);
  });
});

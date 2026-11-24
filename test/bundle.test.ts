// Bundle gate (whole-branch review finding): Pi supplies the host packages
// @earendil-works/pi-ai, @earendil-works/pi-coding-agent, @earendil-works/pi-tui
// and typebox to extensions (pi-coding-agent docs/packages.md, "Declare
// dependencies"). They must be declared as peerDependencies "*" and kept
// EXTERNAL in dist/index.js — a bundled physical copy bypasses Pi's extension
// module mapping and creates duplicate classes, registries and init work.
// This test rebuilds the bundle in-process (scripts/build.ts runs esbuild at
// import time) and asserts no host-package source path is inlined and the
// host imports survive as external import statements. The same assertion
// runs in CI right after the build step (.github/workflows/ci.yml).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Rebuild dist/index.js so the test never judges a stale bundle (dist/ is
// gitignored, so a fresh checkout has none).
await import('../scripts/build.ts');

const DIST_INDEX = fileURLToPath(new URL('../dist/index.js', import.meta.url));

describe('dist/index.js bundle', () => {
  it('does not inline host-provided package sources', () => {
    const bundle = readFileSync(DIST_INDEX, 'utf8');
    expect(bundle).not.toContain('node_modules/@earendil-works');
    expect(bundle).not.toContain('node_modules/typebox');
  });

  it('keeps the host packages as external imports', () => {
    const bundle = readFileSync(DIST_INDEX, 'utf8');
    // Runtime value imports that must survive as external statements.
    // (@earendil-works/pi-coding-agent and pi-tui are imported type-only,
    // so esbuild elides them entirely — the no-inline assertion above is
    // what covers them.)
    expect(bundle).toMatch(/from\s*["']@earendil-works\/pi-ai["']/);
    expect(bundle).toMatch(/from\s*["']typebox["']/);
  });
});

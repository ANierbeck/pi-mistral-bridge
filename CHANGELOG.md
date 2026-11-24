# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
Semantic Versioning.

## 0.1.0 — 2026-11-24

### Added

- Start of development: repository scaffold for task T1 of
  `docs/plans/2026-11-24-implementation.md` — `package.json` with the pi
  manifest and the spike's dependency set, strict `tsconfig.json`,
  eslint/prettier/vitest toolchain with coverage config, esbuild bundle to
  `dist/index.js`, pre-push secret scanning (`scripts/secret-scan.ts`,
  `scripts/forbidden-patterns.ts`, `.githooks/pre-push`), GitHub Actions CI
  (`test`, `secret-scan`), MIT LICENSE. The extension entry point
  (`src/index.ts`) is still a placeholder stub; the bridge itself lands in
  tasks T2–T7.

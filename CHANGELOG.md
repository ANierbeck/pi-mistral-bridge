# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
Semantic Versioning.

## Unreleased

### Added

- **T1 — Scaffold:** pi package manifest, strict TypeScript config,
  eslint/prettier/vitest toolchain with coverage floors, esbuild bundle to
  `dist/index.js`, pre-push secret scanning (`scripts/secret-scan.ts`,
  `scripts/forbidden-patterns.ts`, `.githooks/pre-push`), GitHub Actions CI
  (`test`, `secret-scan`), MIT LICENSE.
- **T2 — Configuration:** `mistral-bridge.json` (global `~/.pi/agent/`,
  project `.pi/`) with defaults and validation, plus `src/vibe-protocol.ts`
  pinning every `VIBE_*` environment variable and Vibe-specific ACP
  extension surface the bridge uses.
- **T3 — ACP client:** per-model `vibe-acp` process pool with idle reaper,
  ndjson stdio ACP client (initialize / session new / prompt / cancel),
  permission-request bridge, abort handling, redacted debug log; unit-tested
  against an in-process fake ACP agent.
- **T4 — MCP bridge:** loopback-only HTTP MCP server (random port, per-session
  bearer token) exposing the Pi session's tools under the `pi__` prefix, with
  park/resume, short batching window, deterministic request-id
  de-duplication and a 55 s pre-emptive tool timeout; unit-tested with a real
  MCP client on loopback.
- **T5 — Provider mode:** Pi provider registration and the `streamSimple` turn
  flow (tool-result continuation / delta / rebuild), usage reporting, abort
  watchdog, stable quota-error prefix; unit-tested against the fake ACP agent.
- **T6 — AskVibe mode:** the `ask_vibe` tool (params `question` and `mode`)
  delegating to a fresh ephemeral Vibe session with mode validation and
  fallback, permission requests bridged to Pi's UI (rejected without a UI),
  changed-files summary in the result.
- **T7 — Model discovery:** the model list is read from `vibe-acp`'s `model`
  config option (never hardcoded), cached by API id, refreshed in the
  background with provider re-registration on change, capabilities enriched
  from Vibe usage updates and Pi's own registry.
- **T8 — Documentation:** README (install, both modes, configuration
  reference, security notes, troubleshooting), `PI.md` package listing,
  this changelog.

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

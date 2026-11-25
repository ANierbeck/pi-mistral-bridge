# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
Semantic Versioning.

## Unreleased

### Fixed

- Rebuild prompts (ADR-0003) now carry a history preamble (`HISTORY_PREAMBLE`
  in `src/transcript.ts`) between the system prompt and the rendered
  transcript, so the model reads the transcript as a read-only log instead of
  imitating the `[tool pi__…]` / `[tool result …]` lines as text. Found in a
  real E2E run (P6 of the multi-step suite): after an abort-triggered rebuild
  the model answered a tool request with the literal text
  `[tool ask_vibe {…}]` instead of making a real tool call.

## 0.1.1 - 2026-11-25

### Changed

- License changed from MIT to **Apache-2.0** (0.1.0 on npm remains MIT).
- npm package is published under the scoped name `@anierbeck/pi-mistral-bridge`
  (the account cannot create unscoped names); install with
  `pi install npm:@anierbeck/pi-mistral-bridge`. GitHub repository name unchanged.
- `publishConfig.access` is now pinned to `public` in package.json (scoped
  packages default to restricted/private, which fails with E402 without it).
- Releases are published by GitHub Actions (`.github/workflows/publish.yml`,
  npm Trusted Publishing via OIDC with provenance) on `release: published` or
  `workflow_dispatch` with a tag ref.

### Fixed

- `prepublishOnly` script contained an unescaped apostrophe that broke
  `sh -c` parsing on every publish attempt.
- The commit-range secret scan no longer flags the public npm scope
  `@anierbeck/` (explicit publication choice); a bare lowercase handle is
  still rejected.
- Publish job runs on Node 24 (npm 11): npm Trusted Publishing (OIDC)
  needs npm >= 11.5.1; on Node 22 (npm 10) the token exchange never
  happened and the registry answered the unauthenticated PUT with 404.

## 0.1.0 - 2026-11-24

### Added

- **Start of development:** repository scaffold for task T1 of
  `docs/plans/2026-11-24-implementation.md` — `package.json` with the pi
  manifest and the spike's dependency set, strict `tsconfig.json`,
  eslint/prettier/vitest toolchain with coverage config, esbuild bundle to
  `dist/index.js`, pre-push secret scanning (`scripts/secret-scan.ts`,
  `scripts/forbidden-patterns.ts`, `.githooks/pre-push`), GitHub Actions CI
  (`test`, `secret-scan`), MIT LICENSE.
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
  reference, security notes, troubleshooting), this changelog.
- **Acknowledgments:** the README gained an Acknowledgments section crediting
  pi-claude-bridge (https://github.com/elidickinson/pi-claude-bridge, npm:
  pi-claude-bridge) by Eli Dickinson as the inspiration for the
  bridge-provider pattern.

### Fixed

- **Startup race:** the extension factory is now async and awaits the first
  model discovery — bounded by the new `startupDiscoveryTimeoutMs` config key
  (default 10000 ms) — so on a fast discovery the `mistral-bridge` models are
  registered before Pi's first render. `pi -p`, `--list-models` and
  `--model mistral-bridge/<id>` issued right after Pi start no longer silently
  fall back to Pi's builtin `mistral` HTTP provider. On timeout a quiet
  warning is logged and startup continues; the discovery itself keeps running
  in the background. Red-first tested against the in-process fake ACP agent
  (red output: 6 failing tests before the fix).

### Changed

- **Docs / gallery metadata:** the README gained a prominent "What this is —
  and what it is not" section (a Pi extension driving your own installed
  `vibe-acp` over ACP — Pi owns the loop and tools; it is not an API-key
  client, not a Vibe credential store, not a Vibe patch, and not a Vibe CLI
  replacement; usage bills against the Vibe allowance because Mistral
  accepts Mistral harnesses via ACP with third-party tools), an explicit
  warning to always address bridge models as `mistral-bridge/<apiModelId>`
  (`mistral/<id>` resolves to Pi's builtin HTTP provider, not the bridge), an
  Install section and an honest limitations section (models appear after the
  first discovery; provider-mode 60 s per-turn budget with 55 s pre-timeout;
  `plan` mode gone on `vibe-acp` >= 3.0). `package.json` gained `repository`
  and `homepage`; `PI.md` was deleted and removed from `files` — pi.dev
  renders the package README and has no PI.md special file (verified against
  https://pi.dev/packages/pi-claude-bridge).
- **Default provider name:** the Pi provider the bridge registers is now
  named `mistral-bridge` by default (was `mistral-vibe`); models are addressed
  as `mistral-bridge/<apiModelId>`. The `providerName` config key is unchanged
  and still overrides the default (ADR-0009, proposed).

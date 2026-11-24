# pi-mistral-bridge — Implementation Plan

> **REQUIRED SUB-SKILL:** `subagent-driven-development` (§17) — implementer =
> builtin `worker` on a cheaper model (§13), reviewers = builtin `reviewer`.

## Status

Approved (2026-11-24) — owner approved the design, ADRs 0001–0007 and the
spike path. Execution starts with Task 1.

## Problem

Build the pi-mistral-bridge extension per the approved design
(`2026-11-24-pi-mistral-bridge-design.md`) and ADRs 0001–0007: a Pi provider
that drives `vibe-acp` over ACP, plus the AskVibe tool.

## Solution

Incremental, red-first tasks below. Each task: worktree task branch from
`spike/acp-surface` (or later from `main`), failing test first, implement,
gates green (§4), commit(s) on the task branch. Integration tests against
real `vibe-acp` only with per-run owner approval (`MISTRAL_BRIDGE_IT=1`).

## Open decisions

- **Owner:** GitHub repo name/visibility and npm publishing (§1). No remote
  exists yet; nothing is pushed until this is decided and the PR flow (§8)
  is set up.

## Verified against

- `vibe-acp` 2.25.8 and 3.1.4 (spike evidence in
  `docs/research/2026-11-24-vibe-acp-surface.md`), pi 1.6.0,
  `@agentclientprotocol/sdk` 2.9.1 (API: `client().onRequest(...).connect(stream)`
  with `ndJsonStream`), `@modelcontextprotocol/sdk` 1.32.2.
- Not verified: behaviour of any Vibe version other than those two.

## Tasks

- [x] **T1 Scaffold.** Root package.json (pi manifest, scripts, deps per
      spike), tsconfig strict, eslint+prettier gates, vitest + coverage
      config, esbuild bundle to `dist/index.js`, `.githooks/pre-push` +
      `scripts/secret-scan.ts` + `scripts/forbidden-patterns.ts`, GitHub
      Actions CI (`test`, `secret-scan`), LICENSE (MIT, credit
      pi-claude-bridge), README skeleton, CHANGELOG. Gates: tsc, lint,
      format, vitest (≥1 trivial test), build, secret-scan.
- [x] **T2 Config + vibe-protocol module.** `src/config.ts`
      (mistral-bridge.json global/project, defaults per design) and
      `src/vibe-protocol.ts` pinning every `VIBE_*` env var and Vibe-specific
      ACP ext/`_meta` used, each with a unit test pinning the name (ADR-0007).
- [x] **T3 ACP client.** `src/acp-client.ts`: spawn `vibe-acp` per model
      (process pool, idle reaper, env from T2), ndjson stdio ACP client,
      initialize/session new/close/prompt/cancel, request_permission bridge
      per ADR-0006, notification routing, abort handling, debug log with
      redaction. Unit tests with an in-process fake ACP agent (in-memory
      streams): handshake, streaming events, permission allow/reject, cancel,
      child crash.
- [x] **T4 MCP bridge.** `src/mcp-bridge.ts`: loopback HTTP MCP server,
      random port + per-session bearer token, stateless per-call sessions,
      tools listed from the Pi session's current tools under `pi__` prefix,
      park/resume of calls, ~100 ms batching window, deterministic request
      id de-dup (ADR-0006), 55 s pre-emptive timeout. Unit tests with a real
      MCP client on loopback: auth, unknown tool, park/resume, duplicates,
      timeout.
- [x] **T5 Provider + history.** `src/provider.ts`, `src/session-map.ts`,
      `src/transcript.ts`: registerProvider, streamSimple turn flow
      (tool-result continuation / delta / rebuild per ADR-0003), event
      mapping, usage (cost 0, cached tokens), abort → cancel + own watchdog
      kill, quota error prefix, model routing to the per-model process pool.
      Unit tests: fake ACP agent covering all three flows, steering-dirty,
      digest logic, transcript snapshots.
- [x] **T6 AskVibe.** `src/ask-vibe.ts`: tool registration, own process,
      modes ask/plan/edit via `set_mode`, permission → `ctx.ui`, headless
      reject, live progress in tool rendering, changed-files summary
      (ADR-0004). Unit tests with mocked `ctx.ui`.

  **Deviations from ADR-0004** (T6 review; flagged for the controller to
  raise as ADR-0008 at the next ADR round — accepted ADRs are immutable
  (§12), so this plan records the narrowing instead of editing ADR-0004):

  - Tool params are `question` (required) + `mode` only. ADR-0004's
    optional `model` and `continue` params are NOT implemented: every call
    runs on Vibe's own default model (no `VIBE_ACTIVE_MODEL` is set) and
    always on a fresh ephemeral ACP session — no resume of a previous
    AskVibe session. Reason: Pi 1.6.0 has no agent-mode API, so AskVibe is
    a plain Pi tool (ADR-0004 Option 2), and always-ephemeral sessions keep
    the ADR-0003 delta/rebuild logic untouched (AskVibe uses no session
    map, so provider-mode histories never mix in).
  - `mode` is mapped to a Vibe policy id (`vibeModeIdFor`) and validated
    against the session's advertised `availableModes` before
    `session/set_mode` (`resolveEffectiveVibeModeId`, src/vibe-protocol.ts):
    plan mode was removed in vibe-acp 3.0.0 and an unknown mode id is a
    silent no-op on 3.1.4, so an unavailable request falls back to the
    closest safe available mode (plan→ask, edit→accept-edits→ask) and the
    effective mode is recorded in the tool result details — the bridge never
    reports a mode that was not actually set.
  - Persisting permission options are never answered. ADR-0004 says the
    user's choice is answered verbatim (allow once / always / reject), but
    `allow_always*` options are downgraded to `allow_once` plus a logged
    anomaly and are never persisted (src/ask-vibe.ts picks by optionId
    prefix, not only by kind, so a mismatched id cannot slip through). The
    bridge never grants a permission it will not remember.
- [x] **T7 Models.** `src/models.ts`: read `model` config option, cache by
      API id, background refresh, enrich capabilities from
      `usage_update.size` / Pi registry (no hardcoded models, §9).

  **Known gaps** (T5/T7; flagged for the ADR-0008 round together with the
  T6 deviations above — accepted ADRs are immutable, §12):

  - ADR-0003 lists a new cwd as a history-rebuild trigger, but the
    session map (src/session-map.ts) keys by Pi sessionId only. Low risk:
    Pi ties the cwd to the session, and a replaced session fires
    `session_shutdown`, which disposes the runtime — so a cwd change in
    practice arrives as a fresh runtime, never as a stale-cwd reuse.
  - ADR-0005's cache file ("cached under the bridge's own cache file, so
    the next Pi start can register…") is NOT implemented: the catalog is
    in-memory (src/models.ts) and re-discovers on every Pi start.
- [ ] **T8 Docs + review.** README (install, config, both modes, verified
      Vibe versions, honest note on provider-mode policy risk per ADR-0002),
      (PI.md was later dropped — pi.dev renders the package README; see
      CHANGELOG), then `requesting-code-review` with builtin `reviewer` (§1),
      PR per §8.
  Docs written (README.md, PI.md, CHANGELOG.md Unreleased section,
  package.json description); the checkbox stays open until the code review
  passes.

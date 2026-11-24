# 0007 — One `vibe-acp` process per model; configuration via process env, not persisted config

## Status

Accepted (2026-11-24).

## Context

ADR-0001 fixes the transport (ACP via `vibe-acp`); ADR-0005 says models and
auth come from Vibe and must not be hardcoded. Two mechanisms turned out to
be unsuitable on `vibe-acp` 3.1.4 (evidence: docs/research/
2026-11-24-vibe-acp-surface.md):

- `session/set_config_option {configId: "model"}` writes the user's
  `~/.vibe/config.toml` (default layer), i.e. it permanently changes the
  model the user's own Vibe CLI starts with. The bridge must not do that.
- A single process per Pi session cannot switch models per turn without
  persisting.

Vibe's config stack has an environment layer (`VIBE_*`,
`core/config/layers/environment.py`) ranked above user/project TOML, so env
wins without writing files. Verified on 3.1.4 by config parse and by live
Stage-1/Stage-3 runs.

The model list itself comes from a remote catalog over ACP `configOptions`
but its aliases change between runs (observed `mistral-large-4-0-3` →
`mistral-large-4-0` one minute apart), so the bridge must re-read it and treat
aliases as unstable identifiers; the stable handle is the API model id in the
option's `description`.

## Decision Drivers

- Never write to the user's Vibe configuration.
- Model switch per Pi turn must be cheap (no process spawn per turn if
  avoidable, but correctness first).
- Models must not be hardcoded (AGENTS.md §9).
- Depend on documented surface as far as possible (AGENTS.md §16).

## Options Considered

1. **`set_config_option model` per turn** — rejected: persists to
   `config.toml`, a silent side effect on the user's own setup.
2. **One process per Pi session, no model switching** — rejected: Pi users
   switch models freely; ADR-0003 rebuild would be forced every switch.
3. **One process per model, env-configured** — chosen.

## Decision

- The bridge keeps a pool of `vibe-acp` processes keyed by model alias:
  lazily spawned on first use, reused across sessions, killed on idle
  timeout and on Pi shutdown. `VIBE_ACTIVE_MODEL=<alias>` selects the model;
  a Pi model switch just routes to another pooled process.
- All bridge-specific Vibe configuration is passed through the child process
  environment and listed in exactly one module, `src/vibe-protocol.ts`,
  each entry with a comment naming the Vibe version it was verified against
  and a unit test that pins the key names:
  `VIBE_ACTIVE_MODEL`, `VIBE_DEFAULT_APPROVAL_POLICY`,
  `VIBE_ENABLE_AUTO_APPROVE`, `VIBE_ENABLED_TOOLS`, `VIBE_MCP_SERVERS`.
- AskVibe sessions (ADR-0004) run in their own process(es) without the
  provider-mode restrictions.
- The model list for `registerProvider` is read from an ACP session's
  `model` config option (cached, refreshed in the background on each Pi
  start); the cache stores the API model id (option `description`), not the
  volatile alias, and Pi model ids are built as `<providerName>/<api id>`.
- Capability enrichment (context window, reasoning, image input) comes from
  `usage_update.size` where available and otherwise from Pi's own registry
  by id match; never from hardcoded tables (AGENTS.md §9).

## Consequences

- Switching models in Pi spawns a process the first time only; process count
  is bounded by the idle-timeout reaper.
- AGENTS.md §16 is extended: the `VIBE_*` env layer is accepted as part of
  Vibe's configuration surface (referenced in Vibe's changelog), but every
  variable the bridge sets is pinned in `src/vibe-protocol.ts` with tests, so
  a Vibe upgrade that renames one fails loudly in CI, not silently in
  production.
- The volatile alias problem is handled by keying everything on the API
  model id.

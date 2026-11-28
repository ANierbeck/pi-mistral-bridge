# 0011 — Diagnostics commands and warning routing

## Status

Proposed (2026-11-28). Implementation: PR #23
(`/mistral-bridge.doctor`, `/mistral-bridge.models`, `src/notify.ts`).

## Context

The bridge's failure modes — no `mistral-bridge` models in the picker, a
failing discovery, a `providerName` that collides with a provider Pi already
registers, a refresh that silently keeps the old list — reach the user only as
`process.stderr` lines. In the interactive TUI a raw stderr write paints over
the rendered frame and is gone from the transcript, so without a debug log the
user has no in-product way to tell "Vibe is not signed in" from "wrong config"
from "provider name collision". The reference project (pi-antigravity) exposes
the same information through a `/<plugin>.doctor` slash command; this ADR
records the equivalent for this bridge and where runtime warnings go.

## Decision Drivers

- Diagnosability from inside Pi: one command that answers "what is the bridge
  doing right now" without reading `~/.pi/agent/logs/`.
- The bridge must not print secrets: no token, prompt or transcript content in
  diagnostics (AGENTS.md §14), and untrusted fields (config values, model names,
  discovery errors) must not inject terminal control sequences.
- Warnings must be visible in the TUI without corrupting it.
- The command surface must work before a session exists (print/RPC mode) and in
  the provider-name collision state, where nothing was registered.
- No new dependency, no network, no new config key.

## Options Considered

1. **Log-only diagnostics (status quo)** — keep stderr plus the debug log.
   Rejected: invisible in the TUI, and the debug log requires restarting with
   `"debug": true`.
2. **Slash commands over Pi's extension command API, warnings through
   `ctx.ui.notify` once a session exists** — chosen.
3. **Write everything to stdout always** — rejected: in TUI mode the raw write
   corrupts the frame; stdout remains the channel for print/RPC (`hasUI:
   false`).

## Decision

- `/mistral-bridge.doctor` renders one report: provider name, `vibe-acp` command,
  which config files exist (global + project, with presence state), effective
  timeouts (tool, abort, discovery, startup discovery, idle, refresh),
  `ask_vibe` and debug state, registered models with their Vibe aliases, the last
  discovery outcome (success/failure, age, retained model count) and a
  remediation hint. It never prints a token, prompt or transcript content, and
  every untrusted field is stripped of terminal control sequences; `Bearer`
  values are redacted.
- `/mistral-bridge.models [refresh]` lists the registered models; `refresh` runs
  a new discovery first. Both commands explain a provider-name collision instead
  of printing an empty list.
- Output channel: `ctx.ui.notify` when `ctx.hasUI`, stdout otherwise.
- Runtime warnings and anomalies (provider, catalog refresh, AskVibe pool) go
  through one session notifier: `process.stderr` with the
  `pi-mistral-bridge: ` prefix before `session_start` (no context yet),
  `ctx.ui.notify(…, 'warning')` afterwards. A session shutdown detaches it.
- `ModelCatalog` records the outcome of its most recent discovery
  (`lastDiscovery`) for the doctor; an abort caused by `dispose()` is not
  recorded as a failure.
- A discovery result is published to Pi BEFORE the catalog commits its own
  state, so a throwing publication (e.g. `registerProvider` rejecting the list)
  is retried by the next discovery instead of leaving Pi with a list the catalog
  believes it published.

## Consequences

- The doctor report's line shape is part of the bridge's observable surface;
  changing it needs no new ADR (it is diagnostic output, not a machine-matched
  contract like ADR-0010's prefix), but the commands stay stable across
  versions.
- Warnings now appear in the transcript, which is slightly noisier than a
  stderr line nobody saw; a failed background refresh is reported once per
  refresh tick while the failure persists.
- `hasUI: false` output is sanitized too, so a crafted project config or model
  name cannot drive a headless terminal.

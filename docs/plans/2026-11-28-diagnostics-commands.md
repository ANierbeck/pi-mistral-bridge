# Plan — diagnostics commands and warning routing (2026-11-28)

Design record for PR #23 (ADR-0011). Scope: make the bridge's state readable
from inside Pi and stop warnings from painting over the TUI.

## Problem

The bridge reports problems as `process.stderr` lines. Under the TUI that write
corrupts a frame and never reaches the transcript, so a user with an empty model
picker cannot tell "Vibe is not signed in" from "wrong config" from "provider
name collision" without restarting with `"debug": true`.

## Work

1. `src/notify.ts` — `createSessionNotifier()`: one warning channel. `stderr`
   with the `pi-mistral-bridge: ` prefix until `session_start` hands over the Pi
   context, `ctx.ui.notify(…, 'warning')` afterwards, `stderr` again after
   `session_shutdown` detaches the context.
2. `src/index.ts` — create one notifier, pass it to the provider and the AskVibe
   pool (both used `stderr` directly through their default anomaly sink), attach
   it in `session_start`, detach in `session_shutdown`. Also pass the
   notifier-backed anomaly to `ModelCatalog`, so a failed background refresh is
   visible in the UI.
3. `src/models.ts` — `DiscoveryOutcome` + `lastDiscovery` getter, recorded for
   every attempt (initial discovery and background refresh). An abort caused by
   `dispose()` is not recorded. A discovery result is published before the
   catalog commits it, so a throwing `onModels` is retried by the next
   discovery.
4. `src/commands.ts` — `/mistral-bridge.doctor` and
   `/mistral-bridge.models [refresh]`. Report: provider, `vibe-acp` command,
   config files (present/absent), timeouts, `ask_vibe`/debug state, models with
   aliases, discovery outcome, remediation hint. Output goes to
   `ctx.ui.notify` when `hasUI`, stdout otherwise; every untrusted field is
   stripped of terminal control characters and `Bearer` values are redacted.
   Commands are registered in both the normal and the provider-name-collision
   branch.
5. Tests: `test/commands.test.ts` (report builder, channel selection, refresh,
   collision, sanitation, notifier), `test/models.test.ts`
   (`lastDiscovery`, publish-before-commit retry, dispose abort),
   `test/index.test.ts` (command registration, notifier lifecycle, refresh
   anomaly reaching the UI).
6. Docs: README "Commands" + troubleshooting, CHANGELOG, ADR-0011.

## Non-goals

- No new config keys, no network access, no change to discovery semantics.
- The doctor does not read the Vibe credential store (AGENTS.md §14).

## Verification

`npm run typecheck`, `node scripts/lint.ts`, `node scripts/format.ts`,
`npx vitest run`, `npm run build`.

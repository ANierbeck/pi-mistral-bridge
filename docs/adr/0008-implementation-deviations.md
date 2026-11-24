# 0008 — Implementation-round deviations, proposed as amendments to ADR-0003, ADR-0004 and ADR-0005

## Status

Proposed (2026-11-24). Would amend ADR-0003, ADR-0004 and ADR-0005 — awaiting owner acceptance.

## Context

The implementation plan
([docs/plans/2026-11-24-implementation.md](../plans/2026-11-24-implementation.md),
T5–T7) recorded five places where the shipped code deliberately narrows what
ADR-0003, ADR-0004 and ADR-0005 say — the three ADR-0004 deviations in T6 plus
the T5/T7 known gaps for ADR-0003/ADR-0005 — and flagged them for this ADR
round. Accepted ADRs are immutable (AGENTS.md §12), so the deviations may not
be written into the old ADR bodies; this ADR proposes them as amendments
instead.

Every claim below was verified against the code at commit 9f3c091 (the src/
tree is unchanged since 828f223)
(`src/ask-vibe.ts`, `src/vibe-protocol.ts`, `src/config.ts`, `src/acp-client.ts`,
`src/session-map.ts`, `src/models.ts`, `src/index.ts`);
line numbers are given so a reviewer can re-check. Verified against
`vibe-acp` 3.1.4 and Pi 1.6.0 (README, "Verified against").

## Decision Drivers

- Accepted ADRs are immutable; corrections are new ADRs that cite the old
  one (AGENTS.md §12).
- Pi 1.6.0's public extension API has no agent-mode registration, so AskVibe
  is a plain Pi tool; keeping it session-less keeps the ADR-0003 provider-mode
  history logic untouched.
- The bridge never reports or grants what it did not actually set: an unknown
  `session/set_mode` id is a silent no-op on vibe-acp 3.1.4, and
  `smart-approve`/`auto-approve` are never used (AGENTS.md §15).
- One permission rule across both modes is simpler and safer than per-mode
  rules; ADR-0006 forbids persisting permissions in provider mode.
- Rebuild triggers should match how Pi actually delivers changes; a trigger
  that can never fire is dead weight.
- A cache adds a staleness class; re-discovery per Pi start is one cheap
  handshake with no prompt and no model usage.

## Options Considered

1. **Edit ADR-0003/0004/0005 in place** — forbidden by AGENTS.md §12.
2. **Leave the deviations only in the plan** — a plan is not the rulebook;
   code and ADRs would disagree silently for the next session.
3. **A new ADR that proposes the five deviations as amendments** — chosen.

## Decision

Five amendments — three narrowing ADR-0004 (AskVibe), one each amending
ADR-0003 and ADR-0005:

1. **Amends ADR-0004 (AskVibe tool params).** The AskVibe Pi tool accepts only
   `question` (required) and `mode` (optional): `parameters: Type.Object({
   question: Type.String(...), mode: Type.Optional(StringEnum(ASK_VIBE_MODES, ...)) })`
   (src/ask-vibe.ts:511–521; `ASK_VIBE_MODES = ['ask', 'plan', 'edit']`,
   src/config.ts:56). ADR-0004's optional `model` and `continue` params are not
   implemented: every call uses the AskVibe process-pool entry with key
   `undefined` — "Vibe's own default model (no `VIBE_ACTIVE_MODEL`)"
   (`pool.get(undefined)`, src/ask-vibe.ts:323–324; the AskVibe pool is spawned
   without `VIBE_ACTIVE_MODEL`, src/acp-client.ts:1115 and 1152) — and always
   opens a fresh ephemeral ACP session for the call (`proc.newSession(...)`,
   src/ask-vibe.ts:325, closed in the `finally` at src/ask-vibe.ts:409–413), so
   no previous AskVibe session is ever resumed. Rationale: Pi 1.6.0's public
   extension API has no agent-mode registration, so AskVibe is a plain Pi tool
   (ADR-0004 Option 2, src/ask-vibe.ts:6–9), and always-ephemeral sessions keep
   the ADR-0003 delta/rebuild logic untouched — AskVibe uses no session map,
   so provider-mode histories never mix in.

2. **Amends ADR-0004 (AskVibe mode validation and fallback).** The requested
   `mode` is mapped to a Vibe approval-policy id by `vibeModeIdFor`
   (src/vibe-protocol.ts:403; `ASK_VIBE_MODE_IDS`: `ask`→`ask`, `plan`→`plan`,
   `edit`→`accept-edits`, src/vibe-protocol.ts:396–401) and validated against
   the session's advertised modes before `session/set_mode`:
   `resolveEffectiveVibeModeId(requestedVibeModeId, session.modes ??
   modeStateFromConfigOptions(session.configOptions))` (src/ask-vibe.ts:339–340,
   src/vibe-protocol.ts:445). vibe-acp ≥ 3.0 removed `plan`, and an unknown mode
   id makes `session/set_mode` a silent no-op on 3.1.4, so an unavailable
   request falls back along `MODE_FALLBACK_CHAIN` (src/vibe-protocol.ts:414–420)
   to the closest SAFE available mode (`plan`→`ask`, `edit`→`accept-edits`→`ask`)
   — never `smart-approve` or `auto-approve` (AGENTS.md §15) — and the
   effective mode is reported in the tool result details
   (`details.vibeModeId = resolution.modeId`, `details.modeNote`,
   src/ask-vibe.ts:341–344; set via `session.setMode(resolution.modeId)`,
   src/ask-vibe.ts:348). The bridge never reports a mode that was not actually
   set.

3. **Amends ADR-0004 (AskVibe permissions).** Persisting permission options
   are never granted in AskVibe mode. In `handlePermissionRequest`
   (src/ask-vibe.ts:434) an option is refused when
   `option.kind === 'allow_always' || option.optionId.startsWith('allow_always')`
   (src/ask-vibe.ts:474) — matched by kind OR id prefix, so a mismatched id
   cannot slip through — and is downgraded to `allow_once` plus a logged
   anomaly (src/ask-vibe.ts:475–479). All non-persisting options are still
   answered verbatim; without a UI the request is still rejected unless the
   explicit opt-in `askVibe.autoApprove` answers `allow_once`. Rationale:
   AskVibe sessions are ephemeral, so "always" has no meaning across calls;
   ADR-0006 forbids persisting permissions in provider mode; keeping one rule
   for both modes is simpler and safer. The bridge never grants a permission
   it will not remember.

4. **Amends ADR-0003 (rebuild triggers).** The bridge keys sessions by Pi
   sessionId only; a cwd change is NOT a rebuild trigger. `sessionKey` returns
   `options.sessionId` when the agent loop provides it
   (src/session-map.ts:167–172), and `decideFlow` (src/session-map.ts:102) has
   no cwd input at all: `DecideFlowInput` carries only `messages` and
   `modelAlias`, `SessionState` records no cwd, and the string `cwd` appears
   nowhere in src/session-map.ts. Rationale: Pi ties the cwd to the session,
   and a replaced session fires `session_shutdown`, which disposes the
   runtime (src/index.ts:146–147 and 224–225) — so in practice a cwd change
   arrives as a fresh runtime, never as a stale-cwd reuse. The cwd trigger
   listed in ADR-0003 is redundant.

5. **Amends ADR-0005 (model catalog cache).** The "cached under the bridge's
   own cache file" mechanism from ADR-0005 is not implemented: `ModelCatalog`
   (src/models.ts:255) keeps the catalog in memory only — `entries`,
   `aliasByApiId`, `modelsValue` and `capabilities` are plain `Map`s and the
   module performs no file I/O (no `fs` usage in src/models.ts) — and
   re-discovers the model list on every Pi start. The implemented shape: the
   registered Pi model id is `<providerName>/<apiModelId>`
   (`toProviderModel`, src/models.ts:410–417, `id: discovered.apiId`); the
   alias map (`aliasMap`, src/models.ts:281–283) is the routing key to the
   per-alias process pool (ADR-0007); the capability cache is keyed by the
   stable API model id, never by the volatile alias (src/models.ts:263–264,
   per ADR-0007). Rationale: `vibe-acp` model lists change frequently and
   re-discovery costs one `initialize`/`session_new` per Pi start with no
   prompt sent (no model usage); a cache file adds staleness risk without
   measurable benefit.

## Consequences

- Code and ADRs agree again; the plan's "Deviations" / "Known gaps" sections
  (T6, T5/T7) are now fully encoded here.
- AskVibe callers cannot select a model or resume a previous AskVibe session:
  every call runs on Vibe's default model on a fresh ephemeral ACP session.
  Accepted: Pi 1.6.0 has no agent-mode API (ADR-0004 Option 2), and ephemeral
  sessions keep the ADR-0003 provider-mode history logic untouched.
- A `plan` request on vibe-acp ≥ 3.0 is effectively answered in `ask` mode;
  the effective mode is visible in the tool result details (`vibeModeId` /
  `modeNote`). The bridge never falls back to `smart-approve` or `auto-approve`.
- AskVibe users cannot grant a permission "always"; every call re-asks.
  Acceptable: AskVibe sessions are ephemeral, so a persisted grant would
  outlive the session it was granted in.
- A cwd change relies on Pi replacing the session (firing `session_shutdown`).
  If a future Pi ever changed the cwd within one session id, the ACP session
  would keep the old cwd — accepted risk; not observed on Pi 1.6.0, and the
  digest / system-prompt checks in `decideFlow` still force a rebuild
  whenever the history actually diverges.
- The provider's model list is empty until the first discovery completes on
  each Pi start; `registerProvider` is always called with the full, current
  list on every change (AGENTS.md §6). The first Pi start after a Vibe model
  release therefore picks up new models immediately — the benefit this
  amendment trades the cache file for.

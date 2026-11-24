# 0008 — Implementation-round deviations, accepted as amendments to ADR-0003, ADR-0004 and ADR-0005

## Status

Accepted (2026-11-24). Amends ADR-0003, ADR-0004 and ADR-0005.

## Context

The implementation plan
([docs/plans/2026-11-24-implementation.md](../plans/2026-11-24-implementation.md),
T5–T7) recorded three places where the shipped code deliberately narrows what
ADR-0003, ADR-0004 and ADR-0005 say, and flagged them for this ADR round.
Accepted ADRs are immutable (AGENTS.md §12), so the deviations may not be
written into the old ADR bodies; this ADR accepts them as amendments instead.

Every claim below was verified against the code at commit 828f223
(`src/ask-vibe.ts`, `src/session-map.ts`, `src/models.ts`, `src/index.ts`);
line numbers are given so a reviewer can re-check. Verified against
`vibe-acp` 3.1.4 and Pi 1.6.0 (README, "Verified against").

## Decision Drivers

- Accepted ADRs are immutable; corrections are new ADRs that cite the old
  one (AGENTS.md §12).
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
3. **A new ADR that accepts the three deviations as amendments** — chosen.

## Decision

Three amendments:

1. **Amends ADR-0004 (AskVibe permissions).** Persisting permission options
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

2. **Amends ADR-0003 (rebuild triggers).** The bridge keys sessions by Pi
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

3. **Amends ADR-0005 (model catalog cache).** The "cached under the bridge's
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
  (T6, T5/T7) are now encoded here.
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

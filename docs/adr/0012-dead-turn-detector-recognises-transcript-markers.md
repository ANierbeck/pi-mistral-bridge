# 0012 — Dead-turn detector also recognises fabricated transcript markers (extends ADR-0010)

## Status

Proposed (2026-11-28).

## Context

ADR-0010 defines a response as dead when it has no real `toolCall` block and
a text block matches the imitated tool-call pattern, and it states that
changing the detector semantics later needs a new ADR. The pattern then
recognised only the `[tool <name> {` shape.

Since 0.1.3 the rebuild transcript renders past tool activity as delimited
records (`--- past tool call pi__<name> ---`, `--- past tool result
pi__<name> ---`). Observed twice on one large model in the owner's router
session (2026-11-28, both right after a compaction): the model continued
that transcript as plain text — fabricated calls and results in exactly the
bridge's own marker format — and ended with `stopReason: stop` and no real
`toolCall`. The old pattern did not match, so neither the corrective prompt
nor the failure text fired and the turn ended silently with fabricated tool
output. Evidence stays in the owner's local session files (§8); the tests
use synthetic fixtures. PR #20 (merged 2026-11-28, plan
`docs/plans/2026-11-28-dead-turn-transcript-imitation.md`) widened the
detector accordingly; this ADR records that decision.

## Decision Drivers

- A silent dead turn is the worst outcome ADR-0010 exists to prevent.
- The recovery path (one corrective prompt, a second occurrence ends the
  turn as an error) is already accepted and stays unchanged.
- The widened pattern must not fire on the bridge's own `HISTORY_PREAMBLE`
  being echoed back.

## Options Considered

1. **Extend the detector with the bridge's own marker shapes** — chosen.
2. **Change the transcript format again** — rejected: 0.1.3 just changed it
   to make it non-imitable; the models still continue the pattern they are
   shown.
3. **Leave it to the user to notice** — rejected: that was the observed
   failure.

## Decision

- `findImitatedToolCallText` also treats a line-initial
  `--- past tool call pi__<name>` or `--- past tool result pi__<name>`
  marker (optional blockquote prefixes and leading whitespace allowed) as
  imitation evidence, in a response with no real `toolCall` block. The real
  `toolCall` guard is unchanged, so legitimate quoting next to a real call
  is never dead.
- `DEAD_TURN_CORRECTION_PROMPT`, `DEAD_TURN_FAILURE_TEXT` and the
  one-retry-then-error contract of ADR-0010 are unchanged.

## Consequences

- A healthy tool-less answer that quotes such a marker at the start of a
  line (for instance when discussing the bridge's transcript format) costs
  one corrective turn; a second such answer ends the turn as an error. This
  false-positive exposure is accepted, as in ADR-0010.
- The marker shapes are now part of the bridge's observable behaviour:
  changing the transcript format later means revisiting this detector in the
  same change.

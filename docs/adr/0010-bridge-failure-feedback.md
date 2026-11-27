# 0010 — Bridge failure feedback contract

## Status

Accepted (2026-11-27).

## Context

Two real sessions died silently after history rebuilds: the serving model
answered with the literal text of a tool call instead of real tool-call
blocks (evidence: the router-fork session of 2026-11-21, entries 2798 and
2824, and the bridge session of 2026-11-24, entry 1609), and each turn ended
like a normal stop — `stopReason: stop`, no tools run, no error. Neither Pi,
the owner, nor a downstream model router can distinguish such a dead turn
from a healthy one.

The transcript side of the problem is addressed by rendering rebuild
records in a non-imitable delimited format (commit `2a7b3ea`, plan
`docs/plans/2026-11-27-rebuild-literal-tool-text.md`); the dead-response
detector `findImitatedToolCallText` (`src/transcript.ts`) already exists.
This ADR records the turn-handling and feedback side. Related: ADR-0003
(history delta with rebuild fallback — the dirty marking reused here) and
ADR-0006 (provider-mode permissions and tool gating).

## Decision Drivers

- Dead turns must be detectable by Pi, the owner and downstream tooling
  (e.g. a model router) without access to bridge internals.
- The bridge must not synthesize or execute tool calls on the model's
  behalf (ADR-0002: Pi owns the agent loop).
- Corrective turns cost model allowance; the mechanism must bound them.
- The feedback contract must be stable and machine-matchable across
  bridge versions.

## Options Considered

1. **Format fix only** — rely on the non-imitable records to prevent
   imitation, no turn handling. Rejected as the sole measure: a dead turn
   would remain silent whenever imitation happens anyway (e.g. driven by
   a compaction, not by the bridge's own rebuild prompt).
2. **Corrective retry plus explicit failure feedback** — detect dead
   responses, give the model exactly one corrective prompt in the same ACP
   session, and turn a second consecutive dead response into an explicit
   error with a stable prefix. Chosen.
3. **Parse and execute the imitated calls bridge-side** — rejected: the
   bridge would fabricate tool executions Pi never requested (violates
   ADR-0002) and would have to parse arbitrary malformed text.

## Decision

- A response is **dead** when it contains zero real `toolCall` blocks and
  at least one text block matches the imitated tool-call pattern
  (`findImitatedToolCallText`, `src/transcript.ts`).
- On a dead response the bridge sends **exactly one corrective prompt**
  into the same ACP session (a fixed text instructing the model to re-issue
  the calls through the tool-calling interface) and streams the corrected
  response as a continuation of the same Pi turn. After a corrective retry
  the session is marked **dirty**, so the next `streamSimple` rebuilds
  (ADR-0003).
- If the corrective response is dead again, the turn ends with
  `stopReason: "error"` and a text block starting with the stable prefix
  `mistral-bridge:` describing the failure. That prefix together with the
  error stop reason is the contract downstream consumers may match on.
- The bridge never executes, rewrites or fakes tool calls itself.

## Consequences

- False positives cost one corrective model turn (e.g. an analysis reply
  that quotes the tool-call syntax without intending a call); accepted.
- The imitated text of a dead response stays verbatim in the delivered Pi
  message and hence in the session history; a later rebuild may re-present
  it as plain text. Accepted: the per-settle detection window keeps it from
  re-triggering recovery, and the rebuild preamble teaches that transcript
  records are history, never to be imitated.
- A session that needed a corrective retry is rebuilt on the next turn
  (conservative, ADR-0003) — one extra rebuild in the rare failure case.
- When the corrective response issues real tool calls, the turn ends at the
  tool batch, before the corrective prompt settles; the delivered `toolUse`
  message therefore keeps the usage of the dead response, and the corrective
  response's usage is never added to it (a parked turn's delivered message
  is frozen). Accepted: token accounting for that turn is understated.
- Downstream tooling can react to the `mistral-bridge:` error (fail over,
  surface it to the user) instead of seeing a normal stop.
- The prefix string and the detector semantics become part of the bridge's
  observable behaviour; changing them later needs a new ADR (AGENTS.md
  §12).

# Late MCP call waves while a tool batch is parked

- **Status:** done — 2026-11-28 (red-first: T1, T2, T4 red against the
  unfixed code, T3 a pin; 347 tests, all gates green; fix commit 9532e7a)
- **Problem:** Vibe sometimes issues the parallel tool calls of one model
  step in more than one wave. The MCP bridge groups calls that arrive within
  `DEFAULT_BATCH_WINDOW_MS` (100 ms, `src/mcp-bridge.ts`) into one batch;
  `onBatch` (`src/provider.ts`) turns the batch into Pi `toolCall` blocks and
  ends the Pi turn with `toolUse` while the ACP prompt stays parked
  (ADR-0002). A call that arrives *after* that — while Pi is still executing
  the first batch — finds no live turn whose stream is still open. `onBatch`
  then writes
  `pi-mistral-bridge: MCP batch of N call(s) with no running ACP prompt — dropped`
  to stderr (the message the owner sees in the Pi terminal) and returns. The
  call stays parked in the bridge until the pre-emptive tool timeout
  (`toolPreTimeoutMs`, 55 s, ADR-0006) answers it with an error. The
  user-visible effect is a ~55 s stall of the turn after Pi answered the first
  batch, followed by a "Pi tool did not finish within 55000 ms" error for a
  tool (typically `read`) that Pi never saw.
- **Solution:** A late wave for a prompt whose current Pi turn is already
  parked is queued on that `LiveTurn` (`lateCalls`) instead of being dropped.
  When the next `streamSimple` delivers the results of the parked batch
  (`continueToolResults`), the provider delivers them to the bridge and then
  immediately emits the queued calls as the next batch on the new stream
  (`toolUse`), exactly as `onBatch` would have. Calls that the bridge no
  longer holds as pending (timed out or released in the meantime) are not
  emitted, so Pi never runs a tool whose result would be discarded. When no
  parked prompt can be identified unambiguously (none, or more than one), the
  current behaviour stays: anomaly + drop, answered by the timeout.
- **Open decisions:** none.
- **Verified against:** `main` @ 71c9e90, `vibe-acp` 3.1.4, pi 1.7.0. Code
  claims checked in `src/provider.ts` (`onBatch`, the `continueToolResults`
  branch of `runTurn`, `LiveTurn`), `src/mcp-bridge.ts` (`queueForBatch`,
  `deliverResults`, `newTurn`, `releaseParked`) and `src/session-map.ts`
  (`decideFlow`: a pending batch must be answered exactly by trailing
  toolResults). Evidence: the owner's debug logs of 2026-11-24…28, counted
  with throw-away scripts (no content extracted, §8). Per ACP session (session
  ids are unique, so this count is not affected by the interleaving described
  in [the per-process log plan](2026-11-28-per-process-debug-logs.md)):
  2 700 bridge MCP calls, 12 of them started while an earlier bridge call of
  the same session was still running and more than 150 ms after it (gaps
  0.28 s … 8 s), i.e. outside the batch window. The round trip from batch to
  Pi's results is typically 2–3 s for `read`, so such a wave reaches
  `onBatch` while the turn is parked. Counts from the shared
  `mcp-bridge.jsonl` were discarded: several Pi processes append to it
  without a process id, so turns of different processes interleave.

## Design

1. `LiveTurn` gets `lateCalls: ParkedCall[]` (empty on creation).
2. `onBatch(calls)`:
   - unchanged: a live turn with an unsettled prompt and an open stream takes
     the batch;
   - new: otherwise, if **exactly one** live turn has an unsettled prompt, an
     ended stream and a non-empty `state.pendingToolBatch`, append the calls
     to its `lateCalls` and return — no anomaly (this is now handled
     behaviour);
   - otherwise: unchanged anomaly + drop.
3. The batch-emitting body of `onBatch` (close open text/thinking, set
   `pendingToolBatch`, push `toolCall` blocks, end with `toolUse`,
   `recordSentPrefix`) moves into a private helper used by both paths, so
   the two cannot drift.
4. `continueToolResults` branch: after `bridge.deliverResults(results)` and
   `bridge.newTurn()`, take `lateCalls` (splice), keep only calls the bridge
   still holds as pending, and if any remain emit them as a batch on the
   newly attached stream via the helper.
5. `McpBridge` gets `isPending(callId): boolean` (read-only query over the
   existing `pending` map) for step 4.
6. Abandon paths need no extra code: `startRebuild` deletes the live turn and
   `releaseParked` answers every pending call including late ones; the
   `lateCalls` array dies with the `LiveTurn`.

## Tasks

- [x] T1 (red) — `test/provider.test.ts`: a fake-ACP prompt parks call A;
  the provider emits batch A (`toolUse`); before Pi answers, call B parks
  (second wave). Assert: no anomaly reported; the next `streamSimple` with
  A's result ends with `toolUse` carrying B's `toolCall`; answering B lets
  the prompt finish and Vibe received both results. Observed RED against the
  unfixed provider (anomaly "dropped", B never surfaced).
- [x] T2 (red) — a late call that the bridge timed out before Pi answered
  the first batch is not emitted (`isPending` false); the turn continues
  normally.
- [x] T3 — existing behaviour pinned: a batch with no parked prompt still
  reports the anomaly and drops (keep or adapt the existing test).
- [x] T4 (red) — `test/mcp-bridge.test.ts`: `isPending` true while parked,
  false after `deliverResults`, timeout and `releaseParked`.
- [x] T5 — implement steps 1–5; update the `onBatch` doc comment and the
  module doc of `src/provider.ts`.
- [x] T6 — gates: `npx tsc --noEmit`, `npm run lint`, `npm run format:check`,
  `npx vitest run`, `npm run test:coverage` (thresholds unchanged).
- [x] T7 — CHANGELOG `## Unreleased` entry (Fixed).

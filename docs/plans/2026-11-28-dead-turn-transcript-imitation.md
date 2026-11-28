# Dead-turn detection for transcript-format imitation

- **Status:** done — 2026-11-28 (red-first: 3 detection tests red against the
  unfixed detector, then green; all gates green, see Tasks)
- **Problem:** After a Pi compaction the bridge rebuilds the Vibe session and the
  model's context becomes the bridge's rendered transcript
  (`--- past tool call pi__<name> --- ... --- end past tool result ... ---`) plus
  the compaction summary. Some models (observed twice on mistral-large-4-0,
  router session 2026-11-28) then "continue the transcript" instead of calling
  tools: they fabricate tool calls **and** tool results as plain text in exactly
  the bridge's own marker format (with degenerate repetition inside the
  fabricated results) and end with `stopReason: stop`, no real `toolCall`
  block, no error. The ADR-0010 dead-turn detector
  (`findImitatedToolCallText`, `src/transcript.ts`) only recognizes
  `[tool <name> {`-shaped text (`IMITATED_TOOL_CALL_TEXT_PATTERN`), so this
  variant slips through: no `DEAD_TURN_CORRECTION_PROMPT`, no
  `DEAD_TURN_FAILURE_TEXT`, the turn ends silently and the user sees a stop
  with fabricated tool output. Two confirmed dead turns in the router session
  (2026-11-28 11:25 and 12:35 UTC), both exactly one entry after a compaction,
  both `mistral-large-4-0`, both `thinking`+`text` only; recovery happened
  only because the owner noticed and nudged. Evidence lives in the session
  JSONL (not committed — §8); fixtures below are synthetic replications of
  the shape.
- **Solution:** Extend `findImitatedToolCallText` to also treat the bridge's
  own transcript markers as imitation evidence: a line-initial
  `--- past tool call pi__<name>` or `--- past tool result pi__<name>`
  marker — allowing an optional markdown blockquote prefix (`>`, possibly
  repeated, as observed in the fabricated turns) and leading whitespace —
  in a response that contains **no real `toolCall` block. The existing
  guard (a response with a real toolCall block is never dead) already covers
  legitimate quoting alongside real calls. The ADR-0010 correction path is
  reused unchanged: `DEAD_TURN_CORRECTION_PROMPT` and
  `DEAD_TURN_FAILURE_TEXT` are verbatim by contract and are not modified.
- **Open decisions:** none. False-positive policy: a healthy no-tool-call
  response that quotes a marker line at line start triggers one corrective
  prompt — accepted under ADR-0010's recover-once contract.
- **Verified against:** `main` @ 701d5c5 (worktree
  `.worktrees/fix-dead-turn-transcript-imitation`, branch
  `fix/dead-turn-transcript-imitation`); detection pattern at
  `src/transcript.ts` (`IMITATED_TOOL_CALL_TEXT_PATTERN`,
  `findImitatedToolCallText`); dead-turn handling at `src/provider.ts`
  (fresh-blocks check, `handleDeadTurn`); evidence from the router session
  JSONL (2 dead turns, both 1 entry after a compaction, synthetic replication
  in tests); bridge 0.1.3, pi 1.7.0, vibe-acp 3.1.4. Baseline gates in the
  worktree green before the first task (tsc, lint, format:check, vitest run
  334/334).

## Tasks

1. **Red-first regression tests** in `test/transcript.test.ts` for
   `findImitatedToolCallText` with synthetic fixtures (no session content, §8):
   - fabricated quoted transcript turn (`> --- past tool call pi__bash ---`,
     JSON body, `> --- end past tool call ---`, fabricated result marker),
     no real toolCall block → must be detected (RED against current code);
   - fabricated unquoted marker (`--- past tool call pi__subagent ---`)
     at line start → detected;
   - fabricated result marker only
     (`--- past tool result pi__bash (abc123) ---`) → detected;
   - the same fabricated text alongside a real `toolCall` block → never dead;
   - healthy text without markers, and a marker embedded mid-line
     (not line-initial) → not dead.
   The red evidence (failing test output) is quoted in the report (§4).
   **Done:** describe `findImitatedToolCallText: fabricated transcript markers
   (dead-turn detection, ADR-0010)`; red evidence: 3 failed / 2 passed against
   the unfixed detector.
2. **Implementation** in `src/transcript.ts`: add
   `IMITATED_TRANSCRIPT_MARKER_PATTERN`
   (`/^[ \t]*(?:>[ \t]*)*--- past tool (?:call|result) pi__[A-Za-z0-9_.-]+/m`)
   next to `IMITATED_TOOL_CALL_TEXT_PATTERN`, extend
   `findImitatedToolCallText` to test both patterns, update its doc comment.
   **Done:** as specified; real-toolCall guard kept.
3. **Gates:** `npx tsc --noEmit`, `npm run lint`, `npm run format:check`,
   `npx vitest run`, `npm run test:coverage` with coverage thresholds
   unchanged (§4 floors are never lowered).
   **Done:** tsc/lint/format:check exit 0, vitest 339/339, coverage
   93.03/84.9/88.35/95.11 (transcript.ts 97.14/96.34/100/97.61).

## Constraints for the implementer

- Unit tests only; no network, no real `vibe-acp`, no integration tests
  (`MISTRAL_BRIDGE_IT` stays unset).
- `DEAD_TURN_CORRECTION_PROMPT`, `DEAD_TURN_FAILURE_TEXT` and
  `QUOTA_ERROR_PREFIX` are verbatim by contract — do not touch.
- ADR-0010 and ADR-0003 are accepted ADRs and are not edited (§12); this plan
  extends the detector within ADR-0010's decision.
- All documentation and comments in English (§3).

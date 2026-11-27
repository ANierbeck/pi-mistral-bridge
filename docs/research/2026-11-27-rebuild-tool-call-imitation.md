# Rebuild tool-call imitation — session-log evidence

Date: 2026-11-27 · Method: throw-away log scan (not committed, see "Method")
Feeds `docs/plans/2026-11-27-rebuild-literal-tool-text.md` (transcript format)
and `docs/plans/2026-11-27-bridge-failure-feedback.md` (dead-turn feedback,
ADR-0010).

## Verified against

- Code: main `2a99a56` (line numbers below are from that commit, not from the
  current branch): `src/transcript.ts` :55 (`HISTORY_PREAMBLE`), :99 (tool-call
  rendering), :105 (tool-result rendering); `src/session-map.ts` (`decideFlow`
  rebuild triggers).
- Versions: bridge 0.1.2, pi 1.6.0 (repo devDependency) / 1.6.1 (installed
  globally), vibe-acp 3.1.4.
- Sources: two Pi session logs, cited by file name only (see "Evidence").
  No prompts or session content are reproduced here.

## Summary

After a history rebuild the serving model at times answered with the literal
text of a tool call instead of a real tool call. The rebuild transcript at
`2a99a56` rendered past tool calls as `[tool pi__<name> {…}]` and tool results
as `[tool result pi__<name> <id>]`; the dead responses copied that shape. Each
such turn ended with `stopReason: stop`, no tool ran, and nothing marked the
turn as failed.

## Evidence

- This project's session `2026-11-24T05-33-09-063Z_01a20c0b….jsonl`:
  - Entry 1609 (10:47:29), directly after compaction entry 1608 (10:46:45):
    `mistral-large-4-0` wrote two tool calls as text, `stopReason: stop`.
  - Entry 1445: `zai-glm-5-3`, the same pattern once.
- Router-fork session `2026-11-21T19-23-52-521Z_01a1ff90….jsonl`:
  - Entry 2798 (10:07).
  - Entry 2824 (10:35), directly after compaction entry 2823.
  - This is the incident that started the investigation.

## Root-cause reading

A rebuild (compaction, model switch, dirty session, edited history —
`src/session-map.ts` `decideFlow`) replays the conversation as a plain-text
transcript. At `2a99a56` that transcript rendered past tool calls in a
bracketed `[tool pi__<name> {json}]` shape (`src/transcript.ts` ~:99), which
looks like live tool syntax. The models continued the pattern as literal
text rather than calling the tool through the tool-calling interface. Two of
the four dead entries sit directly after a compaction, which is a rebuild
trigger.

The 0.1.2 `HISTORY_PREAMBLE` fix ("Never write a tool call as text",
`src/transcript.ts` :55) reduces but does not eliminate the imitation.

## Method

The two session logs were scanned on 2026-11-27 with a throw-away log-scan
script that was not committed. Its purpose was to find assistant responses
with tool-call-shaped text and no real tool call; the evidence above lists
the fields it surfaced (entry number, timestamp where recorded, model where
recorded, `stopReason`, adjacent compaction entries). The exact script logic
was not preserved, so the scan cannot be re-run byte-for-byte; this document,
not the script, is the record.

## Limits of the evidence

- Two sessions and four dead entries. That is not a frequency measurement:
  no rate per rebuild, per model or per compaction was computed.
- "Reduces but does not eliminate" for the 0.1.2 preamble is a qualitative
  reading of these entries, not a before/after comparison.
- Not recorded here: the model of the router-fork entries 2798 and 2824, the
  timestamp of entry 1445, and whether entry 1445 followed a rebuild.
- Not checked: other sessions, other Pi or vibe-acp versions, and whether the
  non-imitable record format of the follow-up fix (commit `2a7b3ea`) prevents
  the imitation against the real `vibe-acp`. No integration run was made
  (AGENTS.md §4); the fix is covered by unit tests only.

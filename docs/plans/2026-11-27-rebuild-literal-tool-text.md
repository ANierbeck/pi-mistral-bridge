# Plan: Rebuild transcripts must not render tool calls in an imitable format

**Status:** done — 2026-11-27 (released in 0.1.3)

Sibling plan (second problem, split out per AGENTS.md §11): [`2026-11-27-bridge-failure-feedback.md`](2026-11-27-bridge-failure-feedback.md) — dead turns end silently, no failure feedback (owner requirement C, ADR-0010).

**Problem**

After a history rebuild (compaction, model switch, dirty session, edited history — `src/session-map.ts` `decideFlow`), the bridge renders past tool calls in the rebuild transcript as `[tool pi__<name> {…}]` (`src/transcript.ts` ~:99) and tool results as `[tool result pi__<name> <id>]` (~:105). The serving model at times imitates exactly this syntax as literal text instead of issuing real tool calls. The turn then ends with `stopReason: stop`, no tool runs, and to the user the session "breaks off".

Evidence summary: two real Pi sessions (one of this project, one of the router fork) show four such dead entries, two of them directly after a compaction; the 0.1.2 `HISTORY_PREAMBLE` fix ("Never write a tool call as text", `src/transcript.ts` :55) reduces but does not eliminate the imitation. Entries, method and limits: [`docs/research/2026-11-27-rebuild-tool-call-imitation.md`](../research/2026-11-27-rebuild-tool-call-imitation.md).

**Solution**

**Non-imitable transcript records** (unit-tested; no network, no real `vibe-acp`). `renderTranscript` no longer emits `[tool pi__… {…}]`. Tool calls render as explicitly historical records. Requirement: the rendered transcript must not contain the string `[tool pi__` and must read as a log record, not as a live call. `HISTORY_PREAMBLE` is updated to describe the new record format and keeps the "never write a tool call as text" instruction.

Hardening from the PR #12 review: untrusted content (user text, tool-result bodies, assistant text/thinking) has record-shaped lines quoted with `> `, so tool output cannot forge bridge-generated history records. The bridge's own records stay byte-identical; content without such lines renders unchanged.

**Open decisions**

- Exact record wording (worker proposes, review decides). Proposed in T1 (`2a7b3ea`): `--- past tool call pi__<name> ---` … `--- end past tool call ---` and `--- past tool result pi__<name> (<id>) ---` … `--- end past tool result ---`; final decision with the PR #12 review.

**Verified against**

- Code (main 2a99a56): `src/transcript.ts` :55 (`HISTORY_PREAMBLE`), :99 (tool-call rendering), :105 (tool results); `src/provider.ts` :506–:555 (`startRebuild`, prompt assembly); `src/session-map.ts` (`decideFlow` rebuild triggers incl. model switch per ADR-0007 and compaction).
- Evidence: the two session logs cited in the research doc, analyzed 2026-11-27 with a throw-away log-scan script (not committed).
- Versions: bridge 0.1.2, pi 1.6.0 (repo devDependency) / 1.6.1 (installed globally), vibe-acp 3.1.4.
- Coverage floors in `vitest.config.ts` (88/78/86/92) are unchanged.

## Tasks (subagent-driven, red-first per AGENTS.md §4/§13)

- [x] T1 — (worker, red-first) Transcript format: new tests in `test/transcript.test.ts` (rendered transcript contains no `[tool pi__` and uses the new record format). Observed RED, then implement in `src/transcript.ts`, update `HISTORY_PREAMBLE` (`2a7b3ea`).
- [x] T1a — (worker, red-first, PR #12 review) Forged record delimiters: line-initial record-delimiter shapes in untrusted content are quoted with `> ` (`c29e0fb`; the transcript tests failed against `b8f1cd7` first).
- Review, gates and PR #12 are shared with the sibling plan and tracked there as T4.

Gate commands (each with `timeout 180`): `npx tsc --noEmit`; `npm run lint`; `npm run format:check`; `npx vitest run`; `npm run test:coverage`; `npm run build`; `npm run secret-scan`.

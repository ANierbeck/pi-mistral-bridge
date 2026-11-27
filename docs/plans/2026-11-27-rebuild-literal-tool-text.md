# Plan: Rebuild turns must not die by tool-call imitation — and must report it when they do

**Status:** in progress — 2026-11-27 (owner go on option A, plus requirement C: the bridge must report failures; T1–T3 committed, T4 review/PR underway)

**Problem**

After a history rebuild (compaction, model switch, dirty session, edited history — `src/session-map.ts` `decideFlow`), the bridge renders past tool calls in the rebuild transcript as `[tool pi__<name> {…}]` (`src/transcript.ts` ~:99) and tool results as `[tool result pi__<name> <id>]` (~:105). The serving model at times imitates exactly this syntax as literal text instead of issuing real tool calls. The turn then ends with `stopReason: stop`, no tool runs, and to the user the session "breaks off".

Evidence (session logs, analyzed 2026-11-27):

- This project's session `2026-11-24T05-33-09-063Z_01a20c0b….jsonl`: entry 1609 (10:47:29, directly after compaction 1608 at 10:46:45) — `mistral-large-4-0` wrote two tool calls as text, `stopReason: stop`; also entry 1445 (`zai-glm-5-3`, same pattern once).
- Router-fork session `2026-11-21T19-23-52-521Z_01a1ff90….jsonl`: entries 2798 (10:07) and 2824 (10:35, directly after compaction 2823) — the incident that started this investigation.
- The 0.1.2 `HISTORY_PREAMBLE` fix ("Never write a tool call as text", `src/transcript.ts` :55) reduces but does not eliminate the imitation.

Second problem (owner requirement C): when this happens, the bridge ends the turn like a normal stop. Pi, the owner and the router cannot distinguish a dead turn from a healthy one — there is no feedback channel at all.

**Solution**

Three bridge-side changes (unit-tested against the in-process fake ACP agent; no network, no real `vibe-acp`):

1. **Non-imitable transcript records.** `renderTranscript` no longer emits `[tool pi__… {…}]`. Tool calls render as explicitly historical records. Requirement: the rendered transcript must not contain the string `[tool pi__` and must read as a log record, not as a live call (worker proposes exact wording in the PR). `HISTORY_PREAMBLE` is updated to describe the new record format and keeps the "never write a tool call as text" instruction.
2. **Dead-turn detection and one corrective retry.** New pure detector: a response is *dead* if it contains tool-call-shaped text (an `[tool …`-style call in a text block) and zero real `toolCall` blocks. On a dead response the bridge sends one corrective prompt into the same ACP session (fixed text: re-issue the calls as real tool calls) and streams the corrected response into the same Pi turn. A session that went through a corrective retry is marked dirty so the next turn rebuilds (conservative delta bookkeeping, ADR-0003).
3. **Explicit failure feedback (C).** If the corrective retry is also dead, the bridge ends the turn with `stopReason: error` and appends a text block with the stable prefix `mistral-bridge:` describing the failure. This prefix is the machine-matchable contract for downstream consumers (Pi UI, owner, router extension — the router-side description lives in the pi-model-router-fork repo).

**Open decisions**

- Exact record wording (worker proposes, review decides).
- False positives: an analysis reply that quotes `[tool …]` syntax and makes no real tool calls triggers one corrective turn. Accepted: the cost is one extra model turn; a turn only fails if the model repeats the dead pattern.
- Folding the corrective exchange into delta tracking instead of marking the session dirty — deferred; dirty is the conservative default.

**Verified against**

- Code (main 2a99a56): `src/transcript.ts` :55 (`HISTORY_PREAMBLE`), :99 (tool-call rendering), :105 (tool results); `src/provider.ts` :506–:555 (`startRebuild`, prompt assembly); `src/session-map.ts` (`decideFlow` rebuild triggers incl. model switch per ADR-0007 and compaction).
- Evidence: the two session logs cited above, analyzed 2026-11-27 with a throw-away log-scan script (not committed).
- Versions: bridge 0.1.2, pi 1.6.0 (repo devDependency) / 1.6.1 (installed globally), vibe-acp 3.1.4.
- Coverage floors in `vitest.config.ts` (88/78/86/92) are unchanged.

## Tasks (subagent-driven, red-first per AGENTS.md §4/§13)

- [x] T1 — (worker, red-first) Detector + transcript format: new tests in `test/transcript.test.ts` (rendered transcript contains no `[tool pi__` and uses the new record format; detector flags a dead response and ignores responses with real tool calls). Observed RED, then implement in `src/transcript.ts`, update `HISTORY_PREAMBLE`.
- [x] T2 — (worker, red-first) Provider recovery: tests against the fake ACP agent — dead response triggers exactly one corrective prompt, healthy retry continues the turn, session marked dirty; a second dead response ends the turn with `stopReason: error` and a `mistral-bridge:`-prefixed feedback block. Then implement in `src/provider.ts` (+ dirty marking via `src/session-map.ts`).
- [x] T3 — (worker) ADR-0010 Proposed: bridge failure feedback contract (cites ADR-0003/0006; content specified in the task brief).
- [ ] T4 — (controller, in progress) Gates re-run, diff review, reviewer subagent, PR to `main`.

Gate commands (each with `timeout 180`): `npx tsc --noEmit`; `npm run lint`; `npm run format:check`; `npx vitest run`; `npm run test:coverage`; `npm run build`; `npm run secret-scan`.

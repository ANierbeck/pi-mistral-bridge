# Plan: Dead provider turns must report failure instead of ending like a normal stop

**Status:** in progress — 2026-11-27 (owner requirement C; T2, T3 and the PR #12 review-fix round committed, T4 review/PR #12 open)

Sibling plan (first problem, split out per AGENTS.md §11): [`2026-11-27-rebuild-literal-tool-text.md`](2026-11-27-rebuild-literal-tool-text.md) — rebuild transcripts rendered tool calls in an imitable format. Evidence for both: [`docs/research/2026-11-27-rebuild-tool-call-imitation.md`](../research/2026-11-27-rebuild-tool-call-imitation.md).

**Problem**

When the serving model answers with the literal text of a tool call instead of a real tool call (a *dead* response, see the sibling plan and the research doc), the bridge ends the turn like a normal stop: `stopReason: stop`, no tool runs, no error. Pi, the owner and the router cannot distinguish a dead turn from a healthy one — there is no feedback channel at all.

**Solution**

Two bridge-side changes (unit-tested against the in-process fake ACP agent; no network, no real `vibe-acp`), recorded as ADR-0010 (Proposed):

1. **Dead-turn detection and one corrective retry.** New pure detector: a response is *dead* if it contains tool-call-shaped text (an `[tool …`-style call in a text block) and zero real `toolCall` blocks. On a dead response the bridge sends one corrective prompt into the same ACP session (fixed text: re-issue the calls as real tool calls) and streams the corrected response into the same Pi turn. A session that went through a corrective retry is marked dirty so the next turn rebuilds (conservative delta bookkeeping, ADR-0003).
2. **Explicit failure feedback (C).** If the corrective retry is also dead, the bridge ends the turn with `stopReason: error` and appends a text block with the stable prefix `mistral-bridge:` describing the failure. This prefix is the machine-matchable contract for downstream consumers (Pi UI, owner, router extension).

**Open decisions**

- False positives: an analysis reply that quotes `[tool …]` syntax and makes no real tool calls triggers one corrective turn. Accepted: the cost is one extra model turn; a turn only fails if the model repeats the dead pattern.
- Folding the corrective exchange into delta tracking instead of marking the session dirty — deferred; dirty is the conservative default.
- The router-side consumer of the `mistral-bridge:` prefix is out of scope here; it is described in the router fork repository's own plan.

**Verified against**

- Code (main 2a99a56): `src/provider.ts` :506–:555 (`startRebuild`, prompt assembly); `src/session-map.ts` (`decideFlow` rebuild triggers).
- Code (branch HEAD `c29e0fb`): `src/transcript.ts` (`findImitatedToolCallText`), `src/provider.ts` (dead-turn recovery, abort before the corrective prompt), ADR-0010 (Proposed).
- Versions: bridge 0.1.2, pi 1.6.0 (repo devDependency) / 1.6.1 (installed globally), vibe-acp 3.1.4.
- Gates at `c29e0fb`: tsc, lint, format:check, vitest (257 passed), test:coverage (92.87/84.11/87.71/94.96), build, secret-scan — all green. Coverage floors in `vitest.config.ts` (88/78/86/92) are unchanged.

## Tasks (subagent-driven, red-first per AGENTS.md §4/§13)

- [x] Detector — the pure detector `findImitatedToolCallText` and its tests in `test/transcript.test.ts` landed with T1 of the sibling plan (`2a7b3ea`).
- [x] T2 — (worker, red-first) Provider recovery: tests against the fake ACP agent — dead response triggers exactly one corrective prompt, healthy retry continues the turn, session marked dirty; a second dead response ends the turn with `stopReason: error` and a `mistral-bridge:`-prefixed feedback block. Then implement in `src/provider.ts` (+ dirty marking via `src/session-map.ts`) (`fee84e7`).
- [x] T3 — (worker) ADR-0010 Proposed: bridge failure feedback contract (cites ADR-0003/0006; content specified in the task brief) (`3e0369e`, residual-imitated-text consequence `db98b1a`).
- [x] Review-fix round — settled ACP usage recorded on dead turns, abort during the corrective retry pinned (`b8f1cd7`); PR #12 review (`c29e0fb`): a Pi abort before the corrective prompt ends the turn aborted and sends nothing, the corrective response's usage is pinned, and the rebuild after a corrective tool call is pinned.
- [ ] T4 — (controller, in progress) Gates re-run, diff review, reviewer subagent, PR #12 to `main` with every review read and resolved (AGENTS.md §8).

Gate commands (each with `timeout 180`): `npx tsc --noEmit`; `npm run lint`; `npm run format:check`; `npx vitest run`; `npm run test:coverage`; `npm run build`; `npm run secret-scan`.

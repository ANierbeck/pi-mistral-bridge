# Resume per-model ACP sessions instead of rebuilding on a model switch

**Status:** approved for the spike (steps 0–2) — 2026-11-28; implementation
(steps 4–6) waits for the spike findings and an owner decision.

## Problem

Every time a Pi session enters a bridge model after another model, the
bridge does a **full rebuild** (ADR-0003). `decideFlow` returns
`rebuild('model switch A -> B (ADR-0007)')` (`src/session-map.ts:107`).
`openNewSession` then cancels and **closes** the previous ACP session
(`src/provider.ts:568-569`), opens a new one on the target model's process
and replays the whole history as a transcript.

The rebuild is the riskiest turn type. All four dead entries in the
2026-11-27 diagnosis followed a rebuild
(`docs/research/2026-11-27-rebuild-tool-call-imitation.md`). It also costs a
full history replay and drops Vibe's prompt cache.

The dynamic router switches models on purpose, and also by failover inside
one turn. For the owner's sessions 2026-11-18..28, the router side counted
18 entries into a bridge model after another model, 12 of them inside one
turn. **The bridge has not verified this count.** It does not log flow
decisions, so the count comes from the router.

`SessionState` holds exactly one ACP session per Pi session
(`acpSessionId`, `modelAlias`, `digestOfSentPrefix`, `sentCount`). On
A → B → A nothing of A's session survives, even though A's `vibe-acp`
process may still be alive. The pool reaps idle processes after 10 min,
`DEFAULT_PROCESS_IDLE_TIMEOUT_MS` (`src/config.ts:30`).

## Solution (proposed, to be confirmed by the spike)

1. **Per-model state.** For each Pi session, keep one record per model alias:
   `{ acpSessionId, digestOfSentPrefix, sentCount, systemPromptDigest }`.
   The flow state that belongs to the *active* model stays as today:
   `pendingToolBatch`, `dirty`, the live turn.
2. **Return to a known model = catch-up, not rebuild.** A request for alias
   A goes through these checks:
   - The bridge needs a record for A whose system-prompt digest matches and
     whose prefix digest matches `messages.slice(0, sentCount)`.
   - It then reattaches A's ACP session. Which mechanism it uses depends on
     spike Q1:
     - **(a)** A's session was kept open in A's process.
     - **(b)** It was closed as today and is reopened with `session/load`
       or `session/resume`. Vibe 3.1.4 serves both from its own session
       store via `ResumeSessionIntent` (`vibe/acp/agent.py:573`, `:1158`).
       `session/close` only drops the session from the process
       (`agent.py:1017-1023`).
   - It then sends `messages.slice(sentCount)` (the turns other models
     served in between, plus the new user message) as one **catch-up
     prompt**:
     - The prompt uses the 0.1.3 non-imitable record format of
       `renderTranscript`, with a catch-up preamble.
     - The prompt carries no system prompt, because A's session already has
       it.
   - Any mismatch falls back to today's full rebuild: compaction, `/tree`,
     a changed system prompt, a failed load or resume, or a process that
     died without a loadable session.
3. **After a `vibe-acp` restart**, the bridge tries load or resume (2b)
   before rebuilding. Option (b) covers restarts and idle reaping with the
   same code path.
4. **ADR-0010 stays the safety net.** A catch-up response is checked for
   imitated tool-call text exactly like any other response, with one
   corrective prompt and then `stopReason: 'error'`.
5. **Out of scope:** in-session model switching via
   `set_config_option model`. It writes the user's `~/.vibe/config.toml`
   (ADR-0007; 3.1.4 source refs in
   `docs/research/2026-11-24-vibe-acp-surface.md`). A session-only variant
   exists inside Vibe (`_unified_harness_backend_adapter.py:10896`), but ACP
   never sets it. That is an upstream request, not bridge work.

The change touches ADR-0003 and ADR-0007. Both are Accepted and stay
untouched (AGENTS.md §12). The decision goes into a **new** ADR, Proposed
after the spike.

## Spike (steps 0–2)

Throw-away scripts under `spikes/`, written and run by a `worker` subagent on
`router/dynamic` (AGENTS.md §13). Findings go to
`docs/research/2026-11-28-per-model-session-resume-spike.md`.

### Step 0 — how often does the proposal apply? (free, local)

The proposal helps only **returns** to an alias that already has a session
in the same Pi session (A → … → A). First entries into a model still have to
rebuild.

- Count from the owner's Pi session files (`~/.pi/agent/sessions/**`,
  2026-11-18..28), per session, over the sequence of assistant-message
  models:
  - entries into a bridge model, split into first entries and returns
  - for each return: whether it happened within the 10 min idle window
  - whether it happened inside one turn (failover)
- Output: **counts only**. No prompt, message text, path or session id
  leaves the machine or lands in the repo (AGENTS.md §8).

### Step 1 — free protocol checks (0 prompts)

Run against the real `vibe-acp` with no `session/prompt`:

- **Q1 (close + reload).** On the same process:
  - `session/new`, then `session/close`, then `session/load` with the same
    id. Does it succeed for a session that was never prompted, or must a
    session hold one turn first? Is the result the same with
    `session/resume`?
  - Then kill the process, spawn a new one and load the id again.
- **Q2 (model of a loaded session).** Load a session id created in a process
  with `VIBE_ACTIVE_MODEL=A` into a process started with alias B. Which
  model does the returned `config_options` report? This is read-only; no
  `model` write is allowed (AGENTS.md §14, ADR-0007).
- **Q3 (replay).** Which `session/update` notifications does `session/load`
  replay? The bridge must swallow them and not forward them as stream
  events. Does `session/resume` replay nothing, as the source suggests?

### Step 2 — paid catch-up runs (**budget: 10 `session/prompt` total**)

- **Model:** one cheap model the user's Vibe reports, `devstral-small` as in
  earlier spikes.
- **Budget:** a fresh counter file. The old one is archived, not deleted;
  failed sends count.
- **Synthetic fixtures only.** No owner prompts. Tools are the spike's
  loopback `pi__echo` and `pi__read_note`.

| Run | Prompts | What |
|-----|---------|------|
| C1–C3 | 3 × 2 | Session on A: prompt 1 does a real `pi__echo` call. Then a catch-up prompt carries a "foreign" turn with tool-call records in the 0.1.3 format, plus a new user message that needs a tool call. Recorded: real tool call or imitated text (ADR-0010 detector), input/output tokens, wall time. Each run uses the best mechanism Step 1 found (kept open, `load` or `resume`). |
| R1–R2 | 2 | The same history as one full rebuild on a fresh session, as the baseline for tokens, time and outcome. |
| L1 | 1 | A run only if Step 1 says a reloaded session after a process restart works: one prompt on it that needs the pre-restart history (does the model really see it?). If not run, the budget shrinks to 9. |
| spare | 1 | Only to repeat a run that failed for a transport reason; never for a new question. |

Three catch-up runs are a feasibility check, **not a rate measurement**. The
real dead-turn rate after catch-up vs rebuild comes from use after shipping,
with ADR-0010 detection in place.

### Step 3 — decision

Write the findings and a Proposed ADR, "resume per-model sessions with a
catch-up delta". The owner decides go, no-go or a different mechanism.

## Implementation (steps 4–6, only after the owner's go on step 3)

4. `src/session-map.ts`: per-alias records; `decideFlow` gains a `catchUp`
   flow (pure, unit-tested, red-first). `src/transcript.ts` gets a catch-up
   renderer reusing the 0.1.3 record format.
5. `src/provider.ts`: reattach (keep open / load / resume per ADR),
   catch-up prompt, fallback to rebuild on any reattach failure. Any
   Vibe-specific method or `_meta` goes into `src/vibe-protocol.ts` (§16).
   Fake ACP agent gains `loadSession`/`resumeSession`.
6. README, CHANGELOG `Unreleased`. An owner-approved integration run with
   its own budget.

## Open decisions

1. **Mechanism:** keep sessions open vs close and `load`/`resume`. Decided
   by spike Q1. Prefer (b) if it works: it also covers restarts and idle
   reaping, and it keeps no idle sessions open.
2. **Go / no-go on catch-up at all**, if C1–C3 imitate or Step 0 shows
   returns are rare.
3. Whether the bridge should **log flow decisions** (rebuild reason,
   catch-up, delta) in debug mode, so this kind of count needs no Pi session
   files next time. That would be its own small plan.
4. **Upstream request** to Mistral for a non-persisting model switch over
   ACP. The owner decides whether and how to file it.

## Verified against

- Bridge `origin/main` `84a47ec` (0.1.3): `src/session-map.ts:101-145`
  (`decideFlow`), `src/provider.ts:545-604` (`openNewSession`: cancel +
  close + `newSession` + rebuild prompt), `src/config.ts:29-30` (idle 10
  min). No flow-decision logging in `src/provider.ts`, checked by grep.
- `vibe-acp` 3.1.4 installed source: `vibe/acp/agent.py`
  - `:520-531` capabilities: `load_session=True`, `close`, `list`, `fork`;
    no resume capability advertised
  - `:573-598` `load_session`: `ResumeSessionIntent`, full-history replay
    via `session_update`
  - `:1009-1023` `close_session`: drops the session from the process
  - `:1158-1178` `resume_session`: `ResumeSessionIntent`, no replay
- Read from source only, **not exercised:** whether a closed or killed
  session is loadable, which model a loaded session uses, and what is
  replayed. Those are the spike questions.
- Pi 1.7.0 installed vs `@earendil-works/pi-*` `^1.6.0` devDependencies.
  This is a mismatch under AGENTS.md §10, to be handled in its own
  alignment round, not in this plan.
- Not verified: the router's count of 18 bridge entries, 12 inside one turn.

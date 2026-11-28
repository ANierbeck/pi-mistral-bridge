# Per-model session resume — spike part 1 (steps 0 and 1) and step 2 preparation

Date: 2026-11-28 · Branch `spike/per-model-session-resume` · Scripts: `spikes/` (not shipped)
Feeds `docs/plans/2026-11-28-per-model-session-resume.md` (steps 0–2).

## Context

The plan proposes keeping one ACP session per model alias for each Pi session, so that a **return**
to a model (A → B → A) reattaches A's session and sends only a catch-up delta instead of a full
rebuild. This note holds what could be checked **without spending a single `session/prompt`**:

- Step 0: how often do returns happen in the owner's real Pi sessions? (local, read-only)
- Step 1: do `session/load` / `session/resume` work on closed, open and restarted sessions? (real
  `vibe-acp`, zero prompts)
- Step 2: the paid catch-up script is **prepared, not run**. Because of step 0, it is not
  recommended to run it (see [Conclusion](#conclusion)).

**Prompts used in this task: 0.** The scripts refuse `session/prompt` and every `session/set_*`
request (allowlist). Checked on the wire: none of the raw JSON-RPC logs of the three step-1 processes
or of the four dry runs contains `session/prompt` or `session/set_config_option` (`grep -c` = 0 in
all of them).

## Verified against

- Bridge branch base `2b6dd38` (`origin/main` `84a47ec`, 0.1.3 plus the plan commit); the spike scripts
  are added on top of it.
- `vibe-acp` **3.1.4** (`vibe-acp --version`), `@agentclientprotocol/sdk` 2.9.1 (installed from the
  worktree root `node_modules`), Node 26.11.1, macOS.
- Provider-mode process env as in `spikes/README.md` Stage 3: `VIBE_ENABLE_AUTO_APPROVE=false`,
  `VIBE_DEFAULT_APPROVAL_POLICY=ask`, `VIBE_ENABLED_TOOLS=["pi_*"]`,
  `VIBE_ACTIVE_MODEL=<alias>`. The loopback MCP server is supplied through ACP `mcpServers`
  (`type: http`, name `pi`, bearer header), on every `session/new`, `session/load`, `session/resume`.
- Alias A = `devstral-small` (as in earlier spikes). Alias B = the first other alias Vibe listed in the
  `model` config option of `session/new`: `mistral-large-4-0` (8 aliases listed).
- Not verified: anything about `~/.vibe/` (never read, AGENTS.md §14); Vibe's source for the "Session
  not found" path was **not** re-read in this task, so why it is raised is an inference (see Q1).

## Step 0 — returns in the owner's Pi sessions (counts only)

Script `spikes/session-model-returns.ts`; window 2026-11-18..2026-11-28 (UTC, inclusive) by message
timestamp. No text, path, cwd or session id was printed or stored.

**Method.**

- Files: 772 `*.jsonl` under the Pi sessions directory. Excluded as subagent sessions, **by path only**:
  `subagent-artifacts/` (transcript copies, 70 files) and `<session>/<uuid>/run-N/session.jsonl`
  (228 child-run sessions). 298 excluded, **474 main session
  files scanned**. None of the 474 has a `parentSession`, and no entry id occurs in two of them, so
  there are no fork duplicates.
- Sequence: assistant messages that carry provider and model, in file order (append order). Abandoned
  `/tree` branches are included, because the bridge saw those messages as well.
- Bridge model = provider `mistral-bridge`; a model is identified as `provider/model`.
- "After a different model" = the previous assistant message in the file has another provider/model.
- Gap = difference of `message.timestamp` between the return and that model's last assistant message
  (approximate: the timestamp need not be the end of the response).
- "Inside one turn" = no `user` message between the previous assistant message and this one
  (failover); "at turn start" = at least one.
- "Compaction since last use" = a `compaction` entry between that model's last assistant message and
  the return (catch-up impossible, the bridge would have to rebuild).

**Counts.**

| Count                                                               |      N |
| ------------------------------------------------------------------- | -----: |
| Entries into a bridge model after a different model                 | **12** |
| — first entry of that model in the session                          |      7 |
| — **return** to a model used earlier in the session                 |  **5** |
| — inside one turn (failover) / at a turn start                      |  6 / 6 |
| Returns, gap since that model's last message ≤ 10 min / > 10 min    |  1 / 4 |
| Returns inside one turn / at a turn start                           |  4 / 1 |
| Returns with a compaction since the last use of that model          |  **5** |
| Returns without compaction and ≤ 10 min (what catch-up could serve) |  **0** |
| …of those at a turn start                                           |      0 |
| Files with at least one bridge assistant message in the window      |      5 |

Reading:

- Of 12 entries, 7 are first entries (rebuild is unavoidable) and **5 are returns**. **All 5 returns
  had a compaction in between**, so per today's design all 5 would still rebuild: the proposal as
  written would have served **0 of 12** observed entries. Only 1 of the 5 returns was within the
  10 min idle window.
- Sensitivity: counting the old provider label `mistral-vibe` (5 assistant messages in the window) as a
  bridge provider as well gives the same entry counts (12 / 7 / 5), only 8 instead of 5 files.
- The data is concentrated: **one session file holds 9 of the 12 entries and all 5 returns** (each of
  three other files holds one first entry). In that session a compaction entry follows every few bridge messages
  (the sequence shows `compaction` between almost every pair of bridge turns). Whether this is typical or a one-off was not examined further.
- **Does not match the plan's router count** (18 entries, 12 inside one turn; this scan: 12 entries,
  6 inside one turn). Not reconciled. Candidate reasons, none checked: the router also counts entries
  that never produced an assistant message in the file, or provider labels other than the two tried;
  the plan itself says the router count was unverified. This scan counts only what was written to the
  Pi session files.

## Step 1 — `session/load` and `session/resume` without a prompt

Script `spikes/session-reattach.ts`, one run, label `reattach`, three `vibe-acp` processes (PIDs
88704 → SIGKILLed on purpose, 89505, 89823; none running afterwards). All sessions were created with
`session/new` and **never prompted**. The agent advertises `loadSession: true` and
`sessionCapabilities {list, fork, close}`; **no `resume` capability** is advertised, yet
`session/resume` is accepted (see Q1a, last row).

### Q1a — same process

| Sequence                                 | Result                                                                                                               |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `new` → `close` → **`load`** (same id)   | **error** `-32602` `Session not found: <id>`, `data: {session_id}`; 1217 ms (first call)                             |
| `new` → `close` → **`resume`** (same id) | **error** `-32602` `Session not found: <id>`, `data: {session_id}`; 153 ms                                           |
| `new` → **`load`** (NOT closed)          | **ok**; response keys `modes`, `configOptions`, `_meta`; model `currentValue` = `devstral-small`, mode `ask`; 157 ms |
| `new` → **`resume`** (NOT closed)        | **ok**; empty result `{}` (no keys); 1 ms                                                                            |

### Q1b — process killed, new process (same alias)

Sessions prepared in process 1 (two closed first, two left open), then process 1 was killed with
`SIGKILL` (no `session/close`); process 2 started with `VIBE_ACTIVE_MODEL=devstral-small`:

| Session state at the kill | Method   | Result                                   |
| ------------------------- | -------- | ---------------------------------------- |
| closed before the kill    | `load`   | error `-32602` `Session not found: <id>` |
| closed before the kill    | `resume` | error `-32602` `Session not found: <id>` |
| open at the kill          | `load`   | error `-32602` `Session not found: <id>` |
| open at the kill          | `resume` | error `-32602` `Session not found: <id>` |

**Finding.** A session that was **never prompted** is not loadable once it has left the process's
memory — neither after `session/close` in the same process nor after a process restart, with `load`
and with `resume` alike. A session that is still open in the process **can** be loaded or resumed
(that only re-attaches what the process still holds, so for mechanism (a) "keep open" no reattach call
is needed at all). The probable reason is that Vibe persists a session only once it holds a turn; that
is an inference from this behaviour, not read from Vibe's source. **Q1 therefore must be re-checked
after a real prompt (step 2).** The first cheap probe is `catch-up-paid.ts --run C --reattach load`:
if the reattach fails the run stops after prompt 1, no catch-up prompt is spent.

### Q2 — model of a loaded session under another alias

Process 3 was started with `VIBE_ACTIVE_MODEL=mistral-large-4-0` (alias B) and asked to `load` and
`resume` two closed sessions created under A. **Both failed with `Session not found`** (same reason
as Q1), so the question is **unanswered**. Read-only control: the B process's own fresh `session/new`
reports model `currentValue` = `mistral-large-4-0`, i.e. a new session follows the process env. No
`model` write was made. To be re-checked after a real prompt on A.

### Q3 — `session/update` notifications

Counts per call (kinds only; a short wait after each response let late notifications land):

| Call                                       | Updates received                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `session/new` (each)                       | `usage_update` ×1, `available_commands_update` ×1 (the very first: ×2)                      |
| `session/close`                            | none                                                                                        |
| `session/load` of an open session          | `usage_update` ×1, `available_commands_update` ×1                                           |
| `session/resume` of an open session        | `usage_update` ×1                                                                           |
| failed `load` / `resume` (closed, restart) | none, except one `available_commands_update` in the first failing call of processes 2 and 3 |

- The one stray `available_commands_update` in a failing call is most likely a late notification of
  that process's own startup `session/new`, not a result of the failed call (attribution is by time
  window, so this is an inference).
- The sessions were empty, so there was **no history to replay**: no `user_message_chunk`,
  `agent_message_chunk` or `tool_call` arrived. Whether `load` replays a real history, and whether
  `resume` replays nothing as the source suggests, **is not answered**; step 2's `C --reattach
load|resume` records `reattach.updateKinds` for exactly this.
- For the bridge: a reattach call emits the same **non-history** updates as `session/new`
  (`usage_update`, `available_commands_update`); they must not be forwarded as stream events either.

## Step 2 — status: prepared, not run

`spikes/catch-up-paid.ts` is written and was exercised only with `--dry-run` (four dry runs: `C open`,
`C resume`, `L load`, `R`; no `session/prompt`, no budget used — `prompt-count-catchup.json` was never
created). The dry runs proved: process spawn with the provider env, prompt rendering, the detector
self-check, the kill/respawn path of `L`, and the reattach error path (it fails with `Session not
found` as Q1 predicts, and the run stops without a prompt).

- **Budget:** `spikes/out/prompt-count-catchup.json`, constant `CATCHUP_MAX_PROMPTS = 10`, reserved
  before each send, failed sends count, the 11th is refused. `lib.ts`'s `MAX_PROMPTS = 3` and its
  counter are untouched. The refusal itself was **not exercised live** (it needs a real send path);
  it is a read-and-reviewed check, not a tested one.
- **Fixtures:** all synthetic. `renderTranscript`, `HISTORY_PREAMBLE` and `findImitatedToolCallText`
  are **imported read-only** from `src/transcript.ts` (no shape is copied). The one-sentence catch-up
  lead-in is spike-local text, because the bridge has no catch-up preamble yet. `lib.ts` gained the
  synthetic MCP tool `pi__read_note`.
- **Cost per run:** `C` = 2 prompts, `R` = 1, `L` = **2** (the plan table counts `L1` as 1, but the
  pre-restart history needs its own prompt). The plan's `C1–C3` (6) + `R1–R2` (2) + `L1` (2) = 10, which
  leaves **no spare**. The owner may prefer fewer `C` runs or dropping `L` if `load`/`resume` fail
  after a prompt.
- **Recommended order:** `C --reattach load` first (1 prompt if the reattach fails), then
  `C --reattach resume`; only if one of them works continue with the rest. If both fail, the answer
  to the plan's open decision 1 is "keep sessions open" (mechanism (a)), and `L` is moot.
- Records per prompt: real tool calls (ACP `tool_call` updates and MCP `tools/call` from the loopback
  log), imitated tool-call text and dead-turn flag, `usage_update`s, wall time, stop reason, reply
  text, and `answerHas…` checks. Result JSON goes to `spikes/out/` (git-ignored).

## Conclusion

- In the observed data a catch-up delta would have replaced **0 of 12** rebuilds caused by model
  switches.
  - First entries (7) need a rebuild by definition.
  - Every return (5 of 5) followed a compaction.
- The mechanism is unproven. Reattaching after `session/close` or a restart fails for
  never-prompted sessions. The prompted case is untested.
- The controller's recommendation: do not run step 2, and do not implement catch-up now.
  - Fewer rebuilds come cheaper from the router: avoid unneeded switches with a sticky session
    model.
  - Bridge-side debug logging of flow decisions (rebuild reason, delta, continuation) would give
    real counts instead of reconstructing them from Pi session files. That would be a separate
    plan.
- **For the router side:**
  - The bridge-side count is 12 switch entries, 6 of them inside one turn, against the router's 18
    and 12.
  - The difference is not reconciled. One likely cause is that the spike excludes subagent
    session files, and the router count may include them.

## Limits

- Step 0 is a single machine, single owner, a short window and **5 returns**: it shows the shape of the
  data, not a rate. Message timestamps are approximate for the 10 min gap. The count was not
  reconciled with the router's (18 / 12).
- Step 1 covers only never-prompted sessions. Everything that matters for the proposal (is a
  _prompted_ session loadable, which model it reports, what `load` replays) is open until step 2.
- One `vibe-acp` version (3.1.4), one machine, one run of the step-1 script. Timings are single
  measurements.
- A `vibe-acp` process (PID 71671) that was already running before this task is not part of the
  spike; it was neither started nor stopped by these scripts.

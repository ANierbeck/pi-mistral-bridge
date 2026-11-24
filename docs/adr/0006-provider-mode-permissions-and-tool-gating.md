# 0006 — Provider mode: permission bridge, tool gating, and the 60 s effect budget

## Status

Proposed (2026-11-24).

## Context

ADR-0002 accepted provider mode (Pi owns the loop, Pi tools via MCP) with a
planned "reject every Vibe permission request in provider mode" rule
(AGENTS.md §15) and an assumption that builtin tools could be disabled.
The spikes against `vibe-acp` 2.25.8 and 3.1.4 (docs/research/
2026-11-24-vibe-acp-surface.md) refuted both:

- ACP has no per-session switch for builtin tools, and on the unified/3.x
  engine `VIBE_ENABLED_TOOLS` does not hide builtin *definitions* from the
  model — it only sets them to deny (observed: `bash ls` → `tool_denied`,
  `approvalSource: "never"`, no permission request).
- MCP tools (including Pi's) default to permission `ask`: in mode
  `accept-edits` Vibe sends `session/request_permission` for every Pi tool
  call. Rejecting all of them would make provider mode unusable.
- The default mode is now the approval policy. `auto-approve` exists but is
  removable via `VIBE_ENABLE_AUTO_APPROVE=false` and must not be used for
  provider mode, because it would auto-run whatever tools the model picks.
- **New hard constraint (3.1.4):** every effect in a turn shares a global
  60 000 ms budget (`programmatic.max_elapsed_ms=60_000`,
  `app_server/_runtime.py:2226`), enforced in the harness
  (`mistralai_vibe_local_harness/vibe/_local_actions.py:929`) and NOT
  configurable via env or ACP. A Pi tool that runs longer than 60 s minus the
  rest of the turn gets `tool_timeout`. Additionally the model may retry
  timed-out calls (observed: 3 attempts of the same pair), and server-side
  handlers kept running past the client-side cancel — so Pi tool execution
  must tolerate duplicate execution.
- `session/cancel` during a pending permission request did not end the prompt
  within ~4 min on 3.1.4 (had to kill the process). The bridge must therefore
  always answer permission requests promptly.
- Verified working combination (3 prompts, devstral-small, ~$0.04):
  `VIBE_DEFAULT_APPROVAL_POLICY=ask`, `VIBE_ENABLE_AUTO_APPROVE=false`,
  `VIBE_ACTIVE_MODEL=<alias>`, `VIBE_ENABLED_TOOLS=["<server>_*"]` globs
  matching the `{server}_{tool}` display names, session mode `ask`, and the
  client answering `allow_once` for its own MCP tools only. Parallel tool
  calls in one step arrive concurrently (≤ ~15 ms apart) and run in parallel.

## Decision Drivers

- Provider mode must work with what Vibe actually offers on 3.1.4.
- Pi's own permission model stays the control point for Pi tools.
- No auto-approve anywhere in provider mode.
- Bounded turn duration; no reliance on `session/cancel` during approvals.

## Options Considered

1. **Reject all permission requests** (original ADR-0002 assumption) —
   refuted: kills every Pi tool call under the default policy.
2. **`auto-approve` mode** — rejected: builtin tool execution was observed
   denied only by policy, and auto-approve would lift that if the gating
   changes; also the model could pick user MCP servers.
3. **Answer selectively: `allow_once` only for the bridge's own MCP
   toolCallIds, `reject_once` for everything else** — chosen.

## Decision

Provider mode runs with the process env above and session mode `ask`. The
bridge's ACP client implements `request_permission` as: resolve the
`toolCallId` to the preceding `tool_call` (title / `_meta.tool_name`); if it
names one of the bridge's MCP tools, answer `allow_once`; otherwise
`reject_once`. Every request is answered immediately — never left pending.
The bridge never uses `auto-approve` in provider mode.

Consequences for the implementation (recorded here so the design plan can
rely on them):

- **60 s effect budget.** Pi tools exposed to provider mode must be able to
  complete within ~55 s, or the bridge must run them with its own timeout and
  return a "still running / killed at 60 s" result before the budget expires.
  The bridge treats `tool_timeout` results as ordinary tool results.
- **Duplicates.** Because Vibe may retry a timed-out call and handlers can
  outlive a cancel, the MCP server must de-duplicate by a deterministic
  request id (hash of session id + tool name + canonical args) and return the
  cached result for a repeat within the same turn.
- **Batching.** Parallel tool calls in one model step are emitted within
  milliseconds; the bridge groups all MCP requests that arrive within a
  ~100 ms quiet window into one Pi `toolCall` batch.
- **Builtin tools stay visible to the model** but are denied at execution.
  The bridge must therefore map by MCP request name only and ignore ACP
  notifications about builtin calls; Pi never executes them.
- AGENTS.md §15 is amended: in provider mode, permission requests are
  answered per the rule above (not blanket-rejected); a permission request
  that does not map to a Pi tool is rejected AND logged as an anomaly.

## Consequences

- Provider mode works on 3.1.4 with an env-only configuration; no files under
  `~/.vibe/` are written by the bridge.
- Long-running Pi tools need the 55 s pre-emptive timeout + duplicate-tolerant
  execution; this is a real behaviour change for tools like `bash`.
- The 60 s budget is per turn and shared, so one slow Pi tool can consume the
  whole turn budget for all parallel calls.

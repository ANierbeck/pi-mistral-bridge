# 0011 — Provider mode: enable Vibe's read-only `read_file` builtin (amends ADR-0006)

## Status

Proposed (2026-11-28).

## Context

ADR-0006 gates Vibe's own tools off in provider mode: the bridge sets
`VIBE_ENABLED_TOOLS` to the bridge server's MCP tools only
(`["<server>_pi__*"]`, `buildEnabledToolsGlobs` in `src/vibe-protocol.ts`).
It also sets `VIBE_DEFAULT_APPROVAL_POLICY=ask` and
`VIBE_ENABLE_AUTO_APPROVE=false`. ADR-0006 recorded that the builtin
*definitions* stay visible to the model while their calls are denied.

The owner's debug logs (2026-11-24…28, counted only, §8) show what that costs:

- Models call Vibe builtins in provider mode all the time. Every attempt fails
  with `tool_denied` and `approvalSource: "never"`, and no permission request
  reaches the bridge. Counted: `bash` 172, `read_file` 149, `process.start` 9,
  `write_file` 8, `process.list` 4, `edit` 3, `skill` 3.
- Each denied attempt costs a model step against the Mistral allowance and
  usually a retry through the Pi tool. A Vibe-driven session that
  investigated the symptom reported it as "tools denied by policy".
- `pi-claude-bridge` has no such friction because the Claude Agent SDK runs
  with `tools: []` and `permissionMode: "bypassPermissions"`. That option does
  not exist for Vibe (ADR-0006).

How the gate works on the installed `vibe-acp` 3.1.4 (unified harness). This
was checked in the installed package source, not in the upstream clone:

1. `VIBE_ENABLED_TOOLS` filters Vibe's *core tool catalogue*
   (`vibe/core/tools/manager.py`, `available_tools`: an `enabled_tools`
   glob list takes precedence). Builtins match by their plain registry name,
   e.g. `read_file`.
2. The Rust runtime does not read those globs directly. Its builtins carry
   namespaced names (`file_system.read_file`, `file_system.bash`, …,
   `mistralai_vibe_local_harness/protocol.py`, `RustRuntimeBuiltinToolName`).
   Each builtin gets one approval mode from `_rust_tool_modes`
   (`vibe/app_server/_runtime.py`). The mode is **`deny` when the filtered
   catalogue contains none of the core tools the builtin stands for**
   (`RUST_BUILTIN_TOOL_SOURCES`, `vibe/app_server/_unified_permissions.py`:
   `file_system.read_file` ← `{"read_file"}`). This is the observed
   `tool_denied` / `approvalSource: "never"`.
3. When the builtin's source tool is present, the core tool's permission
   decides. `read_file` is `ALWAYS`. Outside bypass mode, a would-be `allow`
   is lowered to `ask`, so that Vibe's per-call resolver (`resolve()` in
   `_unified_permissions.py`) decides each call. A call the tool's own rules
   allow is resolved locally to `allow`, without a client round trip. A call
   the tool's rules flag (e.g. sensitive-file patterns, where the tool
   defines them) becomes an approval callback. `vibe/acp/agent.py`
   (`_answer_callback`) turns that callback into ACP
   `session/request_permission`.
4. Vibe 3.1.4's unified harness has **no grep builtin**. No Rust builtin
   stands for the core `grep` tool, and no `grep` call appears in the logs.
   The owner's first choice, "read_file + grep", can therefore only be
   delivered as `read_file` today.

The bridge's permission handler (`providerPermissionRequest`,
`src/acp-client.ts`) answers `allow_once` only for its own MCP tools
(`isBridgeToolName`). Every other request gets `reject_once` and is logged as
an anomaly. Vibe then tells the model "User rejected the tool call; provide an
alternative plan".

## Decision Drivers

- Stop the denied-builtin churn for the most frequent harmless case, reads,
  without giving Vibe any capability that Pi's own tools do not already give
  the model. Pi's `read` tool reads any file without asking.
- Keep every side-effecting builtin (shell, writes, edits, processes) denied.
- No new configuration surface: the owner chose a fixed set.
- Stay on the sanctioned path (§14): environment configuration and ACP only,
  with no Vibe patches and no auto-approve.

## Options Considered

1. **Fixed set: `read_file` added to `VIBE_ENABLED_TOOLS`.** A small,
   auditable change. Writes stay denied. A flagged read is rejected by the
   existing permission bridge. Cons: reads run inside Vibe and never appear
   as Pi tool calls (see Consequences).
2. **Fixed set `read_file` + `grep` (the owner's first choice).** Not
   deliverable on 3.1.4 (Context point 4). A `grep` glob would be a dead
   entry today.
3. **Configurable allowlist in `mistral-bridge.json`.** Rejected by the
   owner: new surface, and a user could re-enable shell or writes.
4. **Allow flagged reads too (`allow_once` for builtin permission
   requests).** Rejected by the owner. Flagged reads stay rejected, so the
   §15 rule "only the bridge's own tools are approved" stays intact.

## Decision

- `buildEnabledToolsGlobs(server)` returns `["<server>_pi__*", "read_file"]`.
  The extra entry comes from one exported constant in `src/vibe-protocol.ts`
  (the single module for Vibe-specific surface, §16), with a doc comment
  that cites this ADR and the Vibe 3.1.4 source locations above.
- No other builtin is enabled. `grep` is added when Vibe ships a builtin for
  it, through a new ADR or an amendment.
- The permission bridge is unchanged. `allow_once` remains bound to
  `isBridgeToolName`. A permission request for `read_file` (a flagged read)
  is answered `reject_once` and logged, as every non-bridge request is.
- Builtin `read_file` activity stays inside Vibe. Its `tool_call` and
  `tool_call_update` notifications keep being dropped on the provider path
  (`mapUpdate` in `src/acp-client.ts`). They never become Pi `toolCall`
  blocks: Pi would try to execute an unknown tool and break the
  parked-batch flow (ADR-0002, ADR-0003).
- AskVibe mode is unaffected. It runs its own pool without the bridge's MCP
  server or tool gate (ADR-0004).
- This ADR amends ADR-0006's tool gating ("Vibe's own tools are gated off")
  by exactly one exception. AGENTS.md §15 is updated to state it.

## Consequences

- Models can read files directly in provider mode. The 149 denied
  `read_file` attempts of the observed period would have succeeded without a
  Pi round trip.
- Reads done by Vibe are not visible in the Pi UI and are not part of Pi's
  transcript. After a rebuild (ADR-0003) the model no longer has their
  content and may re-read. Their tokens count in Vibe's usage report, which
  Pi uses for compaction. Surfacing them in the UI, e.g. as a status line,
  would be a separate decision.
- Flagged reads are rejected with a logged anomaly line on stderr. This is
  rare and expected, not a defect.
- The `isBridgeToolName` safety argument changes. It no longer rests on
  "only bridge tools can execute". It rests on two facts: (a) the only
  enabled builtin is read-only and is resolved by Vibe itself, and (b)
  permission requests are approved only for bridge tools. The doc comment
  in `src/acp-client.ts` is updated accordingly.
- Vibe's builtin agent tools (`agents.*`, `subagent.*`, `self.*`) have no
  entry in `RUST_BUILTIN_TOOL_SOURCES`, so this gate does not cover them.
  Under the narrow ADR-0006 globs the logs show `agents.spawn` completing
  three times and `self.wait` running. Their behaviour in provider mode is a
  separate question outside this decision; this change does not touch it.
- To verify later: on a new `vibe-acp` version, re-check
  `RUST_BUILTIN_TOOL_SOURCES` / `_rust_tool_modes` and, if the owner
  approves the run, one integration prompt that reads a file through Vibe.

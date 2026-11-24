# 0002 — Provider mode: Pi owns the agent loop, Pi tools via MCP

## Status

Accepted (2026-11-24).

## Context

Given ADR-0001 (Vibe via ACP), the bridge must make Mistral models usable as
a regular Pi model: the user picks `mistral-vibe/<model>` in Pi and keeps
Pi's tools, permissions, extensions, UI and session tree.

ACP is an *agent* protocol: the client sends a prompt, the agent runs its own
loop with its own tools and reports updates. Pi, in contrast, expects a
provider's `streamSimple` to return one assistant message — text, thinking
and tool calls — and then runs the tools itself and calls the provider again
with the results.

`pi-claude-bridge` resolves the same mismatch for Claude Code: the runtime
gets no builtin tools, Pi's tools are served to it through an in-process MCP
server, and each MCP tool call is *parked* while Pi executes the tool in its
own loop; the next `streamSimple` call delivers the result and resolves the
parked call.

Verified in Vibe 2.25.8 source (`vibe/acp/agent.py`): `session/new` accepts
`mcpServers` of type stdio, HTTP and SSE.

## Decision Drivers

- Pi stays in control: every tool call is executed, permission-checked and
  rendered by Pi.
- Pi's tools and extension tools must be available to Mistral models.
- Behave like any other Pi provider (streaming, abort, errors, usage).
- Reuse the `pi-claude-bridge` pattern where it fits.

## Options Considered

1. **Let Vibe run its own tools and only relay text** — simplest, but Pi's
   tools, permission model and rendering are bypassed; this is agent
   delegation, covered separately by ADR-0004.
2. **Pi tools via MCP, Vibe tools disabled, park-and-resume** — Pi owns the
   loop; Vibe performs one model step per Pi turn segment.
3. **Translate Vibe's own tool calls into Pi tool calls** — would require
   intercepting Vibe's builtin tool execution; not possible through ACP
   without patching Vibe (forbidden by ADR-0001).

## Decision

Option 2.

- The bridge registers its own Pi provider (default `mistral-vibe`) with
  `streamSimple`.
- Per Pi session, the bridge creates an ACP session whose `mcpServers`
  contains exactly one server: the bridge's local MCP server, bound to
  loopback with a per-session bearer token, offering the Pi session's
  current tools under a `pi__` prefix.
- Vibe's builtin tools are disabled for provider-mode sessions. The concrete
  mechanism (session mode, agent profile, or tool filter) is determined by
  the spike and recorded in a follow-up ADR.
- An MCP call from Vibe is parked; the bridge emits it to Pi as a
  `toolCall` and ends the Pi stream with `stopReason: "toolUse"` while the
  ACP prompt stays open. When Pi calls `streamSimple` again with the matching
  `toolResult`s, the parked calls are resolved and the stream continues on
  the same ACP prompt.
- ACP `agent_message_chunk` → `text_delta`, `agent_thought_chunk` →
  `thinking_delta`; usage from Vibe's usage updates; cost reported as 0
  (allowance, not Pi-billed money).
- Abort → `session/cancel`, parked calls rejected, `stopReason: "aborted"`.
  Quota/429 errors carry a stable prefix (`Mistral Vibe quota exceeded`) so
  Pi's and the router's fallback logic can match them.
- A Vibe permission request in provider mode is rejected and logged
  (AGENTS.md §15).

## Consequences

- Mistral models get Pi's full tool set with Pi's permission handling.
- Tool name and arguments are taken from the MCP request, not from ACP
  `tool_call` notifications, so they are exact.
- Parallel tool calls need batching (a short quiet window on the MCP side);
  the window is tuned in the spike.
- Steering (a new user message while calls are parked) aborts the open
  prompt and forces a rebuild (ADR-0003).
- **Accepted risk:** Mistral accepts "Mistral harnesses via ACP with
  third-party tools" but does not say whether a session whose builtin tools
  are disabled still counts as such. This mode may be narrowed by Mistral
  later; AGENTS.md §14 requires stopping, not working around, if it is.
  AskVibe (ADR-0004) remains available as the unambiguous mode.

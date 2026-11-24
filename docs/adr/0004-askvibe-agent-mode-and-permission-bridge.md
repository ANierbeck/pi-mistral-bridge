# 0004 — AskVibe agent mode and permission bridge

## Status

Accepted (2026-11-24).

## Context

Provider mode (ADR-0002) disables Vibe's own tools, which carries a policy
risk (ADR-0002, Consequences). Running Vibe as a full agent with its own
tools inside an ACP client is exactly what Mistral documents for Zed and
JetBrains, so it is the unambiguous use. It is also useful on its own: a Pi
session on any model can hand a task to Vibe.

Vibe asks the client for consent via `session/request_permission` and can
ask multi-choice clarification questions. Pi offers `ctx.ui.select` /
`ctx.ui.input` when a UI is present (`ctx.hasUI`), and no UI in print mode
or for subagents.

## Decision Drivers

- Offer a mode that is clearly within Mistral's accepted use.
- Never let Vibe change files or run commands without the user's consent.
- Keep the surface small (YAGNI).

## Options Considered

1. **Slash command only** (`/vibe <prompt>`) — user-driven only; the Pi
   agent cannot delegate.
2. **Pi tool `AskVibe`** — the Pi agent or the user can delegate; progress
   renders inside Pi's tool rendering.
3. **Mirror the full Vibe UI** (slash commands, voice, loops, review,
   connectors) — large surface, little value inside Pi.

## Decision

Option 2.

- Tool `AskVibe` with parameters `prompt` (required), `mode`
  (`ask` | `plan` | `edit`, default `ask`), optional `model`, optional
  `continue` (resume this Pi session's last AskVibe session).
- Each call uses its own ACP session in Pi's cwd, with Vibe's builtin tools
  and **without** the Pi MCP server. `mode` maps to Vibe's builtin agents
  via `set_session_mode` (`ask`, `plan`, `accept-edits`); the bridge writes
  no Vibe agent files.
- Progress (`tool_call`, `tool_call_update`, text chunks) streams through
  the tool's `onUpdate`; the result is Vibe's final answer plus the list of
  files Vibe changed (from tool-call locations and diff contents).
- Pi's abort signal sends `session/cancel`.
- **Permissions:** with a UI, `session/request_permission` is shown via
  `ctx.ui.select` using Vibe's options verbatim (allow once / always /
  reject) with title and command or diff preview. Without a UI, the request
  is **rejected**. Auto-approve only via the explicit config flag
  `askVibe.autoApprove: true`, never by default.
- Vibe's clarification questions go to `ctx.ui.select` / `ctx.ui.input`;
  without a UI they are cancelled.
- Out of scope: Vibe slash commands, voice, loops, review, connectors.

## Consequences

- There is always a mode that does not depend on provider mode's policy
  standing.
- Headless runs (print mode, subagents) cannot let Vibe write unless the
  user opted into auto-approve.
- Vibe's tool output is summarised in Pi, not replayed as Pi tool calls; Pi's
  own permission extensions do not see Vibe's tool calls — Vibe's permission
  prompt is the control point in this mode.

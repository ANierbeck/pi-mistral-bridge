# 0001 — Drive Mistral Vibe through ACP (`vibe-acp`)

## Status

Proposed (2026-11-24).

## Context

Paid Mistral plans include a dedicated Vibe allowance and a much smaller API
allowance. Mistral announced (email to users, and the official post
"[Vibe Update] Vibe Allowance Changes" on r/MistralAI, 2026-11) that from the
billing cycle starting **2026-12-01**, usage made through non-Mistral
products — third-party coding tools or harnesses such as Pi talking to the
Mistral API with a Vibe key — counts against the API allowance instead of the
Vibe allowance. The same post lists under "what is not changing":

> The use of Mistral harnesses via ACP with third-party tools is accepted.

Mistral's own documentation ("Use Vibe in other IDEs") describes running
Vibe inside ACP clients such as Zed and JetBrains by launching the
`vibe-acp` command.

The owner wants to keep using Pi as the harness and Mistral models inside it.
`pi-claude-bridge` (MIT, by Eli Dickinson) solves the analogous problem for
Claude Code by driving the official Claude Code runtime through its SDK and
exposing it as a Pi model provider. This project applies the same idea to
Vibe.

Verified locally: `vibe` / `vibe-acp` 2.25.8 is installed; `vibe-acp` speaks
ACP over stdio, and its `session/new` accepts `mcpServers` (stdio, HTTP, SSE).

## Decision Drivers

- Stay on a path Mistral explicitly accepts.
- Reuse the proven `pi-claude-bridge` architecture.
- Depend on a documented protocol, not on Vibe internals.
- Keep authentication and billing attribution entirely inside Vibe.

## Options Considered

1. **Call the Mistral API directly with a Vibe key** — what Pi does today;
   from 2026-12-01 billed against the API allowance. Rejected: it is the
   problem being solved.
2. **Spawn `vibe -p … --output streaming` per turn** — documented CLI, but
   one process per turn, no persistent session, no channel to inject Pi's
   tools mid-turn, no permission round-trip, and not the path Mistral named.
3. **Drive `vibe-acp` over ACP** — the path Mistral names as accepted; one
   long-lived process; sessions, streaming updates, MCP server injection,
   permission requests and model selection are part of the protocol.
4. **Reverse-engineer Vibe's backend calls or wrap its Python code** —
   fragile, and an attempt to obtain Vibe billing outside a Mistral product.
   Rejected outright.

## Decision

The bridge talks to Mistral **only** by spawning the user's installed
`vibe-acp` and speaking ACP to it over stdio, using the official
`@agentclientprotocol/sdk` client. It identifies itself honestly in
`initialize` (`pi-mistral-bridge` and its version). It never handles Mistral
credentials, never calls Mistral endpoints itself, and never modifies Vibe.
AGENTS.md §14 turns this into standing rules.

## Consequences

- Usage is attributed by Vibe the same way as for Zed or JetBrains.
- The bridge inherits Vibe's behaviour, versions and bugs; `vibe-acp` must be
  installed and set up (`vibe-acp --setup`) by the user.
- ACP is a moving protocol and Vibe a moving tool: the verified Vibe version
  is recorded and re-checked (AGENTS.md §10, §16).
- How Mistral treats *provider mode* (ADR-0002), where Vibe's own tools are
  disabled and Pi runs the loop, is not spelled out by Mistral. ADR-0002
  records that risk; if the policy narrows, the bridge must stop rather than
  work around it (AGENTS.md §14).

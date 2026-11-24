# pi-mistral-bridge — Design

## Status

Approved (2026-11-24). ADRs 0001–0007 accepted by the owner (2026-11-24).
Spike done: `docs/research/2026-11-24-vibe-acp-surface.md`; open decisions 1–5
answered, ADR-0006/0007 record the two design changes the evidence forced
(permission bridge + 60 s effect budget; one process per model, env config).
Next step: implementation plan `2026-11-24-implementation.md`.

## Problem

From 2026-12-01 Mistral bills usage from third-party harnesses (such as Pi
calling the Mistral API with a Vibe key) against the small API allowance
instead of the Vibe allowance. Mistral explicitly accepts "Mistral harnesses
via ACP with third-party tools". The owner wants to keep working in Pi with
Mistral models without moving to the Vibe UI.

## Solution

A Pi extension that drives the user's installed `vibe-acp` over ACP
(ADR-0001), modelled on `pi-claude-bridge`, with two modes:

- **Provider mode** (ADR-0002): Mistral models in Pi's model picker; Pi owns
  the loop; Pi's tools are served to Vibe through a loopback MCP server;
  Vibe's own tools are disabled; tool calls are parked and resumed across
  `streamSimple` calls. History via delta prompts with rebuild fallback
  (ADR-0003).
- **AskVibe** (ADR-0004): a Pi tool delegating a task to Vibe as a full
  agent with its own tools; permissions bridged to Pi's UI, rejected when
  headless.

Models and auth come from Vibe (ADR-0005).

### Components

```
 pi (agent loop, tools, UI)
   │  registerProvider("mistral-bridge", streamSimple) · registerTool("AskVibe")
   ▼
 ┌──────────────────── pi-mistral-bridge ─────────────────────┐
 │ src/index.ts         extension entry, lifecycle, config    │
 │ src/provider.ts      streamSimple → turn orchestration     │
 │ src/acp-client.ts    vibe-acp child process, ACP client    │
 │                      (@agentclientprotocol/sdk, stdio)     │
 │ src/vibe-protocol.ts every Vibe-specific ext method/_meta  │
 │ src/mcp-bridge.ts    loopback MCP server, bearer token,    │
 │                      pi__ tool prefix, park/resume         │
 │ src/session-map.ts   Pi session ↔ ACP session, digests,    │
 │                      delta/rebuild decision                │
 │ src/transcript.ts    compact rebuild transcript (pure)     │
 │ src/models.ts        model list from Vibe config options   │
 │ src/ask-vibe.ts      AskVibe tool, permission bridge       │
 │ src/config.ts        mistral-bridge.json (global/project)  │
 └────────────────────────────────────────────────────────────┘
   │ ACP: initialize → session/new{mcpServers:[bridge]} → session/prompt
   ▼
 vibe-acp ──► Mistral (accepted ACP path)
```

### Lifecycle

One `vibe-acp` child per Pi process, started lazily, serving many ACP
sessions. On crash: restart, mark all sessions dirty (next turn rebuilds).
On Pi `session_shutdown`: `close_session`; on extension unload: terminate
the child. No orphaned processes (AGENTS.md §15).

### Turn flow (`streamSimple`)

1. Trailing `toolResult`s match parked calls → resolve them, keep reading the
   open `session/prompt`.
2. History prefix matches the recorded digest → send only the new user
   message (text + image blocks).
3. Otherwise → rebuild: fresh ACP session, Pi system prompt + compact
   transcript + current message.

Streaming map: `agent_message_chunk` → `text_delta`, `agent_thought_chunk`
→ `thinking_delta`, MCP call on `pi__<tool>` → `toolCall` and
`stopReason: "toolUse"`. Usage from Vibe, cost 0. Abort →
`session/cancel`. Quota/429 → `Mistral Vibe quota exceeded…`. Steering while
calls are parked → abort open prompt, mark dirty.

### Configuration

`~/.pi/agent/mistral-bridge.json`, optional project override
`.pi/mistral-bridge.json`:

| Key | Default | Meaning |
|-----|---------|---------|
| `vibeAcpPath` | `vibe-acp` (PATH) | executable to spawn |
| `providerName` | `mistral-bridge` | Pi provider id |
| `askVibe.enabled` | `true` | register the AskVibe tool |
| `askVibe.defaultMode` | `ask` | `ask` / `plan` / `edit` |
| `askVibe.autoApprove` | `false` | approve Vibe permissions without UI |
| `debug` | `false` | JSON-RPC log under `~/.pi/agent/logs/mistral-bridge/` |

### Out of scope (YAGNI)

Vibe slash commands, voice, loops, review, connectors; writing Vibe's native
session files; any direct Mistral API access.

### Testing

- Unit (vitest, no network): in-process fake ACP agent over in-memory
  streams (handshake, streaming map, park/resume, parallel calls, abort,
  crash/rebuild); digest logic and transcript as pure functions (snapshot
  tests); MCP bridge against a real MCP client (token, unknown tool,
  timeout); permission bridge with mocked `ctx.ui`, with and without UI.
- Integration against real `vibe-acp`: opt-in `MISTRAL_BRIDGE_IT=1`, never
  in CI, owner approval per run (AGENTS.md §4).
- Coverage floors set from the first green measurement, never lowered.
- CI: `test` (tsc, lint, format, vitest, coverage) and `secret-scan`
  required.

## Steps

- [ ] 1. Spike in `spikes/` (one owner-approved real run). Answers the open
      decisions below; results to `docs/research/`, load-bearing results to
      a new ADR.
- [ ] 2. Scaffold: package.json (pi manifest), tsconfig strict, esbuild,
      vitest + coverage, eslint/prettier gates, secret-scan + pre-push hook,
      CI, README skeleton, LICENSE (MIT, crediting `pi-claude-bridge`).
- [ ] 3. ACP client + provider, text only.
- [ ] 4. MCP bridge + tool round-trip.
- [ ] 5. History: delta and rebuild.
- [ ] 6. AskVibe + permission bridge.
- [ ] 7. README, review (AGENTS.md §1), owner decision on publishing.

## Open decisions — resolved by the spike (docs/research/2026-11-24-vibe-acp-surface.md)

1. Builtin tools: no per-session switch; process env `VIBE_ENABLED_TOOLS` gates execution, definitions stay visible → ADR-0006.
2. HTTP MCP works (bearer, stateless per-call sessions) → confirmed.
3. Model list comes from the ACP `model` config option; aliases volatile, API id in `description` is the stable key → ADR-0007.
4. Tool calls in one step arrive in parallel within ~15 ms → batch with a ~100 ms quiet window.
5. System prompt is only extendable (prompt text), Vibe's own stays → as designed in ADR-0003.
6. **Owner:** repository name/visibility on GitHub and whether to publish to npm (later, AGENTS.md §1).

New from the spike: hard 60 s per-turn effect budget (ADR-0006), cancel during pending approval hangs (bridge must always answer), duplicate execution on retry must be tolerated.
   npm (later, AGENTS.md §1).

## Verified against

- `vibe` / `vibe-acp` 2.25.8 (installed via uv): `--help` of both;
  `vibe/acp/agent.py` — `new_session` / `load_session` / `resume_session` /
  `fork_session`, `mcp_servers` accepting stdio/HTTP/SSE,
  `set_session_mode`, `set_config_option`, `_send_config_options`,
  `_answer_user_input`.
- `pi` 1.6.0.
- `pi-claude-bridge` 0.13.0 source (`src/index.ts`, MCP tool round-trip,
  session sync) and README.
- Mistral announcement (r/MistralAI official post "[Vibe Update] Vibe
  Allowance Changes") and Mistral docs "Use Vibe in other IDEs".
- Verified against vibe-acp 2.25.8 and 3.1.4 (see research doc); remaining paid-run gaps are listed there under "still unproven".

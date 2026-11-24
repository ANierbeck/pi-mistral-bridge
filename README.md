# pi-mistral-bridge

A Pi coding-agent extension that makes Mistral models usable inside Pi by
driving the official Mistral Vibe harness (`vibe-acp`) over the Agent Client
Protocol (ACP). It has two modes:

- **Provider mode** — the models your `vibe-acp` reports appear in Pi's model
  picker under a dedicated provider (default `mistral-vibe`); Pi owns the
  agent loop and every tool call is executed by Pi.
- **AskVibe mode** — a Pi tool (`ask_vibe`) that delegates a self-contained
  task to Vibe as a sub-agent with Vibe's own tools.

The bridge talks to Mistral **only through your own `vibe-acp` process** over
ACP. It never calls the Mistral HTTP API directly, never spoofs a client
identity, and never reads, copies or forwards Vibe's credentials —
authentication is Vibe's business (`vibe-acp --setup`). In the ACP
`initialize` handshake it identifies itself honestly as `pi-mistral-bridge`
with its real version. Usage is consumed via your own Vibe setup, exactly as
when you run Vibe yourself.

**Not affiliated with Mistral.** This is an independent bridge.

## Requirements

- [Pi](https://github.com/earendil-works/pi) (the `pi` coding agent) with its
  extension API, Node.js >= 22.19.
- The official Mistral Vibe CLI installed and signed in:
  `uv tool install mistral-vibe` (or your preferred installer), then
  `vibe-acp --setup` to authenticate. The bridge spawns `vibe-acp` from your
  `PATH` by default.

## Install

Once published on npm:

```bash
pi install npm:pi-mistral-bridge
```

From a local checkout (until then):

```bash
npm ci
npm run build
pi install ./pi-mistral-bridge   # or an absolute path to the checkout
```

Restart or `/reload` Pi afterwards.

## Quick start

1. Start Pi. Within a few seconds the provider `mistral-vibe` appears in the
   model picker, with exactly the models your `vibe-acp` reports for your
   account (the list is discovered from Vibe, never hardcoded, and refreshed
   in the background).
2. Select a `mistral-vibe` model and chat as usual — Pi runs the agent loop.
3. To delegate a task to Vibe itself, ask the agent to use the `ask_vibe` tool
   (for example: "use ask_vibe to …"), or invoke `ask_vibe` directly from the
   input line.

## The two modes

### Provider mode

The bridge registers a Pi provider (default name `mistral-vibe`) whose models
are the ones `vibe-acp` reports. For each Pi session it starts one ACP session
to a per-model `vibe-acp` process whose only MCP server is the bridge's own
loopback MCP server. That server listens on `127.0.0.1` only, on a random
port, requires a per-session random bearer token, and exposes the Pi session's
current tools under the `pi__` prefix.

When Vibe wants to call a Pi tool, the call is parked and surfaced to Pi as an
ordinary tool call; Pi executes it and the bridge resolves the parked call on
the next provider request, continuing the same ACP prompt. Vibe's own builtin
tools are gated off in provider mode via an env allowlist, and the bridge
answers Vibe's permission requests itself — `allow_once` when the request maps
to one of the bridge's own MCP tools, `reject_once` (and a logged anomaly)
otherwise. Auto-approve is never used in provider mode.

**Per-turn time budget.** Vibe enforces a hard 60 s per-turn budget on tool
calls and it is not configurable. The bridge therefore times Pi tools out
pre-emptively at 55 s (configurable, capped at 60 s) and returns a "killed at
budget" result; repeated identical calls are de-duplicated by a deterministic
request id, because Vibe may retry timed-out calls and the server-side handler
keeps running after a cancel.

**Policy note (honest risk).** Mistral states that use of Mistral harnesses
via ACP with third-party tools is accepted, but does not explicitly say whether
a session with Vibe's builtin tools disabled qualifies. If Mistral narrows
that acceptance, provider mode may stop being permitted; the bridge will then
surface the errors instead of working around them, and AskVibe (below) is the
unambiguous mode. See
[ADR-0002](docs/adr/0002-provider-mode-pi-owns-the-agent-loop.md).

### AskVibe mode — the `ask_vibe` tool

`ask_vibe` delegates a self-contained task to Vibe as a sub-agent, with Vibe's
own tools enabled and no Pi MCP server. Parameters:

| Parameter  | Required | Description                                                                            |
| ---------- | -------- | -------------------------------------------------------------------------------------- |
| `question` | yes      | The full task for Vibe — put everything Vibe needs to know into it.                    |
| `mode`     | no       | `ask` (default), `plan`, or `edit`. Defaults to `askVibe.defaultMode` from the config. |

Each call runs on a fresh ephemeral ACP session on Vibe's default model. The
requested `mode` is validated against the modes the session actually advertises:
on `vibe-acp` >= 3.0 plan mode no longer exists, so `plan` falls back to `ask`
(and `edit` falls back `accept-edits` → `ask`); the effective mode is recorded
in the tool result. Vibe's permission requests are shown in Pi's UI; without a
UI (print mode, subagents) they are rejected, unless `askVibe.autoApprove` is
explicitly enabled. The tool result includes a summary of changed files.
Errors map like in provider mode, including the `Mistral Vibe quota exceeded`
prefix for quota errors. See
[ADR-0004](docs/adr/0004-askvibe-agent-mode-and-permission-bridge.md).

## Configuration

The bridge reads two JSON files; the project file overrides the global one
key by key:

- `~/.pi/agent/mistral-bridge.json` — global (user-level)
- `.pi/mistral-bridge.json` — project-level, relative to the project root

All keys are optional. Unknown keys produce a warning on stderr and are
ignored; invalid values are a hard error that names the file and the key.

| Key                     | Default       | What it does                                                                                                                                                              |
| ----------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vibeAcpPath`           | `"vibe-acp"`  | Command or path used to spawn the `vibe-acp` process.                                                                                                                      |
| `providerName`          | `"mistral-vibe"` | Name of the Pi provider the bridge registers. Must not collide with a provider Pi already registers (e.g. Pi's builtin `mistral`); in that case the bridge registers nothing and warns. |
| `askVibe.enabled`       | `true`        | Whether the `ask_vibe` tool is registered.                                                                                                                                |
| `askVibe.defaultMode`   | `"ask"`       | Default `mode` for `ask_vibe`: one of `ask`, `plan`, `edit`.                                                                                                               |
| `askVibe.autoApprove`   | `false`       | Auto-approve Vibe permission requests in AskVibe mode. Off by default; without a UI, permission requests are always rejected regardless.                                    |
| `debug`                 | `false`       | Write a JSONL debug log of the raw ACP traffic to `~/.pi/agent/logs/mistral-bridge/` (authorization headers and tokens redacted). Off by default.                          |
| `processIdleTimeoutMs`  | `600000`      | Idle `vibe-acp` processes in the per-model pool are reaped after this many milliseconds.                                                                                   |
| `toolPreTimeoutMs`      | `55000`       | Pre-emptive timeout for Pi tools executed in provider mode. Must not exceed `60000` (Vibe's hard per-turn budget); larger values are a config error.                        |
| `abortWatchdogMs`       | `5000`        | After an abort (`session/cancel`), a prompt still unresolved after this many milliseconds kills the `vibe-acp` child and marks the session for rebuild.                   |
| `discoveryTimeoutMs`    | `30000`       | Timeout for the short-lived discovery `vibe-acp` process that reads the model list at startup.                                                                             |
| `modelRefreshIntervalMs`| `1800000`     | Background refresh interval for the model list; when the list changes, the provider is re-registered with the full new list.                                              |

Example:

```json
{
  "providerName": "mistral-vibe",
  "askVibe": { "enabled": true, "defaultMode": "ask", "autoApprove": false },
  "debug": false
}
```

The bridge never writes to Pi-owned files (`models.json`, `settings.json`) or
to anything under Vibe's own directory.

## Security notes

- The MCP bridge listens on **loopback only** (`127.0.0.1`), on a random port,
  and requires a per-session random bearer token on every request; every
  unauthorized request is answered 401. It serves only the tools of the Pi
  session it belongs to.
- In provider mode, **auto-approve is never used**; permission requests are
  answered immediately (`allow_once` for the bridge's own tools, `reject_once`
  plus a logged anomaly otherwise) — a pending request would make
  `session/cancel` hang.
- The environment inherited by the `vibe-acp` child is sanitized: every
  `VIBE_*` variable is dropped except `VIBE_HOME` (the user's own Vibe
  installation location), so an inherited `VIBE_*` setting cannot re-enable
  auto-approve or tool permissions behind the bridge's back.
- The bridge never reads, copies or forwards Vibe's credentials (API keys,
  OAuth tokens, keychain entries, auth files). It identifies itself honestly in
  the ACP handshake as `pi-mistral-bridge` with its real version.
- Debug logs are written only when `debug: true`, under
  `~/.pi/agent/logs/mistral-bridge/`, with authorization headers and tokens
  redacted.
- All `vibe-acp` child processes are cleaned up on Pi session shutdown, on
  abort, and on extension reload — no orphaned processes.

## Verified against

- `vibe-acp` **3.1.4** (primary verification target; 2.25.8 also exercised) —
  evidence and wire traces in
  [docs/research/2026-11-24-vibe-acp-surface.md](docs/research/2026-11-24-vibe-acp-surface.md).
  Behaviour of other Vibe versions is unverified.
- Pi 1.6.0, `@agentclientprotocol/sdk` 2.9.1, `@modelcontextprotocol/sdk`
  1.32.2, Node.js >= 22.19.

## Troubleshooting

- **No `mistral-vibe` models in the picker**, or a `model discovery failed` /
  `vibe-acp --setup` hint on stderr: Vibe is probably not signed in. Run
  `vibe-acp --setup`, then `/reload` in Pi.
- **Errors starting with `Mistral Vibe quota exceeded`**: Vibe surfaced a
  quota/429 error from Mistral. Check your allowance in Vibe.
- **Authentication errors** from the model: run `vibe-acp --setup` — the
  bridge never handles credentials itself.
- **Config errors** name the file and key, e.g.
  `mistral-bridge.json at …: "toolPreTimeoutMs" must not exceed 60000 ms …`.
  Unknown keys only warn (`pi-mistral-bridge: unknown key "…" (ignored)`).
- **Debugging**: set `"debug": true`, reproduce, then inspect the redacted
  JSONL log under `~/.pi/agent/logs/mistral-bridge/`.

## Development

- Design: [docs/plans/2026-11-24-pi-mistral-bridge-design.md](docs/plans/2026-11-24-pi-mistral-bridge-design.md)
- Architecture decisions (ADRs): [docs/adr/](docs/adr/)
- Implementation plan (T1–T8): [docs/plans/2026-11-24-implementation.md](docs/plans/2026-11-24-implementation.md)
- Spike evidence: [docs/research/2026-11-24-vibe-acp-surface.md](docs/research/2026-11-24-vibe-acp-surface.md)

Gates before every commit: `npm run typecheck`, `npm run lint`,
`npm run format:check`, `npx vitest run`, `npm run test:coverage`,
`npm run build`, `npm run secret-scan`.

The architecture is modeled on
[pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge).

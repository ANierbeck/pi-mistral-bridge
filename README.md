# pi-mistral-bridge

## What this is — and what it is not

**What it is.** A [Pi](https://github.com/earendil-works/pi) extension that
lets you use your **Mistral Vibe subscription models inside Pi** by driving
**your own installed `vibe-acp`** over the Agent Client Protocol (ACP). Pi owns
the agent loop and the tools; every tool call Vibe makes is executed by Pi.
Usage bills against your **Vibe allowance**, not the API allowance: Mistral
accepts "Mistral harnesses via ACP with third-party tools", and the announced
billing change from 2026-12-01 moves usage of third-party harnesses that do
not go through a Mistral harness onto the API allowance — this bridge keeps
you on the Vibe allowance because it drives Vibe itself.

The bridge-provider pattern — an external agent exposed as a Pi model
provider — is modelled on
[pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) (see
Acknowledgments).

**What it is not.**

- **Not a Mistral API-key client** — it never calls the Mistral HTTP API
  directly and never spoofs a client identity.
- **Not a Vibe credential store** — it never reads, copies or forwards
  anything under `~/.vibe/`; authentication is Vibe's own business
  (`vibe-acp --setup`). In the ACP `initialize` handshake the bridge
  identifies itself honestly as `pi-mistral-bridge` with its real version.
- **Not a patch of Vibe** — it uses only the documented ACP protocol and
  `vibe-acp` CLI flags.
- **Not a replacement for the Vibe CLI** — run `vibe` yourself as usual.

**Why it works.** `vibe-acp` speaks ACP natively (verified against
`vibe-acp` 3.1.4): the bridge spawns one `vibe-acp` process per model
(`VIBE_ACTIVE_MODEL`), and the tool calls Vibe makes are parked and executed
by Pi through a loopback-only MCP bridge (`127.0.0.1` only, random port,
per-session bearer token).

It has two modes:

- **Provider mode** — the models your `vibe-acp` reports appear in Pi's model
  picker under a dedicated provider (default `mistral-bridge`); Pi owns the
  agent loop and every tool call is executed by Pi.
- **AskVibe mode** — a Pi tool (`ask_vibe`) that delegates a self-contained
  task to Vibe as a sub-agent with Vibe's own tools.

**Always address bridge models as `mistral-bridge/<apiModelId>`.** Pi already
has a builtin `mistral` provider (a plain HTTP API client keyed by a Mistral
API key). The bridge registers its **own** provider (default name
`mistral-bridge`, configurable via `providerName`), so `mistral/<id>` resolves
to Pi's builtin HTTP provider — **not** to this bridge. Use
`mistral-bridge/<apiModelId>` everywhere (`--model`, `/model`, `pi -p`, …).

**Not affiliated with Mistral.** This is an independent bridge.

## Requirements

- [Pi](https://github.com/earendil-works/pi) (the `pi` coding agent) with its
  extension API, Node.js >= 22.19.
- The official Mistral Vibe CLI installed and signed in:
  `uv tool install mistral-vibe` (or your preferred installer), then
  `vibe-acp --setup` to authenticate. The bridge spawns `vibe-acp` from your
  `PATH` by default.

## Install

From npm:

```bash
pi install npm:@anierbeck/pi-mistral-bridge
```

Or from a local checkout:

```bash
npm ci
npm run build
pi install ./pi-mistral-bridge   # or an absolute path to the checkout
```

Restart or `/reload` Pi afterwards.

## Quick start

1. Start Pi. The extension factory awaits the first model discovery (bounded
   by `startupDiscoveryTimeoutMs`, default 10 s), so the provider
   `mistral-bridge` is registered before Pi's first render with exactly the
   models your `vibe-acp` reports for your account (the list is discovered
   from Vibe, never hardcoded, and refreshed in the background).
2. Select a `mistral-bridge/<apiModelId>` model and chat as usual — Pi runs the
   agent loop. (Do not use `mistral/<id>`: that is Pi's builtin HTTP provider,
   not this bridge — see the warning above.)
3. To delegate a task to Vibe itself, ask the agent to use the `ask_vibe` tool
   (for example: "use ask_vibe to …"), or invoke `ask_vibe` directly from the
   input line.

## The two modes

### Provider mode

The bridge registers a Pi provider (default name `mistral-bridge`) whose models
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
pre-emptively at 55 s (configurable, capped at 60 s) and answers with an
error result whose text is exactly `Pi tool did not finish within <n> ms
(Vibe enforces a 60 s per-turn budget)` (`<n>` = the configured
`toolPreTimeoutMs`); repeated identical calls are de-duplicated by a
deterministic request id, because Vibe may retry timed-out calls and the
server-side handler keeps running after a cancel.

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

## Limitations

- **Models appear only after the first discovery.** The extension factory
  waits for the first `vibe-acp` model-list discovery up to
  `startupDiscoveryTimeoutMs` (default 10 s); on timeout startup continues
  with a quiet warning and the models appear as soon as the discovery
  finishes. The list is re-discovered in the background every
  `modelRefreshIntervalMs` (default 30 min).
- **Provider mode has a hard per-turn time budget.** Vibe enforces a 60 s
  per-turn budget on tool calls and it is not configurable; the bridge
  pre-emptively times Pi tools out at 55 s (`toolPreTimeoutMs`) and answers
  with a "did not finish within `<n>` ms" result (see Provider mode above).
- **AskVibe `plan` mode no longer exists on `vibe-acp` >= 3.0** and falls
  back to `ask` (likewise `edit` falls back `accept-edits` → `ask`).
- **Verified against `vibe-acp` 3.1.4 only** (see "Verified against" below);
  other Vibe versions are unverified.

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
| `providerName`          | `"mistral-bridge"` | Name of the Pi provider the bridge registers. Must not collide with a provider Pi already registers (e.g. Pi's builtin `mistral`); in that case the bridge registers nothing and warns. |
| `askVibe.enabled`       | `true`        | Whether the `ask_vibe` tool is registered.                                                                                                                                |
| `askVibe.defaultMode`   | `"ask"`       | Default `mode` for `ask_vibe`: one of `ask`, `plan`, `edit`.                                                                                                               |
| `askVibe.autoApprove`   | `false`       | Auto-approve Vibe permission requests in AskVibe mode. Off by default; without a UI, permission requests are always rejected regardless.                                    |
| `debug`                 | `false`       | Write a JSONL debug log of the raw ACP traffic to `~/.pi/agent/logs/mistral-bridge/` (authorization headers and tokens redacted). Off by default.                          |
| `processIdleTimeoutMs`  | `600000`      | Idle `vibe-acp` processes in the per-model pool are reaped after this many milliseconds.                                                                                   |
| `toolPreTimeoutMs`      | `55000`       | Pre-emptive timeout for Pi tools executed in provider mode. Must not exceed `60000` (Vibe's hard per-turn budget); larger values are a config error.                        |
| `abortWatchdogMs`       | `5000`        | After an abort (`session/cancel`), a prompt still unresolved after this many milliseconds kills the `vibe-acp` child and marks the session for rebuild.                   |
| `discoveryTimeoutMs`    | `30000`       | Timeout for the short-lived discovery `vibe-acp` process that reads the model list at startup.                                                                             |
| `startupDiscoveryTimeoutMs` | `10000`   | How long the extension factory waits for the first model discovery before Pi continues startup anyway (quiet warning; the discovery keeps running in the background, so the models still appear once it finishes). |
| `modelRefreshIntervalMs`| `1800000`     | Background refresh interval for the model list; when the list changes, the provider is re-registered with the full new list.                                              |

Example:

```json
{
  "providerName": "mistral-bridge",
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
- Pi 1.7.0, `@agentclientprotocol/sdk` 2.9.1, `@modelcontextprotocol/sdk`
  1.32.2, Node.js >= 22.19.

## Troubleshooting

- **No `mistral-bridge` models in the picker**, or a `model discovery failed` /
  `vibe-acp --setup` hint on stderr: Vibe is probably not signed in. Run
  `vibe-acp --setup`, then `/reload` in Pi.
- **Errors starting with `Mistral Vibe quota exceeded`**: Vibe surfaced a
  quota/429 or rate-limit error from Mistral (Vibe's ACP error code `-31001`
  or a matching message). Check your allowance in Vibe. In provider mode the
  bridge also reports the limit to Pi through the `onResponse` stream option
  as status `429` with empty headers — no `retry-after`, because Vibe exposes
  no reset time. A router that reads limits from the response then falls back
  to its own backoff.
- **Authentication errors** from the model: run `vibe-acp --setup` — the
  bridge never handles credentials itself.
- **Config errors** name the file and key, e.g.
  `mistral-bridge.json at …: "toolPreTimeoutMs" must not exceed 60000 ms …`.
  Unknown keys only warn (`pi-mistral-bridge: unknown key "…" (ignored)`).
- **Debugging**: set `"debug": true`, reproduce, then inspect the redacted
  JSONL logs under `~/.pi/agent/logs/mistral-bridge/`. Every file name
  carries the id of the Pi process that wrote it, so concurrent Pi processes
  never share a file: `mcp-bridge-<pid>.jsonl` (MCP bridge events),
  `model-discovery-<pid>.jsonl` (model discovery) and
  `vibe-acp-<alias>-<pid>-<n>.jsonl` (raw ACP traffic of the `<n>`-th
  `vibe-acp` process that Pi process spawned for `<alias>`).

## Development

- Design: `docs/plans/` in the repository (not shipped in the npm tarball)
- Architecture decisions (ADRs): [docs/adr/](docs/adr/)
- Implementation plan (T1–T8): `docs/plans/2026-11-24-implementation.md` in the repository
- Spike evidence: `docs/research/2026-11-24-vibe-acp-surface.md` in the repository

Gates before every commit: `npm run typecheck`, `npm run lint`,
`npm run format:check`, `npx vitest run`, `npm run test:coverage`,
`npm run build`, `npm run secret-scan`.

## Acknowledgments

Modelled on [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge)
(npm: [pi-claude-bridge](https://www.npmjs.com/package/pi-claude-bridge)) by
Eli Dickinson — the bridge-provider pattern (external agent as a Pi model
provider) follows that project.

## License

Licensed under the [Apache License, Version 2.0](LICENSE). Version 0.1.0
was published under MIT; 0.1.1 and later are Apache-2.0.

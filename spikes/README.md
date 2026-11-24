# spikes/ — throw-away research scripts

Not shipped, not covered, not imported by `src/` (AGENTS.md §4). Findings live in
`docs/research/2026-11-24-vibe-acp-surface.md`.

## Setup

```bash
cd spikes && npm install   # deps are local to spikes/, there is no root package.json
```

Requires `vibe-acp` on `PATH` and an already authenticated Vibe (`vibe-acp --setup`
is Vibe's business; the scripts never read or touch Vibe credentials).

## Stage 1 — `acp-surface.ts` (no prompts, costs no allowance)

```bash
npx tsx acp-surface.ts --label s1-baseline
npx tsx acp-surface.ts --label s1-restricted --set-mode auto-approve \
  --env 'VIBE_ENABLED_TOOLS=["pi_*"]' --env VIBE_ACTIVE_MODEL=devstral-small
# Vibe >= 3.x: the approval policy is the ACP "mode"; set it by env or via set_mode / set_config_option(mode)
npx tsx acp-surface.ts --label s3-policy-env --env VIBE_DEFAULT_APPROVAL_POLICY=ask
npx tsx acp-surface.ts --label s3-cfgmode --set-config-mode smart-approve
# Pi's MCP server only via env (no ACP mcpServers); {{MCP_URL}} / {{MCP_TOKEN}} are substituted
npx tsx acp-surface.ts --label s3-envmcp --no-acp-mcp \
  --env 'VIBE_MCP_SERVERS=[{"transport":"streamable-http","name":"pienv","url":"{{MCP_URL}}","tool_timeout_sec":600,"auth":{"type":"static","headers":{"Authorization":"Bearer {{MCP_TOKEN}}"}}}]'
```

Stage 1 refuses (throws) `session/prompt` and any `session/set_config_option` whose `configId` is not
`mode` (a `model` write would persist into the user's `~/.vibe/config.toml`).
Vibe 3.x has no `--legacy-harness` / `--experimental-harness` flags any more (the unified harness is
the only one); `vibe-acp` accepts only `-h`, `-v`, `--setup`.

Starts a loopback MCP server (127.0.0.1, random port, bearer token, tools `pi__echo` and
`pi__slow_echo`), spawns `vibe-acp`, runs `initialize` + `session/new`, listens 10 s,
closes the session and kills the child. The ACP permission callback logs and **rejects**.

## Stage 2 — `acp-prompts.ts` (**REAL PROMPTS — spends Mistral allowance**)

```bash
npx tsx acp-prompts.ts --prompt A|B|C [--mode auto-approve] [--slow-ms 45000] [--env K=V ...]
```

Each run sends exactly one `session/prompt`. The hard budget of **3 prompts in total**
is enforced by `spikes/out/prompt-count.json` (checked and incremented *before* sending;
failed runs count). Never run Stage 2 without the owner's approval for that run
(AGENTS.md §4).

## Stage 3 — `acp-paid.ts` (**PAID — owner-approved runs only, vibe-acp 3.1.4**)

```bash
npx tsx acp-paid.ts --prompt timeout|visibility|cancel \
  [--model-alias devstral-small] [--slow-ms 75000] [--timeout-ms 300000]
```

One `session/prompt` per process; the paid stage's budget of **3 prompts** is enforced by
`spikes/out/prompt-count.json` (refuses a 4th send; failed runs count; when a new task gets a
fresh budget, archive the old counter file instead of deleting it). Process configuration
under test (provider-mode candidate, ADR-0002), all env-only:

- `VIBE_ACTIVE_MODEL=<alias>` — cheapest Mistral alias from the `model` config option of
  `session/new` (re-read on every spawn; the catalog is dynamic). NEVER
  `session/set_config_option` with `configId: model` — that persists into the user's
  `~/.vibe/config.toml`.
- `VIBE_ENABLE_AUTO_APPROVE=false`, `VIBE_DEFAULT_APPROVAL_POLICY=ask` — session mode stays `ask`.
- `VIBE_ENABLED_TOOLS=["pi_*","pislow_*"]` — allowlist matching the MCP display name
  `{server}_{tool}` of both the ACP-supplied server "pi" and the env server "pislow".
- `VIBE_MCP_SERVERS` — one streamable-HTTP server "pislow" → the spike's loopback server
  (bearer header, `tool_timeout_sec: 120`). The ACP `session/new` additionally supplies the
  HTTP server "pi" with the default timeout.

The client answers `session/request_permission` itself: `allow_once` only when the referenced
`toolCallId` belongs to a `tool_call` whose title / `_meta.tool_name` names one of the spike's
MCP tools, otherwise `reject_once` (never `allow_always*`); every decision is logged.
`--prompt cancel` instead holds the request unanswered and sends `session/cancel` ~3 s later.
Each run records `stat` + `sha256` of `~/.vibe/config.toml` before and after (hash only — the
file is never read into a log or copied) and kills its `vibe-acp` child.

## Output

`spikes/out/` (git-ignored): `*-acp-raw.jsonl` (every JSON-RPC message, timestamped),
`*-events.jsonl`, `*-mcp.jsonl` (every MCP HTTP request), `*-summary.json` (Stage 2),
`*-vibe-stderr.log`. The bearer token is redacted in every log line. Logs can contain
the prompts that were sent: never commit them.

## Files

- `lib.ts` — MCP server, vibe-acp spawn, raw JSON-RPC tee, prompt budget, redaction,
  pluggable `session/request_permission` handler (`onPermissionRequest`).
- `acp-surface.ts` — Stage 1.
- `acp-prompts.ts` — Stage 2.
- `acp-paid.ts` — Stage 3 (paid).

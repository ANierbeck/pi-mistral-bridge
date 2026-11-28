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

Starts a loopback MCP server (127.0.0.1, random port, bearer token, tools `pi__echo`, `pi__read_note` and
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

## Per-model session resume spike (docs/plans/2026-11-28-per-model-session-resume.md)

Findings: `docs/research/2026-11-28-per-model-session-resume-spike.md`. Run from the repo root
(`npx tsx spikes/<file>.ts`); dependencies resolve from the root `node_modules`.

### Step 0 — `session-model-returns.ts` (free, local, read-only)

```bash
npx tsx spikes/session-model-returns.ts [--from 2026-11-18] [--to 2026-11-28]
```

Scans Pi session files under `~/.pi/agent/sessions` (path built from `os.homedir()`) and prints
**only a counts table** (JSON) to stdout: entries into a bridge model (`provider: mistral-bridge`) after
a different model, split into first entries and returns, returns by idle gap (≤ / > 10 min), inside one
turn vs at a turn start, and returns with a compaction in between. Subagent sessions
(`subagent-artifacts/`, `run-N/session.jsonl`) are excluded by path. No text, path or session id is
printed or written (AGENTS.md §8).

### Step 1 — `session-reattach.ts` (0 prompts, costs no allowance)

```bash
npx tsx spikes/session-reattach.ts [--label reattach] [--alias-a devstral-small]
```

Spawns three `vibe-acp` processes with the provider-mode env of Stage 3 (alias A, alias A again after a
`SIGKILL`, alias B = first other alias Vibe lists) and checks `session/load` / `session/resume` of
sessions that were closed, left open, or created in a killed process (Q1a/Q1b), the model the configOptions
report after a load under another alias (Q2), and which `session/update` notifications arrive (Q3).
Every request goes through an allowlist (`session/new|close|load|resume`); `session/prompt` and every
`session/set_*` throw before anything is sent. Result JSON: `spikes/out/<stamp>-<label>-result.json`.

### Step 2 — `catch-up-paid.ts` (**PAID — owner-approved 2026-11-28, budget 10 prompts; prepared, not run**)

```bash
npx tsx spikes/catch-up-paid.ts --run C|R|L --label <x> [--reattach open|load|resume] [--dry-run]
```

- `C` catch-up (prompt 1: real `pi__echo` call; reattach per `--reattach`; prompt 2: catch-up lead-in +
  `HISTORY_PREAMBLE` + a foreign turn in the 0.1.3 `renderTranscript` record format + a new user message
  that needs a real `pi__read_note` call). 2 prompts.
- `R` rebuild baseline (same full history as one prompt on a fresh session: system prompt +
  `HISTORY_PREAMBLE` + transcript, as `openNewSession`). 1 prompt.
- `L` restart (prompt 1 with a codeword, `SIGKILL`, new process, `load`/`resume` of the old id, prompt 2
  answerable only from pre-restart history). 2 prompts.

Budget: `spikes/out/prompt-count-catchup.json`, `CATCHUP_MAX_PROMPTS = 10`, reserved **before** each
send, failed sends count, the 11th is refused. A fresh budget for this task; the Stage 2/3 counter
(`prompt-count.json`, `MAX_PROMPTS = 3` in `lib.ts`) is not touched. A failed reattach stops the run
without a fallback prompt. `--dry-run` does everything except `session/prompt` (no budget used). Recorded
per prompt: real MCP tool calls, imitated tool-call text (`findImitatedToolCallText` from
`src/transcript.ts`, read-only import), usage updates, wall time. Fixtures are synthetic; the MCP tools are
the spike's `pi__echo` and `pi__read_note` (`lib.ts`). Never run without the owner's go for that run.

## Provider-mode `read_file` builtin (docs/plans/2026-11-28-provider-read-file-builtin.md, T6)

**PAID — one prompt per invocation, owner-approved budget 2 in total.**

```bash
MISTRAL_BRIDGE_IT=1 npx tsx spikes/read-file-builtin.ts <model-alias>
```

Spawns `vibe-acp` with the bridge's own provider-mode env (`VIBE_ENABLED_TOOLS` from
`buildEnabledToolsEnvValue`, which carries `read_file`; ADR-0011) in a temp dir holding a
synthetic `note.txt`, with no MCP server attached. Sends one prompt asking for the file via
`read_file`, rejects every permission request, and prints a JSON summary (builtin tool calls
with final status and error code, permission request count, whether the reply carries the
synthetic content, stop reason). Refuses to start without `MISTRAL_BRIDGE_IT=1`; budget
counter `spikes/out/prompt-count-read-file.json`.

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
- `session-model-returns.ts` — per-model resume, step 0 (local counts).
- `session-reattach.ts` — per-model resume, step 1 (load / resume checks, 0 prompts).
- `catch-up-paid.ts` — per-model resume, step 2 (**paid**, prepared).
- `read-file-builtin.ts` — provider-mode `read_file` builtin check (**paid**, prepared).

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
npx tsx acp-surface.ts --label s1-legacy --vibe-arg=--legacy-harness
```

Starts a loopback MCP server (127.0.0.1, random port, bearer token, tools `pi__echo` and
`pi__slow_echo`), spawns `vibe-acp`, runs `initialize` + `session/new`, listens 10 s,
closes the session and kills the child. The ACP permission callback logs and **rejects**.

## Stage 2 — `acp-prompts.ts` (**REAL PROMPTS — spends Mistral allowance**)

```bash
npx tsx acp-prompts.ts --prompt A|B|C [--mode auto-approve] [--slow-ms 45000] \
  [--vibe-arg=--legacy-harness] [--env K=V ...]
```

Each run sends exactly one `session/prompt`. The hard budget of **3 prompts in total**
is enforced by `spikes/out/prompt-count.json` (checked and incremented *before* sending;
failed runs count). Never run Stage 2 without the owner's approval for that run
(AGENTS.md §4).

## Output

`spikes/out/` (git-ignored): `*-acp-raw.jsonl` (every JSON-RPC message, timestamped),
`*-events.jsonl`, `*-mcp.jsonl` (every MCP HTTP request), `*-summary.json` (Stage 2),
`*-vibe-stderr.log`. The bearer token is redacted in every log line. Logs can contain
the prompts that were sent: never commit them.

## Files

- `lib.ts` — MCP server, vibe-acp spawn, raw JSON-RPC tee, prompt budget, redaction.
- `acp-surface.ts` — Stage 1.
- `acp-prompts.ts` — Stage 2.

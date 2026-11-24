# Vibe ACP surface — spike results for design open decisions 1–5

Date: 2026-11-24 · Branch `spike/acp-surface` · Scripts: `spikes/` (not shipped)
Answers decisions 1–5 of `docs/plans/2026-11-24-pi-mistral-bridge-design.md`.
Feeds the follow-up ADR for ADR-0002 (disable mechanism, permission mode, timeouts).

## Verified against

- `vibe-acp` **2.25.8** (`@mistralai/mistral-vibe`, uv tool, Python 3.12), macOS.
  Source paths below are relative to the tool's `site-packages/`; line numbers are
  2.25.8. `mistralai_vibe_local_harness` (native "Unified Harness", `_native.abi3.so`)
  is installed alongside; its Python wrapper was read, the native part was not.
- `@agentclientprotocol/sdk` 2.9.1, `@modelcontextprotocol/sdk` 1.32.2, Node 26.
- Vibe model used for every prompt: **`devstral-small`** (cheapest alias Vibe offered).
- **Real prompts used: 3 of 3** (budget 3, counted in `spikes/out/prompt-count.json`
  before each send). Reported usage: C 27,751 / B 27,924 / A 20,782 tokens
  (≈ USD 0.0028 / 0.0028 / 0.0021 per Vibe's `usage_update.cost`).
- Raw JSON-RPC/MCP logs are in `spikes/out/` (git-ignored, not committed). Excerpts
  below are redacted; the bearer token never appears.

**Which harness ran.** Vibe 2.25.8 has two agent backends: the legacy Python loop and the
"Unified Harness" (native). `--legacy-harness` forces legacy; otherwise a GrowthBook
rollout decides (`_experimental_harness.py:96-121`, `acp/entrypoint.py:28-47`). On this
machine the **unified harness is the default** (its `mcp-descriptors/unified` cache was
written by plain `vibe-acp`). **All three prompts ran on the unified harness.** The legacy
harness was only started (Stage 1, free) and its behaviour is from source reading.
(A CLI-parsing bug in my spike made the first "legacy" attempts silently run unified; it
was found after prompt B and fixed, see "Honesty notes".)

## Summary

| # | Open decision | Verdict |
|---|---------------|---------|
| 1 | Disable builtin tools per ACP session; does provider mode raise permission requests? | **Refuted as phrased, workaround found.** No per-session switch exists over ACP. A process-level env var (`VIBE_ENABLED_TOOLS`) restricts MCP tools but does **not** hide builtin tools on the unified harness (they are denied by policy instead). Permission requests **do** occur for MCP tools unless the session mode is `auto-approve`. |
| 2 | HTTP MCP or stdio shim? | **Confirmed.** HTTP (streamable) works, bearer header is sent on every request. Vibe opens a *new MCP session per tool call*. |
| 3 | Model list as session config option, with which metadata? | **Confirmed**, but metadata is thin (alias, display name, API model id). No context window / reasoning / image flags. |
| 4 | Multiple tool calls in one step | **Confirmed: parallel.** ACP `tool_call`s and MCP `tools/call`s arrive within ≈ 10–15 ms and execute concurrently. Unified harness adds tool-discovery steps. |
| 5 | System prompt replaceable? | **Refuted: only extendable** (via prompt text). Env knobs choose among Vibe's own prompts; the unified harness does not honour a custom one. |

The biggest risk for ADR-0002 is **not** one of the five questions: Vibe's MCP tool-call
timeout is **60 s and not configurable over ACP** (see "MCP tool-call timeouts").

## Decision 1 — disabling builtin tools; permission requests

### What ACP can and cannot do

- `session/new` ignores `_meta` and all unknown fields: `acp/agent.py:531-554`
  (`del kwargs`). The only inputs used are `cwd`, `additionalDirectories`, `mcpServers`.
- The only tool restriction Vibe's ACP layer sets itself is `disabled_tools =
  ["ask_user_question", "exit_plan_mode"]`, and only when the client does **not**
  advertise `elicitation.form` (`acp/agent.py:189-192, 596-600, 653-657`). The spike did
  not advertise elicitation, so those two are off.
- `SessionOptions` has an `enabled_tools` field (`app_server/_runtime.py:2742`) but the
  ACP agent never sets it (`acp/agent.py:596-612`).
- Modes (`session/set_mode` or config option `mode`): `ask`, `plan`, `accept-edits`
  (default), `auto-approve` (observed list). They only change *permissions*, never the
  tool set (`core/agents/models.py:62-106`). `session/set_mode` returned `{}` and left the
  user's `config.toml` mtime untouched.
- `session/set_config_option` supports only `mode`, `model`, `thinking`, `max_turns`,
  `max_tokens` (`acp/agent.py:1023-1068`).

### The mechanism that exists: process env, `VIBE_*`

Vibe's config stack has an environment layer (`core/config/layers/environment.py:12-30`,
`env_prefix="VIBE_"`) ranked above user/project TOML and below runtime/profile/admin
layers (`core/config/default_orchestrator.py:33-36, 66-76`). Schema field
`enabled_tools` (`core/config/vibe_schema.py:413-420`) = allowlist of tool-name globs.
Verified without Mistral by loading the orchestrator in an isolated temporary
`VIBE_HOME`: `VIBE_ENABLED_TOOLS='["pi_*"]'` → `config.enabled_tools == ['pi_*']`.
No file under `~/.vibe/` has to be written; the bridge controls the child's env.
Granularity: **per `vibe-acp` process**, not per ACP session.

### What it did on the unified harness (observed, prompt C)

Env: `VIBE_ENABLED_TOOLS=["pi_*"]`, `VIBE_ACTIVE_MODEL=devstral-small`,
`VIBE_SYSTEM_PROMPT_ID=minimal`, `VIBE_INCLUDE_PROJECT_CONTEXT=false`,
`VIBE_INCLUDE_PROMPT_DETAIL=false`; mode left at default `accept-edits`.

- The model, asked to list its tools, answered (model-reported, not authoritative):
  `bash, edit, read_file, search_tool_functions, skill, write_file, run_typescript`.
  So **builtin tool definitions stay visible**; on the unified harness `enabled_tools`
  filters only MCP tools (`app_server/_unified_harness_backend_adapter.py:9148-9156`,
  `mistralai_vibe_local_harness/vibe/_mcp_models.py:91-112`).
- It tried `bash: ls` anyway; Vibe **denied it by policy without asking the client**:

  ```json
  {"sessionUpdate":"tool_call_update","kind":"execute","status":"failed",
   "rawOutput":{"type":"failure","error":{"code":"tool_denied",
     "message":"Tool execution denied by approval policy"},
     "_meta":{"approval":{"approvalSource":"never","approvalType":"never","decision":"skip"}}},
   "_meta":{"tool_name":"file_system.bash","effect_kind":"shell"}}
  ```

  Not isolated: I had no un-restricted baseline prompt (budget), so I cannot say whether
  `approvalSource: never` came from the env allowlist or from a unified-harness default.
  Treat "builtin execution denied" as observed-but-unexplained.
- The user's own Vibe config contributed an extra MCP server to every session in every run
  (seen in `~/.vibe/logs/mcp-descriptors/`, discovered at session start). It was not
  offered to the model under the restriction (the model listed none of its tools), but
  **user MCP servers, skills, hooks and AGENTS.md are inherited by bridge sessions**.

### Permission requests in provider mode

- Default mode `accept-edits`, MCP tool `mcp_pi.pi__echo` → Vibe **did** send
  `session/request_permission` (observed, once):

  ```json
  {"method":"session/request_permission","params":{"sessionId":"…",
   "toolCall":{"toolCallId":"effect-e0f5…"},
   "options":[{"optionId":"allow_once","kind":"allow_once"},
              {"optionId":"allow_always","kind":"allow_always"},
              {"optionId":"allow_always_permanent","kind":"allow_always"},
              {"optionId":"reject_once","kind":"reject_once"}]}}
  ```

  The request carries only a `toolCallId`; tool name and arguments came in the preceding
  `tool_call` (`title:"mcp_pi.pi__echo"`, `rawInput:{"text":"c"}`). Rejecting made the call
  fail: `tool_denied`, "denied by approval callback", `approvalSource:"user"`.
  Source: MCP tools default to `ToolPermission.ASK` (`core/tools/base.py:144`,
  `core/agent_loop/_loop.py:2940-2985`).
- Mode **`auto-approve`** (`bypass_tool_permissions`, `core/agents/models.py:101-106`):
  prompts A and B → **zero** permission requests, every MCP call has
  `"approval":{"approvalSource":"bypass","approvalType":"always","decision":"execute"}`.

**Consequence for ADR-0002 / AGENTS.md §15.** "Reject every permission request in
provider mode" would reject *every Pi tool call* under the default mode. The workable
combination observed is: `mode = auto-approve` + env restriction + an `enabled_tools`
allowlist that names only the bridge's server. That makes `auto-approve` acceptable only
because builtin execution was observed to be denied; this is the part that needs the
owner's decision and, ideally, one more owner-approved run (see open items).

## Decision 2 — HTTP MCP (Confirmed)

Stage 1, no prompt (`2026-11-24T06-22-06…-s1-baseline-mcp.jsonl`), loopback server with
bearer check; 0 unauthorized requests in every run:

```
t+6.43s POST /mcp initialize                    UA MistralAI-VibeCLI/2.25.8
                                                Accept: application/json, text/event-stream
t+6.44s POST /mcp notifications/initialized
t+6.44s POST /mcp tools/list
```

- Vibe sends our `Authorization: Bearer …` header on every request.
- ACP `mcpServers` `type:"http"` is projected to streamable-http
  (`acp/agent.py:297-331`); **SSE and ACP-transport servers are rejected** with a
  `ConfigurationError`. The server `name` is normalised (`[^A-Za-z0-9_-]`→`_`).
- **A fresh MCP session per call.** Every tool call is `initialize →
  notifications/initialized → (tools/list) → tools/call`, each on its own HTTP exchange
  (legacy: `core/tools/mcp/tools.py:165-195`; observed on unified, prompt B/A). The
  bridge's MCP server must therefore accept stateless/new sessions per call (no
  `Mcp-Session-Id` reuse) and a `tools/list` may follow a call.
- Startup: first MCP traffic ≈ 6.4 s after spawn (process start + discovery).
- Tool names reach Vibe unchanged: the `tools/call` carried `name:"pi__echo"`. What the
  *model* sees differs: unified → group `mcp_pi`, tool `pi__echo`, called as
  `mcp_pi.pi__echo` (naming `mistral.vibe.mcp-naming/v1`,
  `mistralai_vibe_local_harness/vibe/_mcp_naming.py:23,98-168`); legacy →
  `{server}_{tool}` = `pi_pi__echo` (`core/tools/mcp/tools.py:221`). The `pi__` prefix
  is therefore not visible-name-significant; the bridge must map by the MCP request name.
- The unified harness hides MCP tools behind a discovery step: before the first call the
  model ran two `tool_call`s titled `Searching for relevant tools`
  (`rawInput:{"mode":"best_match"}` then `{"mode":"details"}`), ~1.2 s each — two extra
  LLM steps per first use. The bridge must not mistake these for Pi tool calls.

## Decision 3 — model list (Confirmed)

`session/new` response (redacted, abridged; identical across runs):

```json
{"sessionId":"…","modes":{"currentModeId":"accept-edits","availableModes":[
   {"id":"ask"},{"id":"plan"},{"id":"accept-edits"},{"id":"auto-approve"}]},
 "configOptions":[
  {"id":"mode","category":"mode","type":"select","currentValue":"accept-edits","options":[…]},
  {"id":"model","category":"model","type":"select","currentValue":"mistral-medium-3.5",
   "options":[{"value":"mistral-medium-3.5","name":"Mistral Medium 3.5","description":"mistral-vibe-cli-latest"},
              {"value":"local","name":"Devstral (local)","description":"devstral"},
              {"value":"devstral-small","name":"devstral-small","description":"devstral-small-latest"}]},
  {"id":"thinking","category":"thinking","type":"select","currentValue":"high",
   "options":[{"value":"off"},{"value":"low"},{"value":"medium"},{"value":"high"},{"value":"max"}]}],
 "_meta":{"workspace_trust":{"status":"trusted","details":null}}}
```

- Metadata per model: `value` = Vibe **alias**, `name` = display name, `description` =
  upstream API model id (`acp/utils.py:160-172`). **No** context window, reasoning flag or
  image flag. The context window arrives later in `usage_update.size` (200000 for
  `devstral-small`; not measured for the others). Capability enrichment per ADR-0005 must
  come from Pi's registry.
- `local` ("Devstral (local)") is listed although it needs a local server; the list is
  not availability-filtered.
- `thinking` is a separate select (`off…max`); its default follows the model
  (`high` for medium-3.5, `off` for devstral-small).
- Selecting a model: `session/set_config_option {configId:"model", value:<alias>}`
  (`acp/agent.py:1032-1038`) goes through `config.update(...)` with no target layer, i.e.
  the **default layer = the user's `~/.vibe/config.toml`**
  (`app_server/_runtime_resources.py:182-200`, `app_server/_resources.py:595-650`,
  `core/config/default_orchestrator.py:59-66`). By source this **persists the user's
  active model**; I did not run it (it would write under `~/.vibe/`, forbidden for the
  spike). Per-process alternative that worked: `VIBE_ACTIVE_MODEL=<alias>` (session/new
  then reported `currentValue:"devstral-small"`). This needs an owner decision before
  the bridge switches models per Pi turn.

## Decision 4 — several tool calls in one step (Confirmed: parallel)

Prompt B (three `pi__echo`, unified, `auto-approve`), times relative to prompt send:

```
 4201 ms tool_call  mcp_pi.pi__echo {"text":"a"}  in_progress
 4206 ms tool_call  … {"text":"b"}
 4211 ms tool_call  … {"text":"c"}
 4214 ms MCP tools/call pi__echo a   (own initialize/initialized/tools/list around it)
 4219 ms MCP tools/call pi__echo b
 4226 ms MCP tools/call pi__echo c
 4253 ms tool_call_update a completed  rawOutput {"type":"success","content":[{"type":"text","text":"a"}]}
 4262 / 4266 ms updates b, c completed
```

All three arrive within ≈ 12 ms; the three ACP `tool_call`s precede their MCP requests by
≈ 13 ms and all three are announced before any completes. Because `pi__echo` returns
instantly, B alone cannot show overlap. Prompt A (`pi__slow_echo` "hello", held 45 s, plus
`pi__echo` "fast" in the same step) does:

```
 3840 ms tool_call  mcp_pi.pi__slow_echo {"text":"hello"}
 3843 ms tool_call  mcp_pi.pi__echo      {"text":"fast"}
 3877 ms tool_call_update fast  completed          <- finished while slow is still held
48904 ms tool_call_update slow  completed (server held it 3853→48857 ms)
```

- Calls in one model step are issued **concurrently**, not sequentially.
- Batching window: sample is n=1 per prompt, so 10–15 ms is an observation, not a bound.
  A quiet window of ≈ 50–100 ms after the first `tool_call` (or first MCP request) would
  have grouped all of them; the model decides whether to batch at all.
- ACP gives no "N calls in this step" signal. The ACP `tool_call` notifications are the
  earliest cue (≈ 13 ms before MCP) and carry `rawInput` already.

## Decision 5 — system prompt (Refuted: only extendable)

- ACP has no system-prompt field and Vibe ignores `session/new._meta` (see decision 1).
  `session/prompt` honours only one `_meta` key (user-display content,
  `acp/agent.py:113, 772`).
- Vibe's prompt text: legacy `core/system_prompt.py:380-455` = `config.system_prompt`
  (`core/config/vibe_schema.py:593`, built-in ids `cli, explore, tests, lean, minimal`;
  `core/prompts/__init__.py:19-26, 78-105`) plus commit-signature, model-info, OS/tool
  detail, project context, AGENTS.md sections (toggles `include_*`, `vibe_schema.py:595-599`).
  A custom id resolves to `<id>.md` in the project's or user's prompt dirs
  (`core/prompts/__init__.py:78-96`) — file-based, so using it means writing into the
  user's project or `~/.vibe/`.
- Unified: `system_prompt_id` is a GrowthBook/SDK *variant* resolved by
  `build_vibe_code_system_instructions(variant=…)`; only a built-in agent profile may
  name its own file (`app_server/_runtime.py:195-247`); the native core appends its
  capability sections. Observed: with `VIBE_SYSTEM_PROMPT_ID=minimal` and both
  `include_*=false`, the usage was still 20.7–27.8 k tokens over 2–4 steps (context size
  `used`≈7.3 k per step). Not isolated (tool definitions vs prompt), but a minimal prompt
  did not produce a minimal context.
- **Coexistence:** Pi's system prompt can only travel as text in the first `session/prompt`
  turn (ADR-0003's rebuild transcript already does that); Vibe's own prompt, builtin tool
  descriptions and the user's AGENTS.md/skills stay in force.

## MCP tool-call timeouts (source; the largest ADR-0002 risk)

- `MCPServer.tool_timeout_sec` default **60 s**, `startup_timeout_sec` **10 s**
  (`core/config/models.py:174-181`). ACP's `McpServerHttp` has only `name,url,headers`,
  so a session-scoped server always gets the defaults
  (`app_server/_runtime.py:2691-2718`, `acp/agent.py:297-331`).
- Legacy: `session.call_tool(..., read_timeout_seconds=call_timeout)`
  (`core/tools/mcp/tools.py:165-195`). Unified: `read_timeout_seconds=_timeout(tool_timeout_s)`
  and `httpx.Timeout(startup, read=tool_timeout_s)`, error code `mcp_timeout`, "retryable"
  (`mistralai_vibe_local_harness/vibe/_mcp_transport.py:126,158-159,445`).
- **Observed:** a 45 s hold worked. The ACP `session/prompt` stayed open for the whole
  50.5 s, ended with `stopReason:"end_turn"` and `usage {inputTokens:20707,
  outputTokens:75, totalTokens:20782}`. No `session/update` was sent during the hold (no
  keepalive/progress), and the trailing `tools/list` came 12 ms after the response.
- **Not tested:** a hold > 60 s (prompt budget). From source, expect `mcp_timeout`. If so,
  park-and-resume cannot keep an MCP call open while a slow Pi tool runs, so a Pi tool
  that takes > ~60 s would break the parked turn. Unproven mitigations: the env layer
  also accepts `VIBE_MCP_SERVERS` (JSON, with `tool_timeout_sec`), but that is
  per-process, not per-session. Needs an owner-approved test (one prompt, hold ≈ 75 s).

## Shapes relevant to the bridge

`initialize` response (no `_meta`):

```json
{"protocolVersion":1,
 "agentCapabilities":{"loadSession":true,
   "promptCapabilities":{"image":true,"audio":false,"embeddedContext":true},
   "sessionCapabilities":{"list":{},"fork":{},"close":{}}},
 "authMethods":[{"id":"browser-auth","name":"Sign in through Mistral AI Studio",
   "description":"Sign into Mistral Vibe through your Mistral AI Studio account."}],
 "agentInfo":{"name":"@mistralai/mistral-vibe","title":"Mistral Vibe","version":"2.25.8"}}
```

(`authMethods` is listed even when authenticated; `session/new` succeeded without
`authenticate`.) The client sent `clientInfo {name:"pi-mistral-bridge-spike", version}`
and `fs`/`terminal` false; Vibe called **no** client method except
`session/request_permission` (no fs/terminal/elicitation callbacks).

`session/prompt` response: `{"stopReason":"end_turn","usage":{"totalTokens","inputTokens",
"outputTokens"}}` (stable ACP `usage`; no cost). Observed stopReasons: `end_turn` ×3.
Source also has `cancelled`, `max_tokens`, `max_turn_requests` (`acp/agent.py:826-852`) and
`_meta.show_feedback_prompt` (`acp/agent.py:853`); not observed.

Usage: `usage_update` after every LLM step, e.g.
`{"used":7286,"size":200000,"cost":{"amount":0.0020932,"currency":"USD"},
"_meta":{"steps":2,"promptTokens":20707,"completionTokens":75,"cachedTokens":0,
"totalTokens":20782,"tokensPerSecond":0,"lastTurnDuration":0,"lastTurnTotalTokens":7286}}`.
`used` is the current context size, `_meta.*Tokens` are cumulative.

Session updates seen: `session_info_update` (title from first prompt), `user_message_chunk`
(echo of the prompt), `usage_update`, `available_commands_update` (12 slash commands,
~100 ms after `session/new`), `tool_call`, `tool_call_update`, `agent_message_chunk`.
No `agent_thought_chunk` (thinking was `off`). A text prompt beginning with `/` is
intercepted as a Vibe slash command (`acp/agent.py:782-796`).

Shutdown: `session/close` → `{}` in ≈ 0.2 s; SIGTERM → exit code 0; no `vibe-acp` left.

## Vibe-specific ACP extensions and `_meta` seen (candidate content of `src/vibe-protocol.ts`)

Observed on the wire: `session/new` response `_meta.workspace_trust{status,details}`;
`usage_update.cost` and `usage_update._meta.{steps,promptTokens,completionTokens,
cachedTokens,totalTokens,tokensPerSecond,lastTurnDuration,lastTurnTotalTokens}`;
`tool_call._meta.{tool_name,effect_kind}` (`effect_kind` ∈ `tool`,`shell`);
`tool_call_update.rawOutput._meta.approval.{approvalSource,approvalType,decision}`;
tool ids prefixed `effect-`; discovery pseudo-tool `effect-tool-discovery-*` titled
"Searching for relevant tools"; `session_info_update`; `available_commands_update`.

In source only (not exercised; `acp/agent.py:1127-1211, 1429-1457`): ext methods
`auth/status`, `auth/signOut`, `config/schema`, `session/set_title`, `session/delete`,
`trust/status|decision`, `rewind/preview|to`, `review/*`, `connectors/*`,
`projectLinks/*`, `loops/*`, `identity/*`, `account/*`, `logLevel/*`, `voice/*`; ext
notification `telemetry/send`; client-capability `_meta` keys `browser-auth-delegated`,
`terminal-auth` (`acp/agent.py:462-475`); prompt `_meta` user-display key.

## Surprises and risks for ADR-0002

1. **60 s MCP timeout, not configurable over ACP** (above) — park-and-resume breaks for
   slow Pi tools. Highest priority.
2. **Permission requests do occur** for MCP tools unless mode `auto-approve`; the
   "reject in provider mode" rule must be revised together with the disable mechanism.
3. **No ACP-level builtin-tool switch.** Env allowlist is per process; on the unified
   harness builtins stay *visible* (cost + confusion) though execution was denied.
4. **Two harnesses.** Default is a rollout (unified here); `--legacy-harness` is a
   documented flag but an "escape hatch". Behaviour (tool naming, discovery steps,
   prompt, allowlist semantics) differs; the bridge must pin one or support both. The
   legacy path was not prompted.
5. **User config leaks in**: MCP servers, skills, hooks, AGENTS.md from `~/.vibe` and the
   project are loaded into bridge sessions (and `auto-approve` would auto-run their tools
   if not filtered).
6. **`set_config_option model` persists to the user's `config.toml`** (source) — silent
   side effect on the user's own Vibe.
7. **Per-call MCP sessions** and a **model-visible tool-discovery step** (two extra LLM
   steps before the first Pi tool call on the unified harness).
8. **Token overhead**: ≈ 7.3 k context tokens per step before any Pi context.
9. **SDK drift:** `@agentclientprotocol/sdk` 2.9.1 no longer exports `ClientSideConnection`;
   the client API is `client().onRequest(...).onNotification(...).connect(stream)` with
   `ndJsonStream(output,input)`, and params are schema-validated. The plan's
   `acp-client.ts` should target that API.
10. Vibe writes its own state under `~/.vibe/` during any session (logs, MCP descriptor
    cache, experiment cache); this is Vibe's, not the bridge's, but "no files under
    `~/.vibe/`" cannot be promised for the child process.

## Honesty notes / deviations

- Prompt A was extended: it asks for `pi__slow_echo` **and** a concurrent `pi__echo` in one
  step so that it also answers decision 4's overlap question (B alone cannot). Prompt B
  additionally asked the model to list its tool names (it answered
  `mcp_pi.pi__echo`, `mcp_pi.pi__slow_echo`; C's list included builtins — model-reported
  lists are unreliable and differ).
- Order was C, B, A. My argument parser swallowed `--vibe-arg --legacy-harness`, so
  "legacy" Stage 1 run #1 and prompt B ran on the **unified** harness (the `spawn` event
  shows `args: []`). Fixed (`--vibe-arg=--legacy-harness`); a Stage-1 rerun confirmed the
  legacy backend starts, discovers our MCP server and reports no permission requests. No
  prompt was left to run on legacy.
- Prompts A and B used `auto-approve` mode with builtin tools still visible; prompt C ran in
  the default `accept-edits` mode (it produced the one `session/request_permission`). The
  prompts were synthetic and the cwd was this worktree. Controller check of the raw logs:
  exactly one `session/prompt` in each of the three stage-2 runs, none in stage 1.
- Nothing under `~/.vibe/` was read except directory listings and Vibe's own MCP-descriptor
  cache files (tool schemas only, headers not read). `config.toml` mtime was unchanged.
- Everything about `--legacy-harness` behaviour, the >60 s timeout, `set_config_option
  model` persistence, and "builtin execution denied: allowlist or default?" is **Unclear /
  unproven** — see below.

## Open items needing an owner-approved real run (≤ 3 prompts)

1. Hold ≥ 75 s on a parked MCP call (unified) → confirms or refutes the 60 s limit.
2. Same permission/tool-visibility prompt (C) on `--legacy-harness` → does the allowlist
   remove builtins there?
3. Baseline without `VIBE_ENABLED_TOOLS` (default mode, `bash ls`) → was the denial caused
   by the allowlist?

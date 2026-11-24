# Vibe ACP surface — spike results for design open decisions 1–5

Date: 2026-11-24 · Branch `spike/acp-surface` · Scripts: `spikes/` (not shipped)
Answers decisions 1–5 of `docs/plans/2026-11-24-pi-mistral-bridge-design.md`.
Feeds the follow-up ADR for ADR-0002 (disable mechanism, permission mode, timeouts).

## Verified against

- `vibe-acp` **2.25.8** (sections up to "Honesty notes") and **3.1.4** (section
  "Vibe 3.1.4 re-check", appended below; same uv tool, Python 3.12, macOS). Both
  `@mistralai/mistral-vibe`. Source paths below are relative to the tool's
  `site-packages/`; line numbers are 2.25.8 unless the 3.1.4 section says otherwise. `mistralai_vibe_local_harness` (native "Unified Harness", `_native.abi3.so`)
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

## Vibe 3.1.4 re-check (2026-11-24)

Same worktree, same scripts (`spikes/`, small additions, see its README), after the owner
upgraded Vibe 2.25.8 → **3.1.4** (`vibe-acp --version`). Everything above this heading is
2.25.8 history and is unchanged.

**Budget: 0 `session/prompt` calls.** Seven Stage-1 runs (initialize, `session/new`,
`session/set_mode` / `session/set_config_option` with `configId:"mode"` only,
`session/close`): `s3-baseline`, `s3-baseline2`, `s3-restricted`
(`VIBE_ENABLED_TOOLS=["pi_*"]`, `VIBE_ACTIVE_MODEL=devstral-small`, `set_mode auto-approve`),
`s3-cfgmode`, `s3-policy-env` (`VIBE_DEFAULT_APPROVAL_POLICY=ask`), `s3-noauto`
(`VIBE_ENABLE_AUTO_APPROVE=false`), `s3-envmcp` (Pi's MCP server only through
`VIBE_MCP_SERVERS`). The Stage-1 script now throws on `session/prompt` and on any
`set_config_option` other than `mode`. `~/.vibe/config.toml` mtime was unchanged
(2026-11-21) before and after all runs; no credentials were read; `pgrep -fl vibe-acp` empty
after every run. Config parsing was additionally checked in-process with the tool's own
Python against a throw-away `VIBE_HOME` (removed), no network use by me.
Source paths below: `site-packages/` of the uv tool; line numbers are 3.1.4. The native
core (`mistralai_vibe_local_harness/*.so`) was not read.

### Verdict per open decision (3.1.4)

| # | 2.25.8 | 3.1.4 |
|---|--------|-------|
| 1 | Refuted as phrased; env allowlist does not hide builtins; denial unexplained; permission requests for MCP unless `auto-approve`. | **Still no per-session switch over ACP; denial now explained by source; approval policy is settable by env and `set_mode`.** Details a, d. Whether builtin *definitions* are hidden from the model is unproven (native core). |
| 2 | Confirmed HTTP + bearer. | **Confirmed unchanged** (observed): `initialize` → `notifications/initialized` → `tools/list`, UA `MistralAI-VibeCLI/3.1.4`, bearer on every request, 0 unauthorized; also works when the server is configured only through `VIBE_MCP_SERVERS` (`s3-envmcp`). SSE/ACP transports still rejected (`vibe/acp/agent.py:332-339`). |
| 3 | Confirmed, thin metadata. | **Confirmed, and two new facts:** (i) the list is **dynamic** (remote model catalog), aliases changed between two runs one minute apart; (ii) `usage_update.size` (context window of the *active* model) is now sent right after `session/new`. |
| 4 | Confirmed parallel. | **Not re-measured** (no prompts). Same harness family as 2.25.8's measured runs (those already ran on the unified harness), so the result is expected to carry over. |
| 5 | Refuted: only extendable. | **Still only extendable over ACP.** A per-session `system_prompt` exists in the app-server protocol but ACP does not expose it. Details f. |

### Observed on the wire (3.1.4)

- `initialize` response: same shape as 2.25.8 (`agentInfo.version:"3.1.4"`,
  `loadSession`, `sessionCapabilities {list,fork,close}`, `promptCapabilities
  {image:true,audio:false,embeddedContext:true}`, `authMethods:[browser-auth]`). No new
  capability keys, no `_meta`. Took ≈ 3.6 s after spawn (2.25.8 not timed).
- `session/new` took ≈ 2.9 s. Response:

  ```json
  {"sessionId":"…",
   "modes":{"currentModeId":"accept-edits","availableModes":[
     {"id":"ask","description":"Requires approval for tool executions"},
     {"id":"accept-edits","description":"Auto-approves file edits only"},
     {"id":"smart-approve","description":"Classifies each tool call and auto-runs the safe ones, prompting only for risky ones"},
     {"id":"auto-approve","description":"Auto-approves all tool executions"}]},
   "configOptions":[
     {"id":"mode","category":"mode","type":"select","currentValue":"accept-edits","options":[…same 4…]},
     {"id":"model","category":"model","type":"select","currentValue":"mistral-large-4-0","options":[8 entries]},
     {"id":"thinking","category":"thinking","type":"select","currentValue":"high","options":[low,medium,high]}],
   "_meta":{"workspace_trust":{"status":"trusted","details":null}}}
  ```

  - **Modes = approval policies.** `plan` is gone (3.0.0 release notes, plan mode removed);
    `smart-approve` is new. There is **no separate approval-policy config option and no
    `agent` option**: `mode` *is* the approval policy; an `agent` select only appears when
    more than one primary agent exists (`vibe/acp/utils.py:161-181`; here only `default`).
  - `model` options on the first run (6): `mistral-large-4-0-3`, `glm-5-3`,
    `zai-glm-5-3-flash`, `mistral-medium-3.5`, `devstral-small`, `local`. Two runs later (8):
    `mistral-large-4-0`, `mistral-medium-latest`, `zai-glm-5-3`, `zai-glm-5-3-flash`,
    `deepseek-v4-1-flash-1017`, `mistral-medium-3.5`, `devstral-small`, `local`. Default is
    Mistral Large 4 (3.1.3 release notes). `thinking` options depend on the model (`low…high`
    for the default; `off…max` for `devstral-small`).
  - `session/set_mode` → `{}`; `session/set_config_option {configId:"mode"}` → the full
    updated `configOptions` array (SDK 2.9.1 shape).
- Notifications in the first ≈ 10 s: `usage_update` (`used:0`, `size:400000` for the default
  model / `200000` for `devstral-small`, `_meta.*Tokens` zero) immediately before the
  `session/new` response; `available_commands_update` ≈ 0.1 s after it (14 commands now,
  incl. `compact`, `mcp`, `reload`, `retry`, `vibe:*` skills). No `session_info_update`, no
  `config_option_update`, no permission request, no client callbacks (fs/terminal/elicitation)
  and no `_config/changed`.
- MCP discovery: `initialize` / `notifications/initialized` / `tools/list` ≈ 6.6 s after spawn
  (right after `session/new` was answered), identical for baseline, restricted, `ask`-policy
  and env-only runs. The user's own Vibe MCP servers are still loaded alongside (not
  measured here).
- Shutdown: `session/close` → `{}` in ≈ 0.2 s; SIGTERM → exit code 0. With stdin closed right
  after `initialize`, `vibe-acp` exited within ≈ 2 s (exit code 1, nothing written) —
  consistent with 3.0.3 "exits when its client stops"; not a graceful-path test.

### a. Approval policy vs agent (decision 1)

- **Delta:** 2.25.8 had *modes* (`ask/plan/accept-edits/auto-approve`) that only changed
  permissions. 3.1.4 splits **agent** (what the session is: `default`, `lean`; custom agent
  files) from **approval policy** (`ask`, `accept-edits`, `smart-approve`, `auto-approve`,
  `core/agents/models.py:21-26, 179-210, 271-289`). ACP's `mode` / `session/set_mode` maps
  1:1 to the policy: `set_session_mode` → `resources.agents.switch_policy(mode_id)` →
  app-server `session/approvalPolicy/update` (`vibe/acp/agent.py:1074-1083`,
  `app_server/_runtime_resources.py:351-363`); `set_config_option mode` the same
  (`agent.py:1092-1093`); `set_config_option agent` switches the agent (`agent.py:1094-1095`).
  An unknown/hidden mode id makes `set_mode` return `None` (observed as `{}`), not an error.
- **Per session at creation: no.** The ACP layer builds `SessionOptions(cwd, workspace_roots,
  disabled_tools, mcp_servers)` only (`agent.py:618-626`) and drops everything else in
  `session/new` (`del kwargs`, `agent.py:548-571`). The app-server's `AgentConfig` *has*
  `approval_policy`, `auto_approve`, `enabled_tools`, `system_prompt`, `max_turns`,
  `max_price` (`app_server/protocol.py:411-441, 461`) but ACP never fills them.
- **What the bridge can do instead:** per *process* by env, per *session* by `set_mode` after
  `session/new`. **Verified (Stage 1):** `VIBE_DEFAULT_APPROVAL_POLICY=ask` → the new session
  reports `currentModeId:"ask"` (`core/config/vibe_schema.py:1143-1151`); `session/set_mode
  auto-approve` → `{}`. `set_mode` and `set_config_option mode` did **not** touch
  `config.toml` (mtime unchanged); the switch is pinned to Vibe's own session record
  (`_unified_harness_backend_adapter.py:10535-10570`) and sends a telemetry event
  (`:10584`).
- **Is `auto-approve` refusable?** Yes, but only by Vibe config, not by the ACP client or
  per session: `enable_auto_approve=false` (env `VIBE_ENABLE_AUTO_APPROVE=false`,
  `vibe_schema.py:1193-1201`) removes the policy from `availableModes`
  (`core/agents/manager.py:488-500`) and clamps the bypass
  (`app_server/_runtime.py:3117-3128`). **Verified:** with that env the list is
  `ask, accept-edits, smart-approve`, and `set_mode auto-approve` returned `{}` (silently
  ignored, `agent.py:1078-1080`). ACP has no refusal of its own for auto-approve.
- `smart-approve` runs a *classifier model call per tool call* (`_runtime.py:2029, 2354-2364`,
  `classifier_model`, "Set only under smart approve"): extra LLM requests and cost, and a
  second model sees tool arguments. Not suitable for provider mode.
- **For ADR-0002:** the two workable shapes are (1) policy `auto-approve` + allowlist
  (below) or (2) policy `ask` + the bridge answers each `session/request_permission`
  itself: allow-once when the preceding `tool_call` names a Pi tool (the request still
  carries only `toolCallId`, `agent.py:917-925`), reject otherwise. (2) keeps AGENTS.md §15
  literally satisfiable ("reject non-Pi requests") and needs no `auto-approve`; it adds one
  ACP round-trip per tool call. Option (2) was not exercised (needs a prompt).
- `request_permission` options now come from `build_permission_options`
  (`agent.py:917-925`) and can include `allow_always_permanent` and path-scope variants that
  persist grants (`APPROVE_PERMANENTLY`, `agent.py:934-952`). The bridge must only ever
  answer `allow_once` / `reject_once`.

### b. MCP tool permissions and trust

- Still **ASK by default** for a client-supplied server's tools: provided/MCP tools resolve
  to `ToolPermission.ASK` unless in `_ALLOWED_BY_DEFAULT`
  (`app_server/_unified_permissions.py:85, 613-633`),
  and the runtime gate for provided tools is `ask` (prompt) / `classify` / `allow` (bypass)
  (`_runtime.py:3317-3326`).
- **Per-server trust:** none. `_MCPBase` has `disabled`, `disabled_tools`, `prompt`,
  `sampling_enabled`, timeouts — no permission/trust field (`core/config/models.py:222-260`);
  the ACP projection sets only `name`, `url`, `headers` (`agent.py:306-340`,
  `_runtime.py:3427-3454`).
- **Per-tool permission without writing a file:** the tool's config key
  (`tools.<published-name>.permission`, published name = `{server}_{remote-name}`, per
  `_unified_permissions.py:147-170`) can be set through the env layer. **Verified (config
  load, isolated `VIBE_HOME`):** `VIBE_TOOLS='{"pi_pi__echo":{"permission":"always"}}'` →
  `config.tools["pi_pi__echo"] == {"permission":"always"}`. Keys are exact names (no glob),
  per process, and the Pi tool list is dynamic, so this only works if the bridge spawns
  `vibe-acp` after it knows the tool names. Whether the unified harness honours it for an
  ACP-supplied server at call time was **not** observed (paid run).
- ACP `mcpServers` server entries are **overridden by name** by env-configured ones with the
  same name (`mcp_servers` is `WithUnionMerge(merge_key="name")`, higher layer wins whole
  entries, `vibe_schema.py:1068-1072`, `core/config/schema.py:215-223`). Use a different
  server name if both are used.

### c. MCP tool-call timeout

- **Unchanged: 60 s default** (`tool_timeout_sec`, `core/config/models.py:235-237`;
  `startup_timeout_sec` 10 s, `:230-234`). Session-scoped ACP servers are built with no
  timeout field, so they get the defaults (`_runtime.py:3427-3454`).
- **New finding: configurable, per process, via env.** **Verified (config load + Stage 1):**
  `VIBE_MCP_SERVERS='[{"transport":"streamable-http","name":"pienv","url":…,
  "tool_timeout_sec":600,"auth":{"type":"static","headers":{"Authorization":"Bearer …"}}}]'`
  parses (`config.mcp_servers → [("pienv", 600.0)]`) and `vibe-acp` discovers that server with
  the bearer header with **no ACP `mcpServers`** at all (`s3-envmcp`: `initialize`,
  `initialized`, `tools/list`, 0 unauthorized). The value is carried into the runtime as
  `tool_timeout_s` (`_runtime.py:738, 757`; `_unified_harness_backend_adapter.py:20578`) and
  used as `read_timeout_seconds` and httpx `read` timeout
  (`mistralai_vibe_local_harness/vibe/_mcp_transport.py:118-126, 156-158`). **Whether a hold
  > 60 s with `tool_timeout_sec` raised actually survives is not observed** (paid run). The
  bearer token then lives in the child's environment (same user; not visible in `ps` args).
- **ACP:** no way. **Global setting:** none found besides the per-server field (shell tools
  have their own timeouts, `core/config/shell_timeouts.py`, irrelevant to MCP).
- **Progress/keepalive: no.** Vibe's `call_tool` passes no `progress_callback`
  (`_mcp_transport.py:118-126, 296-300`); the Python MCP SDK 2.3.0's request timeout is an
  anyio deadline on the request (`mcp/shared/_request_clock.py`, `jsonrpc_dispatcher.py:380-440`)
  that is paused only while the client is waiting on a person for a server-initiated request,
  not by progress notifications. Do not rely on progress/SSE keepalive to extend a call; the
  timeout error is `mcp_timeout` ("retryable", `_mcp_transport.py:471`).

### d. `enabled_tools` / `disabled_tools` and a tools-only session

- **Delta (explains the 2.25.8 observation):** `enabled_tools`/`disabled_tools` are applied by
  `ToolManager.available_tools` to *all* tools including builtins
  (`core/tools/manager.py:158-186`); the unified runtime builds `available_tools` from it
  (`_runtime.py:2060-2066`) and sets every builtin that has no available Vibe tool to
  tool-mode **`deny`** (`_rust_tool_modes`, `_runtime.py:3248-3281`; "A builtin is denied when
  the catalogue offers no tool it stands for"). That is exactly the observed
  `tool_denied … approvalSource:"never"` for `bash` in prompt C. So with
  `VIBE_ENABLED_TOOLS=["pi_*"]` the builtins are **denied by policy, regardless of the
  approval policy** (also under `auto-approve`: bypass only fills `allow` for builtins that
  are in `available_tools`, `:3281-3282`; `agent_refused_tools` additionally removes tools an
  agent sets to `never`, `:2073-2077`, `core/agents/registry.py:194-203`). Vibe-provided
  tools (todo, scratchpad, cron, …) honour the same globs (`_provided_tools.py:215-260`);
  connectors/MCP via `_mcp_tool_filter` (`_unified_harness_backend_adapter.py:20548-20554`).
- **Still unknown:** whether the *definitions* of denied builtins are withheld from the model
  (2.25.8: the model listed them). That is native-core behaviour — a paid prompt can tell
  (ask for the tool list; compare `usage_update.used` after the first step).
- **Tools-only agent/profile: none built in.** Builtin agents: `default`, `lean`
  (install-required, own model), `explore` (a *subagent*, read-only builtins)
  (`core/agents/models.py:271-276`). A custom agent can set `enabled_tools`/`disabled_tools`
  (`_AGENT_KEYS`, `models.py:118-134`) but is a **file** (`~/.vibe/agents/*.toml` or project
  `.vibe/agents/`), selected by `default_agent` / `VIBE_DEFAULT_AGENT`. `enabled_agents`/
  `disabled_agents` only filter which agents exist. Relocating `VIBE_HOME` for the child would
  allow generated files but also hides Vibe's auth — not an option (AGENTS.md §14).
  **Conclusion:** the env allowlist is the only file-free switch; per process.

### e. `session/set_config_option` for `model`

- **Unchanged by source: persists.** `set_config_option model` →
  `resources.config.write_model(model_alias=…)` (`agent.py:1096-1100`) → `config/model/write`
  with `session_only=False` (default; `_runtime_resources.py:131-157`,
  `protocol.py:1859-1866`) → `_write_default_model_config`
  (`_unified_harness_backend_adapter.py:10846`): the write goes to the default layer =
  the **user's `config.toml`** (`core/config/default_orchestrator.py:33-45, 59-65`) and is
  *also* pinned in the session override layer. `thinking` is the same path
  (`set_thinking → write_model(reasoning_effort)`). A **non-persisting** variant exists in the
  app-server (`session_only=True`, `_write_session_model_config`, `:10896`), but ACP
  never sets it. **Not executed** (budget rule: no `model` writes).
- **Per-process, non-persisting way: unchanged** — `VIBE_ACTIVE_MODEL=<alias>` works
  (`s3-restricted`: `model.currentValue:"devstral-small"`, thinking default `off`). It is
  per `vibe-acp` process, so a per-Pi-turn model switch means one process per model (or a
  restart on model change). `config.toml` was untouched in all runs.
- The alias set is **not stable** (see decision 3): use the `description` (API id) plus
  `name` for matching and re-read the list on every spawn.

### f. System prompt

- **ACP: no new way.** The app-server's `AgentConfig.system_prompt` ("Replaces Vibe's product
  prompt (or the active agent's own) only: Core's guidance still comes first, and project
  context and AGENTS.md follow", `protocol.py:437-441`) is not reachable from ACP
  (`agent.py:618-626`; `session/new._meta` ignored). `VIBE_SYSTEM_PROMPT_BEHAVIOR` is
  ignored unless GrowthBook set it (`_runtime.py:348-363`); `VIBE_SYSTEM_PROMPT_ID` only picks
  among the SDK's variants.
- File-based only: an agent profile with `system_prompt_id` + prompt file (`base` replaces the
  product prompt, `_runtime.py:303-326, 417`), `session_start` / `pre_agent` hooks
  (`core/hooks/models.py:20-29`, loaded from hook files via `load_hooks_from_fs`,
  `core/hooks/config.py:94-116`). Both would mean writing into the user's project or
  `~/.vibe/`, so not for the bridge.
- **Client-neutral markdown: yes, in source.** ACP sessions get `surface = "neutral"`
  (`app_server/_surface_instructions.py:24-37`, `_runtime.py:2176`): "displayed by a client
  whose rendering is unknown … portable GitHub-flavored markdown" instead of the terminal /
  desktop block. (The 3.1.1 release notes do not mention this; the source does.) The product
  prompt itself is unchanged in kind, so Pi's prompt can still only travel as text in the first
  `session/prompt` (ADR-0003).

### g. Other ACP-layer changes relevant to the bridge

- **`cancelled` with a pending approval (3.0.2):** by source, `session/cancel` →
  `session.cancel_prompt()` (`agent.py:1000-1007`); the turn task's `CancelledError` yields
  `PromptResponse(stop_reason="cancelled", usage=…)` unless the connection itself is closed
  (`agent.py:863-872`), in which case it is re-raised. Not exercised.
- **Cached tokens (3.0.1):** `PromptResponse.usage.cachedReadTokens` (omitted when 0) and
  `usage_update._meta.cachedTokens` (`agent.py:1768-1775`; 1777-1800). Not exercised.
- **Exit when the client stops (3.0.3):** `run_agent(...)` returns on stdin EOF, then
  `agent.close()`; SIGTERM → graceful close with a 1 s budget
  (`agent.py:1839-1895`, `_SIGTERM_CLOSE_TIMEOUT_SECONDS`). Observed: EOF → exit within ≈ 2 s;
  SIGTERM → code 0. The bridge still kills the child on shutdown (AGENTS.md §15).
- **Admin config change notification (3.1.1):** ext notification `_config/changed`
  (`CONFIG_CHANGED_EXT_METHOD`, `agent.py:409-415, 1038-1050`) when org config changes; the
  bridge must ignore unknown ext notifications. Also new: ext `session/retrying`
  (`RETRYING_EXT_METHOD`, `agent.py:405`) and the stable `config_option_update` session
  update after slash commands (`agent.py:1814-1821`).
- **`agentWorktrees`:** an app-server client capability (`_connection_protocol.py:115`,
  default false). The ACP descriptor sets only `callback_kinds` (`approval`, plus `user_input`
  when the client advertises `elicitation.form`) and `client_tools` from `fs`/`terminal`
  (`agent.py:686-710`), so ACP sessions never get the `enter_worktree` tool. Non-interactive
  clients get only `ask_user_question` disabled now (`NON_INTERACTIVE_DISABLED_TOOLS`,
  `agent.py:185`; `exit_plan_mode` is gone with plan mode).
- **Client identification (read-only observation):** `clientInfo.name/title/version` from
  `initialize` are forwarded unchanged into Vibe's own app-server `ClientInfo(entrypoint="acp")`
  (`agent.py:686-710`) and into Vibe's telemetry `vibe.new_session` as `client_name` /
  `client_version` (`core/telemetry/send.py:476-500`, `app_server/_launch_context.py:14-26`) and
  the GrowthBook experiment evaluation context (`app_server/_missing_layers.py:142`). LLM requests carry the
  fixed UA `mistral-client-python/Mistral-Vibe/3.1.4` (`utils/http.py:291-304`); MCP requests
  `MistralAI-VibeCLI/3.1.4`. I found no "third-party client" detection or billing flag in the
  Python layer — the only name check is `JetBrains.*` for auth methods
  (`acp/utils.py:124-125`). The `third-party` hits in source concern third-party *model
  providers*. Native core not read. The bridge keeps identifying itself honestly
  (`pi-mistral-bridge`, real version; AGENTS.md §14); nothing here was altered.
- **Startup:** `vibe-acp` now refuses to start without the unified harness runtime
  (`acp/entrypoint.py:134-143`); `--legacy-harness` and `--experimental-harness` are gone.
  `experimental_local_runtime_session_api` (default true, `vibe_schema.py:1283-1291`) selects
  how the app server drives the local session; the legacy runtime path is only reachable
  with `VIBE_EXPERIMENTAL_LOCAL_RUNTIME_SESSION_API=false` — not exercised, not recommended.

### Updated open items that still need a real (paid) prompt run

Each is one line; together they fit in ≤ 3 prompts if combined (owner approval per run,
AGENTS.md §4).

1. **Timeout:** env `VIBE_MCP_SERVERS` server with `tool_timeout_sec=120`, `pi__slow_echo`
   held 75 s → survives (vs `mcp_timeout` at 60 s with the default). Also run the default
   60 s case with a 75 s hold on the ACP-supplied server as the control.
2. **Builtin visibility:** same run, under `VIBE_ENABLED_TOOLS=["pi_*"]` + policy `ask`, ask
   "list the tools you can call" and call `bash ls` → are builtin definitions hidden, and is
   `bash` denied without a `request_permission`?
3. **Policy `ask` + bridge answering:** call a Pi tool in `ask`; the bridge answers
   `allow_once` to the request; confirm the call runs, the request carries only `toolCallId`
   preceded by `tool_call mcp_pi.*`, and an `ask`-policy request for `bash` can be rejected
   without breaking the turn.
4. **Per-tool `always` via env:** `VIBE_TOOLS` with the published name of one Pi tool under
   `ask` → no `request_permission` for it; confirms the key format `{server}_{tool}`.
5. **Parallel batching on 3.1.4:** re-run prompt A/B shape (two tool calls in one step) —
   confirms decision 4 and the MCP naming (`mcp_pi.pi__echo`) still hold.
6. **Cancel with a pending approval:** policy `ask`, send `session/cancel` while a permission
   request is open → `stopReason:"cancelled"`, no hung request, session reusable.
7. **Usage:** one finished turn → `usage.cachedReadTokens` / `usage_update.cost` shape on 3.1.4
   (decision for ADR-0003's token accounting).
8. **`set_config_option model` persistence** is still *only* source-derived; it would write
   the owner's `config.toml`, so it stays unrun unless the owner wants it proven (back up
   `config.toml` first, run `thinking`/`model` once, diff).

### Honesty notes (3.1.4 round)

- The 2.25.8 text claims in decisions 1–5 that I re-verified are only those listed above;
  parallel tool calls (4), MCP naming and per-call MCP sessions on 3.1.4 are source-only
  (`_mcp_transport.py:118-126` opens a session inside `call_http`) or carried over.
- The first `s3-baseline` run saw a 6-entry model list and the following runs an 8-entry list:
  Vibe refreshes its model catalog from a Mistral endpoint using its own credentials
  (`core/model_catalog/`, TTL 30 days, `_constants.py`); that traffic is Vibe's, not the
  bridge's. The change is therefore a real behaviour of the tool, not a script difference.
- `VIBE_TOOLS`, `VIBE_MCP_SERVERS`, `VIBE_DEFAULT_APPROVAL_POLICY` and `VIBE_ENABLED_TOOLS`
  parsing was verified by loading Vibe's own config orchestrator against a temporary
  `VIBE_HOME` (it created only `trusted_folders.toml` there; removed). Whether the *runtime*
  honours each value for ACP-supplied servers is what the paid items above test.
- The task description attributes "client-neutral markdown" to 3.1.1; the release notes of
  3.1.1 do not say so, the source does (f). `agentWorktrees` is likewise not in the release
  notes; it is in `_connection_protocol.py`.

## Vibe 3.1.4 paid run (2026-11-24)

Stage 3 (`spikes/acp-paid.ts`, one `session/prompt` per process), owner-approved run against
`vibe-acp` 3.1.4. **Budget: 3/3 prompts used** (`spikes/out/prompt-count.json`; the 2.25.8
Stage-2 counter was archived to `prompt-count.2-25-8-stage2-archived.json` when this task's
budget started — nothing deleted). **Model: `devstral-small`**, the smallest Mistral-family
alias in the `model` config option of `session/new` on 2026-11-24 (options:
`mistral-large-4-0`, `mistral-medium-latest`, `mistral-medium-3.5`, `devstral-small` plus
non-Mistral `zai-glm-*`, `deepseek-*`, `local`), selected **only** via
`VIBE_ACTIVE_MODEL=devstral-small` (every session reported `model.currentValue:"devstral-small"`,
`usage_update.size:200000`). Process env under test: `VIBE_ACTIVE_MODEL`,
`VIBE_ENABLE_AUTO_APPROVE=false`, `VIBE_DEFAULT_APPROVAL_POLICY=ask` (session mode stayed `ask`),
`VIBE_ENABLED_TOOLS=["pi_*","pislow_*"]`, `VIBE_MCP_SERVERS=[{"name":"pislow", streamable-http →
spike loopback, bearer, "tool_timeout_sec":120}]`; the ACP `session/new` additionally supplied
the HTTP server `pi` (default timeout). The client answered `session/request_permission` itself:
`allow_once` only when the referenced `toolCallId` belonged to a `tool_call` whose
title / `_meta.tool_name` named a spike MCP tool, otherwise `reject_once`.

**Cost:** prompt 1: 150 739 tokens (cachedRead 132 224), $0.0152483; prompt 2: 210 996 tokens
(cachedRead 205 184), $0.0212932; prompt 3: turn never completed, last `usage_update` $0.0053794.
Total ≈ 361 735 tokens, ≈ **$0.042**. **`~/.vibe/config.toml`: stat `1795262419 6047`, sha256
`34f522af…b85d7` — identical before and after every run** (per-run fingerprints in each
`*-summary.json`; hash only, the file was never read into a log or copied).
`pgrep -fl vibe-acp` empty after every run. No credentials read; bearer tokens redacted in all
logs; prompts synthetic.

### Prompt 1 — timeout, one step, two parallel 75 s holds (server `pi` default vs `pislow` 120 s) — **Refuted**

Both calls failed at **exactly 60 000 ms** with error code `tool_timeout`, message
`mcp_pi.pi__slow_echo ran for the program's whole time budget of 60000 ms and was cancelled.`
(same for `mcp_pislow.pi__slow_echo`), `retryable:false`. The cap is **not** the per-server MCP
read timeout: it is the hardcoded program time budget
`settings.tools.programmatic.max_elapsed_ms = 60_000` that the app server bakes into every
session (`vibe/app_server/_runtime.py:2226`, `RustToolSettings(...)`); the local harness
enforces it on provided-tool (MCP) actions and produces exactly this error
(`mistralai_vibe_local_harness/vibe/_local_actions.py:906-933`, with the source comment that a
remote MCP handler *keeps running* after the call is cancelled). `tool_timeout_sec:120` on the
env server therefore never fires — the 60 s budget fires first. The ACP prompt **stayed open**:
the model re-issued the pair twice more (6 `tools/call` total at t=11032/11036, 91865/91868,
232001/232005 ms; between rounds it issued `wait` calls; the server-side handlers kept running
past the client-side cancel — `tool_exec_end` at t≈86035, ~15 s after the cancel at t≈71 s),
then answered `DONE pi=error pislow=error`; `PromptResponse` `stopReason:"end_turn"` after
293 986 ms, `usage {totalTokens:150739, inputTokens:149867, outputTokens:872, cachedReadTokens:132224}`;
final `usage_update {used:19461, size:200000, cost:{amount:0.0152483, currency:"USD"}, _meta:{…,
cachedTokens:132224}}`. All 6 permission requests (payload only `toolCallId`, preceded by
`tool_call` title `mcp_pi.`/`mcp_pislow.pi__slow_echo`) were answered `allow_once` and the calls
ran (`_meta.approval {approvalSource:"user", approvalType:"ask", decision:"execute"}`).
**Verdict: Refuted** — per-server `tool_timeout_sec` does not extend the effective MCP tool-call
timeout in ACP sessions on 3.1.4; a hardcoded, non-env-configurable 60 s program budget cancels
every MCP tool call first, for ACP-supplied and env-configured servers alike. The transport-level
`mcp_timeout` (60 s default `tool_timeout_sec`) is a second, later layer that never fired here.

### Prompt 2 — ask mode + visibility + parallel batching + builtin attempt — **Confirmed** (one nuance)

Session mode `ask`. The model's final tool list: `read_file, write_file, edit, bash, skill,
search_tool_functions, run_typescript, wait, mcp_pi.pi__echo, mcp_pi.pi__slow_echo` — **builtin
definitions remain visible** under `VIBE_ENABLED_TOOLS=["pi_*","pislow_*"]`; only execution is
blocked. `bash ls` was issued twice and failed with error code `tool_denied`, "Tool execution
denied by approval policy", `_meta.approval {approvalSource:"never", approvalType:"never",
decision:"skip"}` — **without any `session/request_permission`** (builtins are denied by policy,
not by the client). The three `pi__echo` calls ("a","b","c") went out in one step, parallel
(`tools/call` at t=18412, 18423, 18429 ms), all succeeded after `allow_once`; the model then
re-issued the same three calls once more (t=24276/24287/24295, also allowed). 6 permission
requests in total, each carrying only `toolCallId` and mapped via the preceding `tool_call`
(title `mcp_pi.pi__echo`, `_meta.tool_name`) to a spike tool → `allow_once`; no non-spike request
ever arrived. Tool-discovery pseudo-steps ("Searching for relevant tools",
`effect-tool-discovery-*`, modes `all_connector_capabilities`/`best_match`/`details`) ran before
the calls. `stopReason:"end_turn"` after 27 709 ms; `usage {totalTokens:210996, inputTokens:210028,
outputTokens:968, cachedReadTokens:205184}`; cost $0.0212932; `usage_update used:20685/size:200000`.
Nuance: the model's own list did not include `mcp_pislow.*` although those tools were callable
(prompt 1 called `mcp_pislow.pi__slow_echo` successfully) — the listing is model-driven via the
discovery tool and incomplete.
**Verdict: Confirmed** — policy `ask` + the bridge answering `allow_once`/`reject_once` works
(open item 3), parallel batching works on 3.1.4 (open item 5's naming `mcp_pi.pi__echo` and
decision 4 carry over), and builtins are denied *without* a permission request but are **not
hidden** from the model (open item 2: execution denied, definitions visible).

### Prompt 3 — `session/cancel` during a pending approval — **Refuted**

Prompt (call `pi__echo` once) sent 07:42:36.808Z; `tool_call mcp_pi.pi__echo` in_progress
07:42:42.996; `session/request_permission` (id 0) arrived 07:42:43.001 and was **held
unanswered**; `session/cancel` sent 07:42:46.005 (3.005 s later); the guard sent a second cancel
07:44:36.810. Observed: **no agent→client message after the cancel** — no `session/update`, no
response to `session/prompt` (id 2 never resolved), no `cancelled` outcome for the pending
permission request; the tool_call stayed `in_progress` and `vibe-acp` stayed alive until it was
externally killed at ~07:47:23Z (child exit 0 on SIGTERM). Budget was exhausted (3/3), so no
further prompt; `session/close` was the last message.
**Verdict: Refuted** — on 3.1.4, `session/cancel` while a `session/request_permission` is pending
did not end the prompt within ~4 minutes; the turn, the pending request and the tool_call all
stayed open and the process had to be killed. This contradicts the 3.0.2 release-note
expectation (`agent.py:1000-1007` source path was not effective here). Bridge implication: **always
answer `session/request_permission`** — cancel cannot be relied on to unblock it.

### Viability for provider mode (ADR-0002) — viable, with these env-only constraints

All verified without touching `~/.vibe/config.toml` (stat+sha256 identical before/after):

- **Permission policy:** session mode stays `ask` (`VIBE_DEFAULT_APPROVAL_POLICY=ask` +
  `VIBE_ENABLE_AUTO_APPROVE=false`, so `auto-approve` is not even selectable); the bridge answers
  every `session/request_permission` itself — `allow_once` only when the referenced `toolCallId`
  maps to a `tool_call` naming a Pi tool (title / `_meta.tool_name`), `reject_once` otherwise;
  never `allow_always`/`allow_always_permanent`; **always answer** (prompt 3: cancel does not
  unblock a pending request).
- **Allowlist:** `VIBE_ENABLED_TOOLS` globs match the MCP display name `{server}_{tool}`
  (fnmatch, case-insensitive — `mistralai_vibe_local_harness/vibe/_mcp_models.py:93-114`,
  `_mcp_naming.py`); for servers `pi` and `pislow` that is `["pi_*","pislow_*"]`. The bridge must
  spawn `vibe-acp` with globs covering its own MCP server name(s). Result: builtins are denied
  without a permission request (`tool_denied`, `approvalSource:"never"`) — Vibe's own tools never
  execute — but their definitions stay visible to the model (harmless: they always fail).
- **Timeout:** every Pi tool call must complete within **60 s** — hardcoded program time budget
  (`max_elapsed_ms=60_000`, `vibe/app_server/_runtime.py:2226`), **not raisable** via
  `tool_timeout_sec` (prompt 1). Long Pi tools are cancelled client-side while the MCP handler
  keeps running, and the model may retry → **duplicate execution of Pi tools**; the bridge must
  make Pi tool execution idempotent/duplicate-tolerant or keep calls under 60 s.
- **Model selection:** `VIBE_ACTIVE_MODEL=<alias>` per process, alias taken from the dynamic
  `model` config option re-read on every spawn (cheapest Mistral alias observed 2026-11-24:
  `devstral-small`). NEVER `session/set_config_option` with `configId:"model"` (persists into the
  user's `config.toml` — still only source-derived, deliberately unrun).
- **Usage accounting (ADR-0003):** present on 3.1.4 — `PromptResponse.usage {totalTokens,
  inputTokens, outputTokens, cachedReadTokens}` (omitted when 0) and `usage_update {used, size,
  cost:{amount,currency}, _meta:{promptTokens, completionTokens, cachedTokens, totalTokens, steps}}`.

### Still unproven after the paid run

- Per-tool `permission:"always"` via `VIBE_TOOLS={"{server}_{tool}": …}` at call time for an
  ACP-supplied server (open item 4) — unobserved, and unnecessary given the `allow_once` policy works.
- Whether the 60 s program budget also caps a *single* (non-parallel) MCP call — prompt 1 used
  parallel pairs; both were capped, so every MCP call observed was capped, but a single-call run
  was not isolated.
- The transport-level `mcp_timeout` payload on 3.1.4 (never fired; the program budget fired first).
- `set_config_option model` persistence (open item 8) — still source-only, deliberately unrun.
- Any way to hide builtin tool *definitions* from the model (native core) — prompt 2 shows they
  are visible; no env switch hides them.
- What ends a pending-approval turn on 3.1.4 besides answering the request, closing the
  connection or killing the process — `stopReason:"cancelled"` was never observed (prompt 3).

// Stage 3 — PAID run (vibe-acp 3.1.4, owner-approved). Every run spends Mistral allowance.
//
//   npx tsx acp-paid.ts --prompt timeout|visibility|cancel [--model-alias ALIAS] [--slow-ms 75000] [--timeout-ms N]
//
// One session/prompt per process; the hard budget of 3 prompts for this paid stage is
// enforced by spikes/out/prompt-count.json (reservePrompt raises beyond MAX_PROMPTS; failed
// runs count). Process configuration under test (provider-mode candidate, ADR-0002):
//   VIBE_ACTIVE_MODEL=<alias>          (cheapest Mistral model from the `model` config option;
//                                        NEVER set_config_option model — that persists to config.toml)
//   VIBE_ENABLE_AUTO_APPROVE=false     (auto-approve policy not selectable)
//   VIBE_DEFAULT_APPROVAL_POLICY=ask   (session mode stays "ask")
//   VIBE_ENABLED_TOOLS=["pi_*","pislow_*"]  (allowlist: only the spike's MCP tools, on both the
//                                        ACP-supplied server "pi" and the env server "pislow";
//                                        globs match the display name {server}_{tool})
//   VIBE_MCP_SERVERS=[{"name":"pislow", streamable-http, {{MCP_URL}}, bearer {{MCP_TOKEN}},
//                      "tool_timeout_sec":120}]
// The ACP session/new additionally supplies the HTTP server "pi" with the default timeout.
// The client answers session/request_permission itself: allow_once ONLY when the referenced
// toolCallId belongs to a tool_call naming one of the spike's MCP tools, otherwise reject_once
// (--prompt cancel: never answer, send session/cancel ~3 s after the request arrives).
// ~/.vibe/config.toml is only stat-ed + sha256-ed (never read into a log, never copied).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_PROMPTS,
  OUT_DIR,
  iso,
  now,
  openSession,
  parseArgs,
  promptCount,
  reservePrompt,
  sleep,
  type PermissionContext,
  type SpikeSession,
} from "./lib.ts";

const PROMPTS: Record<string, { text: string; defaultTimeoutMs: number }> = {
  timeout: {
    // One step, two parallel held calls: server "pi" (ACP-supplied, default 60 s timeout)
    // vs server "pislow" (env, tool_timeout_sec=120). Both hold 75 s.
    text:
      'In ONE single step, issue two tool calls at the same time: (1) the tool of the MCP server named "pi" whose name ends with "pi__slow_echo" ' +
      '(it may be listed as "pi_pi__slow_echo" or "mcp_pi.pi__slow_echo"), with text "on-pi"; and (2) the tool of the MCP server named "pislow" whose name ends with "pi__slow_echo" ' +
      '(it may be listed as "pislow_pi__slow_echo" or "mcp_pislow.pi__slow_echo"), with text "on-pislow". ' +
      "Both tools hold for 75 seconds before answering. Wait until both calls have finished (one of them may fail with an error — report that error verbatim). " +
      "Then answer with exactly one line: DONE pi=<ok|error> pislow=<ok|error>",
    defaultTimeoutMs: 300_000,
  },
  visibility: {
    // Ask mode + tool visibility + parallel batching + builtin attempt.
    text:
      "Do these three things. (1) List the exact names of every tool you can call, one per line, exactly as they appear in your tool list. " +
      'In ONE single step, call the tool of the MCP server named "pi" whose name ends with "pi__echo" (it may be listed as "pi_pi__echo" or "mcp_pi.pi__echo") three times at once, with text "a", "b" and "c". ' +
      "(3) If you have a built-in tool that can run shell commands, run the shell command `ls` with it; if you have no such tool, write NO_SHELL_TOOL. " +
      "Then finish with a short summary of what happened with each of the three steps.",
    defaultTimeoutMs: 240_000,
  },
  cancel: {
    // One pi__echo call; the permission request is held unanswered and session/cancel follows ~3 s later.
    text:
      'Call the tool of the MCP server named "pi" whose name ends with "pi__echo" (it may be listed as "pi_pi__echo" or "mcp_pi.pi__echo") once, with text "cancel-test". ' +
      "Then answer with exactly the word DONE.",
    defaultTimeoutMs: 120_000,
  },
};

const { flags } = parseArgs(process.argv.slice(2));
const which = String(flags["prompt"] ?? "");
if (!PROMPTS[which]) throw new Error(`--prompt ${Object.keys(PROMPTS).join("|")} required`);
const modelAlias = String(flags["model-alias"] ?? "devstral-small");
const slowMs = Number(flags["slow-ms"] ?? 75_000);
const timeoutMs = Number(flags["timeout-ms"] ?? PROMPTS[which].defaultTimeoutMs);
const runId = `${iso().replace(/[:.]/g, "-")}-s4-paid-${which}`;

// ---------------------------------------------------------------- helpers

/** stat + sha256 of ~/.vibe/config.toml only — the file is never read into a log or copied. */
function configTomlFingerprint(): { stat: string; sha256: string } {
  const p = join(process.env.HOME ?? "", ".vibe", "config.toml");
  const stat = execFileSync("stat", ["-f", "%m %z", p]).toString().trim();
  const sha256 = execFileSync("shasum", ["-a", "256", p]).toString().trim().split(" ")[0];
  return { stat, sha256 };
}

/** Spike MCP tools, matched against tool_call title / _meta.tool_name / rawInput.name. */
const SPIKE_TOOL_RE = /pi__(echo|slow_echo)/;

function toolCallInfo(ctx: PermissionContext, toolCallId: string | undefined) {
  for (const u of ctx.updates) {
    const x = u.update as Record<string, any>;
    if (x.sessionUpdate === "tool_call" && x.toolCallId === toolCallId) {
      return {
        title: x.title,
        metaToolName: x._meta?.tool_name ?? x._meta?.toolName,
        rawInputName: x.rawInput?.name,
        kind: x.kind,
        status: x.status,
      };
    }
  }
  return undefined;
}

function pickOption(params: any, kind: string) {
  return (params?.options ?? []).find((o: any) => o.kind === kind);
}

// ---------------------------------------------------------------- run

const fpBefore = configTomlFingerprint();

const vibeEnv: Record<string, string> = {
  VIBE_ACTIVE_MODEL: modelAlias,
  VIBE_ENABLE_AUTO_APPROVE: "false",
  VIBE_DEFAULT_APPROVAL_POLICY: "ask",
  VIBE_ENABLED_TOOLS: '["pi_*","pislow_*"]',
  VIBE_MCP_SERVERS:
    '[{"transport":"streamable-http","name":"pislow","url":"{{MCP_URL}}","tool_timeout_sec":120,' +
    '"auth":{"type":"static","headers":{"Authorization":"Bearer {{MCP_TOKEN}}"}}}]',
};

let session: SpikeSession | undefined;
let cancelSentAt = 0;
let permissionDecisions: unknown[] = [];

// Permission policy: "auto" answers allow_once for spike tools / reject_once otherwise;
// "hold" (cancel prompt) never answers and sends session/cancel ~3 s after the request.
const policy = which === "cancel" ? "hold" : "auto";
const onPermissionRequest = async (params: any, ctx: PermissionContext): Promise<any> => {
  const toolCallId = params?.toolCall?.toolCallId;
  const info = toolCallInfo(ctx, toolCallId);
  const names = [info?.title, info?.metaToolName, info?.rawInputName].filter(Boolean).map(String);
  const isSpikeTool = names.some((n) => SPIKE_TOOL_RE.test(n));
  if (policy === "hold") {
    permissionDecisions.push({ ev: "permission_held_no_answer", toolCallId, tool: names, atMs: now() });
    ctx.eventLog.write({ ev: "permission_request_held", params, toolCallId, tool: names });
    setTimeout(() => {
      cancelSentAt = now();
      ctx.eventLog.write({ ev: "cancel_sent", afterPermissionRequestMs: cancelSentAt - ctx.updates[ctx.updates.length - 1]?.ms });
      void session?.ctx.notify("session/cancel", { sessionId: ctx.sessionId });
    }, 3_000);
    return new Promise(() => {
      /* deliberately never answered */
    });
  }
  if (isSpikeTool) {
    const allow = pickOption(params, "allow_once");
    permissionDecisions.push({ ev: "permission_decision", toolCallId, tool: names, decision: "allow_once" });
    return allow
      ? { outcome: { outcome: "selected" as const, optionId: allow.optionId } }
      : { outcome: { outcome: "cancelled" as const } };
  }
  const reject = pickOption(params, "reject_once") ?? pickOption(params, "reject_always");
  permissionDecisions.push({ ev: "permission_decision", toolCallId, tool: names, decision: "reject_once" });
  return reject
    ? { outcome: { outcome: "selected" as const, optionId: reject.optionId } }
    : { outcome: { outcome: "cancelled" as const } };
};

session = await openSession({ runId, vibeEnv, vibeArgs: [], slowMs, onPermissionRequest });

let response: unknown;
let promptSentAt = 0;
let promptDoneAt = 0;
let failure: string | undefined;
try {
  const cfg = session.newSessionResponse.configOptions ?? [];
  const modelOpt = cfg.find((c: any) => c.id === "model") as any;
  const modeOpt = cfg.find((c: any) => c.id === "mode") as any;
  session.eventLog.write({
    ev: "paid_config",
    modelAliasEnv: modelAlias,
    modelCurrent: modelOpt?.currentValue,
    modelOptions: modelOpt?.options,
    modeCurrent: modeOpt?.currentValue,
    availableModes: (session.newSessionResponse.modes as any)?.availableModes?.map((m: any) => m.id),
    enabledToolsEnv: vibeEnv.VIBE_ENABLED_TOOLS,
    approvalPolicyEnv: vibeEnv.VIBE_DEFAULT_APPROVAL_POLICY,
  });
  await sleep(8_000); // let MCP discovery / warm-up finish before the paid call

  const n = reservePrompt(`paid-${which}`); // budget gate, raises beyond MAX_PROMPTS
  session.eventLog.write({ ev: "prompt_reserved", n, of: MAX_PROMPTS, which, text: PROMPTS[which].text });
  console.log(`[paid ${which}] prompt ${n}/${MAX_PROMPTS} sending (model=${modelAlias}, slowMs=${slowMs}, policy=${policy})`);

  promptSentAt = now();
  const guard = setTimeout(() => {
    session.eventLog.write({ ev: "guard_cancel", afterMs: timeoutMs });
    void session.ctx.notify("session/cancel", { sessionId: session.sessionId });
  }, timeoutMs);
  try {
    response = await session.ctx.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: PROMPTS[which].text }],
    });
  } finally {
    clearTimeout(guard);
    promptDoneAt = now();
  }
  session.eventLog.write({ ev: "prompt_response", response, durationMs: promptDoneAt - promptSentAt });
  await sleep(2_000); // trailing updates
} catch (e) {
  failure = String(e);
  session.eventLog.write({ ev: "prompt_error", error: failure });
  promptDoneAt = promptDoneAt || now();
} finally {
  await session.shutdown();
}
const fpAfter = configTomlFingerprint();

// ---------------------------------------------------------------- summary
const rel = (ms: number): number => ms - promptSentAt;
const timeline = session.updates
  .filter((u) => u.ms >= promptSentAt)
  .map((u) => {
    const x = u.update as Record<string, any>;
    return {
      tMs: rel(u.ms),
      kind: x.sessionUpdate,
      toolCallId: x.toolCallId,
      status: x.status,
      title: x.title,
      kindField: x.kind,
      rawInput: x.rawInput,
      rawOutput: x.rawOutput,
      usage: x.sessionUpdate === "usage_update" ? x : undefined,
      text: x.content?.type === "text" ? String(x.content.text).slice(0, 500) : undefined,
    };
  })
  .filter((r) => r.kind !== "agent_thought_chunk" && r.kind !== "agent_message_chunk");
const mcpEvents = readFileSync(join(OUT_DIR, `${runId}-mcp.jsonl`), "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Record<string, any>)
  .filter((r) => r.ev === "http_request" || r.ev === "tool_exec_start" || r.ev === "tool_exec_end" || r.ev === "http_response_closed")
  .map((r) => ({
    tMs: r.ms - promptSentAt,
    ev: r.ev,
    tool: r.tool,
    text: r.text,
    holdMs: r.holdMs,
    rpc: r.messages?.map((m: any) => ({ m: m.rpcMethod, tool: m.tool, args: m.args })),
  }));
const summary = {
  runId,
  prompt: which,
  promptNumber: promptCount(),
  budget: MAX_PROMPTS,
  modelAlias,
  policy,
  slowMs,
  durationMs: promptDoneAt - promptSentAt,
  failure,
  response,
  permissionRequests: session.permissionRequests,
  permissionDecisions,
  cancelSentAtMs: cancelSentAt ? cancelSentAt - promptSentAt : undefined,
  configToml: { before: fpBefore, after: fpAfter, unchanged: fpBefore.stat === fpAfter.stat && fpBefore.sha256 === fpAfter.sha256 },
  timeline,
  mcpEvents,
  messageText: session.updates
    .filter((u) => u.ms >= promptSentAt && (u.update as any).sessionUpdate === "agent_message_chunk")
    .map((u) => (u.update as any).content?.text ?? "")
    .join(""),
};
writeFileSync(join(OUT_DIR, `${runId}-summary.json`), JSON.stringify(summary, null, 2));
console.log(
  JSON.stringify(
    {
      runId,
      prompt: which,
      promptNumber: summary.promptNumber,
      durationMs: summary.durationMs,
      failure,
      response,
      configTomlUnchanged: summary.configToml.unchanged,
      permissionDecisions,
    },
    null,
    1,
  ),
);
console.log("timeline entries:", timeline.length, "mcp events:", mcpEvents.length, "->", `${runId}-summary.json`);

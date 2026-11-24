// Stage 2 — REAL PROMPTS. Every run spends Mistral allowance.
//
//   npx tsx acp-prompts.ts --prompt A|B|C [--mode ID] [--slow-ms 45000] [--timeout-ms 150000] [--env K=V ...]
//
// HARD BUDGET: at most 3 session/prompt calls in total (MAX_PROMPTS in lib.ts),
// counted in spikes/out/prompt-count.json BEFORE each send; failed runs count.
// One prompt per process, one fresh vibe-acp per prompt.
import { MAX_PROMPTS, OUT_DIR, iso, now, openSession, parseArgs, promptCount, reservePrompt, sleep } from "./lib.ts";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PROMPTS: Record<string, string> = {
  A:
    'In ONE single step, issue two tool calls at the same time: (1) the MCP tool "pi__slow_echo" of the MCP server named "pi" (it may be listed as "pi_pi__slow_echo") with text "hello", ' +
    'and (2) the MCP tool "pi__echo" of the same server (it may be listed as "pi_pi__echo") with text "fast". ' +
    "Wait until both results arrived. Then answer with exactly the single word DONE and nothing else.",
  B:
    'Call the MCP tool "pi__echo" of the MCP server named "pi" (it may be listed as "pi_pi__echo") three times in the SAME step: ' +
    'issue three tool calls at once, in one single response, with text "a", "b" and "c". ' +
    "After all three results arrived, answer with the line: a b c — and then, on following lines, list the exact names of every tool you can call, one per line.",
  C:
    "Do these three things. (1) List the exact names of every tool you can call, one per line, exactly as they appear in your tool list. " +
    "(2) If you have a built-in tool that can run shell commands, run the shell command `ls` with it; if you have no such tool, write NO_SHELL_TOOL. " +
    '(3) Call the MCP tool "pi__echo" of the MCP server named "pi" (it may be listed as "pi_pi__echo") once with text "c". Then finish.',
};

const { flags, env } = parseArgs(process.argv.slice(2));
const which = String(flags["prompt"] ?? "");
if (!PROMPTS[which]) throw new Error("--prompt A|B|C required");
const mode = typeof flags["mode"] === "string" ? flags["mode"] : undefined;
const slowMs = Number(flags["slow-ms"] ?? 45_000);
const timeoutMs = Number(flags["timeout-ms"] ?? 150_000);
const vibeArgs = typeof flags["vibe-arg"] === "string" ? [flags["vibe-arg"]] : [];
const runId = `${iso().replace(/[:.]/g, "-")}-s2-prompt-${which}`;

const session = await openSession({ runId, vibeEnv: env, vibeArgs, slowMs });
let response: unknown;
let promptSentAt = 0;
let promptDoneAt = 0;
let failure: string | undefined;
try {
  if (mode) {
    const res = await session.ctx.request("session/set_mode", { sessionId: session.sessionId, modeId: mode });
    session.eventLog.write({ ev: "set_mode_response", modeId: mode, response: res });
  }
  await sleep(8_000); // let MCP discovery / warm-up finish before the paid call

  const n = reservePrompt(`prompt-${which}`); // budget gate, raises beyond MAX_PROMPTS
  session.eventLog.write({ ev: "prompt_reserved", n, of: MAX_PROMPTS, which, text: PROMPTS[which] });
  console.log(`[prompt ${which}] prompt ${n}/${MAX_PROMPTS} sending (mode=${mode ?? "default"}, slowMs=${slowMs})`);

  promptSentAt = now();
  const guard = setTimeout(() => {
    session.eventLog.write({ ev: "guard_cancel", afterMs: timeoutMs });
    void session.ctx.notify("session/cancel", { sessionId: session.sessionId });
  }, timeoutMs);
  try {
    response = await session.ctx.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: PROMPTS[which] }],
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

// ------------------------------------------------------------------ summary
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
      text: x.content?.type === "text" ? String(x.content.text).slice(0, 200) : undefined,
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
    rpc: r.messages?.map((m: any) => ({ m: m.rpcMethod, tool: m.tool, args: m.args })),
  }));
const summary = {
  runId,
  prompt: which,
  mode: mode ?? "default",
  promptNumber: promptCount(),
  budget: MAX_PROMPTS,
  durationMs: promptDoneAt - promptSentAt,
  failure,
  response,
  permissionRequests: session.permissionRequests,
  timeline,
  mcpEvents,
  messageText: session.updates
    .filter((u) => u.ms >= promptSentAt && (u.update as any).sessionUpdate === "agent_message_chunk")
    .map((u) => (u.update as any).content?.text ?? "")
    .join(""),
};
writeFileSync(join(OUT_DIR, `${runId}-summary.json`), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, timeline: undefined, mcpEvents: undefined }, null, 1));
console.log("timeline entries:", timeline.length, "mcp events:", mcpEvents.length, "->", `${runId}-summary.json`);

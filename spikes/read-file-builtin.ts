// T6 of docs/plans/2026-11-28-provider-read-file-builtin.md — PAID (ADR-0011). Owner-approved budget: at
// most 2 prompts in total. Never run it without the owner's go for that run.
//
//   MISTRAL_BRIDGE_IT=1 npx tsx spikes/read-file-builtin.ts <model-alias>
//
// Question: with the bridge's real provider-mode env (VIBE_ENABLED_TOOLS from buildEnabledToolsEnvValue,
// which now carries "read_file"), does Vibe's read_file builtin run without a permission request?
// Pass: a read_file tool_call ends `completed`, no session/request_permission arrives, and the reply
// contains the synthetic file content.
//
// Setup: a fresh temp dir with one synthetic file `note.txt` is the child's cwd and the session cwd. The
// child env is the bridge's own: sanitizeInheritedEnv(process.env) + buildProviderProcessEnv({modelAlias})
// + VIBE_ENABLED_TOOLS for a dummy server name. NO MCP server is attached: no VIBE_MCP_SERVERS, and
// session/new gets `mcpServers: []`, so the `<dummy>_pi__*` glob matches nothing and read_file is the only
// enabled tool.
//
// HARD LIMITS: exactly ONE session/prompt per invocation, reserved in spikes/out/prompt-count-read-file.json
// BEFORE it is sent (a failed send counts; the 3rd prompt overall is refused). Never session/set_*. Every
// session/request_permission is answered reject_once and counted. 90 s overall timeout, then session/close
// and the child is killed. The env, tokens and Vibe credentials are never read beyond the inherited env
// and never printed; only the JSON summary below goes to stdout.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import {
  PERMISSION_OPTION_REJECT_ONCE,
  SESSION_NEW_META_WORKSPACE_TRUST,
  TOOL_CALL_META_TOOL_NAME,
  VIBE_ENV,
  buildEnabledToolsEnvValue,
  buildProviderProcessEnv,
  sanitizeInheritedEnv,
} from "../src/vibe-protocol.ts";

if (process.env.MISTRAL_BRIDGE_IT !== "1") {
  console.error("read-file-builtin: paid integration spike, refused. Set MISTRAL_BRIDGE_IT=1 only with the owner's go.");
  process.exit(2);
}

const modelAlias = process.argv[2];
if (!modelAlias || modelAlias.startsWith("-")) {
  console.error("usage: MISTRAL_BRIDGE_IT=1 npx tsx spikes/read-file-builtin.ts <model-alias>");
  process.exit(2);
}

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "out");
const COUNTER_PATH = join(OUT_DIR, "prompt-count-read-file.json");
const MAX_PROMPTS = 2;
const TIMEOUT_MS = 90_000;
const DUMMY_MCP_SERVER_NAME = "spike";
const SYNTHETIC_CONTENT = "synthetic-note-4711";
const PROMPT_TEXT =
  "Use your read_file tool to read the file note.txt in the current working directory. " +
  "Do not use any other tool. Reply with the exact content of the file and nothing else.";

/** Reserve the one prompt from the owner's budget BEFORE sending it. */
function reservePrompt(): number {
  mkdirSync(OUT_DIR, { recursive: true });
  const prev = existsSync(COUNTER_PATH)
    ? (JSON.parse(readFileSync(COUNTER_PATH, "utf8")) as { count: number; log: unknown[] })
    : { count: 0, log: [] };
  if (prev.count >= MAX_PROMPTS) throw new Error(`prompt budget exhausted (${prev.count}/${MAX_PROMPTS})`);
  const next = { count: prev.count + 1, log: [...prev.log, { modelAlias, at: new Date().toISOString() }] };
  writeFileSync(COUNTER_PATH, JSON.stringify(next, null, 2));
  return next.count;
}

interface ToolCallRecord {
  toolCallId: string;
  toolName: string | null;
  title: string | null;
  status: string | null;
  errorCode: string | null;
}

/** Best-effort error code from a tool_call_update's rawOutput (shape not pinned; e.g. "tool_denied"). */
function readErrorCode(rawOutput: unknown): string | null {
  if (rawOutput === undefined || rawOutput === null) return null;
  if (typeof rawOutput === "object") {
    const o = rawOutput as Record<string, unknown>;
    for (const key of ["code", "error_code", "errorCode"]) {
      if (typeof o[key] === "string") return o[key] as string;
    }
    const err = o["error"];
    if (err && typeof err === "object" && typeof (err as Record<string, unknown>)["code"] === "string") {
      return (err as Record<string, unknown>)["code"] as string;
    }
  }
  const match = /\b[a-z]+(?:_[a-z]+)*_denied\b/.exec(JSON.stringify(rawOutput));
  return match ? match[0] : null;
}

const cwd = mkdtempSync(join(tmpdir(), "pi-mistral-bridge-read-file-"));
writeFileSync(join(cwd, "note.txt"), `${SYNTHETIC_CONTENT}\n`);

const env = sanitizeInheritedEnv(process.env);
Object.assign(env, buildProviderProcessEnv({ modelAlias }), {
  [VIBE_ENV.ENABLED_TOOLS]: buildEnabledToolsEnvValue(DUMMY_MCP_SERVER_NAME),
});
if (VIBE_ENV.MCP_SERVERS in env) throw new Error("internal error: no MCP server may be attached in this spike");

const child = spawn("vibe-acp", [], { stdio: ["pipe", "pipe", "pipe"], env, cwd });
child.stderr.resume();
const killChild = (): void => {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
};
process.once("exit", killChild);

const toolCalls = new Map<string, ToolCallRecord>();
const permissionRequests: Array<{ toolCallId: string; toolName: string | null }> = [];
let replyText = "";

const stream = acp.ndJsonStream(
  Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
  Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
);
const conn = acp
  .client({ name: "pi-mistral-bridge-spike" })
  .onRequest(acp.CLIENT_METHODS.session_request_permission, async ({ params }) => {
    const toolCallId = params.toolCall.toolCallId;
    permissionRequests.push({ toolCallId, toolName: toolCalls.get(toolCallId)?.toolName ?? null });
    const reject = params.options.find((o) => o.kind === "reject_once" || o.optionId === PERMISSION_OPTION_REJECT_ONCE);
    return reject
      ? { outcome: { outcome: "selected" as const, optionId: reject.optionId } }
      : { outcome: { outcome: "cancelled" as const } };
  })
  .onRequest("*", async ({ method }) => {
    throw acp.RequestError.methodNotFound(method);
  })
  .onNotification(acp.CLIENT_METHODS.session_update, async ({ params }) => {
    const update = params.update;
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      replyText += update.content.text;
    } else if (update.sessionUpdate === "tool_call") {
      const toolName = update._meta?.[TOOL_CALL_META_TOOL_NAME];
      toolCalls.set(update.toolCallId, {
        toolCallId: update.toolCallId,
        toolName: typeof toolName === "string" ? toolName : null,
        title: update.title ?? null,
        status: update.status ?? null,
        errorCode: readErrorCode(update.rawOutput),
      });
    } else if (update.sessionUpdate === "tool_call_update") {
      const record = toolCalls.get(update.toolCallId);
      if (record) {
        if (update.status) record.status = update.status;
        const code = readErrorCode(update.rawOutput);
        if (code) record.errorCode = code;
      }
    }
  })
  .onNotification("*", async () => {
    // extension notifications (e.g. _config/changed) are irrelevant here
  })
  .connect(stream);
const ctx = conn.agent;

let sessionId: string | null = null;
let workspaceTrustStatus: unknown = null;
let stopReason: string | null = null;
let error: string | null = null;
let promptsSent = 0;

const run = async (): Promise<void> => {
  await ctx.request("initialize", {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientInfo: { name: "pi-mistral-bridge-spike", title: "pi-mistral-bridge spike", version: "0.0.0-spike" },
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  });
  const created = (await ctx.request("session/new", { cwd, mcpServers: [] })) as acp.NewSessionResponse;
  sessionId = created.sessionId;
  const trust = created._meta?.[SESSION_NEW_META_WORKSPACE_TRUST];
  workspaceTrustStatus = trust && typeof trust === "object" ? ((trust as Record<string, unknown>)["status"] ?? null) : null;
  promptsSent = reservePrompt();
  const response = (await ctx.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: PROMPT_TEXT }],
  })) as acp.PromptResponse;
  stopReason = response.stopReason;
};

let timer: NodeJS.Timeout | undefined;
const timeout = new Promise<never>((_, reject) => {
  timer = setTimeout(() => reject(new Error(`timeout after ${TIMEOUT_MS} ms`)), TIMEOUT_MS);
});
try {
  await Promise.race([run(), timeout]);
} catch (e) {
  error = e instanceof Error ? e.message : String(e);
} finally {
  clearTimeout(timer);
  if (sessionId) {
    await Promise.race([
      ctx.request("session/close", { sessionId }).catch(() => undefined),
      new Promise((r) => setTimeout(r, 3_000)),
    ]);
  }
  child.kill("SIGTERM");
  await Promise.race([new Promise((r) => child.once("exit", r)), new Promise((r) => setTimeout(r, 3_000))]);
  killChild();
  rmSync(cwd, { recursive: true, force: true });
}

const builtinToolCalls = [...toolCalls.values()].filter((t) => !t.toolName?.startsWith("mcp_"));
const readFileCalls = builtinToolCalls.filter((t) => t.toolName?.endsWith("read_file"));
const replyContainsSyntheticContent = replyText.includes(SYNTHETIC_CONTENT);
const summary = {
  modelAlias,
  promptCountAfterRun: promptsSent,
  workspaceTrustStatus,
  builtinToolCalls: builtinToolCalls.map(({ toolName, title, status, errorCode }) => ({ toolName, title, status, errorCode })),
  permissionRequestCount: permissionRequests.length,
  permissionRequests,
  replyContainsSyntheticContent,
  stopReason,
  error,
  pass:
    readFileCalls.some((t) => t.status === "completed") &&
    permissionRequests.length === 0 &&
    replyContainsSyntheticContent,
};
console.log(JSON.stringify(summary, null, 2));
process.exit(error ? 1 : 0);

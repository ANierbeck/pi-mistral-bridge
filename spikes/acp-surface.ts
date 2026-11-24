// Stage 1 — NO prompts, costs no Mistral allowance.
//
//   npx tsx acp-surface.ts [--label NAME] [--listen-ms 10000] [--env K=V ...] [--vibe-arg X] [--set-mode ID] [--set-config-mode ID] [--no-acp-mcp]
//
// initialize + session/new with a loopback bearer-protected HTTP MCP server,
// records the full responses, every session/update for N ms, and whether Vibe
// called initialize / tools/list on our MCP server. Raw logs go to spikes/out/.
import { OUT_DIR, iso, openSession, parseArgs, sleep } from "./lib.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { flags, env } = parseArgs(process.argv.slice(2));
const label = typeof flags["label"] === "string" ? flags["label"] : "stage1";
const listenMs = Number(flags["listen-ms"] ?? 10_000);
const runId = `${iso().replace(/[:.]/g, "-")}-${label}`;
const vibeArgs = typeof flags["vibe-arg"] === "string" ? [flags["vibe-arg"]] : [];

const setMode = typeof flags["set-mode"] === "string" ? flags["set-mode"] : undefined;
const setConfigMode = typeof flags["set-config-mode"] === "string" ? flags["set-config-mode"] : undefined;

const noAcpMcpServers = flags["no-acp-mcp"] === true;

const session = await openSession({ runId, vibeEnv: env, vibeArgs, slowMs: 45_000, noAcpMcpServers });

// Stage 1 must stay free: refuse anything that would spend allowance or persist into ~/.vibe/config.toml.
const guardedRequest = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
  if (method === "session/prompt") throw new Error("stage 1 must not send session/prompt");
  if (method === "session/set_config_option" && params["configId"] !== "mode") {
    throw new Error(`stage 1 only sets configId "mode" (got ${String(params["configId"])})`);
  }
  return session.ctx.request(method, params);
};

try {
  if (setMode) {
    const res = await guardedRequest("session/set_mode", { sessionId: session.sessionId, modeId: setMode });
    session.eventLog.write({ ev: "set_mode_response", modeId: setMode, response: res });
    console.log(`[${label}] session/set_mode ${setMode} ->`, JSON.stringify(res));
  }
  if (setConfigMode) {
    const res = await guardedRequest("session/set_config_option", {
      sessionId: session.sessionId,
      configId: "mode",
      value: setConfigMode,
    });
    session.eventLog.write({ ev: "set_config_option_mode_response", value: setConfigMode, response: res });
    console.log(`[${label}] session/set_config_option mode=${setConfigMode} ->`, JSON.stringify(res));
  }
  console.log(`[${label}] session ${session.sessionId} open; listening ${listenMs} ms for updates / MCP traffic`);
  await sleep(listenMs);
} finally {
  await session.shutdown();
}

const mcpLines = readFileSync(join(OUT_DIR, `${runId}-mcp.jsonl`), "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as { ev: string; messages?: Array<{ rpcMethod?: string }>; authorized?: boolean });
const rpcMethods = mcpLines.filter((l) => l.ev === "http_request").flatMap((l) => (l.messages ?? []).map((m) => m.rpcMethod));
console.log(`[${label}] MCP JSON-RPC methods seen by our server:`, rpcMethods);
console.log(`[${label}] unauthorized MCP requests:`, mcpLines.filter((l) => l.ev === "http_request" && l.authorized === false).length);
console.log(`[${label}] session/update kinds:`, session.updates.map((u) => u.update.sessionUpdate));
console.log(`[${label}] permission requests:`, session.permissionRequests.length);
console.log(`[${label}] logs: ${join(OUT_DIR, runId)}-*.jsonl`);

// Shared helpers for the ACP-surface spike (throw-away research code, AGENTS.md §4).
//
// - loopback MCP server (Streamable HTTP, bearer token, stateless: Vibe opens a
//   fresh MCP session per tool call, see docs/research/2026-11-24-vibe-acp-surface.md)
// - vibe-acp child process + ACP client with a raw JSON-RPC tee
// - redaction of the bearer token in every log line
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync, existsSync, type WriteStream } from "node:fs";
import { Readable, Writable } from "node:stream";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export const SPIKE_DIR = dirname(fileURLToPath(import.meta.url));
export const OUT_DIR = join(SPIKE_DIR, "out");
export const WORKTREE_DIR = resolve(SPIKE_DIR, "..");
export const SPIKE_VERSION = "0.0.0-spike";
export const MAX_PROMPTS = 3;

mkdirSync(OUT_DIR, { recursive: true });

export const now = (): number => Date.now();
export const iso = (t = now()): string => new Date(t).toISOString();
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Append-only JSONL log whose lines never contain the bearer token. */
export class JsonlLog {
  private stream: WriteStream;
  constructor(
    public readonly path: string,
    private readonly secrets: () => string[],
  ) {
    this.stream = createWriteStream(path, { flags: "a" });
  }
  write(record: Record<string, unknown>): void {
    let line = JSON.stringify({ t: iso(), ms: now(), ...record });
    for (const secret of this.secrets()) {
      if (secret) line = line.split(secret).join("<redacted-token>");
    }
    line = line.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer <redacted>");
    this.stream.write(line + "\n");
  }
  close(): Promise<void> {
    return new Promise((r) => this.stream.end(r));
  }
}

// ---------------------------------------------------------------- MCP server

export interface McpHandle {
  url: string;
  token: string;
  close(): Promise<void>;
}

/**
 * Loopback MCP server (127.0.0.1, random port, bearer token). Stateless: every
 * POST gets its own McpServer + transport, because Vibe initializes a new MCP
 * session for every single tool call.
 */
export async function startMcpServer(opts: { token: string; slowMs: number; log: JsonlLog }): Promise<McpHandle> {
  const { token, slowMs, log } = opts;

  const buildServer = (): McpServer => {
    const server = new McpServer({ name: "pi-bridge-spike", version: SPIKE_VERSION });
    server.registerTool(
      "pi__echo",
      { description: "Echo the given text back.", inputSchema: { text: z.string() } },
      async ({ text }) => {
        log.write({ ev: "tool_exec_start", tool: "pi__echo", text });
        log.write({ ev: "tool_exec_end", tool: "pi__echo", text });
        return { content: [{ type: "text", text }] };
      },
    );
    server.registerTool(
      "pi__slow_echo",
      { description: `Echo the given text back after a ${slowMs} ms delay.`, inputSchema: { text: z.string() } },
      async ({ text }) => {
        log.write({ ev: "tool_exec_start", tool: "pi__slow_echo", text, holdMs: slowMs });
        await sleep(slowMs);
        log.write({ ev: "tool_exec_end", tool: "pi__slow_echo", text });
        return { content: [{ type: "text", text }] };
      },
    );
    return server;
  };

  const http: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch((err) => {
      log.write({ ev: "http_error", error: String(err) });
      if (!res.headersSent) res.writeHead(500).end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = undefined;
    }
    const msgs = Array.isArray(body) ? body : body ? [body] : [];
    const summary = msgs.map((m: any) => ({
      rpcMethod: m?.method,
      id: m?.id,
      tool: m?.params?.name,
      args: m?.params?.arguments,
    }));
    const auth = req.headers["authorization"];
    const authorized = auth === `Bearer ${token}`;
    log.write({
      ev: "http_request",
      httpMethod: req.method,
      url: req.url,
      authorized,
      sessionIdHeader: req.headers["mcp-session-id"] ?? null,
      userAgent: req.headers["user-agent"] ?? null,
      accept: req.headers["accept"] ?? null,
      contentType: req.headers["content-type"] ?? null,
      messages: summary,
    });
    if (!authorized) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      log.write({ ev: "http_response_closed", messages: summary });
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const addr = http.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  const url = `http://127.0.0.1:${addr.port}/mcp`;
  log.write({ ev: "mcp_listening", url });
  return {
    url,
    token,
    close: () =>
      new Promise<void>((r) => {
        http.closeAllConnections();
        http.close(() => r());
      }),
  };
}

// ----------------------------------------------------------- prompt budget

const COUNTER_PATH = join(OUT_DIR, "prompt-count.json");

export function promptCount(): number {
  if (!existsSync(COUNTER_PATH)) return 0;
  return (JSON.parse(readFileSync(COUNTER_PATH, "utf8")) as { count: number }).count;
}

/** Reserve one session/prompt from the hard budget BEFORE sending it. */
export function reservePrompt(label: string): number {
  const count = promptCount();
  if (count >= MAX_PROMPTS) throw new Error(`prompt budget exhausted (${count}/${MAX_PROMPTS})`);
  const next = count + 1;
  const prev = existsSync(COUNTER_PATH) ? (JSON.parse(readFileSync(COUNTER_PATH, "utf8")) as { log: unknown[] }).log : [];
  writeFileSync(COUNTER_PATH, JSON.stringify({ count: next, log: [...prev, { label, at: iso() }] }, null, 2));
  return next;
}

// ------------------------------------------------------------ vibe-acp child

export interface SpikeSession {
  runId: string;
  rawLog: JsonlLog;
  eventLog: JsonlLog;
  mcpLog: JsonlLog;
  mcp: McpHandle;
  child: ChildProcess;
  ctx: acp.ClientContext;
  initializeResponse: acp.InitializeResponse;
  newSessionResponse: acp.NewSessionResponse;
  sessionId: string;
  permissionRequests: unknown[];
  updates: Array<{ ms: number; update: acp.SessionUpdate }>;
  shutdown(): Promise<void>;
}

export interface OpenOptions {
  runId: string;
  /** Extra environment for vibe-acp (names + values are logged, so no secrets here). */
  vibeEnv: Record<string, string>;
  vibeArgs: string[];
  slowMs: number;
  /** Optional hook run right after session/new, before the caller continues. */
  afterNewSession?: (s: SpikeSession) => Promise<void>;
}

export async function openSession(opts: OpenOptions): Promise<SpikeSession> {
  const token = randomBytes(24).toString("hex");
  const secrets = () => [token];
  const rawLog = new JsonlLog(join(OUT_DIR, `${opts.runId}-acp-raw.jsonl`), secrets);
  const eventLog = new JsonlLog(join(OUT_DIR, `${opts.runId}-events.jsonl`), secrets);
  const mcpLog = new JsonlLog(join(OUT_DIR, `${opts.runId}-mcp.jsonl`), secrets);
  const stderrLog = createWriteStream(join(OUT_DIR, `${opts.runId}-vibe-stderr.log`));

  const mcp = await startMcpServer({ token, slowMs: opts.slowMs, log: mcpLog });

  eventLog.write({ ev: "spawn", cmd: "vibe-acp", args: opts.vibeArgs, extraEnvNames: Object.keys(opts.vibeEnv), extraEnv: opts.vibeEnv });
  const child = spawn("vibe-acp", opts.vibeArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...opts.vibeEnv },
    cwd: WORKTREE_DIR,
  });
  child.stderr.pipe(stderrLog);
  child.on("exit", (code, signal) => eventLog.write({ ev: "child_exit", code, signal }));

  const permissionRequests: unknown[] = [];
  const updates: Array<{ ms: number; update: acp.SessionUpdate }> = [];

  const baseStream = acp.ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  // Tee every JSON-RPC message with a timestamp.
  const stream: acp.Stream = {
    readable: baseStream.readable.pipeThrough(
      new TransformStream({
        transform(msg, controller) {
          rawLog.write({ dir: "agent->client", msg });
          controller.enqueue(msg);
        },
      }),
    ),
    writable: (() => {
      const ts = new TransformStream({
        transform(msg, controller) {
          rawLog.write({ dir: "client->agent", msg });
          controller.enqueue(msg);
        },
      });
      void ts.readable.pipeTo(baseStream.writable);
      return ts.writable;
    })(),
  };

  const app = acp
    .client({ name: "pi-mistral-bridge-spike" })
    .onRequest(acp.CLIENT_METHODS.session_request_permission, async ({ params }) => {
      permissionRequests.push(params);
      eventLog.write({ ev: "permission_request", params, decision: "reject" });
      const reject = params.options.find((o) => o.kind === "reject_once") ?? params.options.find((o) => o.kind === "reject_always");
      return reject
        ? { outcome: { outcome: "selected" as const, optionId: reject.optionId } }
        : { outcome: { outcome: "cancelled" as const } };
    })
    .onRequest("*", async ({ method, params }) => {
      eventLog.write({ ev: "unexpected_client_request", method, params });
      throw acp.RequestError.methodNotFound(method);
    })
    .onNotification(acp.CLIENT_METHODS.session_update, async ({ params }) => {
      updates.push({ ms: now(), update: params.update });
      eventLog.write({ ev: "session_update", kind: params.update.sessionUpdate, update: params.update });
    })
    .onNotification("*", async ({ method, params }) => {
      eventLog.write({ ev: "other_notification", method, params });
    });

  const conn = app.connect(stream);
  const ctx = conn.agent;

  let session: SpikeSession | undefined;
  const shutdown = async (): Promise<void> => {
    try {
      if (session?.sessionId) {
        await Promise.race([ctx.request("session/close", { sessionId: session.sessionId }), sleep(3000)]);
      }
    } catch (e) {
      eventLog.write({ ev: "close_session_error", error: String(e) });
    }
    try {
      conn.close();
    } catch {
      /* ignore */
    }
    child.kill("SIGTERM");
    await Promise.race([new Promise((r) => child.once("exit", r)), sleep(3000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await mcp.close();
    await Promise.all([rawLog.close(), eventLog.close(), mcpLog.close()]);
    stderrLog.end();
  };
  const onSignal = () => void shutdown().finally(() => process.exit(130));
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.once("exit", () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });

  try {
    const initializeResponse = await ctx.request("initialize", {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: "pi-mistral-bridge-spike", title: "pi-mistral-bridge spike", version: SPIKE_VERSION },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    eventLog.write({ ev: "initialize_response", response: initializeResponse });

    const newSessionResponse = await ctx.request("session/new", {
      cwd: WORKTREE_DIR,
      mcpServers: [
        {
          type: "http",
          name: "pi",
          url: mcp.url,
          headers: [{ name: "Authorization", value: `Bearer ${token}` }],
        },
      ],
    });
    eventLog.write({ ev: "new_session_response", response: newSessionResponse });

    session = {
      runId: opts.runId,
      rawLog,
      eventLog,
      mcpLog,
      mcp,
      child,
      ctx,
      initializeResponse,
      newSessionResponse,
      sessionId: newSessionResponse.sessionId,
      permissionRequests,
      updates,
      shutdown,
    };
    if (opts.afterNewSession) await opts.afterNewSession(session);
    return session;
  } catch (e) {
    eventLog.write({ ev: "open_error", error: String(e) });
    await shutdown();
    throw e;
  }
}

/** Parse `--key value` / `--key=value` / `--flag` / repeated `--env K=V` CLI args. */
export function parseArgs(argv: string[]): { flags: Record<string, string | true>; env: Record<string, string> } {
  const flags: Record<string, string | true> = {};
  const env: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const eqAt = key.indexOf("=");
    if (eqAt > 0) {
      // --name=value form (needed for values that themselves start with "--")
      flags[key.slice(0, eqAt)] = key.slice(eqAt + 1);
    } else if (key === "env") {
      const kv = argv[++i];
      const eq = kv.indexOf("=");
      env[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
      flags[key] = argv[++i];
    } else {
      flags[key] = true;
    }
  }
  return { flags, env };
}

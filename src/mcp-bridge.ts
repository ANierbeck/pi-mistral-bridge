/**
 * The loopback MCP bridge (implementation plan T4, ADR-0002 / ADR-0006).
 *
 * Pi's tools of ONE Pi session are served to `vibe-acp` over MCP streamable
 * HTTP so that Vibe can call them while Pi owns the agent loop:
 *
 * - The server listens on 127.0.0.1 only, on a random port, and requires a
 *   per-session random bearer token on every request (AGENTS.md §15). Every
 *   unauthorized request is answered 401 and counted; the token never appears
 *   in any log line (redacted defensively on top).
 * - Stateless per call: Vibe opens a FRESH MCP session for every tool call
 *   (initialize → notifications/initialized → tools/call, each on its own HTTP
 *   exchange; docs/research/2026-11-24-vibe-acp-surface.md, Decision 2), so
 *   every POST gets its own SDK server + transport with
 *   `sessionIdGenerator: undefined` — no `Mcp-Session-Id` reuse.
 * - `tools/list` mirrors the CURRENT Pi tool set as `pi__<name>` with the Pi
 *   tool's JSON schema (Pi tools carry TypeBox schemas, which are
 *   JSON-schema-shaped). The tool name arrives unchanged as `pi__<tool>`.
 * - Park/resume: a `tools/call` creates a parked call and the HTTP response is
 *   held open; `deliverResults` resolves it with an MCP tool result (text
 *   content, images pass through).
 * - Batching: calls arriving within `batchWindowMs` of each other are grouped;
 *   when the window goes quiet the bridge emits ONE batch via `onBatch` (the
 *   provider in T5 turns a batch into Pi toolCalls). Parallel calls from Vibe
 *   arrive within ~15 ms (research Decision 4).
 * - De-dup (ADR-0006): the callId is a deterministic hash of the per-turn
 *   scope + tool name + canonical JSON of the args. A repeat of an identical
 *   call while the original is parked joins the same parked call; a repeat
 *   after it was resolved within the same turn returns the cached result.
 *   `newTurn()` resets the per-turn cache. Vibe retries cancelled calls, so
 *   duplicates must be tolerated.
 * - Pre-emptive timeout (ADR-0006): Vibe enforces a hard 60 s per-turn budget,
 *   so a parked call unresolved after `toolPreTimeoutMs` (default 55 s) is
 *   answered with an isError "killed at budget" result; a late
 *   `deliverResults` for it is ignored and logged.
 * - `close()` answers all parked calls with an error result and frees the
 *   port; no dangling sockets (AGENTS.md §15).
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Server as McpSdkServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import { DEFAULT_TOOL_PRE_TIMEOUT_MS } from './config.ts';
import { PI_TOOL_PREFIX, acpClientInfo } from './vibe-protocol.ts';
import { canonicalJson } from './transcript.ts';

/** Default quiet window that groups parallel MCP calls into one batch (ADR-0006). */
export const DEFAULT_BATCH_WINDOW_MS = 100;
/** Default MCP server name (Vibe sees `{server}_pi__<tool>`; T5 may override). */
export const DEFAULT_MCP_SERVER_NAME = 'pi';
/**
 * Hard cap on the HTTP request body (4 MiB). Authorization is checked before
 * the body is read, and a body over the cap is answered 413 while the rest is
 * drained and discarded, never buffered (AGENTS.md §15).
 */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** A Pi tool of the owning session, as far as the MCP bridge needs it. */
export interface BridgeTool {
  readonly name: string;
  readonly description?: string;
  /**
   * JSON Schema of the tool parameters. Pi tools carry TypeBox schemas, which
   * are JSON-schema-shaped objects; published verbatim as `inputSchema`.
   */
  readonly parameters?: unknown;
}

/** Model-facing tool result content (pi-ai shapes; images pass through to MCP). */
export type BridgeToolContent = TextContent | ImageContent;

/** A parked Pi tool call, as emitted in a batch (T5 turns these into Pi toolCalls). */
export interface ParkedCall {
  /** Deterministic de-dup id: sha256 of per-turn scope + tool name + canonical args. */
  readonly callId: string;
  /** Pi tool name with the `pi__` prefix stripped. */
  readonly piToolName: string;
  /** Raw tool arguments as Vibe sent them. */
  readonly args: unknown;
}

/** One delivered result for a parked call. */
export interface BridgeToolResult {
  readonly callId: string;
  readonly content: readonly BridgeToolContent[];
  readonly isError?: boolean;
}

/** Callback receiving one batch of parked calls. */
export type BatchHandler = (calls: readonly ParkedCall[]) => void;

/** Sink for JSONL debug lines; the token is redacted before it reaches the sink. */
export type McpBridgeLogger = (line: string) => void;

/** Counters; `unauthorizedRequests` counts the 401s (AGENTS.md §15). */
export interface BridgeStats {
  unauthorizedRequests: number;
}

export interface McpBridge {
  /** Loopback URL to hand to Vibe (`http://127.0.0.1:<port>/mcp`). */
  readonly url: string;
  /** Per-session bearer token; required as `Authorization: Bearer <token>`. */
  readonly token: string;
  readonly serverName: string;
  readonly stats: BridgeStats;
  /** Replaces the served tool set (tools/list mirrors this). */
  setTools(tools: readonly BridgeTool[]): void;
  /** Registers the batch handler (replaces a previous one). */
  onBatch(handler: BatchHandler): void;
  /** Resolves parked calls with MCP tool results; unknown/late ids are ignored + logged. */
  deliverResults(results: readonly BridgeToolResult[]): void;
  /** Starts a new turn: resets the per-turn de-dup cache (ADR-0006). */
  newTurn(): void;
  /** Answers all parked calls with an error result, closes the server, frees the port. */
  close(): Promise<void>;
  /**
   * Abandons all parked calls: answers every pending call with an isError result
   * using the provided `reason`, then clears the pending queue. Used when a
   * Pi turn is abandoned (steering / rebuild) so the old prompt's parked calls
   * never land in the new stream (AGENTS.md §15, ADR-0003).
   */
  releaseParked(reason: string): void;
}

export interface CreateMcpBridgeOptions {
  tools?: readonly BridgeTool[] | undefined;
  /** Pre-emptive per-call timeout; default {@link DEFAULT_TOOL_PRE_TIMEOUT_MS} (55 s, ADR-0006). */
  toolPreTimeoutMs?: number | undefined;
  /** Quiet window for batching; default {@link DEFAULT_BATCH_WINDOW_MS}. */
  batchWindowMs?: number | undefined;
  serverName?: string | undefined;
  logger?: McpBridgeLogger | undefined;
}

// ------------------------------------------------------------------ internals

/** One parked call: all HTTP requests that joined it resolve together. */
interface PendingCall {
  readonly callId: string;
  readonly piToolName: string;
  readonly args: unknown;
  readonly resolvers: Array<(result: CallToolResult) => void>;
  readonly timer: NodeJS.Timeout;
  resolved: boolean;
}

const REDACTED = '<redacted>';
const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]+/g;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deterministic de-dup id: per-turn scope + tool name + canonical args (ADR-0006). */
function computeCallId(turn: number, piToolName: string, args: unknown): string {
  const payload = `v1|turn=${turn}|tool=${piToolName}|args=${canonicalJson(args)}`;
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/** The Pi tool's parameters as an MCP `inputSchema` (MCP requires `type: "object"`). */
function toInputSchema(parameters: unknown): Record<string, unknown> {
  const base = isPlainObject(parameters) ? parameters : {};
  return { ...base, type: 'object' };
}

function textResult(text: string, isError: boolean): CallToolResult {
  return { content: [{ type: 'text', text }], isError };
}

/**
 * Creates the loopback MCP bridge for one Pi session: a streamable-HTTP MCP
 * server on 127.0.0.1 with a random port and a random bearer token (AGENTS.md
 * §15), stateless per call (Vibe opens a fresh MCP session per tool call).
 */
export async function createMcpBridge(options: CreateMcpBridgeOptions = {}): Promise<McpBridge> {
  const {
    tools: initialTools = [],
    toolPreTimeoutMs = DEFAULT_TOOL_PRE_TIMEOUT_MS,
    batchWindowMs = DEFAULT_BATCH_WINDOW_MS,
    serverName = DEFAULT_MCP_SERVER_NAME,
    logger,
  } = options;

  const token = randomBytes(32).toString('hex');
  const stats: BridgeStats = { unauthorizedRequests: 0 };

  const log = (event: string, fields: Record<string, unknown> = {}): void => {
    if (!logger) return;
    let line = JSON.stringify({ t: new Date().toISOString(), ev: event, ...fields });
    line = line.split(token).join(REDACTED);
    line = line.replace(BEARER_RE, `Bearer ${REDACTED}`);
    logger(line);
  };

  let currentTools: readonly BridgeTool[] = [...initialTools];
  let batchHandler: BatchHandler | undefined;
  let turn = 0;
  let closed = false;

  const pending = new Map<string, PendingCall>();
  const resolvedCache = new Map<string, CallToolResult>();
  let batchQueue: PendingCall[] = [];
  let batchTimer: NodeJS.Timeout | null = null;

  // ------------------------------------------------------------- park/resume

  function finishCall(call: PendingCall, result: CallToolResult): void {
    if (call.resolved) return;
    call.resolved = true;
    clearTimeout(call.timer);
    pending.delete(call.callId);
    resolvedCache.set(call.callId, result);
    for (const resolve of call.resolvers) resolve(result);
  }

  function queueForBatch(call: PendingCall): void {
    batchQueue.push(call);
    if (batchTimer) clearTimeout(batchTimer);
    // quiet window: the timer restarts on every new parked call, so calls
    // arriving within batchWindowMs of each other land in ONE batch
    batchTimer = setTimeout(() => {
      batchTimer = null;
      const calls = batchQueue;
      batchQueue = [];
      if (calls.length === 0 || closed) return;
      const batch: ParkedCall[] = calls.map((c) => ({
        callId: c.callId,
        piToolName: c.piToolName,
        args: c.args,
      }));
      log('batch', { count: batch.length, callIds: batch.map((c) => c.callId) });
      if (batchHandler) batchHandler(batch);
      else log('batch_without_handler', { count: batch.length });
    }, batchWindowMs);
  }

  function handleCallTool(name: unknown, args: unknown): Promise<CallToolResult> {
    const toolName = typeof name === 'string' ? name : '';
    const piToolName = toolName.startsWith(PI_TOOL_PREFIX)
      ? toolName.slice(PI_TOOL_PREFIX.length)
      : '';
    if (!piToolName || !currentTools.some((tool) => tool.name === piToolName)) {
      log('unknown_tool', { name: toolName || null });
      return Promise.resolve(
        textResult(
          `Unknown tool ${JSON.stringify(toolName)} — not among the Pi session's current tools`,
          true
        )
      );
    }
    const callId = computeCallId(turn, piToolName, args);

    const existing = pending.get(callId);
    if (existing) {
      // identical repeat while parked: joins the same parked call (ADR-0006)
      log('duplicate_joined', { callId, piToolName });
      return new Promise<CallToolResult>((resolve) => {
        existing.resolvers.push(resolve);
      });
    }
    const cached = resolvedCache.get(callId);
    if (cached) {
      // identical repeat after resolution within the same turn: cached result
      log('cached_result', { callId, piToolName });
      return Promise.resolve(cached);
    }

    log('parked', { callId, piToolName, turn });
    return new Promise<CallToolResult>((resolve) => {
      const call: PendingCall = {
        callId,
        piToolName,
        args,
        resolvers: [resolve],
        resolved: false,
        timer: setTimeout(() => {
          // pre-emptive timeout: Vibe enforces a hard 60 s per-turn budget, so
          // the bridge answers itself at toolPreTimeoutMs (ADR-0006)
          log('timeout', { callId, piToolName, toolPreTimeoutMs });
          finishCall(
            call,
            textResult(
              `Pi tool did not finish within ${toolPreTimeoutMs} ms (Vibe enforces a 60 s per-turn budget)`,
              true
            )
          );
        }, toolPreTimeoutMs),
      };
      pending.set(callId, call);
      queueForBatch(call);
    });
  }

  // ------------------------------------------------------------ MCP server

  /** One stateless SDK server per HTTP request (fresh MCP session per call). */
  function buildMcpServer(): McpSdkServer {
    const server = new McpSdkServer(
      { name: serverName, version: acpClientInfo().version },
      { capabilities: { tools: {} } }
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: currentTools.map((tool) => ({
        name: `${PI_TOOL_PREFIX}${tool.name}`,
        description: tool.description ?? '',
        inputSchema: toInputSchema(tool.parameters),
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, (request) =>
      handleCallTool(request.params.name, request.params.arguments)
    );
    return server;
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Authorization FIRST, before reading the body: an unauthorized request
    // must not make the server consume/buffer its payload (AGENTS.md §15).
    if (req.headers['authorization'] !== `Bearer ${token}`) {
      stats.unauthorizedRequests += 1;
      log('unauthorized', { method: req.method, url: req.url, count: stats.unauthorizedRequests });
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' });
      res.end();
      return;
    }

    // Body read under a hard cap: past MAX_BODY_BYTES the request is answered
    // 413 and the remaining chunks are drained without buffering.
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    for await (const chunk of req) {
      if (tooLarge) continue; // drain and discard, never buffer
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        log('body_too_large', { size, max: MAX_BODY_BYTES });
        res.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify({ error: `request body exceeds ${MAX_BODY_BYTES} bytes` }));
        continue;
      }
      chunks.push(chunk as Buffer);
    }
    if (tooLarge) return;
    const raw = Buffer.concat(chunks).toString('utf8');

    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = undefined;
    }

    const server = buildMcpServer();
    // `sessionIdGenerator: undefined` selects stateless mode (the SDK's own doc
    // example); the explicit `undefined` needs a cast under
    // exactOptionalPropertyTypes.
    const statelessOptions = {
      sessionIdGenerator: undefined,
    } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0];
    const transport = new StreamableHTTPServerTransport(statelessOptions);
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  const httpServer: Server = createServer((req, res) => {
    handleRequest(req, res).catch((error: unknown) => {
      log('http_error', { error: String(error) });
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  if (!address || typeof address === 'string')
    throw new Error('internal error: no loopback address');
  const url = `http://127.0.0.1:${address.port}/mcp`;
  log('listening', { url, serverName, tools: currentTools.length });

  // -------------------------------------------------------------- public API

  return {
    url,
    token,
    serverName,
    stats,
    setTools(next: readonly BridgeTool[]): void {
      currentTools = [...next];
      log('tools_updated', { count: currentTools.length, names: currentTools.map((t) => t.name) });
    },
    onBatch(handler: BatchHandler): void {
      batchHandler = handler;
    },
    deliverResults(results: readonly BridgeToolResult[]): void {
      for (const result of results) {
        const call = pending.get(result.callId);
        if (!call) {
          // late delivery for a timed-out/closed call, or an unknown id: ignored
          log('delivery_ignored', { callId: result.callId });
          continue;
        }
        log('resolved', {
          callId: call.callId,
          piToolName: call.piToolName,
          isError: result.isError ?? false,
        });
        finishCall(call, {
          content: result.content as CallToolResult['content'],
          isError: result.isError ?? false,
        });
      }
    },
    newTurn(): void {
      turn += 1;
      resolvedCache.clear();
      log('new_turn', { turn });
    },
    releaseParked(reason: string): void {
      for (const call of pending.values()) {
        log('released_parked', { callId: call.callId, piToolName: call.piToolName, reason });
        finishCall(call, textResult(reason, true));
      }
      pending.clear();
      batchQueue = [];
      if (batchTimer) {
        clearTimeout(batchTimer);
        batchTimer = null;
      }
      log('released_all_parked', { reason });
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (batchTimer) {
        clearTimeout(batchTimer);
        batchTimer = null;
      }
      batchQueue = [];
      const parked = [...pending.values()];
      for (const call of parked) {
        log('closed_with_parked_call', { callId: call.callId, piToolName: call.piToolName });
        finishCall(call, textResult('MCP bridge closed while the Pi tool was still parked', true));
      }
      log('closed', { parked: parked.length });
      // give the in-flight SSE responses a moment to flush before tearing down
      await new Promise((resolve) => setTimeout(resolve, 25));
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

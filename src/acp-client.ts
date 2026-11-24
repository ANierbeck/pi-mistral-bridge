/**
 * ACP client + `vibe-acp` process pool (implementation plan T3).
 *
 * - {@link VibeProcessPool} keeps one `vibe-acp` child per model alias
 *   (ADR-0007), lazily spawned with the provider-mode env from
 *   `vibe-protocol.ts` (ADR-0006), reaped after `processIdleTimeoutMs` and
 *   killed on dispose — no orphaned processes (AGENTS.md §15).
 * - {@link VibeAcpProcess} owns the ndjson ACP connection over the child's
 *   stdio (SDK 2.9.1: `client().onRequest(...).connect(stream)` with
 *   `ndJsonStream`), the honest `initialize` handshake (AGENTS.md §14), the
 *   `session/request_permission` bridge (ADR-0006) and crash handling.
 * - {@link AcpSession} wraps one ACP session: `session/new`, `session/prompt`
 *   with mapped events + final `{stopReason, usage}`, `session/cancel` with
 *   the abort watchdog, `session/close`.
 *
 * Event mapping (pi-ai semantics; T5 builds the `AssistantMessage` partials):
 * `agent_message_chunk` → text delta, `agent_thought_chunk` → thinking
 * delta, bridge `tool_call`/`tool_call_update` (`_meta.tool_name` starting
 * with the bridge server's `mcp_<server>.pi__` prefix) → parked tool call, everything else (builtins,
 * the `search_tool_functions` discovery pseudo-tool) is ignored for Pi
 * mapping. Usage comes from `usage_update` / the prompt response, cost is
 * forced to 0 (ADR-0003).
 *
 * Wire shapes verified against `vibe-acp` 3.1.4 —
 * docs/research/2026-11-24-vibe-acp-surface.md.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type { Usage } from '@earendil-works/pi-ai';
import {
  ACP_CLIENT_NAME,
  MODEL_CONFIG_OPTION_ID,
  PERMISSION_OPTION_ALLOW_ONCE,
  PERMISSION_OPTION_REJECT_ONCE,
  buildBridgeToolMetaPrefix,
  buildMcpDisplayNamePrefix,
  PROMPT_RESPONSE_USAGE,
  TOOL_CALL_META_TOOL_NAME,
  USAGE_UPDATE_META,
  acpClientInfo,
  buildAcpMcpServerEntry,
  buildProviderProcessEnv,
  NEVER_SET_ENV_KEYS,
  sanitizeInheritedEnv,
  type BridgeMcpServer,
} from './vibe-protocol.ts';

// ------------------------------------------------------------------- errors

export type AcpErrorKind = 'auth' | 'quota' | 'aborted' | 'crashed' | 'protocol';

/** Stable prefix for quota/429 errors so callers can match it (T5). */
export const QUOTA_ERROR_PREFIX = 'Mistral Vibe quota exceeded';
/** The remediation hint auth errors carry (Vibe owns authentication, §14). */
export const AUTH_ERROR_HINT = 'vibe-acp --setup';

export class AcpClientError extends Error {
  readonly kind: AcpErrorKind;
  constructor(kind: AcpErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AcpClientError';
    this.kind = kind;
  }
}

// Fallback matching: Vibe surfaces quota/429 and auth failures as plain
// JSON-RPC error messages whose wording varies by version.
const QUOTA_RE =
  /quota|allowance|\b429\b|rate.?limit|too many requests|insufficient (?:credits|balance)/i;
const AUTH_RE =
  /auth|unauthori[sz]ed|\b401\b|not signed in|sign[ -]?in|log[ -]?in|api[_ -]?key|credentials|access token/i;

/**
 * Maps any error from an ACP request to an {@link AcpClientError} with a
 * stable kind: `quota` (message starts with {@link QUOTA_ERROR_PREFIX}),
 * `auth` (message names `vibe-acp --setup`), otherwise `protocol`.
 */
export function classifyAcpError(error: unknown): AcpClientError {
  if (error instanceof AcpClientError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (QUOTA_RE.test(message)) {
    return new AcpClientError('quota', `${QUOTA_ERROR_PREFIX}: ${message}`, { cause: error });
  }
  if (AUTH_RE.test(message)) {
    return new AcpClientError(
      'auth',
      `Mistral Vibe authentication is required — run \`${AUTH_ERROR_HINT}\` to sign in, then retry. ` +
        `Underlying error: ${message}`,
      { cause: error }
    );
  }
  return new AcpClientError('protocol', message, { cause: error });
}

// ------------------------------------------------------------- child process

/** Minimal structural type of the spawned `vibe-acp` child (test-injectable). */
export interface VibeChildProcess {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr?: Readable | null;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  kill(signal?: string): boolean;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  once(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
}

export type SpawnChildFn = (
  command: string,
  args: string[],
  env: Record<string, string>,
  cwd?: string
) => VibeChildProcess;

const defaultSpawnChild: SpawnChildFn = (command, args, env, cwd) =>
  spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
    cwd,
  }) as unknown as VibeChildProcess;

// --------------------------------------------------------------- debug log

/** Default debug log dir: `~/.pi/agent/logs/mistral-bridge/` (AGENTS.md §15). */
export const DEBUG_LOG_DIR_PARTS = ['.pi', 'agent', 'logs', 'mistral-bridge'] as const;

export function defaultDebugLogDir(): string {
  return join(homedir(), ...DEBUG_LOG_DIR_PARTS);
}

const REDACTED = '<redacted>';
const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]+/g;

/**
 * Append-only JSONL log of raw JSON-RPC lines, written only when `debug` is
 * enabled. Authorization headers and every known secret (the MCP bearer
 * token) are redacted (AGENTS.md §15).
 */
export class AcpDebugLog {
  private readonly path: string;

  constructor(
    dir: string,
    fileBase: string,
    private readonly secrets: string[]
  ) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, `${fileBase}.jsonl`);
  }

  /** Synchronous append: a crash must not lose already-logged lines. */
  write(direction: 'client->agent' | 'agent->client' | 'system', message: unknown): void {
    let line = JSON.stringify({ t: new Date().toISOString(), direction, message });
    for (const secret of this.secrets) {
      if (secret) line = line.split(secret).join(REDACTED);
    }
    line = line.replace(BEARER_RE, `Bearer ${REDACTED}`);
    appendFileSync(this.path, `${line}\n`);
  }

  close(): void {
    // synchronous writes need no teardown
  }
}

/** Tees every JSON-RPC message into the debug log without altering it. */
function teeStream(stream: acp.Stream, log: AcpDebugLog): acp.Stream {
  const readable = stream.readable.pipeThrough(
    new TransformStream<acp.AnyMessage, acp.AnyMessage>({
      transform(message, controller): void {
        log.write('agent->client', message);
        controller.enqueue(message);
      },
    })
  );
  const out = new TransformStream<acp.AnyMessage, acp.AnyMessage>({
    transform(message, controller): void {
      log.write('client->agent', message);
      controller.enqueue(message);
    },
  });
  void out.readable.pipeTo(stream.writable).catch(() => {
    // the child died mid-write; the exit handler reports that
  });
  return { readable, writable: out.writable };
}

// ------------------------------------------------------------ events & usage

/** A Pi tool call parked by Vibe: handed to the bridge-facing callback. */
export interface ParkedToolCall {
  toolCallId: string;
  /** MCP request name behind the `mcp_<server>.` title (`pi__`-prefixed). */
  name: string;
  title: string;
  rawInput: unknown;
  rawOutput?: unknown;
  status: acp.ToolCallStatus | null | undefined;
}

/** One mapped ACP session update (pi-ai stream semantics; T5 builds partials). */
export type AcpSessionEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'tool_call'; toolCall: ParkedToolCall }
  | { type: 'tool_call_update'; toolCall: ParkedToolCall }
  | { type: 'usage'; usage: Usage; contextSize?: number; contextUsed?: number };

export interface PromptResult {
  stopReason: acp.StopReason;
  /** pi-ai usage incl. cached tokens; cost is forced to 0 (ADR-0003). */
  usage: Usage;
}

function zeroCost(): Usage['cost'] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function toUsage(input: number, output: number, cacheRead: number, totalTokens: number): Usage {
  return { input, output, cacheRead, cacheWrite: 0, totalTokens, cost: zeroCost() };
}

/** Wire shape of the unstable `session/prompt` response `usage` field. */
interface WirePromptUsage {
  totalTokens?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  cachedReadTokens?: unknown;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mapWireUsage(raw: unknown, fallback: Usage | null): Usage {
  if (!isPlainObject(raw)) return fallback ?? toUsage(0, 0, 0, 0);
  const wire = raw as WirePromptUsage;
  return toUsage(
    num(wire.inputTokens),
    num(wire.outputTokens),
    num(wire.cachedReadTokens),
    num(wire.totalTokens)
  );
}

function mapUsageUpdate(update: acp.UsageUpdate): {
  usage: Usage;
  contextSize: number;
  contextUsed: number;
} {
  const meta = isPlainObject(update._meta) ? update._meta : {};
  return {
    usage: toUsage(
      num(meta[USAGE_UPDATE_META.promptTokens]),
      num(meta[USAGE_UPDATE_META.completionTokens]),
      num(meta[USAGE_UPDATE_META.cachedTokens]),
      num(meta[USAGE_UPDATE_META.totalTokens])
    ),
    contextSize: update.size,
    contextUsed: update.used,
  };
}

// ------------------------------------------------------------- event mapping

/**
 * A tool call is a bridge (Pi) tool iff its `_meta.tool_name` starts with the
 * bridge server's own `mcp_<server>.pi__` prefix — the exact form vibe-acp
 * 3.1.4 puts on MCP tool calls (wire evidence `spikes/out/*-acp-raw.jsonl`,
 * e.g. `mcp_pi.pi__echo`; docs/research/2026-11-24-vibe-acp-surface.md). A
 * `pi__`-prefixed tool of any OTHER MCP server (e.g. `mcp_evil.pi__steal`,
 * which the user's own Vibe config can contribute to every session) is
 * rejected, as is the bare `pi__<tool>` form.
 *
 * Safety assumption behind mapping by tool name at all: this prefix check is
 * only safe because `VIBE_ENABLED_TOOLS` restricts execution to the bridge
 * server's tool display names, and policy-denied tools never raise a
 * `session/request_permission` (docs/research/2026-11-24-vibe-acp-surface.md,
 * paid run prompt 2: builtin attempts failed with `tool_denied` /
 * `approvalSource:"never"` without any request to the client). A permission
 * request for a non-bridge toolCallId can therefore only be an anomaly,
 * which the bridge answers `reject_once` and logs (ADR-0006).
 */
export function isBridgeToolName(
  toolName: unknown,
  mcpServerName: string | undefined
): toolName is string {
  return (
    typeof toolName === 'string' &&
    mcpServerName !== undefined &&
    toolName.startsWith(buildBridgeToolMetaPrefix(mcpServerName))
  );
}

/**
 * The MCP request name behind a bridge `_meta.tool_name`
 * (`mcp_<server>.pi__<tool>` → `pi__<tool>`), i.e. the name the bridge's MCP
 * server published for the tool.
 */
export function bridgeToolRequestName(toolName: string, mcpServerName: string): string {
  const displayPrefix = buildMcpDisplayNamePrefix(mcpServerName);
  return toolName.startsWith(displayPrefix) ? toolName.slice(displayPrefix.length) : toolName;
}

function readToolName(meta: { [key: string]: unknown } | null | undefined): unknown {
  return meta?.[TOOL_CALL_META_TOOL_NAME];
}

/**
 * Extracts the `model` select options from a `session/new` response (T7 reads
 * the model list from here; alias = `value`, API model id = `description`).
 */
export function extractModelOptions(
  configOptions: acp.SessionConfigOption[] | null | undefined
): acp.SessionConfigSelectOption[] {
  const option = configOptions?.find((o) => o.id === MODEL_CONFIG_OPTION_ID);
  if (option?.type !== 'select') return [];
  const options = option.options;
  if (options.length > 0 && options.every((o) => 'options' in o)) {
    return options.flatMap((o) => o.options);
  }
  return options as acp.SessionConfigSelectOption[];
}

// ------------------------------------------------------------------ AcpPrompt

/**
 * One `session/prompt` turn: an async iterable of mapped
 * {@link AcpSessionEvent}s plus {@link result} for the final
 * `{stopReason, usage}` (rejected with an {@link AcpClientError} on failure).
 */
export class AcpPrompt implements AsyncIterable<AcpSessionEvent> {
  private readonly queue: AcpSessionEvent[] = [];
  private wakeups: Array<() => void> = [];
  private resultWaiters: Array<{
    resolve: (result: PromptResult) => void;
    reject: (error: unknown) => void;
  }> = [];
  private settled = false;
  private failure: AcpClientError | null = null;
  private value: PromptResult | null = null;

  get isSettled(): boolean {
    return this.settled;
  }

  push(event: AcpSessionEvent): void {
    if (this.settled) return;
    this.queue.push(event);
    this.wake();
  }

  finish(result: PromptResult): void {
    if (this.settled) return;
    this.settled = true;
    this.value = result;
    this.settle();
  }

  fail(error: AcpClientError): void {
    if (this.settled) return;
    this.settled = true;
    this.failure = error;
    this.settle();
  }

  private settle(): void {
    this.wake();
    const waiters = this.resultWaiters;
    this.resultWaiters = [];
    for (const waiter of waiters) {
      if (this.failure) waiter.reject(this.failure);
      else waiter.resolve(this.value as PromptResult);
    }
  }

  private wake(): void {
    const pending = this.wakeups;
    this.wakeups = [];
    for (const wake of pending) wake();
  }

  result(): Promise<PromptResult> {
    if (this.settled) {
      return this.failure
        ? Promise.reject(this.failure)
        : Promise.resolve(this.value as PromptResult);
    }
    return new Promise<PromptResult>((resolve, reject) => {
      this.resultWaiters.push({ resolve, reject });
    });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AcpSessionEvent> {
    for (;;) {
      const next = this.queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.settled) return; // a failure is reported via result()
      await new Promise<void>((resolve) => this.wakeups.push(resolve));
    }
  }
}

// --------------------------------------------------------------- AcpSession

export interface NewSessionParams {
  cwd: string;
  /**
   * The bridge MCP server of the owning Pi session. Omit for a
   * discovery-only session (ADR-0005): `session/new` then gets
   * `mcpServers: []` and the child serves no Pi tools.
   */
  mcpServer?: BridgeMcpServer | undefined;
  /** Bridge-facing callback invoked for every parked Pi tool call (ADR-0002). */
  onParkedToolCall?: (call: ParkedToolCall) => void;
}

interface ToolCallInfo {
  title: string;
  toolName: unknown;
  rawInput: unknown;
}

/** One ACP session inside a {@link VibeAcpProcess}. */
export class AcpSession {
  readonly sessionId: string;
  readonly modes: acp.SessionModeState | null | undefined;
  readonly configOptions: acp.SessionConfigOption[] | null | undefined;
  private readonly process: VibeAcpProcess;
  private readonly onParkedToolCall: ((call: ParkedToolCall) => void) | undefined;
  private readonly toolCalls = new Map<string, ToolCallInfo>();
  private activePrompt: AcpPrompt | null = null;
  private dirtyFlag = false;
  private lastUsage: Usage | null = null;
  private closed = false;

  constructor(process: VibeAcpProcess, response: acp.NewSessionResponse, params: NewSessionParams) {
    this.process = process;
    this.sessionId = response.sessionId;
    this.modes = response.modes;
    this.configOptions = response.configOptions;
    this.onParkedToolCall = params.onParkedToolCall;
  }

  /** True after a crash or a watchdog kill — the next turn must rebuild (ADR-0003). */
  get dirty(): boolean {
    return this.dirtyFlag;
  }

  get hasActivePrompt(): boolean {
    return this.activePrompt !== null;
  }

  markDirty(): void {
    this.dirtyFlag = true;
  }

  /** All toolCallIds seen on this session (permission mapping, ADR-0006). */
  knownToolCallIds(): string[] {
    return [...this.toolCalls.keys()];
  }

  toolCallInfo(toolCallId: string): ToolCallInfo | undefined {
    return this.toolCalls.get(toolCallId);
  }

  /** The `model` config options of this session (alias + API model id) for T7. */
  modelOptions(): acp.SessionConfigSelectOption[] {
    return extractModelOptions(this.configOptions);
  }

  /** Sends `session/prompt`; returns the event stream immediately. */
  prompt(input: string | acp.ContentBlock[]): AcpPrompt {
    if (this.closed)
      throw new AcpClientError('protocol', `ACP session ${this.sessionId} is closed`);
    if (!this.process.alive) {
      throw new AcpClientError(
        'crashed',
        `vibe-acp for model ${this.process.modelLabel} is dead — respawned on next use; session is dirty (ADR-0003)`
      );
    }
    if (this.activePrompt) {
      throw new AcpClientError(
        'protocol',
        `a prompt is already in flight on ACP session ${this.sessionId}`
      );
    }
    const blocks: acp.ContentBlock[] =
      typeof input === 'string' ? [{ type: 'text', text: input }] : input;
    const prompt = new AcpPrompt();
    this.activePrompt = prompt;
    void this.runPrompt(prompt, blocks);
    return prompt;
  }

  private async runPrompt(prompt: AcpPrompt, blocks: acp.ContentBlock[]): Promise<void> {
    try {
      const response = await this.process.request<acp.PromptResponse>('session/prompt', {
        sessionId: this.sessionId,
        prompt: blocks,
      });
      const rawUsage = (response as unknown as Record<string, unknown>)[PROMPT_RESPONSE_USAGE];
      prompt.finish({
        stopReason: response.stopReason,
        usage: mapWireUsage(rawUsage, this.lastUsage),
      });
    } catch (error) {
      prompt.fail(this.process.classifyError(error));
    } finally {
      if (this.activePrompt === prompt) this.activePrompt = null;
    }
  }

  /**
   * `session/cancel` plus the abort watchdog: if the prompt does not resolve
   * within `abortWatchdogMs`, the child is killed and the session marked
   * dirty (a pending `session/request_permission` makes `session/cancel` hang
   * on Vibe 3.1.4 — ADR-0006; rebuild per ADR-0003).
   */
  async cancel(): Promise<void> {
    const prompt = this.activePrompt;
    try {
      await this.process.notify('session/cancel', { sessionId: this.sessionId });
    } catch (error) {
      if (this.process.alive) throw this.process.classifyError(error);
      return; // child already dead; the pending prompt fails via the exit path
    }
    if (!prompt || prompt.isSettled) return;
    const watchdog = setTimeout(() => {
      if (this.activePrompt === prompt && !prompt.isSettled) {
        this.markDirty();
        prompt.fail(
          new AcpClientError(
            'aborted',
            `session/cancel did not resolve within ${this.process.abortWatchdogMs} ms — killed the vibe-acp ` +
              `child (pending-permission cancel-hang on Vibe 3.1.4, ADR-0006); session marked dirty (ADR-0003)`
          )
        );
        this.process.killNow();
      }
    }, this.process.abortWatchdogMs);
    try {
      await prompt.result();
    } catch {
      // the outcome (cancelled / aborted / crashed) is reported via result()
    } finally {
      clearTimeout(watchdog);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.process.forgetSession(this.sessionId);
    if (this.activePrompt && !this.activePrompt.isSettled) {
      this.activePrompt.fail(
        new AcpClientError(
          'protocol',
          `ACP session ${this.sessionId} was closed with a prompt in flight`
        )
      );
    }
    if (!this.process.alive) return;
    try {
      await this.process.request('session/close', { sessionId: this.sessionId });
    } catch (error) {
      if (this.process.alive) throw this.process.classifyError(error);
    }
  }

  /** Routes one `session/update` notification (called by the owning process). */
  handleUpdate(update: acp.SessionUpdate): void {
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      const info: ToolCallInfo = {
        title: update.title ?? '',
        toolName: readToolName(update._meta),
        rawInput: update.rawInput,
      };
      const existing = this.toolCalls.get(update.toolCallId);
      this.toolCalls.set(
        update.toolCallId,
        existing ? { ...existing, ...definedOnly(info) } : info
      );
    }
    const event = this.mapUpdate(update);
    if (!event) return;
    if (event.type === 'usage') this.lastUsage = event.usage;
    if (event.type === 'tool_call') this.onParkedToolCall?.(event.toolCall);
    this.activePrompt?.push(event);
  }

  private mapUpdate(update: acp.SessionUpdate): AcpSessionEvent | null {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        const content = update.content;
        if (content?.type !== 'text') return null;
        return update.sessionUpdate === 'agent_message_chunk'
          ? { type: 'text_delta', delta: content.text }
          : { type: 'thinking_delta', delta: content.text };
      }
      case 'tool_call': {
        const toolName = readToolName(update._meta);
        // builtins and the search_tool_functions discovery pseudo-tool are
        // ignored for Pi mapping (they are denied by policy anyway, ADR-0006)
        if (!isBridgeToolName(toolName, this.process.mcpServerName)) return null;
        return {
          type: 'tool_call',
          toolCall: {
            toolCallId: update.toolCallId,
            name: bridgeToolRequestName(toolName, this.process.mcpServerName ?? ''),
            title: update.title,
            rawInput: update.rawInput,
            rawOutput: update.rawOutput,
            status: update.status,
          },
        };
      }
      case 'tool_call_update': {
        const info = this.toolCalls.get(update.toolCallId);
        if (!info || !isBridgeToolName(info.toolName, this.process.mcpServerName)) return null;
        return {
          type: 'tool_call_update',
          toolCall: {
            toolCallId: update.toolCallId,
            name: bridgeToolRequestName(info.toolName, this.process.mcpServerName ?? ''),
            title: info.title,
            rawInput: update.rawInput !== undefined ? update.rawInput : info.rawInput,
            rawOutput: update.rawOutput !== undefined ? update.rawOutput : undefined,
            status: update.status !== undefined ? update.status : null,
          },
        };
      }
      case 'usage_update': {
        const mapped = mapUsageUpdate(update);
        return {
          type: 'usage',
          usage: mapped.usage,
          contextSize: mapped.contextSize,
          contextUsed: mapped.contextUsed,
        };
      }
      default:
        return null;
    }
  }
}

function definedOnly(info: ToolCallInfo): Partial<ToolCallInfo> {
  const result: Partial<ToolCallInfo> = {};
  if (info.title !== '') result.title = info.title;
  if (info.toolName !== undefined) result.toolName = info.toolName;
  if (info.rawInput !== undefined) result.rawInput = info.rawInput;
  return result;
}

// ----------------------------------------------------------- VibeAcpProcess

export interface VibeAcpProcessOptions {
  /**
   * Model alias for `VIBE_ACTIVE_MODEL`. Omit for a discovery-only process
   * (ADR-0005): Vibe runs on its own default model.
   */
  modelAlias?: string | undefined;
  vibeAcpPath: string;
  cwd?: string | undefined;
  /**
   * The bridge MCP server of the owning Pi session (env at spawn, ADR-0007).
   * Omit for a discovery-only process: no Pi tools are served.
   */
  mcpServer?: BridgeMcpServer | undefined;
  abortWatchdogMs: number;
  debug: boolean;
  logDir: string;
  spawnChild?: SpawnChildFn | undefined;
  onAnomaly?: ((message: string) => void) | undefined;
  logFileBase: string;
  /**
   * Abort hook: when the signal fires, the child is killed immediately (even
   * mid-`initialize`), which unblocks every pending ACP request through the
   * exit path. Used by model discovery so `dispose()`/timeout can kill a
   * wedged discovery child (no orphan, AGENTS.md §15).
   */
  signal?: AbortSignal | undefined;
}

function defaultAnomalySink(message: string): void {
  // src/ must not use console (eslint no-console); anomalies go to stderr.
  process.stderr.write(`pi-mistral-bridge: ${message}\n`);
}

function describeExit(exit: { code: number | null; signal: string | null } | null): string {
  return `code ${exit?.code ?? 'null'}, signal ${exit?.signal ?? 'none'}`;
}

function shortToolName(value: unknown): string {
  return typeof value === 'string' ? value : 'unknown';
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One spawned `vibe-acp` process and its ACP connection. */
export class VibeAcpProcess {
  readonly modelAlias: string | undefined;
  /** Name of the bridge MCP server this process was spawned with, if any. */
  readonly mcpServerName: string | undefined;
  readonly child: VibeChildProcess;
  readonly abortWatchdogMs: number;
  alive = true;
  /** Set by the pool; called when the child exits (crash or kill). */
  onExit: ((proc: VibeAcpProcess) => void) | null = null;

  private readonly conn: acp.ClientConnection;
  private readonly ctx: acp.ClientContext;
  private readonly sessions = new Map<string, AcpSession>();
  private readonly debugLog: AcpDebugLog | null;
  private readonly onAnomaly: (message: string) => void;
  private exitInfo: { code: number | null; signal: string | null } | null = null;

  private constructor(
    options: VibeAcpProcessOptions,
    child: VibeChildProcess,
    conn: acp.ClientConnection,
    debugLog: AcpDebugLog | null
  ) {
    this.modelAlias = options.modelAlias;
    this.mcpServerName = options.mcpServer?.name;
    this.child = child;
    this.conn = conn;
    this.ctx = conn.agent;
    this.debugLog = debugLog;
    this.abortWatchdogMs = options.abortWatchdogMs;
    this.onAnomaly = options.onAnomaly ?? defaultAnomalySink;
  }

  /** Spawns the child, wires the ACP client and performs the `initialize` handshake. */
  static async start(options: VibeAcpProcessOptions): Promise<VibeAcpProcess> {
    // Inherited env is sanitized first (AGENTS.md §15): every inherited
    // `VIBE_*` key except `VIBE_HOME` is dropped so nothing from the Pi
    // process (e.g. `VIBE_TOOLS={"x":{"permission":"always"}}` or
    // `VIBE_ENABLE_AUTO_APPROVE=true`) can auto-approve tools in the child;
    // the bridge's own provider env is layered on top (ADR-0006).
    const env = sanitizeInheritedEnv(process.env);
    Object.assign(
      env,
      buildProviderProcessEnv({ modelAlias: options.modelAlias, mcpServer: options.mcpServer })
    );
    // Real invariant (AGENTS.md §14): the bridge never SETS a
    // NEVER_SET_ENV_KEY on the child. An inherited `VIBE_HOME` (the user's
    // own Vibe installation, where their auth lives) passes through
    // unchanged; any other appearance here means the bridge itself set it.
    for (const key of NEVER_SET_ENV_KEYS) {
      if (key in env && !(key in process.env)) {
        throw new Error(`internal error: the bridge must never set ${key} (AGENTS.md §14)`);
      }
    }
    const spawnChild = options.spawnChild ?? defaultSpawnChild;
    const child = spawnChild(options.vibeAcpPath, [], env, options.cwd);
    // Abort hook: kill the child the moment the signal fires — even while
    // `initialize` is still in flight — so a wedged child can never outlive
    // its owner (discovery timeout / provider dispose, AGENTS.md §15). The
    // exit then fails every pending request through the connection-close path.
    if (options.signal) {
      const onAbort = (): void => {
        child.kill('SIGKILL');
      };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const debugLog = options.debug
        ? new AcpDebugLog(
            options.logDir,
            options.logFileBase,
            options.mcpServer ? [options.mcpServer.token] : []
          )
        : null;
      if (!child.stdin || !child.stdout) {
        throw new AcpClientError('protocol', `${options.vibeAcpPath} did not provide stdio pipes`);
      }
      const base = acp.ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
      );
      const stream = debugLog ? teeStream(base, debugLog) : base;

      // Handlers only fire once the peer sends something, which happens after
      // the initialize request below — by then procRef.current is set.
      const procRef: { current: VibeAcpProcess | null } = { current: null };
      const app = acp
        .client({ name: ACP_CLIENT_NAME })
        .onRequest(acp.CLIENT_METHODS.session_request_permission, ({ params }) => {
          const proc = procRef.current;
          if (!proc) throw acp.RequestError.internalError('ACP client is not connected yet');
          return proc.handlePermissionRequest(params);
        })
        .onRequest('*', ({ method }) => {
          debugLog?.write('system', { unexpected_client_request: method });
          throw acp.RequestError.methodNotFound(method);
        })
        .onNotification(acp.CLIENT_METHODS.session_update, ({ params }) => {
          procRef.current?.sessions.get(params.sessionId)?.handleUpdate(params.update);
        })
        .onNotification('*', () => {
          // Unknown extension notifications (e.g. _config/changed) are ignored (AGENTS.md §16).
        });
      const conn = app.connect(stream);
      const proc = new VibeAcpProcess(options, child, conn, debugLog);
      procRef.current = proc;
      child.on('exit', proc.handleChildExit);
      if (child.stderr) {
        if (debugLog) {
          child.stderr.on('data', (chunk: Buffer) =>
            debugLog.write('system', { stderr: String(chunk) })
          );
        } else {
          child.stderr.resume();
        }
      }
      try {
        // Honest client identification (AGENTS.md §14); no fs/terminal/elicitation
        // capabilities, so Vibe never calls back into us beyond permissions.
        await proc.request('initialize', {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientInfo: acpClientInfo(),
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        });
      } catch (error) {
        await proc.terminate('initialize-failed').catch(() => {
          // the original error matters more
        });
        throw error;
      }
      return proc;
    } catch (error) {
      // No orphan window (AGENTS.md §15): everything after spawnChild runs
      // inside this try — any throw (debug-log mkdir, stream setup, connect,
      // initialize) must not leak a running child.
      child.kill('SIGKILL');
      throw error;
    }
  }

  /** A prompt is running on one of this process's sessions. */
  get busy(): boolean {
    for (const session of this.sessions.values()) {
      if (session.hasActivePrompt) return true;
    }
    return false;
  }

  /** Display form of {@link modelAlias} for error messages ('default' when unset, ADR-0005). */
  get modelLabel(): string {
    return this.modelAlias ?? 'default';
  }

  async newSession(params: NewSessionParams): Promise<AcpSession> {
    const response = await this.request<acp.NewSessionResponse>('session/new', {
      cwd: params.cwd,
      mcpServers: params.mcpServer ? [buildAcpMcpServerEntry(params.mcpServer)] : [],
    });
    const session = new AcpSession(this, response, params);
    this.sessions.set(response.sessionId, session);
    return session;
  }

  forgetSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  async request<Response>(method: string, params?: unknown): Promise<Response> {
    try {
      return await this.ctx.request<Response, unknown>(method, params);
    } catch (error) {
      throw this.classifyError(error);
    }
  }

  async notify(method: string, params?: unknown): Promise<void> {
    try {
      await this.ctx.notify(method, params);
    } catch (error) {
      throw this.classifyError(error);
    }
  }

  /** Classifies an ACP error; dead child ⇒ `crashed` (respawn on next use). */
  classifyError(error: unknown): AcpClientError {
    if (!this.alive) {
      return new AcpClientError(
        'crashed',
        `vibe-acp (model ${this.modelLabel}) exited ${describeExit(this.exitInfo)} — the process is respawned ` +
          `on next use and affected sessions are dirty for rebuild (ADR-0003)`,
        { cause: error }
      );
    }
    return classifyAcpError(error);
  }

  /**
   * ADR-0006 permission bridge: resolve the `toolCallId` to the preceding
   * `tool_call`; `allow_once` only for the bridge's own MCP tools, otherwise
   * `reject_once` + anomaly log. Every request is answered immediately —
   * never left pending (a pending request makes `session/cancel` hang on
   * Vibe 3.1.4). Never `allow_always` / `allow_always_permanent`.
   */
  private handlePermissionRequest(
    params: acp.RequestPermissionRequest
  ): acp.RequestPermissionResponse {
    const session = this.sessions.get(params.sessionId);
    const info = session?.toolCallInfo(params.toolCall.toolCallId);
    const bridge = info !== undefined && isBridgeToolName(info.toolName, this.mcpServerName);
    const wantedId = bridge ? PERMISSION_OPTION_ALLOW_ONCE : PERMISSION_OPTION_REJECT_ONCE;
    const wantedKind: acp.PermissionOptionKind = bridge ? 'allow_once' : 'reject_once';
    const option =
      params.options.find((o) => o.optionId === wantedId) ??
      params.options.find((o) => o.kind === wantedKind);
    if (!bridge) {
      this.onAnomaly(
        `rejected session/request_permission for non-Pi toolCallId ${params.toolCall.toolCallId} ` +
          `(tool_name=${shortToolName(info?.toolName)}, title=${info?.title ?? 'unknown'}) — ADR-0006 anomaly`
      );
    }
    this.debugLog?.write('system', {
      permission_decision: {
        toolCallId: params.toolCall.toolCallId,
        bridge,
        optionId: option?.optionId ?? null,
      },
    });
    if (!option) {
      // still an answer — never leave the request pending
      return { outcome: { outcome: 'cancelled' } };
    }
    return { outcome: { outcome: 'selected', optionId: option.optionId } };
  }

  private readonly handleChildExit = (code: number | null, signal: string | null): void => {
    this.markDead(code, signal, 'exit');
  };

  private markDead(code: number | null, signal: string | null, reason: string): void {
    if (!this.alive) return;
    this.alive = false;
    this.exitInfo = { code, signal };
    this.debugLog?.write('system', { event: 'child_exit', code, signal, reason });
    // Deliberately no conn.close() here: the child's stdout EOF closes the
    // connection from the peer side, which still dispatches notifications
    // already received and rejects pending requests. Closing locally would
    // drop a buffered update that arrived just before the crash.
    for (const session of this.sessions.values()) session.markDirty();
    this.onExit?.(this);
  }

  /** Watchdog kill after a hung `session/cancel`. */
  killNow(): void {
    this.markDead(null, 'watchdog', 'abort-watchdog');
    this.child.kill('SIGTERM');
    const escalate = setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null)
        this.child.kill('SIGKILL');
    }, 1000);
    escalate.unref();
  }

  /** Synchronous kill for the process-exit hook (no orphans, AGENTS.md §15). */
  killSync(): void {
    try {
      this.child.kill('SIGKILL');
    } catch {
      // already dead
    }
  }

  /** Graceful shutdown: close the connection, SIGTERM, escalate to SIGKILL. */
  async terminate(reason: string): Promise<void> {
    this.markDead(this.child.exitCode, this.child.signalCode, reason);
    this.child.kill('SIGTERM');
    const exited = new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) resolve();
      else this.child.once('exit', () => resolve());
    });
    await Promise.race([exited, sleep(1000)]);
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
    this.debugLog?.close();
  }
}

// ------------------------------------------------------------ VibeProcessPool

export interface VibeProcessPoolOptions {
  vibeAcpPath: string;
  processIdleTimeoutMs: number;
  abortWatchdogMs: number;
  debug: boolean;
  /** The bridge MCP server of the owning Pi session (env at spawn, ADR-0007). */
  mcpServer: BridgeMcpServer;
  cwd?: string | undefined;
  /** Debug log dir; defaults to `~/.pi/agent/logs/mistral-bridge/`. */
  logDir?: string;
  /** Test injection: child spawn. Defaults to `node:child_process.spawn`. */
  spawnChild?: SpawnChildFn | undefined;
  onAnomaly?: ((message: string) => void) | undefined;
}

interface PoolEntry {
  alias: string;
  process: VibeAcpProcess;
  idleTimer: NodeJS.Timeout;
}

function sanitizeFileBase(alias: string): string {
  return alias.replace(/[^A-Za-z0-9._-]+/g, '_');
}

/**
 * Pool of `vibe-acp` processes keyed by model alias (ADR-0007): lazily
 * spawned on first use, reused across ACP sessions, reaped after
 * `processIdleTimeoutMs` idle, killed on dispose. A crashed entry is dropped
 * so the next `get` respawns.
 */
export class VibeProcessPool {
  private readonly entries = new Map<string, PoolEntry>();
  /** In-flight spawns by alias: concurrent `get`s share one spawn (no racing `entries.set`). */
  private readonly pending = new Map<string, Promise<VibeAcpProcess>>();
  private readonly exitHook: () => void;
  private disposed = false;
  private spawnCounter = 0;

  constructor(private readonly options: VibeProcessPoolOptions) {
    // No orphans (AGENTS.md §15): SIGKILL every child when the Pi process exits.
    this.exitHook = (): void => {
      for (const entry of this.entries.values()) entry.process.killSync();
    };
    process.on('exit', this.exitHook);
  }

  get size(): number {
    return this.entries.size;
  }

  async get(modelAlias: string): Promise<VibeAcpProcess> {
    if (this.disposed) throw new AcpClientError('protocol', 'VibeProcessPool is disposed');
    const existing = this.entries.get(modelAlias);
    if (existing) {
      if (existing.process.alive) {
        this.touch(existing);
        return existing.process;
      }
      this.drop(modelAlias); // crashed: respawn on next use
    }
    // Concurrent gets of the same alias share one in-flight spawn, so a
    // racing second `entries.set` can never orphan the first child.
    const proc = await (this.pending.get(modelAlias) ?? this.startPending(modelAlias));
    if (this.disposed) {
      // dispose() ran while the start was in flight: never register into a
      // disposed pool — terminate the fresh child and fail (AGENTS.md §15).
      await proc.terminate('pool-disposed-during-start').catch(() => {
        // already dead
      });
      throw new AcpClientError('protocol', 'VibeProcessPool is disposed');
    }
    if (this.entries.get(modelAlias)?.process === proc) return proc; // a concurrent get already registered it
    const entry: PoolEntry = {
      alias: modelAlias,
      process: proc,
      idleTimer: setTimeout(() => this.reap(modelAlias), this.options.processIdleTimeoutMs),
    };
    proc.onExit = (p): void => {
      if (this.entries.get(modelAlias)?.process === p) this.drop(modelAlias);
    };
    this.entries.set(modelAlias, entry);
    return proc;
  }

  /** Starts one spawn for `modelAlias` and records it in {@link pending} until it settles. */
  private startPending(modelAlias: string): Promise<VibeAcpProcess> {
    const p = VibeAcpProcess.start({
      modelAlias,
      vibeAcpPath: this.options.vibeAcpPath,
      cwd: this.options.cwd,
      mcpServer: this.options.mcpServer,
      abortWatchdogMs: this.options.abortWatchdogMs,
      debug: this.options.debug,
      logDir: this.options.logDir ?? defaultDebugLogDir(),
      spawnChild: this.options.spawnChild,
      onAnomaly: this.options.onAnomaly,
      logFileBase: `vibe-acp-${sanitizeFileBase(modelAlias)}-${++this.spawnCounter}`,
    });
    this.pending.set(modelAlias, p);
    const cleanup = (): void => {
      if (this.pending.get(modelAlias) === p) this.pending.delete(modelAlias);
    };
    p.then(cleanup, cleanup);
    return p;
  }

  private touch(entry: PoolEntry): void {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => this.reap(entry.alias), this.options.processIdleTimeoutMs);
  }

  private reap(alias: string): void {
    const entry = this.entries.get(alias);
    if (!entry) return;
    if (entry.process.busy) {
      this.touch(entry); // a long turn is still running; retry later
      return;
    }
    this.drop(alias);
    void entry.process.terminate('idle-reaper').catch(() => {
      // already dead
    });
  }

  private drop(alias: string): void {
    const entry = this.entries.get(alias);
    if (!entry) return;
    clearTimeout(entry.idleTimer);
    this.entries.delete(alias);
  }

  /** Kills every child and stops the reapers; the pool is unusable afterwards. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    process.removeListener('exit', this.exitHook);
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) clearTimeout(entry.idleTimer);
    await Promise.all(
      entries.map((entry) =>
        entry.process.terminate('pool-dispose').catch(() => {
          // already dead
        })
      )
    );
  }
}

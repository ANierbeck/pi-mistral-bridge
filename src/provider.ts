/**
 * Provider mode: Pi owns the agent loop, `vibe-acp` drives the model (ADR-0002,
 * implementation plan T5 slice C1). `MistralProvider.streamSimple` is the
 * `streamSimple` handler registered via `pi.registerProvider` (src/index.ts):
 *
 * - One loopback MCP bridge per Pi session serves the current Pi tools as
 *   `pi__<tool>` (ADR-0002, AGENTS.md §15); before every prompt the current
 *   `Context.tools` are pushed into it via `setTools`.
 * - One `VibeProcessPool` per Pi session, keyed by the model alias
 *   (ADR-0007); the alias for a Pi model id comes from the discovery map
 *   (api id → alias, ADR-0005).
 * - Turn flows per `decideFlow` (ADR-0003, src/session-map.ts):
 *   - `rebuild` → new ACP session, prompt = system prompt + renderTranscript;
 *   - `delta` → same ACP session, prompt = renderDelta of the new messages;
 *   - `continueToolResults` → `mcpBridge.deliverResults` for the parked batch,
 *     keep consuming the SAME still-running ACP prompt.
 * - While Vibe streams: text/thinking deltas become Pi events; when the bridge
 *   emits a batch, the calls become Pi `toolCall` blocks (bridge callId as the
 *   tool-call id, `pi__` prefix stripped, parsed args) and the stream ends with
 *   `stopReason: "toolUse"` WITHOUT ending the parked ACP prompt.
 * - Prompt end maps to `stop` (end_turn) / `length` (max_tokens) / `aborted`
 *   (cancelled); failures end with an `error` event carrying the classified
 *   message (quota prefix / `vibe-acp --setup` hint from acp-client, ADR-0002).
 * - Abort (`options.signal`) → `session/cancel` (watchdog inside acp-client),
 *   session marked dirty, `stopReason: "aborted"` → next call rebuilds.
 * - Usage comes from the ACP side incl. cacheRead; cost is forced to 0
 *   (ADR-0003).
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type JsonObject,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
  type TranscriptContext,
  type Usage,
} from '@earendil-works/pi-ai';
import {
  AcpClientError,
  classifyAcpError,
  VibeProcessPool,
  defaultDebugLogDir,
  type AcpPrompt,
  type AcpSession,
  type AcpSessionEvent,
  type PromptResult,
  type SpawnChildFn,
} from './acp-client.ts';
import type { BridgeConfig } from './config.ts';
import {
  createMcpBridge,
  type BridgeTool,
  type BridgeToolResult,
  type CreateMcpBridgeOptions,
  type McpBridge,
  type ParkedCall,
} from './mcp-bridge.ts';
import {
  SessionMap,
  decideFlow,
  hashText,
  recordSentPrefix,
  sessionKey,
  type FlowDecision,
  type SessionState,
} from './session-map.ts';
import { renderDelta, renderTranscript } from './transcript.ts';
import type { BridgeMcpServer } from './vibe-protocol.ts';

/** Options of {@link MistralProvider}. */
export interface MistralProviderOptions {
  config: BridgeConfig;
  /** The Pi session cwd, passed to `session/new`. */
  cwd: string;
  /**
   * API model id → Vibe model alias, from the discovery (`model` config
   * option: `value` = alias, `description` = API id; ADR-0005/0007). A model
   * id missing from the map is used as its own alias.
   */
  aliasByApiId?: ReadonlyMap<string, string> | undefined;
  /** Test injection: child spawn. Defaults to `node:child_process.spawn`. */
  spawnChild?: SpawnChildFn | undefined;
  /** Anomaly sink (permission anomalies etc.); defaults to stderr. */
  onAnomaly?: ((message: string) => void) | undefined;
  /** Debug log dir; defaults to `~/.pi/agent/logs/mistral-bridge/`. */
  logDir?: string | undefined;
  /** Test injection: the loopback MCP bridge factory. Defaults to {@link createMcpBridge}. */
  createBridge?: ((options: CreateMcpBridgeOptions) => Promise<McpBridge>) | undefined;
  /** Extra bridge options (batch window / pre-timeout); defaults from `config`. */
  bridgeOptions?: Partial<CreateMcpBridgeOptions> | undefined;
}

/** The Pi-side view of one in-flight `streamSimple` call. */
interface TurnStream {
  stream: AssistantMessageEventStream;
  message: AssistantMessage;
  /** Content index of the currently open text block, if any. */
  openText: number | null;
  /** Content index of the currently open thinking block, if any. */
  openThinking: number | null;
  /** True once the terminal event was pushed (toolUse park or done/error). */
  ended: boolean;
  /** Events produced while no stream was attached (parked turn). */
  queued: AssistantMessageEvent[];
}

/** The live ACP counterpart of one Pi session key. */
interface LiveTurn {
  key: string;
  state: SessionState;
  session: AcpSession;
  prompt: AcpPrompt;
  /** The streamSimple call currently receiving events. */
  current: TurnStream;
  /** The context messages of the current call (for recordSentPrefix). */
  contextMessages: readonly Message[];
}

function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function newAssistantMessage(model: Model<Api>): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason: 'pending',
    timestamp: Date.now(),
  };
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Vibe's raw tool arguments as a Pi `ToolCall.arguments` (JsonObject). */
function toArguments(args: unknown): JsonObject {
  return isPlainObject(args) ? args : {};
}

function toBridgeTool(tool: Tool): BridgeTool {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

/** Maps one trailing Pi toolResult to a bridge delivery via the parked batch. */
function toBridgeResult(
  batch: readonly ParkedCall[],
  result: ToolResultMessage
): BridgeToolResult | null {
  const call = batch.find((c) => c.callId === result.toolCallId);
  if (!call) return null;
  return {
    callId: call.callId,
    content: result.content,
    isError: result.isError,
  };
}

/** ACP stop reason → Pi terminal event (ADR-0002). */
function mapStopReason(stopReason: acp.StopReason): {
  reason: Extract<StopReason, 'stop' | 'length'>;
  rawStopReason: string | undefined;
} {
  switch (stopReason) {
    case 'max_tokens':
      return { reason: 'length', rawStopReason: stopReason };
    default:
      // end_turn (and refusal / max_turn_requests, which Pi has no better
      // reason for) end the turn normally
      return { reason: 'stop', rawStopReason: stopReason === 'end_turn' ? undefined : stopReason };
  }
}

/**
 * The provider-mode runtime: session map + per-Pi-session bridge/pool +
 * turn orchestration. One instance per extension load; `openSession` /
 * `dispose` follow Pi's `session_start` / `session_shutdown` (src/index.ts).
 */
export class MistralProvider {
  private readonly options: MistralProviderOptions;
  private readonly sessions = new SessionMap();
  private aliasByApiId: ReadonlyMap<string, string>;
  private bridge: McpBridge | null = null;
  private pool: VibeProcessPool | null = null;
  /**
   * One memoized in-flight resource creation: concurrent first calls share it,
   * so a racing second `ensureResources` can never leak a second bridge/pool.
   */
  private resourcesPromise: Promise<void> | null = null;
  private readonly live = new Map<string, LiveTurn>();
  private disposed = false;

  constructor(options: MistralProviderOptions) {
    this.options = options;
    this.aliasByApiId = options.aliasByApiId ?? new Map();
  }

  /** Installs the discovery result (api id → alias) once discovery finished. */
  setAliasByApiId(aliasByApiId: ReadonlyMap<string, string>): void {
    this.aliasByApiId = aliasByApiId;
  }

  /** The Vibe model alias for a Pi model (pool key, ADR-0007). */
  modelAliasFor(model: Model<Api>): string {
    const id = model.id;
    const prefix = `${model.provider}/`;
    const apiId = id.startsWith(prefix) ? id.slice(prefix.length) : id;
    return this.aliasByApiId.get(apiId) ?? this.aliasByApiId.get(id) ?? apiId;
  }

  // ------------------------------------------------------------ resources

  private bridgeServer(): BridgeMcpServer {
    const bridge = this.bridge;
    if (!bridge) throw new Error('internal error: bridge not created');
    return { name: bridge.serverName, url: bridge.url, token: bridge.token };
  }

  /** Creates the per-Pi-session bridge + process pool if absent (lazy). */
  private async ensureResources(): Promise<void> {
    if (this.disposed) throw new AcpClientError('protocol', 'MistralProvider is disposed');
    if (this.bridge && this.pool) return;
    let promise = this.resourcesPromise;
    if (!promise) {
      promise = this.createResources();
      this.resourcesPromise = promise;
      // a failed creation must not poison later calls: reset so the next call retries
      promise.catch(() => {
        if (this.resourcesPromise === promise) this.resourcesPromise = null;
      });
    }
    await promise;
    if (this.disposed) {
      // dispose() ran while the creation was in flight and may have seen null
      // before the assignment: close whatever was created now and fail the
      // call — no orphaned bridge socket or vibe-acp child (AGENTS.md §15)
      const bridge = this.bridge;
      const pool = this.pool;
      this.bridge = null;
      this.pool = null;
      if (pool) await pool.dispose().catch(() => {});
      if (bridge) await bridge.close().catch(() => {});
      throw new AcpClientError('protocol', 'MistralProvider is disposed');
    }
  }

  /** One bridge + one pool, assigned to the provider fields (memoized by ensureResources). */
  private async createResources(): Promise<void> {
    const { config } = this.options;
    const logDir = this.options.logDir ?? defaultDebugLogDir();
    const logger = config.debug
      ? (line: string): void => {
          mkdirSync(logDir, { recursive: true });
          appendFileSync(join(logDir, 'mcp-bridge.jsonl'), `${line}\n`);
        }
      : undefined;
    const createBridge = this.options.createBridge ?? createMcpBridge;
    this.bridge = await createBridge({
      toolPreTimeoutMs: config.toolPreTimeoutMs,
      ...this.options.bridgeOptions,
      logger,
    });
    this.bridge.onBatch((calls) => this.onBatch(calls));
    this.pool = new VibeProcessPool({
      vibeAcpPath: config.vibeAcpPath,
      processIdleTimeoutMs: config.processIdleTimeoutMs,
      abortWatchdogMs: config.abortWatchdogMs,
      debug: config.debug,
      mcpServer: this.bridgeServer(),
      cwd: this.options.cwd,
      logDir,
      spawnChild: this.options.spawnChild,
      onAnomaly: this.options.onAnomaly,
    });
  }

  /** `session_start`: a fresh Pi session gets a fresh bridge + pool. */
  async openSession(): Promise<void> {
    await this.disposeResources();
    this.sessions.clear();
    this.live.clear();
  }

  private async disposeResources(): Promise<void> {
    const pool = this.pool;
    const bridge = this.bridge;
    this.pool = null;
    this.bridge = null;
    this.resourcesPromise = null;
    if (pool) await pool.dispose().catch(() => {});
    if (bridge) await bridge.close().catch(() => {});
  }

  /** `session_shutdown`: no orphaned processes or sockets (AGENTS.md §15). */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.disposeResources();
    this.live.clear();
    this.sessions.clear();
  }

  // ------------------------------------------------------------ streamSimple

  streamSimple(
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions
  ): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    const systemPrompt = getCurrentSystemPrompt(context.messages);
    const tools = getCurrentTools(context.messages);
    const key = sessionKey(options, context.messages, systemPrompt);
    const modelAlias = this.modelAliasFor(model);
    const state = this.sessions.get(key, modelAlias);
    const decision = decideFlow(state, {
      messages: context.messages,
      modelAlias,
      systemPrompt,
    });
    void this.runTurn({
      model,
      context,
      options,
      stream,
      key,
      state,
      modelAlias,
      systemPrompt,
      tools,
      decision,
    }).catch((error: unknown) => {
      // last resort: never leave a returned stream open
      this.endWithError(stream, state, model, error);
    });
    return stream;
  }

  private async runTurn(args: {
    model: Model<Api>;
    context: TranscriptContext;
    options: SimpleStreamOptions | undefined;
    stream: AssistantMessageEventStream;
    key: string;
    state: SessionState;
    modelAlias: string;
    systemPrompt: string;
    tools: Tool[];
    decision: FlowDecision;
  }): Promise<void> {
    const { model, context, options, stream, key, state, tools, decision } = args;
    await this.ensureResources();
    const bridge = this.bridge as McpBridge;
    const pool = this.pool as VibeProcessPool;

    // Before each prompt push the current Pi tools into the bridge (ADR-0002).
    bridge.setTools(tools.map(toBridgeTool));

    const signal = options?.signal;
    if (signal?.aborted) {
      state.dirty = true;
      this.endAborted(stream, state, model, 'aborted before the turn started');
      return;
    }

    if (decision.flow === 'continueToolResults') {
      const live = this.live.get(key);
      const batch = state.pendingToolBatch;
      if (!live || live.prompt.isSettled || !batch || batch.length === 0) {
        // decideFlow saw a pending batch, but the turn already ended (e.g. the
        // bridge's pre-emptive timeout answered it): rebuild instead of hanging
        await this.startRebuild(args, bridge, pool, 'parked batch already answered');
        return;
      }
      // attach the new stream to the still-running parked prompt
      const turnStream = this.newTurnStream(stream, model);
      live.current = turnStream;
      live.contextMessages = context.messages;
      stream.push({ type: 'start', partial: turnStream.message });
      for (const event of turnStream.queued.splice(0)) stream.push(event);
      this.attachAbort(live, state, signal);
      const results = decision.results
        .map((r) => toBridgeResult(batch, r))
        .filter((r): r is BridgeToolResult => r !== null);
      bridge.deliverResults(results);
      // New turn scope for the de-dup cache (ADR-0006): a call identical to one
      // of the answered calls must park again in this round and get the fresh
      // result, never the cached one. The turn number is part of the callId
      // hash, so callIds stay unique; repeats INSIDE one round still de-dup.
      // This also bounds the resolvedCache (no per-result retention forever).
      bridge.newTurn();
      return; // the existing consume loop finishes this stream
    }

    // rebuild + delta start a new user turn on the bridge (ADR-0006 de-dup scope)
    bridge.newTurn();

    if (decision.flow === 'delta') {
      const live = this.live.get(key);
      if (live && live.prompt.isSettled && !live.session.dirty) {
        // same ACP session, only the new message(s) as the next prompt
        const input = renderDelta(decision.newMessages);
        const prompt = live.session.prompt(input);
        this.startTurn(key, state, live.session, prompt, context.messages, stream, model, signal);
        return;
      }
      // no usable live session (should not happen after decideFlow): rebuild
      await this.startRebuild(args, bridge, pool, 'delta without a settled live session');
      return;
    }

    await this.startRebuild(args, bridge, pool, decision.reason);
  }

  /** Rebuild flow: close the old ACP session, open a new one, prompt = system prompt + transcript. */
  private async startRebuild(
    args: {
      model: Model<Api>;
      context: TranscriptContext;
      options: SimpleStreamOptions | undefined;
      stream: AssistantMessageEventStream;
      key: string;
      state: SessionState;
      modelAlias: string;
      systemPrompt: string;
      decision: FlowDecision;
    },
    bridge: McpBridge,
    pool: VibeProcessPool,
    reason: string
  ): Promise<void> {
    const { model, context, stream, key, state, modelAlias, systemPrompt, options } = args;
    const existing = this.live.get(key);
    if (existing) {
      this.live.delete(key);
      await existing.session.close().catch(() => {});
    }
    state.acpSessionId = null;
    state.pendingToolBatch = null;
    state.dirty = false;
    const proc = await pool.get(modelAlias);
    const session = await proc.newSession({
      cwd: this.options.cwd,
      mcpServer: this.bridgeServer(),
    });
    state.acpSessionId = session.sessionId;
    // the state now belongs to the NEW model alias, so later calls on the same
    // model delta/continue instead of rebuilding on every call (ADR-0007)
    state.modelAlias = modelAlias;
    state.systemPromptDigest = hashText(systemPrompt);
    const transcript = renderTranscript(context.messages);
    const promptText = systemPrompt ? `${systemPrompt}\n\n${transcript}` : transcript;
    const prompt = session.prompt(promptText);
    this.startTurn(key, state, session, prompt, context.messages, stream, model, options?.signal);
    void reason; // the reason is already logged by the caller's decision; kept for clarity
  }

  /** Registers a new (prompt, stream) pair on a live turn and starts its consume loop. */
  private startTurn(
    key: string,
    state: SessionState,
    session: AcpSession,
    prompt: AcpPrompt,
    contextMessages: readonly Message[],
    stream: AssistantMessageEventStream,
    model: Model<Api>,
    signal: AbortSignal | undefined
  ): void {
    const turnStream = this.newTurnStream(stream, model);
    const live: LiveTurn = {
      key,
      state,
      session,
      prompt,
      current: turnStream,
      contextMessages,
    };
    this.live.set(key, live);
    stream.push({ type: 'start', partial: turnStream.message });
    this.attachAbort(live, state, signal);
    void this.consumeLoop(live, model);
  }

  private newTurnStream(stream: AssistantMessageEventStream, model: Model<Api>): TurnStream {
    return {
      stream,
      message: newAssistantMessage(model),
      openText: null,
      openThinking: null,
      ended: false,
      queued: [],
    };
  }

  /** Abort: `session/cancel` (watchdog inside acp-client) + dirty (ADR-0003). */
  private attachAbort(live: LiveTurn, state: SessionState, signal: AbortSignal | undefined): void {
    if (!signal) return;
    const onAbort = (): void => {
      state.dirty = true;
      live.session.markDirty();
      void live.session.cancel().catch(() => {
        // the prompt reports the outcome (aborted/cancelled/crashed) itself
      });
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  // ------------------------------------------------------------ event pump

  /** Consumes one ACP prompt to its end, routing events to the current stream. */
  private async consumeLoop(live: LiveTurn, model: Model<Api>): Promise<void> {
    const prompt = live.prompt;
    let outcome: PromptResult | null = null;
    let failure: unknown = null;
    try {
      for await (const event of prompt) this.handleAcpEvent(live, event);
      outcome = await prompt.result();
    } catch (error) {
      failure = error;
    }
    // a stale loop (its prompt was replaced by a newer turn) must not end the
    // new stream
    if (live.prompt !== prompt) return;
    this.finishTurn(live, model, outcome, failure);
  }

  private handleAcpEvent(live: LiveTurn, event: AcpSessionEvent): void {
    const turn = live.current;
    switch (event.type) {
      case 'text_delta': {
        if (turn.openThinking !== null) this.closeThinking(live);
        if (turn.openText === null) {
          turn.message.content.push({ type: 'text', text: '' });
          turn.openText = turn.message.content.length - 1;
          this.emit(live, {
            type: 'text_start',
            contentIndex: turn.openText,
            partial: turn.message,
          });
        }
        const block = turn.message.content[turn.openText];
        if (block?.type === 'text') block.text += event.delta;
        this.emit(live, {
          type: 'text_delta',
          contentIndex: turn.openText,
          delta: event.delta,
          partial: turn.message,
        });
        return;
      }
      case 'thinking_delta': {
        if (turn.openText !== null) this.closeText(live);
        if (turn.openThinking === null) {
          turn.message.content.push({ type: 'thinking', thinking: '' });
          turn.openThinking = turn.message.content.length - 1;
          this.emit(live, {
            type: 'thinking_start',
            contentIndex: turn.openThinking,
            partial: turn.message,
          });
        }
        const block = turn.message.content[turn.openThinking];
        if (block?.type === 'thinking') block.thinking += event.delta;
        this.emit(live, {
          type: 'thinking_delta',
          contentIndex: turn.openThinking,
          delta: event.delta,
          partial: turn.message,
        });
        return;
      }
      case 'usage': {
        turn.message.usage = event.usage; // cost already forced to 0 (ADR-0003)
        return;
      }
      default:
        // tool_call / tool_call_update of bridge tools are surfaced via the
        // MCP batch (onBatch), not via these ACP notifications
        return;
    }
  }

  private closeText(live: LiveTurn): void {
    const turn = live.current;
    if (turn.openText === null) return;
    const block = turn.message.content[turn.openText];
    this.emit(live, {
      type: 'text_end',
      contentIndex: turn.openText,
      content: block?.type === 'text' ? block.text : '',
      partial: turn.message,
    });
    turn.openText = null;
  }

  private closeThinking(live: LiveTurn): void {
    const turn = live.current;
    if (turn.openThinking === null) return;
    const block = turn.message.content[turn.openThinking];
    this.emit(live, {
      type: 'thinking_end',
      contentIndex: turn.openThinking,
      content: block?.type === 'thinking' ? block.thinking : '',
      partial: turn.message,
    });
    turn.openThinking = null;
  }

  private emit(live: LiveTurn, event: AssistantMessageEvent): void {
    const turn = live.current;
    if (turn.ended) {
      turn.queued.push(event);
      return;
    }
    turn.stream.push(event);
  }

  // ------------------------------------------------------------ batch (park)

  /**
   * A batch of parked MCP calls: emit Pi toolCall blocks and end the current
   * stream with `toolUse` — the ACP prompt stays parked until the next
   * `streamSimple` delivers the toolResults (ADR-0002).
   */
  private onBatch(calls: readonly ParkedCall[]): void {
    const live = [...this.live.values()].find((l) => !l.prompt.isSettled && !l.current.ended);
    if (!live) {
      this.anomaly(`MCP batch of ${calls.length} call(s) with no running ACP prompt — dropped`);
      return;
    }
    const turn = live.current;
    this.closeText(live);
    this.closeThinking(live);
    live.state.pendingToolBatch = calls;
    for (const call of calls) {
      const toolCall: ToolCall = {
        type: 'toolCall',
        id: call.callId, // the bridge's deterministic de-dup id (ADR-0006)
        name: call.piToolName, // Pi tool name, `pi__` prefix stripped
        arguments: toArguments(call.args),
      };
      turn.message.content.push(toolCall);
      const contentIndex = turn.message.content.length - 1;
      this.emit(live, { type: 'toolcall_start', contentIndex, partial: turn.message });
      this.emit(live, { type: 'toolcall_end', contentIndex, toolCall, partial: turn.message });
    }
    turn.message.stopReason = 'toolUse';
    this.emit(live, { type: 'done', reason: 'toolUse', message: turn.message });
    turn.ended = true;
    turn.stream.end();
    // Pi appends this assistant message and answers with toolResults, so the
    // sent prefix now includes it (decideFlow's continueToolResults check)
    recordSentPrefix(live.state, [...live.contextMessages, turn.message]);
  }

  // ------------------------------------------------------------ turn end

  private finishTurn(
    live: LiveTurn,
    model: Model<Api>,
    outcome: PromptResult | null,
    failure: unknown
  ): void {
    const turn = live.current;
    const state = live.state;
    this.closeText(live);
    this.closeThinking(live);
    state.pendingToolBatch = null;

    if (failure !== null) {
      const error = failure instanceof AcpClientError ? failure : classifyAcpError(failure);
      if (error.kind === 'aborted' || error.kind === 'crashed') state.dirty = true;
      if (!turn.ended) {
        if (error.kind === 'aborted') {
          this.endAborted(turn.stream, state, model, error.message);
        } else {
          turn.message.stopReason = 'error';
          turn.message.errorMessage = error.message; // quota prefix / auth hint (ADR-0002)
          turn.stream.push({ type: 'error', reason: 'error', error: turn.message });
          turn.stream.end();
          turn.ended = true;
        }
      }
      if (!turn.ended || live.prompt.isSettled) {
        // record what the ACP session has seen (incl. the emitted message)
        recordSentPrefix(state, [...live.contextMessages, turn.message]);
      }
      return;
    }

    const result = outcome as PromptResult;
    if (result.stopReason === 'cancelled') {
      state.dirty = true;
      if (!turn.ended) this.endAborted(turn.stream, state, model, 'prompt was cancelled');
      return;
    }
    turn.message.usage = result.usage;
    const mapped = mapStopReason(result.stopReason);
    turn.message.stopReason = mapped.reason;
    if (mapped.rawStopReason !== undefined) turn.message.rawStopReason = mapped.rawStopReason;
    if (!turn.ended) {
      turn.stream.push({ type: 'done', reason: mapped.reason, message: turn.message });
      turn.stream.end();
      turn.ended = true;
    }
    recordSentPrefix(state, [...live.contextMessages, turn.message]);
  }

  /** Terminal `error` event with `aborted` (Pi's abort contract). */
  private endAborted(
    stream: AssistantMessageEventStream,
    state: SessionState,
    model: Model<Api>,
    errorMessage: string
  ): void {
    state.dirty = true;
    const message = newAssistantMessage(model);
    message.stopReason = 'aborted';
    message.errorMessage = errorMessage;
    stream.push({ type: 'error', reason: 'aborted', error: message });
    stream.end();
  }

  /** Last-resort terminal error for a stream whose turn crashed before start. */
  private endWithError(
    stream: AssistantMessageEventStream,
    state: SessionState,
    model: Model<Api>,
    error: unknown
  ): void {
    state.dirty = true;
    const classified = error instanceof AcpClientError ? error : classifyAcpError(error);
    const message = newAssistantMessage(model);
    message.stopReason = 'error';
    message.errorMessage = classified.message;
    stream.push({ type: 'error', reason: 'error', error: message });
    stream.end();
  }

  private anomaly(message: string): void {
    const sink = this.options.onAnomaly;
    if (sink) sink(message);
    else process.stderr.write(`pi-mistral-bridge: ${message}\n`);
  }
}

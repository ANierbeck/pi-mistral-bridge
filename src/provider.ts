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
 *   - `rebuild` → new ACP session, prompt = system prompt + HISTORY_PREAMBLE + renderTranscript;
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
 * - Dead turn (ADR-0010): a response that imitates a tool call as plain text
 *   and calls nothing gets exactly one fixed corrective prompt in the same
 *   ACP session (the corrective response continues the same Pi message, the
 *   session goes dirty); a second dead response ends with an `error` event
 *   and a visible `mistral-bridge:` feedback text.
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
import {
  HISTORY_PREAMBLE,
  findImitatedToolCallText,
  renderDelta,
  renderTranscript,
} from './transcript.ts';
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
  /**
   * Runtime capability observation (T7, ADR-0005): called with the API model
   * id and `usage_update.size` (the active model's context window) whenever a
   * provider session reports one. The model catalog caches it per API id and
   * re-registers the provider when a registered model's contextWindow changed
   * (src/models.ts `noteContextSize`).
   */
  onUsageContextSize?: ((apiId: string, contextSize: number) => void) | undefined;
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
  /** True once the dead-turn corrective prompt (ADR-0010) was sent. */
  correctiveSent: boolean;
  /** Content length already checked for imitated tool-call text (ADR-0010). */
  checkedContentLength: number;
}

/** The live ACP counterpart of one Pi session key. */
interface LiveTurn {
  key: string;
  state: SessionState;
  session: AcpSession;
  prompt: AcpPrompt;
  /**
   * Set once the Pi abort signal of this turn fired (attachAbort): a dead turn
   * that settles afterwards must not get the corrective retry (ADR-0010).
   */
  aborted: boolean;
  /** The streamSimple call currently receiving events. */
  current: TurnStream;
  /** The context messages of the current call (for recordSentPrefix). */
  contextMessages: readonly Message[];
  /**
   * Raw ACP events that arrived while `current` was already ended (parked):
   * they belong to the still-running prompt and are replayed into the next
   * attached stream by the continue branch — the delivered message of an
   * ended turn is never mutated.
   */
  pendingEvents: AcpSessionEvent[];
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
 * Fixed corrective prompt for a dead turn (ADR-0010): the model wrote tool
 * calls as literal text instead of calling them. Verbatim by contract —
 * stable, machine-matchable, carries no session content.
 */
const DEAD_TURN_CORRECTION_PROMPT =
  'Your last reply contained tool calls written as plain text instead of real tool calls. Re-issue them now as real tool calls through the tool-calling interface.';

/**
 * Fixed failure feedback when the response after the corrective prompt is
 * dead again (ADR-0010): end the turn as an explicit error instead of
 * silently delivering a dead message.
 */
const DEAD_TURN_FAILURE_TEXT =
  'mistral-bridge: the model wrote tool calls as plain text again after one corrective prompt; this turn ends as an error.';

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
  /** Hooks run by dispose() (e.g. abort an in-flight model discovery). */
  private readonly disposeHooks: Array<() => void> = [];

  constructor(options: MistralProviderOptions) {
    this.options = options;
    this.aliasByApiId = options.aliasByApiId ?? new Map();
  }

  /** True once dispose() ran; the extension entry checks this before registering. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Registers a hook that {@link dispose} runs (immediately when already
   * disposed). Used by the entry point to abort an in-flight model discovery
   * so its `vibe-acp` child is killed with the provider (AGENTS.md §15).
   */
  onDispose(hook: () => void): void {
    if (this.disposed) hook();
    else this.disposeHooks.push(hook);
  }

  /** Installs the discovery result (api id → alias) once discovery finished. */
  setAliasByApiId(aliasByApiId: ReadonlyMap<string, string>): void {
    this.aliasByApiId = aliasByApiId;
  }

  /**
   * The stable API model id of a Pi model: the registered id with the
   * `<provider>/` prefix stripped (ADR-0007: Pi model ids are
   * `<providerName>/<api id>`; the API id is the catalog/cache key).
   */
  modelApiIdFor(model: Model<Api>): string {
    const prefix = `${model.provider}/`;
    return model.id.startsWith(prefix) ? model.id.slice(prefix.length) : model.id;
  }

  /**
   * The Vibe model alias for a Pi model (pool key, ADR-0007): looked up in
   * the alias map by API id, so a volatile alias change between discoveries
   * re-routes existing Pi models without changing their ids.
   */
  modelAliasFor(model: Model<Api>): string {
    const apiId = this.modelApiIdFor(model);
    return this.aliasByApiId.get(apiId) ?? this.aliasByApiId.get(model.id) ?? apiId;
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

  /** `session_shutdown`: no orphaned processes, sockets, or hanging streams (AGENTS.md §15). */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const hook of this.disposeHooks.splice(0)) {
      try {
        hook();
      } catch {
        // a failing hook must not block the rest of the teardown
      }
    }
    // End every in-flight stream FIRST, so no caller is left waiting on a
    // stream whose consume loop may never run again after the teardown (the
    // child kill settles the prompt asynchronously — racing live.clear()).
    for (const live of this.live.values()) {
      const turn = live.current;
      if (!turn.ended) {
        this.endAborted(
          turn.stream,
          live.state,
          turn.message,
          'pi session ended (provider disposed)'
        );
        turn.ended = true;
      }
    }
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
      this.endAborted(stream, state, newAssistantMessage(model), 'aborted before the turn started');
      return;
    }

    if (decision.flow === 'continueToolResults') {
      const live = this.live.get(key);
      const batch = state.pendingToolBatch;
      if (!live || live.prompt.isSettled || !batch || batch.length === 0) {
        // decideFlow saw a pending batch, but the turn already ended (e.g. the
        // bridge's pre-emptive timeout answered it): rebuild instead of hanging
        await this.startRebuild(args, bridge, pool);
        return;
      }
      // attach the new stream to the still-running parked prompt
      const turnStream = this.newTurnStream(stream, model);
      live.current = turnStream;
      live.contextMessages = context.messages;
      stream.push({ type: 'start', partial: turnStream.message });
      // replay the events that arrived while the old turn was already parked:
      // they belong to this still-running prompt and must land in the new
      // stream (the old turn's delivered message is never touched again)
      for (const event of live.pendingEvents.splice(0)) this.handleAcpEvent(live, event, model);
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
      await this.startRebuild(args, bridge, pool);
      return;
    }

    await this.startRebuild(args, bridge, pool);
  }

  /** Rebuild flow: close the old ACP session, open a new one, prompt = system prompt + HISTORY_PREAMBLE + transcript. */
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
    pool: VibeProcessPool
  ): Promise<void> {
    const { model, context, stream, key, state, modelAlias, systemPrompt, options } = args;
    const existing = this.live.get(key);
    if (existing) {
      this.live.delete(key);
      // abandon the parked prompt: releaseParked answers all parked calls with
      // an error (they must not land in the new stream), then cancel() asks
      // Vibe to stop the prompt, then close() cleans up the ACP session
      // (AGENTS.md §15). This prevents a late tool call from the abandoned
      // turn being attributed to the new stream.
      const bridge = this.bridge as McpBridge;
      bridge.releaseParked('turn abandoned: steering or model switch (ADR-0003)');
      await existing.session.cancel().catch(() => {});
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
    // Frame the rebuilt history as a read-only log (HISTORY_PREAMBLE) so the
    // model does not imitate the past-tool-call records as text (real-run
    // finding after an abort-triggered rebuild, ADR-0003; record shape and
    // detection per ADR-0010).
    const promptText = systemPrompt
      ? `${systemPrompt}\n\n${HISTORY_PREAMBLE}\n\n${transcript}`
      : `${HISTORY_PREAMBLE}\n\n${transcript}`;
    let prompt: AcpPrompt;
    try {
      prompt = session.prompt(promptText);
    } catch (error) {
      // never leak the ACP session when the prompt cannot even start
      // (closed session / dead child): close it before propagating
      await session.close().catch(() => {});
      throw error;
    }
    this.startTurn(key, state, session, prompt, context.messages, stream, model, options?.signal);
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
      aborted: false,
      current: turnStream,
      contextMessages,
      pendingEvents: [],
    };
    this.live.set(key, live);
    stream.push({ type: 'start', partial: turnStream.message });
    this.attachAbort(live, state, signal);
    void this.consumeLoop(live, model).catch((error: unknown) => {
      // last resort: consumeLoop already handles per-prompt errors; a throw
      // from emit/finishTurn must never become an unhandled rejection nor
      // leave the returned stream open (AGENTS.md §15)
      live.state.dirty = true;
      const turn = live.current;
      if (!turn.ended) {
        turn.message.stopReason = 'error';
        turn.message.errorMessage = String(error);
        turn.stream.push({ type: 'error', reason: 'error', error: turn.message });
        turn.stream.end();
        turn.ended = true;
      }
      this.anomaly(`consumeLoop failed: ${String(error)}`);
    });
  }

  private newTurnStream(stream: AssistantMessageEventStream, model: Model<Api>): TurnStream {
    return {
      stream,
      message: newAssistantMessage(model),
      openText: null,
      openThinking: null,
      ended: false,
      correctiveSent: false,
      checkedContentLength: 0,
    };
  }

  /** Abort: `session/cancel` (watchdog inside acp-client) + dirty (ADR-0003). */
  private attachAbort(live: LiveTurn, state: SessionState, signal: AbortSignal | undefined): void {
    if (!signal) return;
    const onAbort = (): void => {
      live.aborted = true;
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

  /**
   * Consumes ACP prompts to their end, routing events to the current stream.
   * A dead turn (ADR-0010) re-prompts the same ACP session exactly once.
   */
  private async consumeLoop(live: LiveTurn, model: Model<Api>): Promise<void> {
    for (;;) {
      let outcome: PromptResult | null = null;
      let failure: unknown = null;
      try {
        for await (const event of live.prompt) this.handleAcpEvent(live, event, model);
        outcome = await live.prompt.result();
      } catch (error) {
        failure = error;
      }
      // A stale loop — its LiveTurn was replaced in the map by a newer turn
      // (steering / model-switch rebuild) — must not finishTurn: it could null
      // the new turn's pendingToolBatch or overwrite recordSentPrefix. The map
      // identity is the guard; `live.prompt` may have been reassigned by the
      // dead-turn corrective retry (ADR-0010) below, so comparing prompts
      // would not identify a stale loop.
      if (this.live.get(live.key) !== live) return;
      if (!this.finishTurn(live, model, outcome, failure)) return;
      // Dead turn (ADR-0010): finishTurn asked for the one corrective prompt
      try {
        live.prompt = live.session.prompt(DEAD_TURN_CORRECTION_PROMPT);
      } catch (error) {
        // sending the corrective prompt failed: end the turn like any prompt
        // failure
        this.finishTurn(live, model, null, error);
        return;
      }
    }
  }

  private handleAcpEvent(live: LiveTurn, event: AcpSessionEvent, model: Model<Api>): void {
    const turn = live.current;
    if (turn.ended) {
      // The terminal event (toolUse park / done / error) was already pushed:
      // the delivered message must never be mutated afterwards. Park the raw
      // event; the continue branch replays it into the next attached stream.
      live.pendingEvents.push(event);
      return;
    }
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
        // `usage_update.size` is the active model's context window (ADR-0005
        // capability source): feed it to the model catalog, cached per API id
        // (T7, src/models.ts noteContextSize)
        if (event.contextSize !== undefined) {
          this.options.onUsageContextSize?.(this.modelApiIdFor(model), event.contextSize);
        }
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
    live.current.stream.push(event);
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
      // No running prompt to attach the batch to (e.g. a late call after the
      // batch was already emitted and answered, or after a steering rebuild
      // released the parked calls). The calls stay parked in the bridge and
      // are answered by the pre-emptive tool timeout (toolPreTimeoutMs, ~55 s
      // against Vibe's 60 s per-turn budget, ADR-0006) — never left hanging.
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

  /**
   * Maps a settled ACP prompt onto the Pi turn: usage/stopReason and the
   * done event, or the failure path. Returns true only for a dead turn
   * (ADR-0010) whose one corrective prompt has not been sent yet.
   */
  private finishTurn(
    live: LiveTurn,
    model: Model<Api>,
    outcome: PromptResult | null,
    failure: unknown
  ): boolean {
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
          this.endAborted(turn.stream, state, turn.message, error.message);
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
      return false;
    }

    const result = outcome as PromptResult;
    if (result.stopReason === 'cancelled') {
      state.dirty = true;
      if (!turn.ended) this.endAborted(turn.stream, state, turn.message, 'prompt was cancelled');
      return false;
    }
    if (!turn.ended) {
      // a parked turn's delivered message is frozen: usage/stopReason are only
      // written while the turn is still open. The usage is recorded before
      // the dead-turn check (ADR-0010) so dead and dead-again endings keep the
      // token accounting of the most recent ACP result: a corrective response
      // overwrites the dead one, a second dead response leaves its own.
      turn.message.usage = result.usage;
      // Dead turn (ADR-0010): the response imitated a tool call as plain text
      // and called nothing — recover once, then fail explicitly. Only blocks
      // added since the last settle are checked: the first dead response's
      // text stays in the message after the corrective retry, and a healthy
      // corrective response must not read as a second dead one.
      const fresh = turn.message.content.slice(turn.checkedContentLength);
      turn.checkedContentLength = turn.message.content.length;
      if (findImitatedToolCallText(fresh)) {
        // aborted meanwhile (before the first or during the corrective
        // response): end the turn aborted — no corrective prompt, no failure
        // text; the abort contract wins over the dead-turn feedback
        if (live.aborted) {
          this.endAborted(turn.stream, state, turn.message, 'aborted before the corrective retry');
          turn.ended = true;
          return false;
        }
        return this.handleDeadTurn(live);
      }
      if (live.aborted) {
        // the abort landed while the prompt was settling normally: Pi's abort
        // contract wins over a late `done`
        this.endAborted(turn.stream, state, turn.message, 'aborted before the prompt completed');
      } else {
        const mapped = mapStopReason(result.stopReason);
        turn.message.stopReason = mapped.reason;
        if (mapped.rawStopReason !== undefined) turn.message.rawStopReason = mapped.rawStopReason;
        turn.stream.push({ type: 'done', reason: mapped.reason, message: turn.message });
        turn.stream.end();
      }
      turn.ended = true;
    }
    recordSentPrefix(state, [...live.contextMessages, turn.message]);
    return false;
  }

  /**
   * A dead turn (ADR-0010): the response imitated a tool call as plain text
   * and called nothing. The first dead response sends exactly one corrective
   * prompt into the same ACP session — its response continues the same Pi
   * stream — and marks the session dirty: the ACP side saw an exchange Pi's
   * history does not represent, so the next turn rebuilds (ADR-0003). A
   * second dead response gets no further prompt: the turn ends as an
   * explicit error with visible feedback, mirroring finishTurn's failure
   * path. Returns true when consumeLoop must send the corrective prompt.
   */
  private handleDeadTurn(live: LiveTurn): boolean {
    const turn = live.current;
    const state = live.state;
    state.dirty = true;
    live.session.markDirty();
    if (turn.correctiveSent) {
      // explicit failure feedback (ADR-0010): visible text block + error event
      turn.message.content.push({ type: 'text', text: '' });
      turn.openText = turn.message.content.length - 1;
      this.emit(live, {
        type: 'text_start',
        contentIndex: turn.openText,
        partial: turn.message,
      });
      const block = turn.message.content[turn.openText];
      if (block?.type === 'text') block.text += DEAD_TURN_FAILURE_TEXT;
      this.emit(live, {
        type: 'text_delta',
        contentIndex: turn.openText,
        delta: DEAD_TURN_FAILURE_TEXT,
        partial: turn.message,
      });
      this.closeText(live);
      turn.message.stopReason = 'error';
      turn.message.errorMessage = DEAD_TURN_FAILURE_TEXT;
      turn.stream.push({ type: 'error', reason: 'error', error: turn.message });
      turn.stream.end();
      turn.ended = true;
      recordSentPrefix(state, [...live.contextMessages, turn.message]);
      return false;
    }
    turn.correctiveSent = true;
    return true;
  }

  /**
   * Terminal `error` event with `aborted` (Pi's abort contract). Carries the
   * partial turn message when one exists, so content streamed before the
   * abort is preserved; a fresh empty message is only used when the turn
   * never started.
   */
  private endAborted(
    stream: AssistantMessageEventStream,
    state: SessionState,
    message: AssistantMessage,
    errorMessage: string
  ): void {
    state.dirty = true;
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

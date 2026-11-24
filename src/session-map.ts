/**
 * Pi-session → ACP-session map and the turn-flow state machine (ADR-0003,
 * implementation plan T5 slice B). Pure: no ACP, no I/O — the provider
 * (src/provider.ts) holds the live `AcpSession`/`McpBridge` objects and only
 * consults this module for the decision.
 *
 * Key derivation ({@link sessionKey}): Pi's agent loop passes its session id
 * in the provider call options (`options.sessionId`), which is the primary
 * key. Callers that omit it (direct `streamSimple` uses such as summaries or
 * subagents) are keyed by a content hash of the system prompt + the first
 * user message, so two different conversations never share an ACP session
 * and the same conversation start does.
 *
 * Flow decision ({@link decideFlow}), given the recorded state and the
 * current Pi context:
 *
 * - `continueToolResults` — a tool batch is pending and the trailing messages
 *   are exactly the `toolResult`s answering its callIds: deliver them to the
 *   MCP bridge and keep streaming the SAME parked ACP prompt (ADR-0002).
 * - `delta` — the digest of the first `sentCount` messages still matches
 *   `digestOfSentPrefix` and only new user message(s) follow: send just
 *   {@link renderDelta} of them (ADR-0003).
 * - `rebuild` — anything else (no session yet, dirty after abort/crash/
 *   steering, model switch, changed system prompt, edited/compacted history):
 *   new ACP session, prompt = system prompt + transcript (ADR-0003).
 */
import { createHash } from 'node:crypto';
import type { Message, ToolResultMessage } from '@earendil-works/pi-ai';
import type { ParkedCall } from './mcp-bridge.ts';
import { digestMessages } from './transcript.ts';

/** Recorded state of one Pi session's ACP counterpart. */
export interface SessionState {
  /** ACP session id of the live session; null before the first one is created. */
  acpSessionId: string | null;
  /** Model alias the ACP session runs (process-pool key, ADR-0007). */
  modelAlias: string;
  /** {@link digestMessages} of the message prefix the ACP session has seen. */
  digestOfSentPrefix: string;
  /** Length of that prefix (context messages + the assistant message emitted last turn). */
  sentCount: number;
  /** sha256 of the system prompt the session was built with; a change forces a rebuild. */
  systemPromptDigest: string | null;
  /** Parked Pi tool batch awaiting toolResults (bridge callIds), null when none. */
  pendingToolBatch: readonly ParkedCall[] | null;
  /** True after an abort/crash/steering — the next turn must rebuild (ADR-0003). */
  dirty: boolean;
}

/** The three turn flows of ADR-0003. */
export type FlowDecision =
  | { flow: 'continueToolResults'; results: readonly ToolResultMessage[] }
  | { flow: 'delta'; newMessages: readonly Message[] }
  | { flow: 'rebuild'; reason: string };

export interface DecideFlowInput {
  /** The Pi context messages of this streamSimple call. */
  messages: readonly Message[];
  /** Model alias this call routes to (pool key, ADR-0007). */
  modelAlias: string;
  /** Current effective system prompt. */
  systemPrompt: string;
}

/** Fresh state for a Pi session (no ACP session yet). */
export function createSessionState(modelAlias: string): SessionState {
  return {
    acpSessionId: null,
    modelAlias,
    digestOfSentPrefix: '',
    sentCount: 0,
    systemPromptDigest: null,
    pendingToolBatch: null,
    dirty: false,
  };
}

/** sha256 hex of an arbitrary string (system prompts, fallback session keys). */
export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Records what the ACP session has now seen after a prompt completed: the
 * context messages of the call plus the assistant message the provider
 * emitted (Pi appends it right after streamSimple returns).
 */
export function recordSentPrefix(state: SessionState, sentMessages: readonly Message[]): void {
  state.sentCount = sentMessages.length;
  state.digestOfSentPrefix = digestMessages(sentMessages);
}

function isToolResult(message: Message): message is ToolResultMessage {
  return message.role === 'toolResult';
}

/**
 * Decides the flow for one `streamSimple` call (ADR-0003). See the module
 * doc for the branch order; every branch is unit-tested in
 * test/session-map.test.ts.
 */
export function decideFlow(state: SessionState, input: DecideFlowInput): FlowDecision {
  const rebuild = (reason: string): FlowDecision => ({ flow: 'rebuild', reason });

  if (state.dirty) return rebuild('session is dirty (abort/crash/steering) — rebuild (ADR-0003)');
  if (state.acpSessionId === null) return rebuild('no ACP session yet');
  if (input.modelAlias !== state.modelAlias) {
    return rebuild(`model switch ${state.modelAlias} -> ${input.modelAlias} (ADR-0007)`);
  }
  if (state.systemPromptDigest !== hashText(input.systemPrompt)) {
    return rebuild('system prompt changed (ADR-0003)');
  }

  // A parked tool batch must be answered exactly by trailing toolResults;
  // anything else (e.g. a steering user message while tools are parked) is a
  // rebuild (ADR-0003: steering aborts the prompt and forces a rebuild).
  const batch = state.pendingToolBatch;
  if (batch && batch.length > 0) {
    const n = batch.length;
    const results = input.messages.slice(-n);
    const batchIds = new Set(batch.map((call) => call.callId));
    const answered =
      results.length === n &&
      results.every(isToolResult) &&
      new Set(results.map((r) => r.toolCallId)).size === n &&
      results.every((r) => batchIds.has(r.toolCallId)) &&
      input.messages.length - n === state.sentCount &&
      digestMessages(input.messages.slice(0, input.messages.length - n)) ===
        state.digestOfSentPrefix;
    if (answered) return { flow: 'continueToolResults', results };
    return rebuild(
      'pending tool batch not answered exactly by trailing toolResults (steering/divergence)'
    );
  }

  // Delta: the sent prefix is unchanged and only new user message(s) follow.
  if (
    input.messages.length > state.sentCount &&
    digestMessages(input.messages.slice(0, state.sentCount)) === state.digestOfSentPrefix &&
    input.messages.slice(state.sentCount).every((m) => m.role === 'user')
  ) {
    return { flow: 'delta', newMessages: input.messages.slice(state.sentCount) };
  }

  return rebuild(
    'history diverged from the sent prefix (edit/compaction/fork) — rebuild (ADR-0003)'
  );
}

// ------------------------------------------------------------------ session key

export interface SessionKeyOptions {
  /** Pi session id from the provider call options, when the caller passes one. */
  sessionId?: string | undefined;
}

/**
 * The map key for one Pi session: `options.sessionId` when the agent loop
 * provides it, otherwise a sha256 over the system prompt + the first user
 * message (content-canonical, so regenerated ids/timestamps do not matter).
 */
export function sessionKey(
  options: SessionKeyOptions | undefined,
  messages: readonly Message[],
  systemPrompt: string
): string {
  if (options?.sessionId) return options.sessionId;
  const firstUser = messages.find((m) => m.role === 'user');
  return hashText(`${hashText(systemPrompt)}\n${firstUser ? digestMessages([firstUser]) : ''}`);
}

/** Map of Pi-session key → {@link SessionState} (one entry per Pi session). */
export class SessionMap {
  private readonly states = new Map<string, SessionState>();

  get size(): number {
    return this.states.size;
  }

  /** The state for `key`, created (with `modelAlias`) on first use. */
  get(key: string, modelAlias: string): SessionState {
    let state = this.states.get(key);
    if (!state) {
      state = createSessionState(modelAlias);
      this.states.set(key, state);
    }
    return state;
  }

  delete(key: string): void {
    this.states.delete(key);
  }

  clear(): void {
    this.states.clear();
  }
}

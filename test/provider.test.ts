// Unit tests for src/provider.ts (T5 slice C1): provider-mode `streamSimple`
// orchestration (ADR-0002/0003). The ACP side runs against the shared in-process
// fake ACP agent (test/helpers/fake-acp-agent.ts, AGENTS.md §4: no real
// vibe-acp); the MCP side is the REAL loopback bridge with a real MCP client
// playing Vibe's role (parallel tool calls arrive as one batch, ADR-0006).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import * as acp from '@agentclientprotocol/sdk';
import {
  createAssistantMessageEventStream,
  normalizeContext,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Message,
  type Model,
  type Tool,
  type ToolResultMessage,
  type UserMessage,
} from '@earendil-works/pi-ai';
import type { BridgeConfig } from '../src/config.ts';
import { QUOTA_ERROR_PREFIX, AUTH_ERROR_HINT } from '../src/acp-client.ts';
import { createMcpBridge, type CreateMcpBridgeOptions, type McpBridge } from '../src/mcp-bridge.ts';
import { MistralProvider } from '../src/provider.ts';
import { PROMPT_RESPONSE_USAGE, TOOL_CALL_META_TOOL_NAME, VIBE_ENV } from '../src/vibe-protocol.ts';
import {
  makeFakeSpawn,
  sendUpdate,
  type FakeBehavior,
  type FakeSpawnHarness,
  type PromptScript,
} from './helpers/fake-acp-agent.ts';

const CWD = mkdtempSync(join(tmpdir(), 'pi-mistral-bridge-provider-cwd-'));
const LOG_DIR = mkdtempSync(join(tmpdir(), 'pi-mistral-bridge-provider-logs-'));

const CONFIG: BridgeConfig = {
  vibeAcpPath: 'vibe-acp',
  providerName: 'mistral-vibe',
  askVibe: { enabled: false, defaultMode: 'ask', autoApprove: false },
  debug: false,
  processIdleTimeoutMs: 600_000,
  toolPreTimeoutMs: 1_500,
  abortWatchdogMs: 5_000,
  discoveryTimeoutMs: 30_000,
};

// The Pi model registered from the discovered API id; the alias is the
// volatile `value` of the `model` config option (ADR-0005/0007). Tests may use
// model literals freely (AGENTS.md §9).
const MODEL: Model<Api> = {
  id: 'devstral-small-latest',
  name: 'Devstral Small',
  api: 'mistral-vibe-acp',
  provider: 'mistral-vibe',
  baseUrl: 'vibe-acp',
  input: ['text'],
  reasoning: false,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
};

const ALIAS_BY_API_ID = new Map([
  ['devstral-small-latest', 'devstral-small'],
  ['mistral-medium-3.5', 'mistral-medium-3.5'],
]);

/** A second Pi model routing to a different Vibe alias (pool key, ADR-0007). */
const MODEL2: Model<Api> = {
  ...MODEL,
  id: 'mistral-medium-3.5',
  name: 'Mistral Medium 3.5',
};

const TOOLS: Tool[] = [
  {
    name: 'echo',
    description: 'Echo text back',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
];

const SYSTEM_PROMPT = 'You are a helpful assistant.';

/** Captured result of a parked MCP call. */
interface ParkedResult {
  isError: boolean | undefined;
  text: string | undefined;
}

/** A second Pi tool so a batch can contain two different parked calls. */
const READ_TOOL: Tool = {
  name: 'read',
  description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
};

const ts = 1_700_000_000_000;

function user(content: UserMessage['content']): UserMessage {
  return { role: 'user', content, timestamp: ts };
}

function toolResult(toolCallId: string, toolName: string, text: string): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName,
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: ts,
  };
}

function contextOf(messages: Message[], tools: Tool[] = TOOLS) {
  return normalizeContext({ systemPrompt: SYSTEM_PROMPT, messages, tools });
}

// ------------------------------------------------------------------- harness

interface ProviderHarness {
  provider: MistralProvider;
  fake: FakeSpawnHarness;
  anomalies: string[];
  bridge: () => McpBridge;
  bridgeCount: () => number;
  mcpClient: () => Promise<Client>;
  prompts: () => Array<{ method: string; params: any }>;
  sessionNews: () => number;
}

const bridges: McpBridge[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const bridge of bridges.splice(0)) await bridge.close().catch(() => {});
});

function makeProvider(behavior: FakeBehavior = {}): ProviderHarness {
  const fake = makeFakeSpawn(behavior);
  const anomalies: string[] = [];
  let bridge: McpBridge | null = null;
  let bridgeCount = 0;
  let client: Client | null = null;
  const provider = new MistralProvider({
    config: CONFIG,
    cwd: CWD,
    aliasByApiId: ALIAS_BY_API_ID,
    spawnChild: fake.spawnChild,
    onAnomaly: (message) => anomalies.push(message),
    logDir: LOG_DIR,
    createBridge: async (options: CreateMcpBridgeOptions) => {
      bridgeCount += 1;
      bridge = await createMcpBridge({ batchWindowMs: 30, ...options });
      bridges.push(bridge);
      return bridge;
    },
  });
  return {
    provider,
    fake,
    anomalies,
    bridge: () => {
      if (!bridge) throw new Error('bridge not created yet');
      return bridge;
    },
    bridgeCount: () => bridgeCount,
    mcpClient: async () => {
      if (!client) {
        const b = bridge!;
        const transport = new StreamableHTTPClientTransport(new URL(b.url), {
          requestInit: { headers: { Authorization: `Bearer ${b.token}` } },
        });
        client = new Client({ name: 'fake-vibe-mcp', version: '0.0.0' }, { capabilities: {} });
        await client.connect(transport);
        clients.push(client);
      }
      return client;
    },
    prompts: () =>
      fake.agents.flatMap((a) => a.recorded).filter((r) => r.method === 'session/prompt'),
    sessionNews: () =>
      fake.agents.reduce(
        (n, a) => n + a.recorded.filter((r) => r.method === 'session/new').length,
        0
      ),
  };
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(5);
  }
}

async function collectStream(
  stream: AssistantMessageEventStream
): Promise<{ types: string[]; events: AssistantMessageEvent[]; message: AssistantMessage }> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return { types: events.map((e) => e.type), events, message: await stream.result() };
}

/** A plain text turn: thinking + two text chunks + usage, then end_turn. */
const textTurnScript: PromptScript = async (params, agent) => {
  const sessionId = params.sessionId;
  await sendUpdate(agent, sessionId, {
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'let me think' },
  });
  await sendUpdate(agent, sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Hello' },
  });
  await sendUpdate(agent, sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: ' world' },
  });
  await sendUpdate(agent, sessionId, {
    sessionUpdate: 'usage_update',
    used: 100,
    size: 200_000,
    cost: { amount: 0.001, currency: 'USD' },
    _meta: { promptTokens: 80, completionTokens: 20, cachedTokens: 5, totalTokens: 105, steps: 2 },
  });
  return {
    stopReason: 'end_turn',
    [PROMPT_RESPONSE_USAGE]: {
      totalTokens: 105,
      inputTokens: 80,
      outputTokens: 20,
      cachedReadTokens: 5,
    },
  };
};

/** Emits one bridge tool call update (the ACP-side view of a Pi tool call). */
async function sendToolCallUpdate(
  agent: acp.AgentContext,
  sessionId: string,
  toolCallId: string,
  args: unknown
): Promise<void> {
  await sendUpdate(agent, sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId,
    title: 'mcp_pi.pi__echo',
    status: 'in_progress',
    rawInput: args,
    _meta: { [TOOL_CALL_META_TOOL_NAME]: 'mcp_pi.pi__echo', effect_kind: 'tool' },
  });
}

// --------------------------------------------------------------------- tests

describe('MistralProvider.streamSimple: text turn + delta reuse (ADR-0003)', () => {
  it('rebuilds on first call (system prompt + transcript), streams text/thinking, reports usage with cost 0, then reuses the ACP session for a delta', async () => {
    const h = makeProvider({ promptScript: textTurnScript });
    try {
      // --- first turn: rebuild ---
      const stream1 = h.provider.streamSimple(MODEL, contextOf([user('hi')]), {
        sessionId: 'pi-1',
      });
      const first = await collectStream(stream1);

      expect(first.types).toEqual([
        'start',
        'thinking_start',
        'thinking_delta',
        'thinking_end',
        'text_start',
        'text_delta',
        'text_delta',
        'text_end',
        'done',
      ]);
      expect(first.message.stopReason).toBe('stop');
      expect(first.message.content).toEqual([
        { type: 'thinking', thinking: 'let me think' },
        { type: 'text', text: 'Hello world' },
      ]);
      // usage from the ACP side incl. cached tokens; cost forced to 0 (ADR-0003)
      expect(first.message.usage).toEqual({
        input: 80,
        output: 20,
        cacheRead: 5,
        cacheWrite: 0,
        totalTokens: 105,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      });

      // one ACP session, spawned with the model alias from the alias map
      expect(h.sessionNews()).toBe(1);
      expect(h.fake.spawns[0].env[VIBE_ENV.ACTIVE_MODEL]).toBe('devstral-small');
      const prompt1 = h.prompts()[0].params;
      expect(prompt1.prompt).toHaveLength(1);
      expect(prompt1.prompt[0].type).toBe('text');
      // rebuild prompt = system prompt + rendered transcript (ADR-0003)
      expect(prompt1.prompt[0].text).toContain(SYSTEM_PROMPT);
      expect(prompt1.prompt[0].text).toContain('[user]\nhi');

      // Pi tools were pushed into the bridge before the prompt
      const client = await h.mcpClient();
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name)).toEqual(['pi__echo']);

      // --- second turn: delta on the SAME ACP session ---
      const assistant1 = first.message;
      const stream2 = h.provider.streamSimple(
        MODEL,
        contextOf([user('hi'), assistant1, user('again')]),
        { sessionId: 'pi-1' }
      );
      const second = await collectStream(stream2);
      expect(second.types).toEqual([
        'start',
        'thinking_start',
        'thinking_delta',
        'thinking_end',
        'text_start',
        'text_delta',
        'text_delta',
        'text_end',
        'done',
      ]);
      expect(second.message.stopReason).toBe('stop');
      // still one ACP session, but a second prompt carrying ONLY the new message
      expect(h.sessionNews()).toBe(1);
      expect(h.prompts()).toHaveLength(2);
      expect(h.prompts()[1].params.prompt[0].text).toBe('again');
    } finally {
      await h.provider.dispose();
    }
  });
});

describe('MistralProvider.streamSimple: tool turn (park/resume, ADR-0002)', () => {
  it('parks the MCP batch as Pi toolCalls (stopReason toolUse, ACP prompt stays open), delivers toolResults on the next call and streams the continuation on the same ACP session', async () => {
    const h = makeProvider({
      promptScript: async (params, agent) => {
        const sessionId = params.sessionId;
        await sendUpdate(agent, sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Calling tool' },
        });
        await sendToolCallUpdate(agent, sessionId, 'effect-1', { text: 'hi' });
        // Vibe's role: call the bridge MCP tool; the HTTP call parks until the
        // provider delivers the Pi tool result on the next streamSimple call
        const client = await h.mcpClient();
        const pending = client.callTool({ name: 'pi__echo', arguments: { text: 'hi' } });
        const result = (await pending) as { content: Array<{ type: string; text?: string }> };
        await sendUpdate(agent, sessionId, {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'effect-1',
          status: 'completed',
          rawOutput: { type: 'success', content: result.content },
        });
        await sendUpdate(agent, sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'done after tool' },
        });
        return { stopReason: 'end_turn' };
      },
    });
    try {
      const stream1 = h.provider.streamSimple(MODEL, contextOf([user('run the tool')]), {
        sessionId: 'pi-1',
      });
      const first = await collectStream(stream1);

      // the batch became one Pi toolCall block; the stream ended with toolUse
      // while the ACP prompt stayed parked
      expect(first.types).toEqual([
        'start',
        'text_start',
        'text_delta',
        'text_end',
        'toolcall_start',
        'toolcall_end',
        'done',
      ]);
      expect(first.message.stopReason).toBe('toolUse');
      const toolCalls = first.message.content.filter((b) => b.type === 'toolCall');
      expect(toolCalls).toHaveLength(1);
      const call = toolCalls[0];
      if (call.type !== 'toolCall') throw new Error('unreachable');
      // bridge callId as the tool-call id, Pi tool name without the pi__ prefix, parsed args
      expect(call.id).toMatch(/^[0-9a-f]{64}$/);
      expect(call.name).toBe('echo');
      expect(call.arguments).toEqual({ text: 'hi' });
      expect(h.prompts()).toHaveLength(1);

      // --- Pi executed the tool; next streamSimple delivers the toolResult ---
      const stream2 = h.provider.streamSimple(
        MODEL,
        contextOf([
          user('run the tool'),
          first.message,
          toolResult(call.id, 'echo', 'tool output'),
        ]),
        { sessionId: 'pi-1' }
      );
      const second = await collectStream(stream2);

      expect(second.types).toEqual(['start', 'text_start', 'text_delta', 'text_end', 'done']);
      expect(second.message.stopReason).toBe('stop');
      expect(second.message.content).toEqual([{ type: 'text', text: 'done after tool' }]);
      // continuation: NO new ACP session and NO new prompt — the parked one resumed
      expect(h.sessionNews()).toBe(1);
      expect(h.prompts()).toHaveLength(1);
    } finally {
      await h.provider.dispose();
    }
  });

  it('handles parallel tool calls in one batch (ADR-0006)', async () => {
    const h = makeProvider({
      promptScript: async (params, agent) => {
        const sessionId = params.sessionId;
        await sendToolCallUpdate(agent, sessionId, 'effect-a', { text: 'a' });
        await sendToolCallUpdate(agent, sessionId, 'effect-b', { text: 'b' });
        const client = await h.mcpClient();
        const results = await Promise.all([
          client.callTool({ name: 'pi__echo', arguments: { text: 'a' } }),
          client.callTool({ name: 'pi__echo', arguments: { text: 'b' } }),
        ]);
        const texts = results.map(
          (r) => (r as { content: Array<{ text?: string }> }).content[0].text
        );
        await sendUpdate(agent, sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `both done: ${texts.join(',')}` },
        });
        return { stopReason: 'end_turn' };
      },
    });
    try {
      const stream1 = h.provider.streamSimple(MODEL, contextOf([user('two tools')]), {
        sessionId: 'pi-1',
      });
      const first = await collectStream(stream1);
      expect(first.message.stopReason).toBe('toolUse');
      const calls = first.message.content.filter((b) => b.type === 'toolCall');
      expect(calls).toHaveLength(2);
      const ids = calls.map((c) => (c.type === 'toolCall' ? c.id : ''));
      expect(new Set(ids).size).toBe(2);
      expect(calls.map((c) => (c.type === 'toolCall' ? c.arguments : null))).toEqual([
        { text: 'a' },
        { text: 'b' },
      ]);

      // answer both in one continuation call
      const stream2 = h.provider.streamSimple(
        MODEL,
        contextOf([
          user('two tools'),
          first.message,
          toolResult(ids[0], 'echo', 'A'),
          toolResult(ids[1], 'echo', 'B'),
        ]),
        { sessionId: 'pi-1' }
      );
      const second = await collectStream(stream2);
      expect(second.message.stopReason).toBe('stop');
      expect(second.message.content).toEqual([{ type: 'text', text: 'both done: A,B' }]);
      expect(h.sessionNews()).toBe(1);
      expect(h.prompts()).toHaveLength(1);
    } finally {
      await h.provider.dispose();
    }
  });
});

describe('MistralProvider.streamSimple: divergence and abort rebuild (ADR-0003)', () => {
  it('rebuilds with the full transcript when the history diverges from the sent prefix', async () => {
    const h = makeProvider({ promptScript: textTurnScript });
    try {
      const stream1 = h.provider.streamSimple(MODEL, contextOf([user('hi')]), {
        sessionId: 'pi-1',
      });
      const first = await collectStream(stream1);
      expect(h.sessionNews()).toBe(1);

      // the first user message was edited → prefix digest mismatch → rebuild
      const stream2 = h.provider.streamSimple(
        MODEL,
        contextOf([user('hello edited'), first.message, user('again')]),
        { sessionId: 'pi-1' }
      );
      const second = await collectStream(stream2);
      expect(second.message.stopReason).toBe('stop');
      expect(h.sessionNews()).toBe(2); // fresh ACP session
      expect(h.prompts()).toHaveLength(2);
      const prompt2 = h.prompts()[1].params.prompt[0].text as string;
      expect(prompt2).toContain('[user]\nhello edited');
      expect(prompt2).toContain('[user]\nagain');
      expect(prompt2).toContain(SYSTEM_PROMPT);
    } finally {
      await h.provider.dispose();
    }
  });

  it('abort mid-turn: the aborted message keeps the partial content streamed before the abort', async () => {
    const h = makeProvider({
      promptScript: async (params, agent) => {
        const sessionId = params.sessionId;
        await sendUpdate(agent, sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'partial answer' },
        });
        // hang until session/cancel resolves the prompt as cancelled
        return new Promise((resolve) => {
          h.fake.behavior.onCancel = () => resolve({ stopReason: 'cancelled' });
        });
      },
    });
    try {
      const controller = new AbortController();
      const stream = h.provider.streamSimple(MODEL, contextOf([user('long turn')]), {
        sessionId: 'pi-1',
        signal: controller.signal,
      });
      const events: AssistantMessageEvent[] = [];
      const done = (async () => {
        for await (const event of stream) events.push(event);
        return stream.result();
      })();
      await waitFor(() => h.prompts().length === 1, 'prompt start');
      await waitFor(
        () => events.some((e) => e.type === 'text_delta' && e.delta === 'partial answer'),
        'partial text delivered'
      );
      controller.abort();
      const message = await done;
      expect(message.stopReason).toBe('aborted');
      expect(message.errorMessage).toBeTruthy();
      // the partial content streamed before the abort is preserved on the
      // aborted message, not replaced by a fresh empty one
      expect(message.content).toEqual([{ type: 'text', text: 'partial answer' }]);
    } finally {
      await h.provider.dispose();
    }
  });

  it('abort: session/cancel + stopReason aborted, session dirty, next call rebuilds', async () => {
    const h = makeProvider({
      promptScript: () =>
        new Promise((resolve) => {
          // the prompt settles only when session/cancel arrives (fake answers cancelled)
          h.fake.behavior.onCancel = () => resolve({ stopReason: 'cancelled' });
        }),
    });
    try {
      const controller = new AbortController();
      const stream = h.provider.streamSimple(MODEL, contextOf([user('long turn')]), {
        sessionId: 'pi-1',
        signal: controller.signal,
      });
      await waitFor(() => h.prompts().length === 1, 'prompt start');
      controller.abort();
      const result = await collectStream(stream);

      expect(result.types).toEqual(['start', 'error']);
      const errorEvent = result.events[1];
      if (errorEvent.type !== 'error') throw new Error('unreachable');
      expect(errorEvent.reason).toBe('aborted');
      expect(result.message.stopReason).toBe('aborted');
      expect(result.message.errorMessage).toBeTruthy();
      // the provider sent session/cancel to the ACP session
      const cancels = h.fake.agents[0].recorded.filter((r) => r.method === 'session/cancel');
      expect(cancels).toHaveLength(1);

      // the session is dirty → the next call rebuilds (new ACP session);
      // the fake answers the rebuilt prompt immediately
      h.fake.behavior.promptScript = async () => ({ stopReason: 'end_turn' });
      const stream2 = h.provider.streamSimple(
        MODEL,
        contextOf([user('long turn'), user('retry')]),
        {
          sessionId: 'pi-1',
        }
      );
      const second = await collectStream(stream2);
      expect(second.message.stopReason).toBe('stop');
      expect(h.sessionNews()).toBe(2);
    } finally {
      await h.provider.dispose();
    }
  });
});

describe('MistralProvider.streamSimple: error surfaces', () => {
  it('quota/429 errors carry the stable prefix (ADR-0002)', async () => {
    const h = makeProvider({
      promptScript: async () => {
        throw new acp.RequestError(-32000, 'HTTP 429: Mistral quota exceeded, retry later');
      },
    });
    try {
      const stream = h.provider.streamSimple(MODEL, contextOf([user('hi')]), { sessionId: 'pi-1' });
      const result = await collectStream(stream);
      expect(result.types).toEqual(['start', 'error']);
      const errorEvent = result.events[1];
      if (errorEvent.type !== 'error') throw new Error('unreachable');
      expect(errorEvent.reason).toBe('error');
      expect(result.message.stopReason).toBe('error');
      expect(result.message.errorMessage).toBeTruthy();
      expect(result.message.errorMessage!.startsWith(QUOTA_ERROR_PREFIX)).toBe(true);
    } finally {
      await h.provider.dispose();
    }
  });

  it('auth errors point at vibe-acp --setup (Vibe owns authentication, AGENTS.md §14)', async () => {
    const h = makeProvider({
      promptScript: async () => {
        throw acp.RequestError.authRequired('not signed in');
      },
    });
    try {
      const stream = h.provider.streamSimple(MODEL, contextOf([user('hi')]), { sessionId: 'pi-1' });
      const result = await collectStream(stream);
      expect(result.types).toEqual(['start', 'error']);
      expect(result.message.errorMessage).toContain(AUTH_ERROR_HINT);
    } finally {
      await h.provider.dispose();
    }
  });
});

describe('MistralProvider.streamSimple: turn scope of the bridge de-dup cache (ADR-0006)', () => {
  it('does not reuse a cached tool result across tool rounds: an identical call in a later round parks again (new turn scope) and gets the new result', async () => {
    const h = makeProvider({
      promptScript: async (params, agent) => {
        const sessionId = params.sessionId;
        const client = await h.mcpClient();
        // round 1: parks, becomes the Pi toolCall of the first stream
        await sendToolCallUpdate(agent, sessionId, 'effect-1', { text: 'same' });
        const r1 = (await client.callTool({
          name: 'pi__echo',
          arguments: { text: 'same' },
        })) as { content: Array<{ text?: string }> };
        await sendUpdate(agent, sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `round1:${r1.content[0].text}` },
        });
        // round 2: identical args, but the NEXT Pi tool round — must park again
        await sendToolCallUpdate(agent, sessionId, 'effect-2', { text: 'same' });
        const r2 = (await client.callTool({
          name: 'pi__echo',
          arguments: { text: 'same' },
        })) as { content: Array<{ text?: string }> };
        await sendUpdate(agent, sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: ` round2:${r2.content[0].text}` },
        });
        return { stopReason: 'end_turn' };
      },
    });
    try {
      const stream1 = h.provider.streamSimple(MODEL, contextOf([user('go')]), {
        sessionId: 'pi-1',
      });
      const first = await collectStream(stream1);
      expect(first.message.stopReason).toBe('toolUse');
      const call1 = first.message.content.find((b) => b.type === 'toolCall');
      if (call1?.type !== 'toolCall') throw new Error('expected a toolCall in round 1');
      expect(call1.arguments).toEqual({ text: 'same' });

      // Pi answers round 1 -> continueToolResults on the same parked prompt
      const stream2 = h.provider.streamSimple(
        MODEL,
        contextOf([user('go'), first.message, toolResult(call1.id, 'echo', 'first')]),
        { sessionId: 'pi-1' }
      );
      const second = await collectStream(stream2);
      // the identical repeat in the next tool round must NOT get the cached
      // 'first' result: it parks again under a new turn scope (new callId)
      expect(second.message.stopReason).toBe('toolUse');
      const call2 = second.message.content.find((b) => b.type === 'toolCall');
      if (call2?.type !== 'toolCall') throw new Error('expected a toolCall in round 2');
      expect(call2.id).not.toBe(call1.id);
      expect(call2.arguments).toEqual({ text: 'same' });
      // the round-1 continuation text streamed into the second message
      expect(
        second.message.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
      ).toContain('round1:first');
      expect(h.prompts()).toHaveLength(1); // still the same parked ACP prompt

      const stream3 = h.provider.streamSimple(
        MODEL,
        contextOf([
          user('go'),
          first.message,
          toolResult(call1.id, 'echo', 'first'),
          second.message,
          toolResult(call2.id, 'echo', 'second'),
        ]),
        { sessionId: 'pi-1' }
      );
      const third = await collectStream(stream3);
      expect(third.message.stopReason).toBe('stop');
      const text = third.message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      expect(text).toContain('round2:second'); // not the cached 'first'
      expect(text).not.toContain('round2:first');
      expect(h.sessionNews()).toBe(1);
      expect(h.prompts()).toHaveLength(1);
    } finally {
      await h.provider.dispose();
    }
  });
});

describe('MistralProvider.streamSimple: model switch (ADR-0007)', () => {
  const sessionNewsAll = (h: ProviderHarness): number =>
    h.fake.agents.reduce(
      (n, agent) => n + agent.recorded.filter((r) => r.method === 'session/new').length,
      0
    );
  const promptsOf = (h: ProviderHarness, agentIndex: number) =>
    h.fake.agents[agentIndex]?.recorded.filter((r) => r.method === 'session/prompt') ?? [];

  it('switch rebuilds once, then the new model can delta on its own session', async () => {
    const h = makeProvider({ promptScript: textTurnScript });
    try {
      const stream1 = h.provider.streamSimple(MODEL, contextOf([user('hi')]), {
        sessionId: 'pi-1',
      });
      const first = await collectStream(stream1);
      expect(sessionNewsAll(h)).toBe(1);

      // model switch -> rebuild on a second vibe-acp process (pool key = alias)
      const stream2 = h.provider.streamSimple(
        MODEL2,
        contextOf([user('hi'), first.message, user('again')]),
        { sessionId: 'pi-1' }
      );
      const second = await collectStream(stream2);
      expect(second.message.stopReason).toBe('stop');
      expect(sessionNewsAll(h)).toBe(2);
      expect(h.fake.spawns[1].env[VIBE_ENV.ACTIVE_MODEL]).toBe('mistral-medium-3.5');

      // the state must now carry the NEW alias: the next call on MODEL2 is a
      // delta on the second session, not another rebuild
      const stream3 = h.provider.streamSimple(
        MODEL2,
        contextOf([user('hi'), first.message, user('again'), second.message, user('more')]),
        { sessionId: 'pi-1' }
      );
      const third = await collectStream(stream3);
      expect(third.message.stopReason).toBe('stop');
      expect(sessionNewsAll(h)).toBe(2); // no third session
      const promptsAgent2 = promptsOf(h, 1);
      expect(promptsAgent2).toHaveLength(2);
      expect(promptsAgent2[1].params.prompt[0].text).toBe('more'); // delta, not full transcript
    } finally {
      await h.provider.dispose();
    }
  });

  it('switch rebuilds once, then the new model can continueToolResults on its parked prompt', async () => {
    const h = makeProvider({
      promptScript: async (params, agent, fake) => {
        const promptText = params.prompt[0]?.type === 'text' ? params.prompt[0].text : '';
        if (!promptText.includes('tool please')) return textTurnScript(params, agent, fake);
        const sessionId = params.sessionId;
        await sendToolCallUpdate(agent, sessionId, 'effect-1', { text: 'hi' });
        const client = await h.mcpClient();
        const result = (await client.callTool({
          name: 'pi__echo',
          arguments: { text: 'hi' },
        })) as { content: Array<{ text?: string }> };
        await sendUpdate(agent, sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `tool said: ${result.content[0].text}` },
        });
        return { stopReason: 'end_turn' };
      },
    });
    try {
      const stream1 = h.provider.streamSimple(MODEL, contextOf([user('hi')]), {
        sessionId: 'pi-1',
      });
      const first = await collectStream(stream1);
      expect(first.message.stopReason).toBe('stop');

      // switch to MODEL2, which parks a tool batch on the second process
      const stream2 = h.provider.streamSimple(
        MODEL2,
        contextOf([user('hi'), first.message, user('tool please')]),
        { sessionId: 'pi-1' }
      );
      const second = await collectStream(stream2);
      expect(second.message.stopReason).toBe('toolUse');
      const call = second.message.content.find((b) => b.type === 'toolCall');
      if (call?.type !== 'toolCall') throw new Error('expected a toolCall');
      expect(sessionNewsAll(h)).toBe(2);

      // answering the batch on MODEL2 must continue the SAME parked prompt
      // (no rebuild: the state carries the new alias after the switch)
      const stream3 = h.provider.streamSimple(
        MODEL2,
        contextOf([
          user('hi'),
          first.message,
          user('tool please'),
          second.message,
          toolResult(call.id, 'echo', 'tool output'),
        ]),
        { sessionId: 'pi-1' }
      );
      const third = await collectStream(stream3);
      expect(third.message.stopReason).toBe('stop');
      expect(third.message.content).toEqual([{ type: 'text', text: 'tool said: tool output' }]);
      expect(sessionNewsAll(h)).toBe(2); // no rebuild after the switch
      expect(promptsOf(h, 1)).toHaveLength(1); // no new prompt: the parked one resumed
    } finally {
      await h.provider.dispose();
    }
  });
});

describe('MistralProvider: resource creation races (one bridge/pool, dispose during ensure)', () => {
  it('creates exactly one bridge and one vibe-acp child for concurrent first calls', async () => {
    const h = makeProvider({ promptScript: textTurnScript });
    try {
      const stream1 = h.provider.streamSimple(MODEL, contextOf([user('a')]), {
        sessionId: 'pi-1',
      });
      const stream2 = h.provider.streamSimple(MODEL, contextOf([user('b')]), {
        sessionId: 'pi-2',
      });
      const [first, second] = await Promise.all([collectStream(stream1), collectStream(stream2)]);
      expect(first.message.stopReason).toBe('stop');
      expect(second.message.stopReason).toBe('stop');
      // both turns shared ONE memoized resource creation: no leaked second bridge
      expect(h.bridgeCount()).toBe(1);
      expect(h.fake.spawns).toHaveLength(1); // one pool child serves both sessions
    } finally {
      await h.provider.dispose();
    }
  });

  it('dispose() during resource creation closes what was created and rejects the call', async () => {
    const fake = makeFakeSpawn({ promptScript: textTurnScript });
    let bridgeClosed = false;
    let started!: () => void;
    const startedP = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: (bridge: McpBridge) => void;
    const gate = new Promise<McpBridge>((resolve) => {
      release = resolve;
    });
    const provider = new MistralProvider({
      config: CONFIG,
      cwd: CWD,
      aliasByApiId: ALIAS_BY_API_ID,
      spawnChild: fake.spawnChild,
      onAnomaly: () => {},
      logDir: LOG_DIR,
      createBridge: async (_options: CreateMcpBridgeOptions) => {
        started();
        const b = await gate;
        const origClose = b.close.bind(b);
        b.close = async () => {
          bridgeClosed = true;
          await origClose();
        };
        bridges.push(b);
        return b;
      },
    });
    try {
      const stream = provider.streamSimple(MODEL, contextOf([user('hi')]), {
        sessionId: 'pi-1',
      });
      await startedP; // the bridge creation is in flight
      await provider.dispose(); // dispose while ensureResources() is awaiting
      release(await createMcpBridge({ batchWindowMs: 30 })); // creation completes after dispose
      const result = await collectStream(stream); // must settle, not hang
      expect(result.types).toContain('error');
      expect(result.message.stopReason).toBe('error');
      // the bridge created after dispose was closed again (no orphaned socket)
      expect(bridgeClosed).toBe(true);
      // no vibe-acp child was spawned for the disposed provider
      expect(fake.spawns).toHaveLength(0);
    } finally {
      await provider.dispose();
    }
  });
});

describe('MistralProvider.streamSimple: late events while parked (ADR-0002)', () => {
  it('events arriving while the turn is parked never mutate the delivered message and are replayed into the continuation stream', async () => {
    const h = makeProvider({
      promptScript: async (params, agent) => {
        const sessionId = params.sessionId;
        await sendToolCallUpdate(agent, sessionId, 'effect-1', { text: 'hi' });
        const client = await h.mcpClient();
        const pending = client.callTool({ name: 'pi__echo', arguments: { text: 'hi' } });
        const result = (await pending) as { content: Array<{ text?: string }> };
        await sendUpdate(agent, sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `after tool (${result.content[0]?.text})` },
        });
        return { stopReason: 'end_turn' };
      },
    });
    try {
      const stream1 = h.provider.streamSimple(MODEL, contextOf([user('run tool')]), {
        sessionId: 'pi-1',
      });
      const first = await collectStream(stream1);
      expect(first.message.stopReason).toBe('toolUse');
      const call = first.message.content.find((b) => b.type === 'toolCall');
      if (call?.type !== 'toolCall') throw new Error('expected a toolCall');
      const deliveredContent = JSON.stringify(first.message.content);
      const deliveredUsage = { ...first.message.usage };

      // late events while the prompt is parked (no stream attached): a usage
      // update and a text chunk from the still-running ACP prompt
      const agent = h.fake.agents[0].agentCtx;
      if (!agent) throw new Error('fake agent has no client context yet');
      await sendUpdate(agent, 'sess-1', {
        sessionUpdate: 'usage_update',
        used: 999,
        size: 1000,
        cost: { amount: 0, currency: 'USD' },
        _meta: {
          promptTokens: 900,
          completionTokens: 99,
          cachedTokens: 0,
          totalTokens: 999,
          steps: 1,
        },
      });
      await sendUpdate(agent, 'sess-1', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'late ' },
      });
      await sleep(150); // let the parked consume loop process them

      // the delivered assistant message must be untouched by the late events
      expect(JSON.stringify(first.message.content)).toBe(deliveredContent);
      expect(first.message.usage).toEqual(deliveredUsage);

      // continue: deliver the toolResult; the parked prompt finishes
      const stream2 = h.provider.streamSimple(
        MODEL,
        contextOf([user('run tool'), first.message, toolResult(call.id, 'echo', 'tool output')]),
        { sessionId: 'pi-1' }
      );
      const second = await collectStream(stream2);
      expect(second.message.stopReason).toBe('stop');
      // the late events were replayed into the continuation stream, not lost
      expect(second.message.content).toEqual([
        { type: 'text', text: 'late after tool (tool output)' },
      ]);
      // and the delivered message is still untouched
      expect(JSON.stringify(first.message.content)).toBe(deliveredContent);
      expect(first.message.usage).toEqual(deliveredUsage);
    } finally {
      await h.provider.dispose();
    }
  });
});

describe('MistralProvider: openSession and the no-live batch anomaly', () => {
  it('openSession resets bridge/pool/session state; a batch with no running ACP prompt is an anomaly, not a crash', async () => {
    const h = makeProvider({ promptScript: textTurnScript });
    try {
      const stream1 = h.provider.streamSimple(MODEL, contextOf([user('hi')]), {
        sessionId: 'pi-1',
      });
      const first = await collectStream(stream1);
      expect(first.message.stopReason).toBe('stop');
      expect(h.bridgeCount()).toBe(1);

      // a bridge tool call while no ACP prompt is running: it parks, the
      // batch fires, but there is no live turn to attach it to -> anomaly,
      // and the pre-timeout still answers the parked call
      const client = await h.mcpClient();
      const pending = client.callTool({ name: 'pi__echo', arguments: { text: 'orphan' } });
      await waitFor(
        () => h.anomalies.some((a) => a.includes('no running ACP prompt')),
        'no-live batch anomaly'
      );
      const orphan = (await pending) as { isError?: boolean };
      expect(orphan.isError).toBe(true); // pre-timeout answered it

      // session_start: fresh bridge + pool, cleared session state (lazy:
      // the bridge is only recreated on the next call)
      await h.provider.openSession();
      expect(h.bridgeCount()).toBe(1);
      const stream2 = h.provider.streamSimple(MODEL, contextOf([user('hi again')]), {
        sessionId: 'pi-2',
      });
      const second = await collectStream(stream2);
      expect(second.message.stopReason).toBe('stop');
      expect(h.bridgeCount()).toBe(2); // a fresh bridge was created
      expect(h.sessionNews()).toBe(2); // ... on a fresh pooled process
    } finally {
      await h.provider.dispose();
    }
  });
});

describe('MistralProvider.streamSimple: steering abandons a parked prompt (ADR-0003)', () => {
  it('steering while parked: the old prompt is cancelled, parked calls released with an error, and the new user message rebuilds on a fresh session', async () => {
    // what the parked MCP call resolved to once the provider released it
    let released: { isError: boolean | undefined; text: string | undefined } | null = null;
    const h = makeProvider({
      promptScript: async (params, agent, fake) => {
        // park only on the FIRST prompt (harness-wide count); the steering
        // rebuild prompt must not park again on the fresh session
        if (fake.promptCount !== 1) return { stopReason: 'end_turn' };
        const sessionId = params.sessionId;
        await sendToolCallUpdate(agent, sessionId, 'effect-1', { text: 'hi' });
        const client = await h.mcpClient();
        // the call parks; the provider answers it when the turn is abandoned
        const result = (await client.callTool({
          name: 'pi__echo',
          arguments: { text: 'hi' },
        })) as { content: Array<{ text?: string }>; isError?: boolean };
        released = { isError: result.isError, text: result.content[0]?.text };
        await sendUpdate(agent, sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `tool returned: ${result.content[0].text}` },
        });
        return { stopReason: 'end_turn' };
      },
    });
    try {
      // first turn parks a tool batch
      const stream1 = h.provider.streamSimple(MODEL, contextOf([user('run tool')]), {
        sessionId: 'pi-1',
      });
      const first = await collectStream(stream1);
      expect(first.message.stopReason).toBe('toolUse');
      const call = first.message.content.find((b) => b.type === 'toolCall');
      if (call?.type !== 'toolCall') throw new Error('expected a toolCall');
      expect(h.prompts()).toHaveLength(1);

      // steering: a NEW user message after the parked assistant message (and NO
      // toolResult for the parked call) -> decideFlow rebuilds (ADR-0003). The
      // old prompt must be cancelled and the parked call released with an
      // error so it does not resolve into the new stream.
      const stream2 = h.provider.streamSimple(
        MODEL,
        contextOf([user('run tool'), first.message, user('forget it, do something else')]),
        { sessionId: 'pi-1' }
      );
      const second = await collectStream(stream2);
      expect(second.message.stopReason).toBe('stop');
      // the abandoned turn's trailing output must NOT leak into the new stream
      expect(second.message.content).toEqual([]);
      // the parked call was released with an isError result naming the reason
      expect(released).toEqual({
        isError: true,
        text: 'turn abandoned: steering or model switch (ADR-0003)',
      });
      // the old ACP session was cancelled, a new one created on the SAME
      // pooled process (same model alias -> no new spawn)
      expect(h.sessionNews()).toBe(2);
      expect(h.prompts()).toHaveLength(2); // old parked prompt + fresh prompt
      expect(h.fake.spawns).toHaveLength(1);
      // the provider sent session/cancel to the old session
      const cancels = h.fake.agents[0].recorded.filter((r) => r.method === 'session/cancel');
      expect(cancels).toHaveLength(1);
    } finally {
      await h.provider.dispose();
    }
  });

  it('steering mid-turn: the abandoned consume loop cannot corrupt the session state (the next call deltas)', async () => {
    const h = makeProvider({
      promptScript: async (params, agent, fake) => {
        const sessionId = params.sessionId;
        if (fake.promptCount === 1) {
          // first prompt parks a tool call; the steering rebuild releases it,
          // and the abandoned prompt only settles AFTER the new turn is up
          await sendToolCallUpdate(agent, sessionId, 'effect-1', { text: 'hi' });
          const client = await h.mcpClient();
          await client.callTool({ name: 'pi__echo', arguments: { text: 'hi' } });
          await sleep(300);
          return { stopReason: 'end_turn' };
        }
        await sendUpdate(agent, sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `answer ${fake.promptCount}` },
        });
        return { stopReason: 'end_turn' };
      },
    });
    try {
      const stream1 = h.provider.streamSimple(MODEL, contextOf([user('run tool')]), {
        sessionId: 'pi-1',
      });
      const first = await collectStream(stream1);
      expect(first.message.stopReason).toBe('toolUse');

      // steering while parked -> rebuild on a fresh session
      const stream2 = h.provider.streamSimple(
        MODEL,
        contextOf([user('run tool'), first.message, user('forget it, do something else')]),
        { sessionId: 'pi-1' }
      );
      const second = await collectStream(stream2);
      expect(second.message.stopReason).toBe('stop');
      expect(second.message.content).toEqual([{ type: 'text', text: 'answer 2' }]);
      expect(h.sessionNews()).toBe(2);

      // let the abandoned prompt settle (its consume loop finishes late)
      await sleep(400);

      // the next call must DELTA on the new session (state not corrupted by
      // the abandoned loop's finishTurn): same session, prompt = new message only
      const stream3 = h.provider.streamSimple(
        MODEL,
        contextOf([
          user('run tool'),
          first.message,
          user('forget it, do something else'),
          second.message,
          user('more'),
        ]),
        { sessionId: 'pi-1' }
      );
      const third = await collectStream(stream3);
      expect(third.message.stopReason).toBe('stop');
      expect(third.message.content).toEqual([{ type: 'text', text: 'answer 3' }]);
      expect(h.sessionNews()).toBe(2); // no extra rebuild
      expect(h.prompts()).toHaveLength(3); // third prompt on the SAME ACP session
      expect(h.prompts()[2].params.prompt[0].text).toBe('more'); // delta = new message only
    } finally {
      await h.provider.dispose();
    }
  });

  it('model switch while parked: old prompt is cancelled, parked calls released, new model rebuilds on its own process', async () => {
    let released: { isError: boolean | undefined; text: string | undefined } | null = null;
    const h = makeProvider({
      promptScript: async (params, agent, fake) => {
        // park only on the FIRST prompt (harness-wide count, because the model
        // switch spawns a second agent whose own count would restart at 1)
        if (fake.promptCount !== 1) return { stopReason: 'end_turn' };
        const sessionId = params.sessionId;
        const promptText = params.prompt[0]?.type === 'text' ? params.prompt[0].text : '';
        if (!promptText.includes('run tool')) return { stopReason: 'end_turn' };
        await sendToolCallUpdate(agent, sessionId, 'effect-1', { text: 'hi' });
        const client = await h.mcpClient();
        const result = (await client.callTool({
          name: 'pi__echo',
          arguments: { text: 'hi' },
        })) as { content: Array<{ text?: string }>; isError?: boolean };
        released = { isError: result.isError, text: result.content[0]?.text };
        await sendUpdate(agent, sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `tool returned: ${result.content[0].text}` },
        });
        return { stopReason: 'end_turn' };
      },
    });
    try {
      const stream1 = h.provider.streamSimple(MODEL, contextOf([user('run tool')]), {
        sessionId: 'pi-1',
      });
      const first = await collectStream(stream1);
      expect(first.message.stopReason).toBe('toolUse');
      const call = first.message.content.find((b) => b.type === 'toolCall');
      if (call?.type !== 'toolCall') throw new Error('expected a toolCall');

      // switch models while the tool is still parked -> rebuild on MODEL2
      // (parked assistant message + plain user message, no toolResult)
      const stream2 = h.provider.streamSimple(
        MODEL2,
        contextOf([user('run tool'), first.message, user('use the other model')]),
        { sessionId: 'pi-1' }
      );
      const second = await collectStream(stream2);
      expect(second.message.stopReason).toBe('stop');
      // the old parked call was released (errored); the new model's prompt ran
      // without tool calls, so nothing lands in the new stream
      expect(second.message.content).toEqual([]);
      expect(released).toEqual({
        isError: true,
        text: 'turn abandoned: steering or model switch (ADR-0003)',
      });
      // a new session on a NEW process for the new model alias (ADR-0007)
      expect(h.sessionNews()).toBe(2);
      expect(h.fake.spawns).toHaveLength(2);
      expect(h.fake.spawns[1].env[VIBE_ENV.ACTIVE_MODEL]).toBe('mistral-medium-3.5');
      // the old session got session/cancel
      const cancels = h.fake.agents[0].recorded.filter((r) => r.method === 'session/cancel');
      expect(cancels).toHaveLength(1);
    } finally {
      await h.provider.dispose();
    }
  });
});

describe('MistralProvider.streamSimple: review T5 #16 test gaps (ADR-0002/0003)', () => {
  it('partial toolResults (only some parked calls answered) rebuild instead of continuing', async () => {
    const parked: ParkedResult[] = [];
    const h = makeProvider({
      promptScript: async (params, agent, fake) => {
        if (fake.promptCount !== 1) return { stopReason: 'end_turn' };
        const sessionId = params.sessionId;
        await sendToolCallUpdate(agent, sessionId, 'effect-1', { text: 'a' });
        await sendToolCallUpdate(agent, sessionId, 'effect-2', { path: '/x' });
        const client = await h.mcpClient();
        const p1 = client.callTool({ name: 'pi__echo', arguments: { text: 'a' } });
        const p2 = client.callTool({ name: 'pi__read', arguments: { path: '/x' } });
        const [r1, r2] = (await Promise.all([p1, p2])) as Array<{
          content: Array<{ text?: string }>;
          isError?: boolean;
        }>;
        parked.push(
          { isError: r1.isError, text: r1.content[0]?.text },
          { isError: r2.isError, text: r2.content[0]?.text }
        );
        return { stopReason: 'end_turn' };
      },
    });
    try {
      const stream1 = h.provider.streamSimple(
        MODEL,
        contextOf([user('run tools')], [TOOLS[0], READ_TOOL]),
        { sessionId: 'pi-1' }
      );
      const first = await collectStream(stream1);
      expect(first.message.stopReason).toBe('toolUse');
      const calls = first.message.content.filter((b) => b.type === 'toolCall');
      expect(calls).toHaveLength(2); // both parked calls in one batch

      // only ONE of the two parked calls gets a toolResult -> decideFlow
      // rebuilds (a partial answer is not a valid continuation)
      const stream2 = h.provider.streamSimple(
        MODEL,
        contextOf(
          [
            user('run tools'),
            first.message,
            toolResult(calls[0].type === 'toolCall' ? calls[0].id : '', 'echo', 'out'),
          ],
          [TOOLS[0], READ_TOOL]
        ),
        { sessionId: 'pi-1' }
      );
      const second = await collectStream(stream2);
      expect(second.message.stopReason).toBe('stop');
      expect(h.sessionNews()).toBe(2); // fresh session, not a continuation
      // both parked calls were released with an error by the rebuild
      expect(parked).toEqual([
        { isError: true, text: 'turn abandoned: steering or model switch (ADR-0003)' },
        { isError: true, text: 'turn abandoned: steering or model switch (ADR-0003)' },
      ]);
    } finally {
      await h.provider.dispose();
    }
  });

  it('second tool round on the resumed stream parks again (toolUse twice, then stop)', async () => {
    const h = makeProvider({
      promptScript: async (params, agent, fake) => {
        if (fake.promptCount !== 1) return { stopReason: 'end_turn' };
        const sessionId = params.sessionId;
        // the SAME prompt runs two sequential tool rounds; each callTool parks
        // until the corresponding streamSimple delivers its toolResult
        for (const round of [1, 2]) {
          await sendToolCallUpdate(agent, sessionId, `effect-${round}`, { text: `r${round}` });
          const client = await h.mcpClient();
          const result = (await client.callTool({
            name: 'pi__echo',
            arguments: { text: `r${round}` },
          })) as { content: Array<{ text?: string }> };
          await sendUpdate(agent, sessionId, {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `after r${round}: ${result.content[0]?.text}` },
          });
        }
        return { stopReason: 'end_turn' };
      },
    });
    try {
      const stream1 = h.provider.streamSimple(MODEL, contextOf([user('two rounds')]), {
        sessionId: 'pi-1',
      });
      const first = await collectStream(stream1);
      expect(first.message.stopReason).toBe('toolUse');
      const call1 = first.message.content.find((b) => b.type === 'toolCall');
      if (call1?.type !== 'toolCall') throw new Error('expected toolCall');

      // deliver round 1's result -> the same prompt continues and parks again
      const stream2 = h.provider.streamSimple(
        MODEL,
        contextOf([user('two rounds'), first.message, toolResult(call1.id, 'echo', 'output-1')]),
        { sessionId: 'pi-1' }
      );
      const second = await collectStream(stream2);
      expect(second.message.stopReason).toBe('toolUse'); // second round parked
      expect(
        second.message.content.some(
          (b) => b.type === 'text' && b.text.includes('after r1: output-1')
        )
      ).toBe(true);
      const call2 = second.message.content.find((b) => b.type === 'toolCall');
      if (call2?.type !== 'toolCall') throw new Error('expected second toolCall');
      expect(h.sessionNews()).toBe(1); // still the same ACP session/prompt

      // deliver round 2's result -> the prompt finishes
      const stream3 = h.provider.streamSimple(
        MODEL,
        contextOf([
          user('two rounds'),
          first.message,
          toolResult(call1.id, 'echo', 'output-1'),
          second.message,
          toolResult(call2.id, 'echo', 'output-2'),
        ]),
        { sessionId: 'pi-1' }
      );
      const third = await collectStream(stream3);
      expect(third.message.stopReason).toBe('stop');
      expect(
        third.message.content.some(
          (b) => b.type === 'text' && b.text.includes('after r2: output-2')
        )
      ).toBe(true);
      expect(h.sessionNews()).toBe(1);
      expect(h.prompts()).toHaveLength(1); // one prompt, three Pi turns
    } finally {
      await h.provider.dispose();
    }
  });

  it('abort while parked: session cancelled + dirty, the parked call is released on the next rebuild', async () => {
    const parked: { current: ParkedResult | null } = { current: null };
    const h = makeProvider({
      promptScript: async (params, agent, fake) => {
        if (fake.promptCount !== 1) return { stopReason: 'end_turn' };
        const sessionId = params.sessionId;
        await sendToolCallUpdate(agent, sessionId, 'effect-1', { text: 'hi' });
        const client = await h.mcpClient();
        const pending = client.callTool({ name: 'pi__echo', arguments: { text: 'hi' } });
        // capture the parked call's result whenever it resolves (release on
        // rebuild / pre-timeout), without blocking the prompt
        void pending.then((result) => {
          const r = result as { content: Array<{ text?: string }>; isError?: boolean };
          parked.current = { isError: r.isError, text: r.content[0]?.text };
        });
        // the prompt settles as cancelled when session/cancel arrives (abort)
        return new Promise((resolve) => {
          h.fake.behavior.onCancel = () => resolve({ stopReason: 'cancelled' });
        });
      },
    });
    try {
      const controller = new AbortController();
      const stream1 = h.provider.streamSimple(MODEL, contextOf([user('run tool')]), {
        sessionId: 'pi-1',
        signal: controller.signal,
      });
      const first = await collectStream(stream1);
      expect(first.message.stopReason).toBe('toolUse');

      controller.abort(); // abort while the prompt is parked
      await waitFor(
        () => h.fake.agents[0].recorded.filter((r) => r.method === 'session/cancel').length >= 1,
        'session/cancel'
      );
      await sleep(150); // the cancelled prompt settles

      // the next call rebuilds (dirty) and releases the parked call
      const stream2 = h.provider.streamSimple(
        MODEL,
        contextOf([user('run tool'), first.message, user('again')]),
        { sessionId: 'pi-1' }
      );
      const second = await collectStream(stream2);
      expect(second.message.stopReason).toBe('stop');
      expect(h.sessionNews()).toBe(2);
      await waitFor(() => parked.current !== null, 'parked call released');
      expect(parked.current).toEqual({
        isError: true,
        text: 'turn abandoned: steering or model switch (ADR-0003)',
      });
    } finally {
      await h.provider.dispose();
    }
  });

  it('pre-timeout while Pi still runs the tool: the parked call gets an isError budget answer, the next call rebuilds instead of hanging', async () => {
    const parked: { current: ParkedResult | null } = { current: null };
    const h = makeProvider({
      promptScript: async (params, agent, fake) => {
        if (fake.promptCount !== 1) return { stopReason: 'end_turn' };
        const sessionId = params.sessionId;
        await sendToolCallUpdate(agent, sessionId, 'effect-1', { text: 'slow' });
        const client = await h.mcpClient();
        const result = (await client.callTool({
          name: 'pi__echo',
          arguments: { text: 'slow' },
        })) as { content: Array<{ text?: string }>; isError?: boolean };
        parked.current = { isError: result.isError, text: result.content[0]?.text };
        return { stopReason: 'end_turn' };
      },
    });
    try {
      const stream1 = h.provider.streamSimple(MODEL, contextOf([user('slow tool')]), {
        sessionId: 'pi-1',
      });
      const first = await collectStream(stream1);
      expect(first.message.stopReason).toBe('toolUse');
      const call = first.message.content.find((b) => b.type === 'toolCall');
      if (call?.type !== 'toolCall') throw new Error('expected toolCall');

      // Pi never answers: the bridge's pre-timeout (CONFIG.toolPreTimeoutMs)
      // answers the parked call itself with an isError budget result
      await waitFor(() => parked.current !== null, 'pre-timeout answer', 5_000);
      expect(parked.current?.isError).toBe(true);
      expect(parked.current?.text).toContain('did not finish within');
      await sleep(100); // the prompt settles after the answered call

      // a late toolResult for the timed-out call must not hang: the prompt is
      // settled, so the turn rebuilds
      const stream2 = h.provider.streamSimple(
        MODEL,
        contextOf([user('slow tool'), first.message, toolResult(call.id, 'echo', 'late')]),
        { sessionId: 'pi-1' }
      );
      const second = await collectStream(stream2);
      expect(second.message.stopReason).toBe('stop');
      expect(h.sessionNews()).toBe(2); // rebuild, not a continuation
    } finally {
      await h.provider.dispose();
    }
  });

  it('crash mid-turn: error event + dirty session, the next call rebuilds on a respawned process', async () => {
    const h = makeProvider({
      promptScript: async (params, agent, fake) => {
        if (fake.promptCount !== 1) return { stopReason: 'end_turn' };
        const sessionId = params.sessionId;
        await sendUpdate(agent, sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'partial before crash' },
        });
        return new Promise(() => {}); // never settles; the child crashes instead
      },
    });
    try {
      const stream1 = h.provider.streamSimple(MODEL, contextOf([user('hi')]), {
        sessionId: 'pi-1',
      });
      await waitFor(() => h.prompts().length === 1, 'prompt start');
      await sleep(100); // let the partial text through
      h.fake.children[0].crash(1);
      const first = await collectStream(stream1);
      expect(first.types).toContain('error');
      expect(first.message.stopReason).toBe('error');
      expect(first.message.errorMessage).toBeTruthy();
      expect(first.message.content).toEqual([{ type: 'text', text: 'partial before crash' }]);

      // the session is dirty: the next call rebuilds on a respawned child
      const stream2 = h.provider.streamSimple(MODEL, contextOf([user('hi'), user('retry')]), {
        sessionId: 'pi-1',
      });
      const second = await collectStream(stream2);
      expect(second.message.stopReason).toBe('stop');
      expect(h.fake.spawns).toHaveLength(2); // respawned
      expect(h.sessionNews()).toBe(2);
    } finally {
      await h.provider.dispose();
    }
  });

  it('dispose mid-turn: the in-flight stream is ended, no caller left hanging (AGENTS.md §15)', async () => {
    const h = makeProvider({
      promptScript: () => new Promise(() => {}), // never settles
    });
    const stream = h.provider.streamSimple(MODEL, contextOf([user('hi')]), {
      sessionId: 'pi-1',
    });
    await waitFor(() => h.prompts().length === 1, 'prompt start');
    const collecting = collectStream(stream);
    await h.provider.dispose();
    const result = await Promise.race([collecting, sleep(2_000).then(() => null as null)]);
    expect(result).not.toBeNull(); // the stream must have ended on dispose
    expect(result?.message.stopReason).toBe('aborted');
    expect(result?.types).toContain('error');
  });
});

// keep the import used for the stream type in helpers
void createAssistantMessageEventStream;

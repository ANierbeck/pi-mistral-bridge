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
  let client: Client | null = null;
  const provider = new MistralProvider({
    config: CONFIG,
    cwd: CWD,
    aliasByApiId: ALIAS_BY_API_ID,
    spawnChild: fake.spawnChild,
    onAnomaly: (message) => anomalies.push(message),
    logDir: LOG_DIR,
    createBridge: async (options: CreateMcpBridgeOptions) => {
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
    prompts: () => fake.agents[0]?.recorded.filter((r) => r.method === 'session/prompt') ?? [],
    sessionNews: () =>
      fake.agents[0]?.recorded.filter((r) => r.method === 'session/new').length ?? 0,
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

// keep the import used for the stream type in helpers
void createAssistantMessageEventStream;

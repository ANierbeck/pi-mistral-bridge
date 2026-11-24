// Unit tests for src/acp-client.ts (T3). The ACP side is exercised against an
// IN-PROCESS fake ACP agent over in-memory streams (AGENTS.md §4: no real
// vibe-acp, no network). The fake agent lives in test/helpers/fake-acp-agent.ts
// and is built with the SDK's own agent-side app, connected to the fake child's
// stdio through ndJsonStream — the same wire shape the real vibe-acp speaks.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as acp from '@agentclientprotocol/sdk';
import {
  AcpClientError,
  QUOTA_ERROR_PREFIX,
  VibeAcpProcess,
  VibeProcessPool,
  bridgeToolRequestName,
  classifyAcpError,
  extractModelOptions,
  isBridgeToolName,
  type AcpPrompt,
  type AcpSessionEvent,
  type PromptResult,
} from '../src/acp-client.ts';
import {
  ACP_CLIENT_NAME,
  NEVER_SET_ENV_KEYS,
  PERMISSION_OPTION_ALLOW_ONCE,
  PERMISSION_OPTION_REJECT_ONCE,
  PROMPT_RESPONSE_USAGE,
  TOOL_CALL_META_TOOL_NAME,
  UNIFIED_HARNESS_DISCOVERY_TOOL,
  VIBE_ENV,
  buildAcpMcpServerEntry,
} from '../src/vibe-protocol.ts';
import {
  makeFakeSpawn,
  requestPermission,
  sendUpdate,
  type FakeAgent,
  type FakeBehavior,
  type FakeVibeChild,
  type PromptScript,
} from './helpers/fake-acp-agent.ts';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

const MCP_SERVER = {
  name: 'pi',
  url: 'http://127.0.0.1:4711/mcp',
  token: 'test-secret-token-0123456789',
};

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

// ------------------------------------------------------------------- harness

interface Harness {
  pool: VibeProcessPool;
  children: FakeVibeChild[];
  spawns: Array<{ command: string; args: string[]; env: Record<string, string> }>;
  agents: FakeAgent[];
  anomalies: string[];
  behavior: FakeBehavior;
  logDir: string;
}

function makePool(
  opts: {
    debug?: boolean;
    processIdleTimeoutMs?: number;
    abortWatchdogMs?: number;
    promptScript?: PromptScript;
    onCancel?: () => void;
    failInitialize?: boolean;
    onInitialize?: () => Promise<void>;
    logDir?: string;
  } = {}
): Harness {
  const anomalies: string[] = [];
  const fake = makeFakeSpawn({
    promptScript: opts.promptScript,
    onCancel: opts.onCancel,
    failInitialize: opts.failInitialize,
    onInitialize: opts.onInitialize,
  });
  const logDir = opts.logDir ?? mkdtempSync(join(tmpdir(), 'pi-mistral-bridge-acp-logs-'));
  const pool = new VibeProcessPool({
    vibeAcpPath: 'vibe-acp',
    processIdleTimeoutMs: opts.processIdleTimeoutMs ?? 600_000,
    abortWatchdogMs: opts.abortWatchdogMs ?? 5_000,
    debug: opts.debug ?? false,
    mcpServer: MCP_SERVER,
    logDir,
    spawnChild: fake.spawnChild,
    onAnomaly: (message) => anomalies.push(message),
  });
  return {
    pool,
    children: fake.children,
    spawns: fake.spawns,
    agents: fake.agents,
    anomalies,
    behavior: fake.behavior,
    logDir,
  };
}

/** The default fake turn: thinking + two text chunks + a Pi tool call + usage, then end_turn. */
const defaultPromptScript: PromptScript = async (params, agent) => {
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
    sessionUpdate: 'tool_call',
    toolCallId: 'effect-1',
    title: 'mcp_pi.pi__echo',
    status: 'in_progress',
    rawInput: { text: 'hi' },
    _meta: { [TOOL_CALL_META_TOOL_NAME]: 'mcp_pi.pi__echo', effect_kind: 'tool' },
  });
  await sendUpdate(agent, sessionId, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'effect-1',
    status: 'completed',
    rawOutput: { type: 'success', content: [{ type: 'text', text: 'hi' }] },
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

async function collect(
  prompt: AcpPrompt
): Promise<{ events: AcpSessionEvent[]; result: PromptResult }> {
  const events: AcpSessionEvent[] = [];
  const resultPromise = prompt.result();
  for await (const event of prompt) events.push(event);
  return { events, result: await resultPromise };
}

const CWD = mkdtempSync(join(tmpdir(), 'pi-mistral-bridge-cwd-'));

// --------------------------------------------------------------------- tests

describe('VibeProcessPool: spawn, env, handshake, dispose', () => {
  it('spawns vibe-acp with the provider-mode env (ADR-0006/0007) and identifies honestly in initialize', async () => {
    const h = makePool();
    try {
      const proc = await h.pool.get('devstral-small');
      expect(proc.modelAlias).toBe('devstral-small');
      expect(h.spawns).toHaveLength(1);
      expect(h.spawns[0].command).toBe('vibe-acp');
      expect(h.spawns[0].args).toEqual([]);

      const env = h.spawns[0].env;
      expect(env[VIBE_ENV.ACTIVE_MODEL]).toBe('devstral-small');
      expect(env[VIBE_ENV.DEFAULT_APPROVAL_POLICY]).toBe('ask');
      expect(env[VIBE_ENV.ENABLE_AUTO_APPROVE]).toBe('false');
      expect(JSON.parse(env[VIBE_ENV.ENABLED_TOOLS])).toEqual(['pi_pi__*']);
      const mcpServers = JSON.parse(env[VIBE_ENV.MCP_SERVERS]) as any[];
      expect(mcpServers).toHaveLength(1);
      expect(mcpServers[0].name).toBe('pi');
      expect(mcpServers[0].url).toBe(MCP_SERVER.url);
      // the bridge never SETS a never-set key; an inherited VIBE_HOME passes through
      for (const key of NEVER_SET_ENV_KEYS) {
        if (key in process.env) expect(env[key]).toBe(process.env[key]);
        else expect(env).not.toHaveProperty(key);
      }

      const init = h.agents[0].recorded.find((r) => r.method === 'initialize');
      expect(init).toBeDefined();
      if (!init) throw new Error('initialize was not recorded');
      expect(init.params.clientInfo).toEqual({ name: ACP_CLIENT_NAME, version: pkg.version });
      expect(init.params.clientCapabilities.fs).toEqual({
        readTextFile: false,
        writeTextFile: false,
      });
      expect(init.params.clientCapabilities.terminal).toBe(false);
    } finally {
      await h.pool.dispose();
    }
    // no orphans: dispose kills the child (AGENTS.md §15)
    expect(h.children[0].killedWith.length).toBeGreaterThan(0);
  });

  it('sanitizes inherited VIBE_* env (drops VIBE_TOOLS/auto-approve, keeps VIBE_HOME and PATH/HOME)', async () => {
    vi.stubEnv('VIBE_TOOLS', '{"x_pi__y":{"permission":"always"}}');
    vi.stubEnv('VIBE_DEFAULT_APPROVAL_POLICY', 'auto');
    vi.stubEnv('VIBE_ENABLE_AUTO_APPROVE', 'true');
    vi.stubEnv('VIBE_HOME', '/custom/vibe-home');
    try {
      const h = makePool();
      try {
        await h.pool.get('devstral-small');
        expect(h.spawns).toHaveLength(1);
        const env = h.spawns[0].env;
        // inherited VIBE_* keys that could auto-approve tools never reach the child
        expect(env).not.toHaveProperty('VIBE_TOOLS');
        // the bridge's own overlay wins over any inherited value
        expect(env[VIBE_ENV.DEFAULT_APPROVAL_POLICY]).toBe('ask');
        expect(env[VIBE_ENV.ENABLE_AUTO_APPROVE]).toBe('false');
        // VIBE_HOME is the user's own Vibe installation (auth lives there): the
        // bridge never SETS it (§14) but must not hide it either (§15)
        expect(env.VIBE_HOME).toBe('/custom/vibe-home');
        // non-VIBE vars pass through untouched
        expect(env.PATH).toBe(process.env.PATH);
        expect(env.HOME).toBe(process.env.HOME);
      } finally {
        await h.pool.dispose();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reuses the pooled process for the same alias and pools per alias', async () => {
    const h = makePool();
    try {
      const a = await h.pool.get('devstral-small');
      const b = await h.pool.get('devstral-small');
      expect(a).toBe(b);
      expect(h.spawns).toHaveLength(1);
      const c = await h.pool.get('mistral-medium-3.5');
      expect(c).not.toBe(a);
      expect(h.spawns).toHaveLength(2);
      expect(h.pool.size).toBe(2);
    } finally {
      await h.pool.dispose();
    }
  });

  it('reaps an idle process after processIdleTimeoutMs and respawns on next use (fake timers)', async () => {
    vi.useFakeTimers();
    try {
      const h = makePool({ processIdleTimeoutMs: 1_000 });
      await h.pool.get('devstral-small');
      expect(h.pool.size).toBe(1);
      await vi.advanceTimersByTimeAsync(1_001);
      expect(h.children[0].killedWith.length).toBeGreaterThan(0);
      expect(h.pool.size).toBe(0);
      await h.pool.get('devstral-small');
      expect(h.spawns).toHaveLength(2);
      await h.pool.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('VibeAcpProcess.start failure paths (no orphan window, AGENTS.md §15)', () => {
  it('kills the child with SIGKILL when the debug log dir cannot be created after spawn', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'pi-mistral-bridge-block-'));
    const blocker = join(parent, 'blocker');
    writeFileSync(blocker, 'a file, not a dir');
    try {
      const h = makePool({ debug: true, logDir: join(blocker, 'logs') });
      try {
        await expect(h.pool.get('devstral-small')).rejects.toThrow();
        expect(h.spawns).toHaveLength(1);
        // the throw happened after spawnChild — the child must not be orphaned
        expect(h.children[0].killedWith).toContain('SIGKILL');
      } finally {
        await h.pool.dispose();
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('kills the child when the initialize handshake fails', async () => {
    const h = makePool({ failInitialize: true });
    try {
      await expect(h.pool.get('devstral-small')).rejects.toThrow();
      expect(h.children[0].killedWith.length).toBeGreaterThan(0);
    } finally {
      await h.pool.dispose();
    }
  });
});

describe('VibeProcessPool races (AGENTS.md §15)', () => {
  it('shares exactly one spawn between concurrent gets of the same alias', async () => {
    const h = makePool();
    try {
      const [a, b] = await Promise.all([
        h.pool.get('devstral-small'),
        h.pool.get('devstral-small'),
      ]);
      expect(a).toBe(b);
      expect(h.spawns).toHaveLength(1);
      expect(h.pool.size).toBe(1);
    } finally {
      await h.pool.dispose();
    }
  });

  it('terminates the fresh child and rejects when dispose() lands during an awaited start', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = makePool({ onInitialize: () => gate });
    const getPromise = h.pool.get('devstral-small');
    await vi.waitFor(() => expect(h.spawns).toHaveLength(1));
    // dispose while the start is still in flight
    await h.pool.dispose();
    release();
    await expect(getPromise).rejects.toThrow(/disposed/);
    // the child spawned by the in-flight start must not survive
    expect(h.children[0].killedWith.length).toBeGreaterThan(0);
  });

  it('throws on get after dispose', async () => {
    const h = makePool();
    await h.pool.get('devstral-small');
    await h.pool.dispose();
    await expect(h.pool.get('devstral-small')).rejects.toThrow(/disposed/);
  });
});

describe('AcpSession.newSession', () => {
  it('returns sessionId, modes, configOptions and the model options list for T7', async () => {
    const h = makePool();
    try {
      const proc = await h.pool.get('devstral-small');
      const session = await proc.newSession({ cwd: CWD, mcpServer: MCP_SERVER });
      expect(session.sessionId).toBe('sess-1');
      expect(session.modes?.currentModeId).toBe('ask');
      expect(session.configOptions).toHaveLength(2);
      expect(session.modelOptions()).toEqual([
        { value: 'devstral-small', name: 'Devstral Small', description: 'devstral-small-latest' },
        {
          value: 'mistral-medium-3.5',
          name: 'Mistral Medium 3.5',
          description: 'mistral-medium-3.5',
        },
      ]);

      const newReq = h.agents[0].recorded.find((r) => r.method === 'session/new');
      if (!newReq) throw new Error('session/new was not recorded');
      expect(newReq.params.cwd).toBe(CWD);
      // the bridge MCP server is offered as an ACP http entry with the bearer header
      expect(newReq.params.mcpServers).toEqual([buildAcpMcpServerEntry(MCP_SERVER)]);
      expect(newReq.params.mcpServers[0].type).toBe('http');
    } finally {
      await h.pool.dispose();
    }
  });

  it('supports a discovery-only process: no alias, no MCP server (ADR-0005)', async () => {
    const fake = makeFakeSpawn();
    const logDir = mkdtempSync(join(tmpdir(), 'pi-mistral-bridge-acp-logs-'));
    const proc = await VibeAcpProcess.start({
      vibeAcpPath: 'vibe-acp',
      cwd: CWD,
      abortWatchdogMs: 5_000,
      debug: false,
      logDir,
      spawnChild: fake.spawnChild,
      logFileBase: 'model-discovery',
    });
    try {
      // no VIBE_ACTIVE_MODEL / VIBE_ENABLED_TOOLS / VIBE_MCP_SERVERS in the child env
      const env = fake.spawns[0].env;
      expect(VIBE_ENV.ACTIVE_MODEL in env).toBe(false);
      expect(VIBE_ENV.ENABLED_TOOLS in env).toBe(false);
      expect(VIBE_ENV.MCP_SERVERS in env).toBe(false);
      expect(env[VIBE_ENV.DEFAULT_APPROVAL_POLICY]).toBe('ask');
      expect(proc.modelLabel).toBe('default');

      const session = await proc.newSession({ cwd: CWD });
      const newReq = fake.agents[0].recorded.find((r) => r.method === 'session/new');
      if (!newReq) throw new Error('session/new was not recorded');
      expect(newReq.params.mcpServers).toEqual([]);
      // the model list is still offered by the discovery session (ADR-0005/0007)
      expect(session.modelOptions().map((o) => o.value)).toEqual([
        'devstral-small',
        'mistral-medium-3.5',
      ]);
      await session.close();
    } finally {
      await proc.terminate('test-done');
    }
  });
});

describe('extractModelOptions (pure, T7)', () => {
  it('flattens grouped select options and returns [] without a model option', () => {
    expect(
      extractModelOptions([
        {
          id: 'model',
          category: 'model',
          type: 'select',
          name: 'Model',
          currentValue: 'a',
          options: [
            {
              group: 'g1',
              name: 'Group',
              options: [
                { value: 'a', name: 'A', description: 'a-latest' },
                { value: 'b', name: 'B' },
              ],
            },
          ],
        } as any,
      ])
    ).toEqual([
      { value: 'a', name: 'A', description: 'a-latest' },
      { value: 'b', name: 'B' },
    ]);
    expect(extractModelOptions([{ id: 'mode', type: 'select' } as any])).toEqual([]);
    expect(extractModelOptions(undefined)).toEqual([]);
  });
});

describe('prompt: streaming, event mapping, result', () => {
  it('streams mapped events and resolves with stopReason + usage (cost forced to 0)', async () => {
    const h = makePool({ promptScript: defaultPromptScript });
    try {
      const proc = await h.pool.get('devstral-small');
      const session = await proc.newSession({ cwd: CWD, mcpServer: MCP_SERVER });
      const { events, result } = await collect(session.prompt('say hi'));

      const promptReq = h.agents[0].recorded.find((r) => r.method === 'session/prompt');
      if (!promptReq) throw new Error('session/prompt was not recorded');
      expect(promptReq.params.prompt).toEqual([{ type: 'text', text: 'say hi' }]);

      expect(events.map((e) => e.type)).toEqual([
        'thinking_delta',
        'text_delta',
        'text_delta',
        'tool_call',
        'tool_call_update',
        'usage',
      ]);
      const [thinking, text1, text2, toolCall, toolUpdate, usage] = events as any[];
      expect(thinking.delta).toBe('let me think');
      expect(text1.delta).toBe('Hello');
      expect(text2.delta).toBe(' world');
      expect(toolCall.toolCall).toMatchObject({
        toolCallId: 'effect-1',
        name: 'pi__echo',
        title: 'mcp_pi.pi__echo',
        rawInput: { text: 'hi' },
        status: 'in_progress',
      });
      expect(toolUpdate.toolCall.status).toBe('completed');
      expect(toolUpdate.toolCall.rawOutput).toEqual({
        type: 'success',
        content: [{ type: 'text', text: 'hi' }],
      });
      // usage_update: tokens incl. cached, cost forced to 0, context size/used surfaced
      expect(usage.usage).toEqual({
        input: 80,
        output: 20,
        cacheRead: 5,
        cacheWrite: 0,
        totalTokens: 105,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      });
      expect(usage.contextSize).toBe(200_000);
      expect(usage.contextUsed).toBe(100);

      // prompt response: stopReason + usage from the unstable response field
      expect(result.stopReason).toBe('end_turn');
      expect(result.usage.input).toBe(80);
      expect(result.usage.output).toBe(20);
      expect(result.usage.cacheRead).toBe(5);
      expect(result.usage.totalTokens).toBe(105);
      expect(result.usage.cost).toEqual({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      });
    } finally {
      await h.pool.dispose();
    }
  });

  it('accepts ContentBlock[] prompts and forwards them unchanged', async () => {
    const h = makePool({ promptScript: defaultPromptScript });
    try {
      const proc = await h.pool.get('devstral-small');
      const session = await proc.newSession({ cwd: CWD, mcpServer: MCP_SERVER });
      const blocks: acp.ContentBlock[] = [
        { type: 'text', text: 'look at this' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      ];
      const { result } = await collect(session.prompt(blocks));
      expect(result.stopReason).toBe('end_turn');
      const promptReq = h.agents[0].recorded.find((r) => r.method === 'session/prompt');
      if (!promptReq) throw new Error('session/prompt was not recorded');
      expect(promptReq.params.prompt).toEqual(blocks);
    } finally {
      await h.pool.dispose();
    }
  });

  it('ignores builtin and discovery tool calls for Pi mapping (still records them for permissions)', async () => {
    const script: PromptScript = async (params, agent) => {
      const sessionId = params.sessionId;
      await sendUpdate(agent, sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'effect-disc',
        title: 'Searching for relevant tools',
        status: 'in_progress',
        _meta: { [TOOL_CALL_META_TOOL_NAME]: UNIFIED_HARNESS_DISCOVERY_TOOL },
      });
      await sendUpdate(agent, sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'effect-bash',
        title: 'bash',
        status: 'in_progress',
        rawInput: { command: 'ls' },
        _meta: { [TOOL_CALL_META_TOOL_NAME]: 'file_system.bash', effect_kind: 'shell' },
      });
      await sendUpdate(agent, sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'effect-1',
        title: 'mcp_pi.pi__echo',
        status: 'in_progress',
        _meta: { [TOOL_CALL_META_TOOL_NAME]: 'mcp_pi.pi__echo' },
      });
      return { stopReason: 'end_turn' };
    };
    const h = makePool({ promptScript: script });
    try {
      const proc = await h.pool.get('devstral-small');
      const parked: string[] = [];
      const session = await proc.newSession({
        cwd: CWD,
        mcpServer: MCP_SERVER,
        onParkedToolCall: (call) => parked.push(call.name),
      });
      const { events } = await collect(session.prompt('go'));
      const toolEvents = events.filter(
        (e) => e.type === 'tool_call' || e.type === 'tool_call_update'
      );
      expect(toolEvents).toHaveLength(1);
      expect((toolEvents[0] as any).toolCall.toolCallId).toBe('effect-1');
      expect(parked).toEqual(['pi__echo']);
      // the builtin/discovery calls were recorded for permission mapping only
      expect(session.knownToolCallIds().sort()).toEqual(['effect-1', 'effect-bash', 'effect-disc']);
    } finally {
      await h.pool.dispose();
    }
  });

  it('passes parallel tool calls through with their ids', async () => {
    const script: PromptScript = async (params, agent) => {
      const sessionId = params.sessionId;
      for (const [id, text] of [
        ['effect-a', 'a'],
        ['effect-b', 'b'],
        ['effect-c', 'c'],
      ] as const) {
        await sendUpdate(agent, sessionId, {
          sessionUpdate: 'tool_call',
          toolCallId: id,
          title: `mcp_pi.pi__echo`,
          status: 'in_progress',
          rawInput: { text },
          _meta: { [TOOL_CALL_META_TOOL_NAME]: 'mcp_pi.pi__echo' },
        });
      }
      await sendUpdate(agent, sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'effect-b',
        status: 'completed',
      });
      return { stopReason: 'end_turn' };
    };
    const h = makePool({ promptScript: script });
    try {
      const proc = await h.pool.get('devstral-small');
      const session = await proc.newSession({ cwd: CWD, mcpServer: MCP_SERVER });
      const { events } = await collect(session.prompt('go'));
      const calls = events.filter((e) => e.type === 'tool_call') as any[];
      expect(calls.map((c) => c.toolCall.toolCallId)).toEqual(['effect-a', 'effect-b', 'effect-c']);
      const updates = events.filter((e) => e.type === 'tool_call_update') as any[];
      expect(updates.map((u) => [u.toolCall.toolCallId, u.toolCall.status])).toEqual([
        ['effect-b', 'completed'],
      ]);
    } finally {
      await h.pool.dispose();
    }
  });

  it('rejects a second concurrent prompt on the same session', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = makePool({ promptScript: async () => gate.then(() => ({ stopReason: 'end_turn' })) });
    try {
      const proc = await h.pool.get('devstral-small');
      const session = await proc.newSession({ cwd: CWD, mcpServer: MCP_SERVER });
      const first = session.prompt('one');
      await vi.waitFor(() => {
        expect(h.agents[0].recorded.some((r) => r.method === 'session/prompt')).toBe(true);
      });
      expect(() => session.prompt('two')).toThrow(/already in flight/);
      release();
      await first.result();
    } finally {
      await h.pool.dispose();
    }
  });
});

describe('isBridgeToolName (server-scoped, ADR-0006)', () => {
  it('accepts only the bridge server’s own mcp_<server>.pi__ display names (3.1.4 wire form)', () => {
    expect(isBridgeToolName('mcp_pi.pi__echo', 'pi')).toBe(true);
    expect(isBridgeToolName('mcp_pi.pi__slow_echo', 'pi')).toBe(true);
    // a pi__-prefixed tool of a DIFFERENT MCP server is rejected
    expect(isBridgeToolName('mcp_evil.pi__steal', 'pi')).toBe(false);
    // the bare pi__ form is not the observed _meta.tool_name form → rejected
    expect(isBridgeToolName('pi__echo', 'pi')).toBe(false);
    // builtins and the discovery pseudo-tool are not bridge tools
    expect(isBridgeToolName('file_system.bash', 'pi')).toBe(false);
    expect(isBridgeToolName(UNIFIED_HARNESS_DISCOVERY_TOOL, 'pi')).toBe(false);
    expect(isBridgeToolName(undefined, 'pi')).toBe(false);
    expect(isBridgeToolName(42, 'pi')).toBe(false);
  });

  it('normalizes the MCP server name like Vibe does ([^A-Za-z0-9_-] → _)', () => {
    expect(isBridgeToolName('mcp_my_server.pi__x', 'my server')).toBe(true);
    expect(isBridgeToolName('mcp_my_server.pi__x', 'other')).toBe(false);
  });

  it('rejects every tool name when no bridge server is configured (discovery-only process, ADR-0005)', () => {
    expect(isBridgeToolName('mcp_pi.pi__echo', undefined)).toBe(false);
    expect(isBridgeToolName(undefined, undefined)).toBe(false);
  });

  it('strips the mcp_<server>. prefix to the MCP request name for the parked call', () => {
    expect(bridgeToolRequestName('mcp_pi.pi__echo', 'pi')).toBe('pi__echo');
  });
});

describe('request_permission bridge (ADR-0006)', () => {
  it('answers allow_once for a bridge MCP tool, reject_once + anomaly for a builtin, always answers', async () => {
    const script: PromptScript = async (params, agent, fake) => {
      const sessionId = params.sessionId;
      await sendUpdate(agent, sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'effect-pi',
        title: 'mcp_pi.pi__echo',
        status: 'in_progress',
        _meta: { [TOOL_CALL_META_TOOL_NAME]: 'mcp_pi.pi__echo' },
      });
      await requestPermission(fake, sessionId, 'effect-pi');
      await sendUpdate(agent, sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'effect-bash',
        title: 'bash',
        status: 'in_progress',
        _meta: { [TOOL_CALL_META_TOOL_NAME]: 'file_system.bash' },
      });
      await requestPermission(fake, sessionId, 'effect-bash');
      await requestPermission(fake, sessionId, 'effect-unknown');
      return { stopReason: 'end_turn' };
    };
    const h = makePool({ promptScript: script });
    try {
      const proc = await h.pool.get('devstral-small');
      const session = await proc.newSession({ cwd: CWD, mcpServer: MCP_SERVER });
      const { result } = await collect(session.prompt('go'));
      expect(result.stopReason).toBe('end_turn');
      const decisions = h.agents[0].permissionRequests.map((r) => (r.response as any)?.outcome);
      // bridge tool → allow_once (never allow_always / allow_always_permanent)
      expect(decisions[0]).toEqual({ outcome: 'selected', optionId: PERMISSION_OPTION_ALLOW_ONCE });
      // builtin → reject_once AND logged anomaly
      expect(decisions[1]).toEqual({
        outcome: 'selected',
        optionId: PERMISSION_OPTION_REJECT_ONCE,
      });
      // unknown toolCallId → still answered (never left pending; cancel-hang evidence)
      expect(decisions[2]).toEqual({
        outcome: 'selected',
        optionId: PERMISSION_OPTION_REJECT_ONCE,
      });
      // both non-Pi requests were rejected AND logged as anomalies
      expect(h.anomalies).toHaveLength(2);
      expect(h.anomalies[0]).toContain('effect-bash');
      expect(h.anomalies[1]).toContain('effect-unknown');
    } finally {
      await h.pool.dispose();
    }
  });

  it('rejects pi__-prefixed tools of a different MCP server and bare pi__ names (no prefix-only mapping)', async () => {
    const script: PromptScript = async (params, agent, fake) => {
      const sessionId = params.sessionId;
      // a tool of another MCP server (e.g. inherited from the user's Vibe config)
      await sendUpdate(agent, sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'effect-evil',
        title: 'mcp_evil.pi__steal',
        status: 'in_progress',
        _meta: { [TOOL_CALL_META_TOOL_NAME]: 'mcp_evil.pi__steal' },
      });
      await requestPermission(fake, sessionId, 'effect-evil');
      // bare pi__ name without the bridge server prefix
      await sendUpdate(agent, sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'effect-bare',
        title: 'pi__evil',
        status: 'in_progress',
        _meta: { [TOOL_CALL_META_TOOL_NAME]: 'pi__evil' },
      });
      await requestPermission(fake, sessionId, 'effect-bare');
      return { stopReason: 'end_turn' };
    };
    const h = makePool({ promptScript: script });
    try {
      const proc = await h.pool.get('devstral-small');
      const session = await proc.newSession({ cwd: CWD, mcpServer: MCP_SERVER });
      const { result } = await collect(session.prompt('go'));
      expect(result.stopReason).toBe('end_turn');
      const decisions = h.agents[0].permissionRequests.map((r) => (r.response as any)?.outcome);
      expect(decisions).toEqual([
        { outcome: 'selected', optionId: PERMISSION_OPTION_REJECT_ONCE },
        { outcome: 'selected', optionId: PERMISSION_OPTION_REJECT_ONCE },
      ]);
      expect(h.anomalies).toHaveLength(2);
      expect(h.anomalies[0]).toContain('effect-evil');
      expect(h.anomalies[1]).toContain('effect-bare');
    } finally {
      await h.pool.dispose();
    }
  });
});

describe('cancel + abort watchdog', () => {
  it('kills the child after abortWatchdogMs when the prompt hangs, marks the session dirty, respawns on next use', async () => {
    const h = makePool({
      abortWatchdogMs: 50,
      promptScript: () => new Promise(() => {}), // never resolves (pending-approval hang)
    });
    try {
      const proc = await h.pool.get('devstral-small');
      const session = await proc.newSession({ cwd: CWD, mcpServer: MCP_SERVER });
      const prompt = session.prompt('go');
      await vi.waitFor(() => {
        expect(h.agents[0].recorded.some((r) => r.method === 'session/prompt')).toBe(true);
      });
      await session.cancel();
      // session/cancel was sent
      expect(h.agents[0].recorded.some((r) => r.method === 'session/cancel')).toBe(true);
      // watchdog killed the child and marked the session dirty (ADR-0003)
      expect(h.children[0].killedWith.length).toBeGreaterThan(0);
      expect(session.dirty).toBe(true);
      await expect(prompt.result()).rejects.toMatchObject({ kind: 'aborted' });
      // the dead entry is dropped: next get() respawns
      await tick();
      await h.pool.get('devstral-small');
      expect(h.spawns).toHaveLength(2);
    } finally {
      await h.pool.dispose();
    }
  });

  it('resolves with stopReason cancelled when the agent answers the cancel promptly', async () => {
    let cancelSeen!: () => void;
    const cancelPromise = new Promise<void>((r) => (cancelSeen = r));
    const h = makePool({
      abortWatchdogMs: 5_000,
      onCancel: () => cancelSeen(),
      promptScript: async () => {
        await cancelPromise;
        return { stopReason: 'cancelled' };
      },
    });
    try {
      const proc = await h.pool.get('devstral-small');
      const session = await proc.newSession({ cwd: CWD, mcpServer: MCP_SERVER });
      const prompt = session.prompt('go');
      await vi.waitFor(() => {
        expect(h.agents[0].recorded.some((r) => r.method === 'session/prompt')).toBe(true);
      });
      await session.cancel();
      const { result } = await collect(prompt);
      expect(result.stopReason).toBe('cancelled');
      expect(h.children[0].killedWith).toHaveLength(0);
      expect(session.dirty).toBe(false);
    } finally {
      await h.pool.dispose();
    }
  });
});

describe('child crash mid-prompt', () => {
  it('rejects the pending prompt, marks the session dirty and respawns on next use', async () => {
    const h = makePool({
      promptScript: async (params, agent) => {
        await sendUpdate(agent, params.sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'partial' },
        });
        h.children[0].crash(1);
        return new Promise(() => {});
      },
    });
    try {
      const proc = await h.pool.get('devstral-small');
      const session = await proc.newSession({ cwd: CWD, mcpServer: MCP_SERVER });
      const prompt = session.prompt('go');
      const events: AcpSessionEvent[] = [];
      const iter = prompt[Symbol.asyncIterator]();
      // drain events until the stream ends
      await (async () => {
        for (;;) {
          const next = await iter.next();
          if (next.done) break;
          events.push(next.value);
        }
      })();
      await expect(prompt.result()).rejects.toMatchObject({ kind: 'crashed' });
      expect(events.map((e) => e.type)).toEqual(['text_delta']);
      expect(session.dirty).toBe(true);
      expect(proc.alive).toBe(false);
      await tick();
      await h.pool.get('devstral-small');
      expect(h.spawns).toHaveLength(2);
    } finally {
      await h.pool.dispose();
    }
  });
});

describe('error classification', () => {
  it('maps quota/429 errors to the stable prefix and auth errors to the setup hint', () => {
    const quota = classifyAcpError(new Error('HTTP 429: quota exceeded for this key'));
    expect(quota).toBeInstanceOf(AcpClientError);
    expect(quota.kind).toBe('quota');
    expect(quota.message.startsWith(QUOTA_ERROR_PREFIX)).toBe(true);

    const auth = classifyAcpError(acp.RequestError.authRequired('no credentials found'));
    expect(auth.kind).toBe('auth');
    expect(auth.message).toContain('vibe-acp --setup');

    const other = classifyAcpError(new Error('boom'));
    expect(other.kind).toBe('protocol');
    expect(other.message).toContain('boom');
  });

  it('surfaces quota errors from a failing prompt with the stable prefix', async () => {
    const h = makePool({
      promptScript: async () => {
        throw new acp.RequestError(-32000, 'HTTP 429: Mistral quota exceeded, retry later');
      },
    });
    try {
      const proc = await h.pool.get('devstral-small');
      const session = await proc.newSession({ cwd: CWD, mcpServer: MCP_SERVER });
      const prompt = session.prompt('go');
      await expect(prompt.result()).rejects.toMatchObject({
        kind: 'quota',
        message: expect.stringContaining(QUOTA_ERROR_PREFIX),
      });
    } finally {
      await h.pool.dispose();
    }
  });

  it('surfaces auth errors from a failing prompt with the setup hint', async () => {
    const h = makePool({
      promptScript: async () => {
        throw acp.RequestError.authRequired('not signed in');
      },
    });
    try {
      const proc = await h.pool.get('devstral-small');
      const session = await proc.newSession({ cwd: CWD, mcpServer: MCP_SERVER });
      const prompt = session.prompt('go');
      await expect(prompt.result()).rejects.toMatchObject({ kind: 'auth' });
      await expect(prompt.result()).rejects.toThrow(/vibe-acp --setup/);
    } finally {
      await h.pool.dispose();
    }
  });
});

describe('debug log (AGENTS.md §15)', () => {
  it('writes redacted JSON-RPC lines only when debug is enabled', async () => {
    const h = makePool({ debug: true, promptScript: defaultPromptScript });
    try {
      const proc = await h.pool.get('devstral-small');
      const session = await proc.newSession({ cwd: CWD, mcpServer: MCP_SERVER });
      await collect(session.prompt('log me'));

      const files = readdirSync(h.logDir);
      expect(files.length).toBeGreaterThan(0);
      const content = files.map((f) => readFileSync(join(h.logDir, f), 'utf-8')).join('\n');
      // JSON-RPC lines are there (both directions)
      expect(content).toContain('initialize');
      expect(content).toContain('session/prompt');
      expect(content).toContain('client->agent');
      expect(content).toContain('agent->client');
      // the bearer token never appears, Authorization headers are redacted
      expect(content).not.toContain(MCP_SERVER.token);
      expect(content).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/);
      expect(content).toContain('Bearer <redacted>');
    } finally {
      await h.pool.dispose();
    }
  });

  it('writes no log file when debug is off', async () => {
    const h = makePool({ debug: false, promptScript: defaultPromptScript });
    try {
      const proc = await h.pool.get('devstral-small');
      const session = await proc.newSession({ cwd: CWD, mcpServer: MCP_SERVER });
      await collect(session.prompt('quiet'));
      expect(readdirSync(h.logDir)).toEqual([]);
    } finally {
      await h.pool.dispose();
    }
  });
});

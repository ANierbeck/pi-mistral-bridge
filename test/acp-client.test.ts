// Unit tests for src/acp-client.ts (T3). The ACP side is exercised against an
// IN-PROCESS fake ACP agent over in-memory streams (AGENTS.md §4: no real
// vibe-acp, no network). The fake agent is built with the SDK's own agent-side
// app, connected to the fake child's stdio through ndJsonStream — the same wire
// shape the real vibe-acp speaks.
import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import * as acp from '@agentclientprotocol/sdk';
import {
  AcpClientError,
  QUOTA_ERROR_PREFIX,
  VibeProcessPool,
  classifyAcpError,
  extractModelOptions,
  type AcpPrompt,
  type AcpSessionEvent,
  type PromptResult,
  type SpawnChildFn,
  type VibeChildProcess,
} from '../src/acp-client.ts';
import {
  ACP_CLIENT_NAME,
  MODEL_CONFIG_OPTION_ID,
  NEVER_SET_ENV_KEYS,
  PERMISSION_OPTION_ALLOW_ONCE,
  PERMISSION_OPTION_REJECT_ONCE,
  PROMPT_RESPONSE_USAGE,
  TOOL_CALL_META_TOOL_NAME,
  UNIFIED_HARNESS_DISCOVERY_TOOL,
  VIBE_ENV,
  buildAcpMcpServerEntry,
} from '../src/vibe-protocol.ts';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

const MCP_SERVER = {
  name: 'pi',
  url: 'http://127.0.0.1:4711/mcp',
  token: 'test-secret-token-0123456789',
};

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

// ------------------------------------------------------------------ fake child

/** A fake `vibe-acp` child: stdio pipes + an 'exit' event, no real process. */
class FakeVibeChild extends EventEmitter implements VibeChildProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  readonly killedWith: string[] = [];

  kill(signal = 'SIGTERM'): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.killedWith.push(signal);
    const sig = signal as NodeJS.Signals;
    queueMicrotask(() => {
      this.signalCode = sig;
      this.exitCode = sig === 'SIGKILL' ? null : 0;
      this.emit('exit', this.exitCode, this.signalCode);
      this.stdout.end();
      this.stdin.end();
      this.stderr.end();
    });
    return true;
  }

  /** Simulate an unexpected crash: 'exit' + EOF on the pipes, no kill(). */
  crash(code = 1): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    queueMicrotask(() => {
      this.emit('exit', code, null);
      this.stdout.end();
      this.stdin.end();
    });
  }
}

// ---------------------------------------------------------------- fake agent

type PromptScript = (
  params: acp.PromptRequest,
  agent: acp.AgentContext,
  fake: FakeAgent
) => Promise<unknown>;

interface FakeAgent {
  conn: acp.AgentConnection;
  recorded: Array<{ method: string; params: any }>;
  permissionRequests: Array<{ params: any; response: any }>;
  agentCtx: acp.AgentContext | null;
  close(): void;
}

interface FakeAgentOptions {
  child: FakeVibeChild;
  behavior: FakeBehavior;
}

interface FakeBehavior {
  promptScript?: PromptScript;
  onCancel?: () => void;
  /** When set, the fake agent's initialize handler throws (start must not orphan the child). */
  failInitialize?: boolean;
  /** When set, the fake agent's initialize handler awaits this first (lets a test dispose mid-start). */
  onInitialize?: () => Promise<void>;
}

function startFakeAgent(opts: FakeAgentOptions): FakeAgent {
  const { child, behavior } = opts;
  const recorded: FakeAgent['recorded'] = [];
  const permissionRequests: FakeAgent['permissionRequests'] = [];
  const fake: FakeAgent = {
    conn: null as unknown as acp.AgentConnection,
    recorded,
    permissionRequests,
    agentCtx: null,
    close: () => fake.conn.close(),
  };
  // The agent reads what the client wrote into child.stdin and writes its
  // answers to child.stdout — exactly the wire a spawned vibe-acp sees.
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdin) as ReadableStream<Uint8Array>
  );
  const app = acp
    .agent({ name: 'fake-vibe-acp' })
    .onRequest(acp.AGENT_METHODS.initialize, async ({ params }) => {
      recorded.push({ method: 'initialize', params });
      await behavior.onInitialize?.();
      if (behavior.failInitialize) throw acp.RequestError.internalError('fake initialize failure');
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          sessionCapabilities: { list: {}, fork: {}, close: {} },
        },
        agentInfo: { name: 'fake-vibe', title: 'Fake Vibe', version: '0.0.0-test' },
      };
    })
    .onRequest(acp.AGENT_METHODS.session_new, async ({ params }) => {
      recorded.push({ method: 'session/new', params });
      return {
        sessionId: 'sess-1',
        modes: {
          currentModeId: 'ask',
          availableModes: [
            { id: 'ask', name: 'Ask' },
            { id: 'accept-edits', name: 'Accept edits' },
          ],
        },
        configOptions: [
          {
            id: 'mode',
            category: 'mode',
            type: 'select',
            name: 'Mode',
            currentValue: 'ask',
            options: [{ value: 'ask', name: 'Ask' }],
          },
          {
            id: MODEL_CONFIG_OPTION_ID,
            category: 'model',
            type: 'select',
            name: 'Model',
            currentValue: 'devstral-small',
            options: [
              {
                value: 'devstral-small',
                name: 'Devstral Small',
                description: 'devstral-small-latest',
              },
              {
                value: 'mistral-medium-3.5',
                name: 'Mistral Medium 3.5',
                description: 'mistral-medium-3.5',
              },
            ],
          },
        ],
        _meta: { workspace_trust: { status: 'trusted', details: null } },
      };
    })
    .onRequest(acp.AGENT_METHODS.session_prompt, async ({ params, client }) => {
      recorded.push({ method: 'session/prompt', params });
      fake.agentCtx = client;
      if (behavior.promptScript) return behavior.promptScript(params, client, fake);
      return { stopReason: 'end_turn' };
    })
    .onRequest(acp.AGENT_METHODS.session_close, async ({ params }) => {
      recorded.push({ method: 'session/close', params });
      return {};
    })
    .onRequest('*', async ({ method }) => {
      throw acp.RequestError.methodNotFound(method);
    })
    .onNotification(acp.AGENT_METHODS.session_cancel, async ({ params }) => {
      recorded.push({ method: 'session/cancel', params });
      behavior.onCancel?.();
    })
    .onNotification('*', async () => {
      // unknown extension notifications must be ignored, not error
    });
  fake.conn = app.connect(stream);
  return fake;
}

async function sendUpdate(
  agent: acp.AgentContext,
  sessionId: string,
  update: acp.SessionUpdate
): Promise<void> {
  await agent.notify(acp.CLIENT_METHODS.session_update, { sessionId, update });
}

async function requestPermission(
  fake: FakeAgent,
  sessionId: string,
  toolCallId: string
): Promise<unknown> {
  const response = await fake.agentCtx!.request(acp.CLIENT_METHODS.session_request_permission, {
    sessionId,
    toolCall: { toolCallId },
    options: [
      { optionId: PERMISSION_OPTION_ALLOW_ONCE, name: 'Allow once', kind: 'allow_once' },
      { optionId: 'allow_always', name: 'Allow always', kind: 'allow_always' },
      { optionId: 'allow_always_permanent', name: 'Allow always', kind: 'allow_always' },
      { optionId: PERMISSION_OPTION_REJECT_ONCE, name: 'Reject once', kind: 'reject_once' },
    ],
  });
  fake.permissionRequests.push({ params: { sessionId, toolCallId }, response });
  return response;
}

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
  const children: FakeVibeChild[] = [];
  const spawns: Harness['spawns'] = [];
  const agents: FakeAgent[] = [];
  const anomalies: string[] = [];
  const behavior: FakeBehavior = {
    promptScript: opts.promptScript,
    onCancel: opts.onCancel,
    failInitialize: opts.failInitialize,
    onInitialize: opts.onInitialize,
  };
  const logDir = opts.logDir ?? mkdtempSync(join(tmpdir(), 'pi-mistral-bridge-acp-logs-'));
  const spawnChild: SpawnChildFn = (command, args, env) => {
    spawns.push({ command, args, env });
    const child = new FakeVibeChild();
    children.push(child);
    agents.push(startFakeAgent({ child, behavior }));
    return child;
  };
  const pool = new VibeProcessPool({
    vibeAcpPath: 'vibe-acp',
    processIdleTimeoutMs: opts.processIdleTimeoutMs ?? 600_000,
    abortWatchdogMs: opts.abortWatchdogMs ?? 5_000,
    debug: opts.debug ?? false,
    mcpServer: MCP_SERVER,
    logDir,
    spawnChild,
    onAnomaly: (message) => anomalies.push(message),
  });
  return { pool, children, spawns, agents, anomalies, behavior, logDir };
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
    _meta: { [TOOL_CALL_META_TOOL_NAME]: 'pi__echo', effect_kind: 'tool' },
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
      expect(newReq.params.cwd).toBe(CWD);
      // the bridge MCP server is offered as an ACP http entry with the bearer header
      expect(newReq.params.mcpServers).toEqual([buildAcpMcpServerEntry(MCP_SERVER)]);
      expect(newReq.params.mcpServers[0].type).toBe('http');
    } finally {
      await h.pool.dispose();
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
        _meta: { [TOOL_CALL_META_TOOL_NAME]: 'pi__echo' },
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
          _meta: { [TOOL_CALL_META_TOOL_NAME]: 'pi__echo' },
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

describe('request_permission bridge (ADR-0006)', () => {
  it('answers allow_once for a bridge MCP tool, reject_once + anomaly for a builtin, always answers', async () => {
    const script: PromptScript = async (params, agent, fake) => {
      const sessionId = params.sessionId;
      await sendUpdate(agent, sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'effect-pi',
        title: 'mcp_pi.pi__echo',
        status: 'in_progress',
        _meta: { [TOOL_CALL_META_TOOL_NAME]: 'pi__echo' },
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

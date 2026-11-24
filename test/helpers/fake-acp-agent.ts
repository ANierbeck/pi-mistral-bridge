// Shared in-process fake ACP agent for the ACP-side tests (AGENTS.md §4: no
// real `vibe-acp`, no network beyond 127.0.0.1). Extracted from
// test/acp-client.test.ts so the provider (T5 slice C1) and the extension
// entry (T5 slice C2) drive the same fake wire: the SDK's own agent-side app
// connected to a fake child's stdio through ndJsonStream — exactly the wire
// shape the real `vibe-acp` speaks.
import { EventEmitter } from 'node:events';
import { PassThrough, Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type { SpawnChildFn, VibeChildProcess } from '../../src/acp-client.ts';
import {
  MODEL_CONFIG_OPTION_ID,
  PERMISSION_OPTION_ALLOW_ONCE,
  PERMISSION_OPTION_REJECT_ONCE,
} from '../../src/vibe-protocol.ts';

// ------------------------------------------------------------------ fake child

/** A fake `vibe-acp` child: stdio pipes + an 'exit' event, no real process. */
export class FakeVibeChild extends EventEmitter implements VibeChildProcess {
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

export type PromptScript = (
  params: acp.PromptRequest,
  agent: acp.AgentContext,
  fake: FakeAgent
) => Promise<unknown>;

export interface FakeAgent {
  conn: acp.AgentConnection;
  recorded: Array<{ method: string; params: any }>;
  permissionRequests: Array<{ params: any; response: any }>;
  agentCtx: acp.AgentContext | null;
  /**
   * Number of `session/prompt` requests seen so far across the whole harness
   * (1 = very first prompt). Lets a promptScript run a tool-parking body only
   * on the first prompt, so a rebuild/steering/model-switch second prompt does
   * not park again.
   */
  promptCount: number;
  close(): void;
}

export interface FakeAgentOptions {
  child: FakeVibeChild;
  behavior: FakeBehavior;
  /**
   * Shared prompt counter across all agents of one harness (one per spawn):
   * a rebuild on a NEW model spawns a new agent whose own count would restart
   * at 1, so parking gates must use this harness-wide count.
   */
  promptCounter?: { count: number } | undefined;
}

export interface FakeBehavior {
  promptScript?: PromptScript | undefined;
  onCancel?: (() => void) | undefined;
  /** When set, the fake agent's initialize handler throws (start must not orphan the child). */
  failInitialize?: boolean | undefined;
  /** When set, the fake agent's initialize handler awaits this first (lets a test dispose mid-start). */
  onInitialize?: (() => Promise<void>) | undefined;
  /** The `sessionId` the fake hands out; default 'sess-1'. */
  sessionId?: string | undefined;
  /** The `model` config-option entries of `session/new` (alias = value, API id = description). */
  modelOptions?: acp.SessionConfigSelectOption[] | undefined;
}

/** Default `model` config-option entries (tests may use model literals freely, AGENTS.md §9). */
export const DEFAULT_MODEL_OPTIONS: acp.SessionConfigSelectOption[] = [
  { value: 'devstral-small', name: 'Devstral Small', description: 'devstral-small-latest' },
  { value: 'mistral-medium-3.5', name: 'Mistral Medium 3.5', description: 'mistral-medium-3.5' },
];

export function startFakeAgent(opts: FakeAgentOptions): FakeAgent {
  const { child, behavior } = opts;
  const recorded: FakeAgent['recorded'] = [];
  const permissionRequests: FakeAgent['permissionRequests'] = [];
  const sessionId = behavior.sessionId ?? 'sess-1';
  const modelOptions = behavior.modelOptions ?? DEFAULT_MODEL_OPTIONS;
  const fake: FakeAgent = {
    conn: null as unknown as acp.AgentConnection,
    recorded,
    permissionRequests,
    agentCtx: null,
    promptCount: 0,
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
        sessionId,
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
            currentValue: modelOptions[0]?.value ?? '',
            options: modelOptions,
          },
        ],
        _meta: { workspace_trust: { status: 'trusted', details: null } },
      };
    })
    .onRequest(acp.AGENT_METHODS.session_prompt, async ({ params, client }) => {
      recorded.push({ method: 'session/prompt', params });
      fake.agentCtx = client;
      fake.promptCount = opts.promptCounter ? ++opts.promptCounter.count : fake.promptCount + 1;
      if (behavior.promptScript)
        return (await behavior.promptScript(params, client, fake)) as acp.PromptResponse;
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

export async function sendUpdate(
  agent: acp.AgentContext,
  sessionId: string,
  update: acp.SessionUpdate
): Promise<void> {
  await agent.notify(acp.CLIENT_METHODS.session_update, { sessionId, update });
}

export async function requestPermission(
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

/** A `spawnChild` factory wired to fake children + fake agents (test injection). */
export interface FakeSpawnHarness {
  children: FakeVibeChild[];
  agents: FakeAgent[];
  spawns: Array<{ command: string; args: string[]; env: Record<string, string> }>;
  behavior: FakeBehavior;
  /** Harness-wide `session/prompt` count (across all spawned agents). */
  promptCount: () => number;
  spawnChild: SpawnChildFn;
}

export function makeFakeSpawn(behavior: FakeBehavior = {}): FakeSpawnHarness {
  const promptCounter = { count: 0 };
  const harness: FakeSpawnHarness = {
    children: [],
    agents: [],
    spawns: [],
    behavior,
    promptCount: () => promptCounter.count,
    spawnChild: (command, args, env) => {
      harness.spawns.push({ command, args, env });
      const child = new FakeVibeChild();
      harness.children.push(child);
      harness.agents.push(startFakeAgent({ child, behavior, promptCounter }));
      return child;
    },
  };
  return harness;
}

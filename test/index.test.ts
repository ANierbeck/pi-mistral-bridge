// Unit tests for src/index.ts (T5 slice C2): extension entry, model discovery
// from the ACP `model` config option (ADR-0005/0007) and lifecycle wiring.
// The ACP side is the shared in-process fake ACP agent (no real vibe-acp,
// AGENTS.md §4); `pi` is a minimal fake ExtensionAPI capturing registrations
// and event handlers.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  normalizeContext,
  type Api,
  type AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import type { BridgeConfig } from '../src/config.ts';
import {
  BRIDGE_API,
  FALLBACK_CONTEXT_WINDOW,
  FALLBACK_MAX_TOKENS,
  registerMistralProvider,
} from '../src/index.ts';
import { VIBE_ENV } from '../src/vibe-protocol.ts';
import {
  DEFAULT_MODEL_OPTIONS,
  makeFakeSpawn,
  type FakeSpawnHarness,
} from './helpers/fake-acp-agent.ts';

const CWD = mkdtempSync(join(tmpdir(), 'pi-mistral-bridge-index-cwd-'));
const LOG_DIR = mkdtempSync(join(tmpdir(), 'pi-mistral-bridge-index-logs-'));

const CONFIG: BridgeConfig = {
  vibeAcpPath: 'vibe-acp',
  providerName: 'mistral-vibe',
  askVibe: { enabled: false, defaultMode: 'ask', autoApprove: false },
  debug: false,
  processIdleTimeoutMs: 600_000,
  toolPreTimeoutMs: 1_500,
  abortWatchdogMs: 5_000,
};

const MODEL: Model<Api> = {
  id: 'devstral-small-latest',
  name: 'Devstral Small',
  api: BRIDGE_API,
  provider: 'mistral-vibe',
  baseUrl: 'vibe-acp',
  input: ['text'],
  reasoning: false,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
};

// ------------------------------------------------------------------- fake pi

interface FakePi {
  pi: ExtensionAPI;
  registrations: Array<{ name: string; config: any }>;
  handlers: Map<string, (event: any, ctx: any) => unknown>;
}

function makeFakePi(): FakePi {
  const registrations: FakePi['registrations'] = [];
  const handlers: FakePi['handlers'] = new Map();
  const pi = {
    registerProvider: (name: string, config: unknown) => {
      registrations.push({ name, config });
    },
    on: (event: string, handler: (event: any, ctx: any) => unknown) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
  } as unknown as ExtensionAPI;
  return { pi, registrations, handlers };
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
): Promise<{ types: string[]; stopReason: string }> {
  const types: string[] = [];
  for await (const event of stream) types.push(event.type);
  const message = await stream.result();
  return { types, stopReason: message.stopReason };
}

function ctxOf(text: string): TranscriptContext {
  return normalizeContext({
    systemPrompt: 'sys',
    messages: [{ role: 'user', content: text, timestamp: 1 }],
    tools: [],
  });
}

// --------------------------------------------------------------------- tests

describe('registerMistralProvider: model discovery + registration (ADR-0005/0007)', () => {
  it('discovers the model list from the session/new model config option (no hardcoded ids) and registers the provider with cost 0 models + streamSimple', async () => {
    const fake = makeFakeSpawn({
      // custom option list proves the registered models are derived, not literal
      modelOptions: [
        { value: 'alias-one', name: 'Model One', description: 'api-id-one' },
        { value: 'alias-two', name: 'Model Two', description: 'api-id-two' },
      ],
    });
    const { pi, registrations } = makeFakePi();
    const warns: string[] = [];
    const provider = registerMistralProvider(pi, CONFIG, {
      cwd: CWD,
      spawnChild: fake.spawnChild,
      logDir: LOG_DIR,
      onWarn: (m) => warns.push(m),
    });
    try {
      await waitFor(() => registrations.length === 1, 'provider registration');
      expect(warns).toEqual([]);

      const { name, config } = registrations[0];
      expect(name).toBe('mistral-vibe');
      // models come from the fake configOptions: id = API id (description), alias = value
      expect(config.models).toEqual([
        {
          id: 'api-id-one',
          name: 'Model One',
          input: ['text'],
          reasoning: false,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: FALLBACK_CONTEXT_WINDOW,
          maxTokens: FALLBACK_MAX_TOKENS,
        },
        {
          id: 'api-id-two',
          name: 'Model Two',
          input: ['text'],
          reasoning: false,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: FALLBACK_CONTEXT_WINDOW,
          maxTokens: FALLBACK_MAX_TOKENS,
        },
      ]);
      expect(typeof config.streamSimple).toBe('function');
      expect(config.api).toBe(BRIDGE_API);

      // the discovery process ran on Vibe's default model with no MCP server
      expect(fake.spawns).toHaveLength(1);
      expect(fake.spawns[0].env[VIBE_ENV.ACTIVE_MODEL]).toBeUndefined();
      expect(fake.spawns[0].env[VIBE_ENV.MCP_SERVERS]).toBeUndefined();
      const newReq = fake.agents[0].recorded.find((r) => r.method === 'session/new');
      expect(newReq?.params.mcpServers).toEqual([]);
      // ... and was terminated after reading the model option (no orphan)
      expect(fake.children[0].killedWith.length).toBeGreaterThan(0);

      // the alias map is wired: Pi model id (API id) → Vibe alias (pool key)
      expect(provider.modelAliasFor({ ...MODEL, id: 'api-id-one' })).toBe('alias-one');
    } finally {
      await provider.dispose();
    }
  });

  it('registers nothing and logs a clear message when discovery fails', async () => {
    const fake = makeFakeSpawn({ failInitialize: true });
    const { pi, registrations } = makeFakePi();
    const warns: string[] = [];
    const provider = registerMistralProvider(pi, CONFIG, {
      cwd: CWD,
      spawnChild: fake.spawnChild,
      logDir: LOG_DIR,
      onWarn: (m) => warns.push(m),
    });
    try {
      await waitFor(() => warns.length === 1, 'discovery failure warning');
      expect(registrations).toEqual([]);
      expect(warns[0]).toContain('model discovery failed');
      expect(warns[0]).toContain('vibe-acp --setup');
      // the failed child was killed, not orphaned (AGENTS.md §15)
      expect(fake.children[0].killedWith.length).toBeGreaterThan(0);
    } finally {
      await provider.dispose();
    }
  });

  it("refuses to shadow Pi's builtin mistral provider (AGENTS.md §6)", async () => {
    const fake = makeFakeSpawn();
    const { pi, registrations } = makeFakePi();
    const warns: string[] = [];
    const provider = registerMistralProvider(
      pi,
      { ...CONFIG, providerName: 'mistral' },
      { cwd: CWD, spawnChild: fake.spawnChild, logDir: LOG_DIR, onWarn: (m) => warns.push(m) }
    );
    try {
      await waitFor(() => warns.length === 1, 'shadow warning');
      expect(registrations).toEqual([]);
      expect(warns[0]).toContain('mistral');
      expect(fake.spawns).toHaveLength(0); // no discovery process needed
    } finally {
      await provider.dispose();
    }
  });
});

describe('extension lifecycle wiring (session_start / session_shutdown)', () => {
  it('streamSimple works through the registered provider and session_shutdown disposes pool + bridge (no orphaned children)', async () => {
    const fake: FakeSpawnHarness = makeFakeSpawn(); // default prompt: immediate end_turn
    const { pi, registrations, handlers } = makeFakePi();
    const provider = registerMistralProvider(pi, CONFIG, {
      cwd: CWD,
      spawnChild: fake.spawnChild,
      logDir: LOG_DIR,
      onWarn: () => {},
    });
    try {
      await waitFor(() => registrations.length === 1, 'provider registration');
      expect(handlers.has('session_start')).toBe(true);
      expect(handlers.has('session_shutdown')).toBe(true);

      // a full text turn through the registered streamSimple (pool spawns a
      // second child with the bridge MCP server in its env)
      const stream = registrations[0].config.streamSimple(MODEL, ctxOf('hi'), {
        sessionId: 'pi-1',
      } satisfies Partial<SimpleStreamOptions>) as AssistantMessageEventStream;
      const result = await collectStream(stream);
      expect(result.types).toEqual(['start', 'done']);
      expect(result.stopReason).toBe('stop');
      await waitFor(() => fake.spawns.length === 2, 'pool spawn');
      const poolEnv = fake.spawns[1].env;
      expect(poolEnv[VIBE_ENV.ACTIVE_MODEL]).toBe('devstral-small'); // default alias of option 1
      expect(poolEnv[VIBE_ENV.MCP_SERVERS]).toBeDefined();

      // session_shutdown disposes the pool (kills every child) — no orphans
      await handlers.get('session_shutdown')!({ type: 'session_shutdown', reason: 'quit' }, {});
      await waitFor(
        () => fake.children.every((c) => c.killedWith.length > 0),
        'all children killed'
      );
    } finally {
      await provider.dispose();
    }
  });
});

describe('AGENTS.md §9: no hardcoded model ids in shipped src', () => {
  it('src/index.ts derives every model from the ACP model config option and names no concrete model', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf-8');
    for (const option of DEFAULT_MODEL_OPTIONS) {
      expect(source).not.toContain(option.value);
      if (typeof option.description === 'string') expect(source).not.toContain(option.description);
    }
    // the model list is read via the pinned config-option id
    expect(source).toContain('modelOptions');
  });
});

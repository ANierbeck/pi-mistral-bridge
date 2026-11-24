// Unit tests for src/index.ts (T5 slice C2): extension entry, model discovery
// from the ACP `model` config option (ADR-0005/0007) and lifecycle wiring.
// The ACP side is the shared in-process fake ACP agent (no real vibe-acp,
// AGENTS.md §4); `pi` is a minimal fake ExtensionAPI capturing registrations
// and event handlers.
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  bridgeExtension,
  FALLBACK_CONTEXT_WINDOW,
  FALLBACK_MAX_TOKENS,
  registerMistralProvider,
  reservedProviderNames,
  wireExtension,
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
  providerName: 'mistral-bridge',
  askVibe: { enabled: false, defaultMode: 'ask', autoApprove: false },
  debug: false,
  processIdleTimeoutMs: 600_000,
  toolPreTimeoutMs: 1_500,
  abortWatchdogMs: 5_000,
  discoveryTimeoutMs: 30_000,
  startupDiscoveryTimeoutMs: 30_000,
  modelRefreshIntervalMs: 600_000,
};

const MODEL: Model<Api> = {
  id: 'devstral-small-latest',
  name: 'Devstral Small',
  api: BRIDGE_API,
  provider: 'mistral-bridge',
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
  tools: Array<{ name: string; definition: any }>;
  handlers: Map<string, (event: any, ctx: any) => unknown>;
}

function makeFakePi(): FakePi {
  const registrations: FakePi['registrations'] = [];
  const tools: FakePi['tools'] = [];
  const handlers: FakePi['handlers'] = new Map();
  const pi = {
    registerProvider: (name: string, config: unknown) => {
      registrations.push({ name, config });
    },
    registerTool: (definition: any) => {
      tools.push({ name: definition.name, definition });
    },
    on: (event: string, handler: (event: any, ctx: any) => unknown) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
  } as unknown as ExtensionAPI;
  return { pi, registrations, tools, handlers };
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
      expect(name).toBe('mistral-bridge');
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

  it('refuses any providerName colliding with a Pi builtin provider, not just mistral (AGENTS.md §6)', async () => {
    const fake = makeFakeSpawn();
    const { pi, registrations } = makeFakePi();
    const warns: string[] = [];
    const provider = registerMistralProvider(
      pi,
      { ...CONFIG, providerName: 'anthropic' },
      { cwd: CWD, spawnChild: fake.spawnChild, logDir: LOG_DIR, onWarn: (m) => warns.push(m) }
    );
    try {
      await waitFor(() => warns.length === 1, 'collision warning');
      expect(registrations).toEqual([]); // nothing registered: no shadowing
      expect(warns[0]).toContain('anthropic');
      expect(warns[0]).toContain('collides');
      expect(fake.spawns).toHaveLength(0); // no discovery process needed
    } finally {
      await provider.dispose();
    }
  });

  it('reservedProviderNames covers the Pi builtin catalog incl. mistral, but not the bridge default name', () => {
    const reserved = reservedProviderNames();
    expect(reserved.has('mistral')).toBe(true);
    expect(reserved.has('anthropic')).toBe(true);
    expect(reserved.has('openai')).toBe(true);
    expect(reserved.has('google')).toBe(true);
    expect(reserved.has('mistral-bridge')).toBe(false);
  });

  it('kills a hung discovery child after discoveryTimeoutMs and registers nothing', async () => {
    const fake = makeFakeSpawn({
      // initialize never answers: the discovery process hangs mid-handshake
      onInitialize: () => new Promise(() => {}),
    });
    const { pi, registrations } = makeFakePi();
    const warns: string[] = [];
    const provider = registerMistralProvider(
      pi,
      { ...CONFIG, discoveryTimeoutMs: 120 },
      { cwd: CWD, spawnChild: fake.spawnChild, logDir: LOG_DIR, onWarn: (m) => warns.push(m) }
    );
    try {
      await waitFor(() => warns.length === 1, 'discovery timeout warning', 5_000);
      expect(registrations).toEqual([]); // nothing registered on timeout
      expect(warns[0]).toContain('model discovery failed');
      expect(warns[0]).toContain('timed out after 120 ms');
      // the hung child was killed by the timeout, not orphaned (AGENTS.md §15)
      expect(fake.children[0].killedWith.length).toBeGreaterThan(0);
    } finally {
      await provider.dispose();
    }
  });

  it('dispose() during discovery kills the discovery child and never calls registerProvider', async () => {
    const fake = makeFakeSpawn({
      onInitialize: () => new Promise(() => {}), // hangs until killed
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
      await waitFor(() => fake.spawns.length === 1, 'discovery child spawned');
      await provider.dispose(); // session_shutdown while discovery is in flight
      await waitFor(() => fake.children[0].killedWith.length > 0, 'discovery child killed', 5_000);
      await sleep(300); // let the aborted discovery reject and the catch handler run
      // the dispose-abort is an intentional shutdown, not a discovery failure:
      // no "model discovery failed" warning (see the quiet-shutdown test below)
      expect(warns.filter((m) => m.includes('model discovery failed'))).toEqual([]);
      expect(registrations).toEqual([]); // the disposed check before registerProvider held
    } finally {
      await provider.dispose();
    }
  });

  it('dispose() during the initial discovery is a quiet shutdown: no "model discovery failed" warning', async () => {
    const fake = makeFakeSpawn({
      onInitialize: () => new Promise(() => {}), // hangs until killed
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
      await waitFor(() => fake.spawns.length === 1, 'discovery child spawned');
      await provider.dispose(); // session_shutdown while discovery is in flight
      await waitFor(() => fake.children[0].killedWith.length > 0, 'discovery child killed', 5_000);
      await sleep(300); // let the aborted discovery reject and the catch handler run
      // The abort is the catalog's own dispose() — an intentional shutdown that
      // killed the child (AGENTS.md §15), not a discovery failure — so the
      // "model discovery failed" error must NOT be logged.
      expect(warns.filter((m) => m.includes('model discovery failed'))).toEqual([]);
      expect(registrations).toEqual([]); // nothing registered
    } finally {
      await provider.dispose();
    }
  });
});

// ---------------------------------------------------- async factory (startup race)
//
// Pi awaits an async extension factory before session_start and before queued
// registerProvider calls are flushed (pi-coding-agent docs/extensions.md,
// "Async factory functions"). The factory's returned promise therefore must
// NOT resolve before the FIRST model discovery resolves — and must still
// resolve after `startupDiscoveryTimeoutMs` when the discovery never does.

describe('async extension factory: bounded await of the first model discovery', () => {
  it('the default export is an async factory, so Pi awaits the returned promise before session_start / registerProvider flush', async () => {
    const mod = await import('../src/index.ts');
    expect(typeof mod.default).toBe('function');
    // an async function returns a Promise — that is Pi's await point
    expect(mod.default.constructor.name).toBe('AsyncFunction');
  });

  it('the factory promise does not resolve before the first discovery resolves (models registered before Pi first render)', async () => {
    let releaseInit!: () => void;
    const initGate = new Promise<void>((resolve) => {
      releaseInit = resolve;
    });
    const fake = makeFakeSpawn({ onInitialize: () => initGate }); // discovery gated on initialize
    const { pi, registrations } = makeFakePi();
    const warns: string[] = [];
    let factoryResolved = false;
    const config: BridgeConfig = { ...CONFIG, discoveryTimeoutMs: 2_000 };
    const factoryPromise = bridgeExtension(pi, config, {
      cwd: CWD,
      spawnChild: fake.spawnChild,
      logDir: LOG_DIR,
      onWarn: (m) => warns.push(m),
    }).then((wired) => {
      factoryResolved = true;
      return wired;
    });
    try {
      await waitFor(() => fake.spawns.length === 1, 'discovery child spawned');
      await sleep(100); // initialize still gated: the first discovery is unresolved
      expect(factoryResolved).toBe(false); // the factory must still be waiting
      expect(registrations).toEqual([]); // nothing registered yet
      releaseInit();
      const wired = await factoryPromise;
      expect(factoryResolved).toBe(true);
      // the provider was registered BEFORE the factory promise resolved
      expect(registrations).toHaveLength(1);
      expect(registrations[0].name).toBe('mistral-bridge');
      expect(warns).toEqual([]);
      await wired.provider.dispose();
    } finally {
      releaseInit(); // idempotent: a failing test must not hang on the gate
      await factoryPromise.then(
        (w) => w.provider.dispose(),
        () => {}
      );
    }
  });

  it('the factory promise DOES resolve after startupDiscoveryTimeoutMs when the discovery never resolves (quiet warning; the background discovery keeps running)', async () => {
    const fake = makeFakeSpawn({
      onInitialize: () => new Promise(() => {}), // hangs until killed
    });
    const { pi, registrations } = makeFakePi();
    const warns: string[] = [];
    const config: BridgeConfig = {
      ...CONFIG,
      startupDiscoveryTimeoutMs: 150,
      discoveryTimeoutMs: 60_000,
    };
    const start = Date.now();
    const wired = await bridgeExtension(pi, config, {
      cwd: CWD,
      spawnChild: fake.spawnChild,
      logDir: LOG_DIR,
      onWarn: (m) => warns.push(m),
    });
    const elapsed = Date.now() - start;
    try {
      expect(elapsed).toBeGreaterThanOrEqual(140);
      expect(elapsed).toBeLessThan(5_000);
      expect(registrations).toEqual([]); // discovery still in flight: nothing registered yet
      expect(warns).toHaveLength(1); // a QUIET warning, not an error
      expect(warns[0]).toContain('150 ms');
      expect(warns[0]).toContain('continuing startup');
      expect(warns[0]).not.toContain('model discovery failed');
      // the startup timeout did NOT kill the discovery child — it keeps running
      expect(fake.children[0].killedWith).toEqual([]);
      await wired.provider.dispose();
      await waitFor(() => fake.children[0].killedWith.length > 0, 'discovery child killed', 5_000);
      await sleep(200); // let the aborted discovery's catch handler run
      expect(warns).toHaveLength(1); // still just the startup warning: quiet shutdown
    } finally {
      await wired.provider.dispose();
    }
  });

  it('dispose during the startup wait stays silent (no startup-timeout warning, no discovery-failure warning — 828f223 behavior)', async () => {
    const fake = makeFakeSpawn({
      onInitialize: () => new Promise(() => {}), // hangs until killed
    });
    const { pi, registrations } = makeFakePi();
    const warns: string[] = [];
    const config: BridgeConfig = {
      ...CONFIG,
      startupDiscoveryTimeoutMs: 60_000,
      discoveryTimeoutMs: 60_000,
    };
    const { provider, startupReady } = wireExtension(pi, config, {
      cwd: CWD,
      spawnChild: fake.spawnChild,
      logDir: LOG_DIR,
      onWarn: (m) => warns.push(m),
    });
    await waitFor(() => fake.spawns.length === 1, 'discovery child spawned');
    await provider.dispose(); // session_shutdown while the factory would still be waiting
    await startupReady; // resolves quietly: the dispose-abort is an intentional shutdown
    await waitFor(() => fake.children[0].killedWith.length > 0, 'discovery child killed', 5_000);
    await sleep(200); // let the aborted discovery's catch handler run
    expect(warns).toEqual([]);
    expect(registrations).toEqual([]);
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

// AGENTS.md §9 (ADR-0005): shipped src/ must not name a concrete Mistral
// model id in any position that admits, selects, ranks or excludes a model —
// the model list is derived from what vibe-acp reports for the session (the
// `model` config option). Tests may use model literals freely (§9), so only
// src/ is scanned, never test/ or scripts/.
//
// The pattern/allow style mirrors scripts/forbidden-patterns.ts: every
// pattern carries a WHY comment, and the strings that are allowed on purpose
// (provider names, the bridge's own config keys) are listed explicitly with
// their reason — like the case-sensitive owner-handle pattern there, which
// deliberately lets the capitalized legal name in LICENSE/package.json pass.
const MODEL_ID_PATTERNS: ReadonlyArray<{ name: string; re: RegExp; why: string }> = [
  // "mistral/<id>" is a Pi model reference.
  {
    name: 'provider-prefixed model ref',
    re: /mistral\//,
    why: '"mistral/<model-id>" selects a model',
  },
  { name: 'mistral-large id', re: /mistral-large/, why: 'concrete mistral-large-* model id' },
  { name: 'mistral-medium id', re: /mistral-medium/, why: 'concrete mistral-medium-* model id' },
  { name: 'mistral-small id', re: /mistral-small/, why: 'concrete mistral-small-* model id' },
  { name: 'open-mistral id', re: /open-mistral/, why: 'concrete open-mistral-* model id' },
  { name: 'devstral id', re: /devstral/, why: 'concrete devstral-* model id' },
  { name: 'ministral id', re: /ministral/, why: 'concrete ministral-* model id' },
  { name: 'pixtral id', re: /pixtral/, why: 'concrete pixtral-* model id' },
  { name: 'codestral id', re: /codestral/, why: 'concrete codestral-* model id' },
  { name: 'glm id', re: /glm-/, why: '"glm-<version>" used as a model ref' },
];

// Allowed on purpose (AGENTS.md §6): the provider NAME strings and the
// bridge's own config keys are not model references. The guard test below
// fails if a future pattern ever matches one of them.
const ALLOWED_MODEL_TOKENS: readonly string[] = [
  "'mistral'", // Pi's builtin provider name (PI_BUILTIN_MISTRAL_PROVIDER, src/index.ts)
  "'mistral-bridge'", // the bridge's own default provider name (DEFAULT_PROVIDER_NAME, src/config.ts)
  'mistral-bridge', // config file name / log dir / bridge config keys (mistral-bridge.json)
  'pi-mistral-bridge', // ACP client identity (AGENTS.md §14, ACP_CLIENT_NAME)
  'mistral.vibe.', // vibe-acp extension _meta key namespace (src/vibe-protocol.ts)
];

describe('AGENTS.md §9: no hardcoded model ids in shipped src', () => {
  const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));
  // Recursive over src/: a model literal in ANY shipped file must be caught,
  // not just in the entry point.
  const srcFiles = readdirSync(SRC_DIR, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith('.ts'))
    .sort();

  it('scans every src/**/*.ts file, not just src/index.ts', () => {
    expect(srcFiles).toContain('index.ts');
    expect(srcFiles.length).toBeGreaterThan(1);
  });

  it('no src file names a concrete model id; provider names and config keys stay allowed', () => {
    const hits: string[] = [];
    for (const file of srcFiles) {
      const source = readFileSync(join(SRC_DIR, file), 'utf-8');
      for (const { name, re, why } of MODEL_ID_PATTERNS) {
        if (re.test(source)) hits.push(`${file}: pattern "${name}" matched (${why})`);
      }
      for (const option of DEFAULT_MODEL_OPTIONS) {
        if (source.includes(option.value)) {
          hits.push(`${file}: literal model option value "${option.value}"`);
        }
        if (typeof option.description === 'string' && source.includes(option.description)) {
          hits.push(`${file}: literal model option description "${option.description}"`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('the allowed provider names / config keys match no model-id pattern', () => {
    const hits: string[] = [];
    for (const token of ALLOWED_MODEL_TOKENS) {
      for (const { name, re } of MODEL_ID_PATTERNS) {
        if (re.test(token)) hits.push(`allowed token "${token}" matches pattern "${name}"`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('src/models.ts derives every model from the ACP model config option (pinned id read, nothing hardcoded)', () => {
    const source = readFileSync(new URL('../src/models.ts', import.meta.url), 'utf-8');
    // the model list is read via the pinned config-option accessor
    expect(source).toContain('modelOptions');
  });
});

// ------------------------------------------------------------------ T6 wiring

describe('wireExtension: AskVibe tool registration (ADR-0004, askVibe.enabled)', () => {
  it('registers the ask_vibe tool next to the provider when askVibe.enabled=true', async () => {
    const fake = makeFakeSpawn();
    const { pi, registrations, tools } = makeFakePi();
    const config: BridgeConfig = {
      ...CONFIG,
      askVibe: { enabled: true, defaultMode: 'ask', autoApprove: false },
    };
    const { provider, askVibe } = wireExtension(pi, config, {
      cwd: CWD,
      spawnChild: fake.spawnChild,
      logDir: LOG_DIR,
      onWarn: () => {},
    });
    try {
      expect(tools.map((t) => t.name)).toEqual(['ask_vibe']);
      expect(tools[0].definition.parameters).toBeDefined();
      await waitFor(() => registrations.length === 1, 'provider registration');
      expect(registrations[0].name).toBe('mistral-bridge');
      expect(askVibe).not.toBeNull();
    } finally {
      await provider.dispose();
      await askVibe?.dispose();
    }
  });

  it('registers NO ask_vibe tool when askVibe.enabled=false (provider still registered)', async () => {
    const fake = makeFakeSpawn();
    const { pi, registrations, tools } = makeFakePi();
    const { provider, askVibe } = wireExtension(pi, CONFIG, {
      cwd: CWD,
      spawnChild: fake.spawnChild,
      logDir: LOG_DIR,
      onWarn: () => {},
    });
    try {
      expect(tools).toEqual([]);
      expect(askVibe).toBeNull();
      await waitFor(() => registrations.length === 1, 'provider registration');
    } finally {
      await provider.dispose();
    }
  });
});

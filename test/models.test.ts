// Unit tests for src/models.ts (implementation plan T7, ADR-0005/0007): the
// ModelCatalog — model list from the ACP `model` config option of one
// short-lived discovery `vibe-acp` process, cached by the stable API model id,
// capability enrichment (option extra fields / usage_update.size / Pi's own
// registry), and the alias map that routes provider.streamSimple to the
// per-alias process pool (ADR-0007). The ACP side is the shared in-process
// fake ACP agent (no real vibe-acp, AGENTS.md §4).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import type * as acp from '@agentclientprotocol/sdk';
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
  FALLBACK_CONTEXT_WINDOW,
  FALLBACK_MAX_TOKENS,
  ModelCatalog,
  PI_BUILTIN_MISTRAL_PROVIDER,
  type ModelCatalogOptions,
} from '../src/models.ts';
import { BRIDGE_API, registerMistralProvider } from '../src/index.ts';
import { VIBE_ENV } from '../src/vibe-protocol.ts';
import { makeFakeSpawn, sendUpdate, type FakeSpawnHarness } from './helpers/fake-acp-agent.ts';

const CWD = mkdtempSync(join(tmpdir(), 'pi-mistral-bridge-models-cwd-'));
const LOG_DIR = mkdtempSync(join(tmpdir(), 'pi-mistral-bridge-models-logs-'));

const CONFIG: BridgeConfig = {
  vibeAcpPath: 'vibe-acp',
  providerName: 'mistral-vibe',
  askVibe: { enabled: false, defaultMode: 'ask', autoApprove: false },
  debug: false,
  processIdleTimeoutMs: 600_000,
  toolPreTimeoutMs: 1_500,
  abortWatchdogMs: 5_000,
  discoveryTimeoutMs: 30_000,
  modelRefreshIntervalMs: 600_000,
};

interface CatalogHarness {
  catalog: ModelCatalog;
  /** onModels events: the full model list + alias map of each publication. */
  events: Array<{ models: any[]; aliasByApiId: ReadonlyMap<string, string> }>;
  anomalies: string[];
}

function makeCatalog(
  fake: FakeSpawnHarness,
  extra: Partial<ModelCatalogOptions> = {}
): CatalogHarness {
  const events: CatalogHarness['events'] = [];
  const anomalies: string[] = [];
  const catalog = new ModelCatalog({
    config: CONFIG,
    cwd: CWD,
    spawnChild: fake.spawnChild,
    logDir: LOG_DIR,
    onAnomaly: (message) => anomalies.push(message),
    onModels: (models, aliasByApiId) => events.push({ models: [...models], aliasByApiId }),
    ...extra,
  });
  return { catalog, events, anomalies };
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(5);
  }
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// ------------------------------------------------------------- discovery

describe('ModelCatalog.discover: model list from the ACP model config option (ADR-0005/0007)', () => {
  it('maps each option to a model with id = API id (description) and alias = value as the routing key; cost 0; fallback capabilities', async () => {
    const fake = makeFakeSpawn({
      // custom option list proves the registered models are derived, not literal
      modelOptions: [
        { value: 'alias-one', name: 'Model One', description: 'api-id-one' },
        { value: 'alias-two', name: 'Model Two', description: 'api-id-two' },
      ],
    });
    const { catalog, events } = makeCatalog(fake);
    try {
      const models = await catalog.discover();

      // ADR-0007: the registered Pi model id is the stable API id
      // (`<providerName>/<api id>` once Pi prefixes it); the volatile alias
      // (`value`) is kept separately as the pool/routing key.
      expect(models).toEqual([
        {
          id: 'api-id-one',
          name: 'Model One',
          input: ['text'],
          reasoning: false,
          cost: ZERO_COST,
          contextWindow: FALLBACK_CONTEXT_WINDOW,
          maxTokens: FALLBACK_MAX_TOKENS,
        },
        {
          id: 'api-id-two',
          name: 'Model Two',
          input: ['text'],
          reasoning: false,
          cost: ZERO_COST,
          contextWindow: FALLBACK_CONTEXT_WINDOW,
          maxTokens: FALLBACK_MAX_TOKENS,
        },
      ]);

      // alias map: API id (stable cache key) → alias (pool key, VIBE_ACTIVE_MODEL)
      expect([...catalog.aliasMap.entries()]).toEqual([
        ['api-id-one', 'alias-one'],
        ['api-id-two', 'alias-two'],
      ]);

      // the list was published once via onModels with the full list + alias map
      expect(events).toHaveLength(1);
      expect(events[0].models).toEqual(models);
      expect(events[0].aliasByApiId.get('api-id-one')).toBe('alias-one');

      // the discovery process ran on Vibe's default model, served no MCP
      // server, and was terminated after reading the option (no orphan)
      expect(fake.spawns).toHaveLength(1);
      expect(fake.spawns[0].env[VIBE_ENV.ACTIVE_MODEL]).toBeUndefined();
      expect(fake.spawns[0].env[VIBE_ENV.MCP_SERVERS]).toBeUndefined();
      expect(fake.children[0].killedWith.length).toBeGreaterThan(0);
    } finally {
      catalog.dispose();
    }
  });

  it('falls back to value/name when the option carries no description', async () => {
    const fake = makeFakeSpawn({ modelOptions: [{ value: 'alias-x', name: 'Model X' }] });
    const { catalog } = makeCatalog(fake);
    try {
      const models = await catalog.discover();
      expect(models[0].id).toBe('alias-x');
      expect(models[0].name).toBe('Model X');
      expect(catalog.aliasMap.get('alias-x')).toBe('alias-x');
    } finally {
      catalog.dispose();
    }
  });

  it('rejects when the model option lists no models and publishes nothing', async () => {
    const fake = makeFakeSpawn({ modelOptions: [] });
    const { catalog, events, anomalies } = makeCatalog(fake);
    try {
      await expect(catalog.discover()).rejects.toThrow(/listed no models/);
      expect(events).toEqual([]);
      expect(anomalies).toEqual([]);
    } finally {
      catalog.dispose();
    }
  });

  it('rejects on discovery timeout and kills the hung child (no orphan)', async () => {
    const fake = makeFakeSpawn({ onInitialize: () => new Promise(() => {}) });
    const { catalog } = makeCatalog(fake, { config: { ...CONFIG, discoveryTimeoutMs: 120 } });
    await expect(catalog.discover()).rejects.toThrow(/timed out after 120 ms/);
    expect(fake.children[0].killedWith.length).toBeGreaterThan(0);
    catalog.dispose();
  });

  it('dispose() aborts an in-flight discovery: the child is killed and discover() rejects', async () => {
    const fake = makeFakeSpawn({ onInitialize: () => new Promise(() => {}) });
    const { catalog } = makeCatalog(fake);
    const pending = catalog.discover();
    await waitFor(() => fake.spawns.length === 1, 'discovery spawn');
    catalog.dispose();
    await expect(pending).rejects.toThrow(/aborted/);
    expect(fake.children[0].killedWith.length).toBeGreaterThan(0);
    // a disposed catalog refuses new discoveries
    await expect(catalog.discover()).rejects.toThrow(/disposed/);
  });
});

// ------------------------------------------------- capability enrichment

describe('ModelCatalog capability enrichment (AGENTS.md §9: no hardcoded models)', () => {
  it("enriches from Pi's own registry by id match, never admits a registry-only model, and falls back to the documented defaults otherwise", async () => {
    const fake = makeFakeSpawn({
      modelOptions: [
        { value: 'alias-one', name: 'Model One', description: 'api-id-one' },
        { value: 'alias-two', name: 'Model Two', description: 'api-id-two' },
      ],
    });
    const { catalog } = makeCatalog(fake, {
      builtinModels: () => [
        {
          id: 'api-id-one',
          reasoning: true,
          contextWindow: 200_000,
          maxTokens: 65_536,
          input: ['text', 'image'],
        },
        { id: 'registry-only', contextWindow: 1 }, // must NOT be admitted
      ],
    });
    try {
      const models = await catalog.discover();
      // enrichment never admits a model Vibe did not report (AGENTS.md §9)
      expect(models.map((m) => m.id)).toEqual(['api-id-one', 'api-id-two']);
      expect(models[0]).toMatchObject({
        id: 'api-id-one',
        reasoning: true,
        contextWindow: 200_000,
        maxTokens: 65_536,
        input: ['text', 'image'],
      });
      // no registry match → conservative documented fallback
      expect(models[1]).toMatchObject({
        id: 'api-id-two',
        reasoning: false,
        contextWindow: FALLBACK_CONTEXT_WINDOW,
        maxTokens: FALLBACK_MAX_TOKENS,
        input: ['text'],
      });
    } finally {
      catalog.dispose();
    }
  });

  it("the default registry lookup is Pi's builtin catalog of the mistral provider (read-only, no network)", async () => {
    expect(PI_BUILTIN_MISTRAL_PROVIDER).toBe('mistral');
    // default lookup is used when builtinModels is not injected: the fake's
    // api ids match nothing in the real registry, so the fallbacks apply and
    // no registry model leaks into the list
    const fake = makeFakeSpawn({
      modelOptions: [{ value: 'alias-one', name: 'Model One', description: 'api-id-one' }],
    });
    const { catalog } = makeCatalog(fake);
    try {
      const models = await catalog.discover();
      expect(models).toHaveLength(1);
      expect(models[0]).toMatchObject({ contextWindow: FALLBACK_CONTEXT_WINDOW });
    } finally {
      catalog.dispose();
    }
  });

  it('capability fields on the option itself win over registry and runtime cache (future Vibe versions may send them)', async () => {
    const fake = makeFakeSpawn({
      modelOptions: [
        {
          value: 'alias-a',
          name: 'Model A',
          description: 'api-a',
          contextWindow: 123_456,
          maxTokens: 4_096,
          reasoning: true,
        } as never,
      ],
    });
    const { catalog } = makeCatalog(fake, {
      builtinModels: () => [{ id: 'api-a', contextWindow: 999_999, reasoning: false }],
    });
    try {
      const models = await catalog.discover();
      expect(models[0]).toMatchObject({
        id: 'api-a',
        contextWindow: 123_456,
        maxTokens: 4_096,
        reasoning: true,
      });
    } finally {
      catalog.dispose();
    }
  });

  it('noteContextSize (usage_update.size) caches per API id, re-publishes on change, and survives an alias change', async () => {
    const fake = makeFakeSpawn({
      modelOptions: [{ value: 'alias-one', name: 'Model One', description: 'api-id-one' }],
    });
    const { catalog, events } = makeCatalog(fake);
    try {
      const models = await catalog.discover();
      expect(events).toHaveLength(1);
      expect(models[0]).toMatchObject({ contextWindow: FALLBACK_CONTEXT_WINDOW });

      // runtime observation: usage_update.size for the active model
      catalog.noteContextSize('api-id-one', 250_000);
      expect(events).toHaveLength(2);
      expect(events[1].models[0]).toMatchObject({ id: 'api-id-one', contextWindow: 250_000 });

      // unchanged / invalid sizes do not re-publish
      catalog.noteContextSize('api-id-one', 250_000);
      catalog.noteContextSize('api-id-one', 0);
      catalog.noteContextSize('api-id-one', Number.NaN);
      catalog.noteContextSize('not-reported-by-vibe', 100); // cache only, no model to update
      expect(events).toHaveLength(2);

      // the alias changed between two discoveries (volatile, ADR-0007): the
      // capability cache is keyed by the stable API id and survives
      fake.behavior.modelOptions = [
        { value: 'alias-one-v2', name: 'Model One', description: 'api-id-one' },
      ];
      const refreshed = await catalog.discover();
      expect(refreshed[0]).toMatchObject({ id: 'api-id-one', contextWindow: 250_000 });
      expect(catalog.aliasMap.get('api-id-one')).toBe('alias-one-v2');
      expect(events).toHaveLength(3); // alias map changed → re-published
      expect(events[2].aliasByApiId.get('api-id-one')).toBe('alias-one-v2');
    } finally {
      catalog.dispose();
    }
  });
});

// ------------------------------------------------------ background refresh

describe('ModelCatalog background refresh (ADR-0007: aliases volatile, re-read the list)', () => {
  it('refresh() re-runs discovery and re-publishes the FULL list only on change', async () => {
    const fake = makeFakeSpawn({
      modelOptions: [{ value: 'alias-one', name: 'Model One', description: 'api-id-one' }],
    });
    const { catalog, events } = makeCatalog(fake);
    try {
      await catalog.discover();
      expect(events).toHaveLength(1);

      await catalog.refresh(); // nothing changed → no re-publication
      expect(events).toHaveLength(1);
      expect(fake.spawns).toHaveLength(2); // but the discovery did re-run

      // a new model appears → re-published with the FULL list (replace semantics, AGENTS.md §6)
      fake.behavior.modelOptions = [
        { value: 'alias-one', name: 'Model One', description: 'api-id-one' },
        { value: 'alias-two', name: 'Model Two', description: 'api-id-two' },
      ];
      await catalog.refresh();
      expect(events).toHaveLength(2);
      expect(events[1].models.map((m) => m.id)).toEqual(['api-id-one', 'api-id-two']);
      expect(events[1].aliasByApiId.get('api-id-two')).toBe('alias-two');
    } finally {
      catalog.dispose();
    }
  });

  it('a failed refresh keeps the old list and logs an anomaly (never wipes on failure)', async () => {
    const fake = makeFakeSpawn({
      modelOptions: [{ value: 'alias-one', name: 'Model One', description: 'api-id-one' }],
    });
    const { catalog, events, anomalies } = makeCatalog(fake);
    try {
      await catalog.discover();
      expect(events).toHaveLength(1);

      fake.behavior.failInitialize = true; // every later spawn fails the handshake
      await catalog.refresh();
      expect(events).toHaveLength(1); // old list kept, nothing re-registered
      expect(catalog.currentModels.map((m) => m.id)).toEqual(['api-id-one']);
      expect(anomalies.some((m) => m.includes('model refresh failed'))).toBe(true);
    } finally {
      catalog.dispose();
    }
  });

  it('an empty refresh result does not wipe a non-empty list', async () => {
    const fake = makeFakeSpawn({
      modelOptions: [{ value: 'alias-one', name: 'Model One', description: 'api-id-one' }],
    });
    const { catalog, events, anomalies } = makeCatalog(fake);
    try {
      await catalog.discover();
      expect(events).toHaveLength(1);

      fake.behavior.modelOptions = []; // Vibe reports no models anymore
      await catalog.refresh();
      expect(events).toHaveLength(1); // no re-registration with an empty list
      expect(catalog.currentModels).toHaveLength(1); // old list kept
      expect(anomalies.some((m) => m.includes('model refresh failed'))).toBe(true);
    } finally {
      catalog.dispose();
    }
  });

  it('startRefresh() re-runs discovery on the configured interval; dispose() stops the timer', async () => {
    const fake = makeFakeSpawn({
      modelOptions: [{ value: 'alias-one', name: 'Model One', description: 'api-id-one' }],
    });
    const { catalog, events } = makeCatalog(fake, {
      config: { ...CONFIG, modelRefreshIntervalMs: 25 },
    });
    try {
      catalog.startRefresh();
      await catalog.discover(); // initial publication
      expect(events).toHaveLength(1);

      fake.behavior.modelOptions = [
        { value: 'alias-one', name: 'Model One', description: 'api-id-one' },
        { value: 'alias-two', name: 'Model Two', description: 'api-id-two' },
      ];
      await waitFor(() => events.length === 2, 'background refresh publication');
      expect(events[1].models.map((m) => m.id)).toEqual(['api-id-one', 'api-id-two']);

      const spawnsAfterRefresh = fake.spawns.length;
      catalog.dispose();
      await sleep(100); // several intervals pass — the timer must be stopped
      expect(fake.spawns.length).toBe(spawnsAfterRefresh);
    } finally {
      catalog.dispose();
    }
  });

  it('dispose() kills an in-flight refresh discovery child and stops further refreshes', async () => {
    const fake = makeFakeSpawn({ onInitialize: () => new Promise(() => {}) });
    const { catalog, anomalies } = makeCatalog(fake, {
      config: { ...CONFIG, modelRefreshIntervalMs: 20 },
    });
    catalog.startRefresh();
    await waitFor(() => fake.spawns.length === 1, 'refresh spawn');
    catalog.dispose();
    expect(fake.children[0].killedWith.length).toBeGreaterThan(0); // child killed, no orphan
    await sleep(80);
    expect(fake.spawns.length).toBe(1); // no further refresh spawns
    expect(anomalies).toEqual([]); // dispose is not an anomaly
  });
});

// ------------------------------------------------- entry-point wiring (T7)

/** Minimal fake ExtensionAPI capturing registerProvider calls (like test/index.test.ts). */
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
    registerTool: () => {},
    on: (event: string, handler: (event: any, ctx: any) => unknown) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
  } as unknown as ExtensionAPI;
  return { pi, registrations, handlers };
}

const WIRED_MODEL: Model<Api> = {
  id: 'api-id-one',
  name: 'Model One',
  api: BRIDGE_API,
  provider: 'mistral-vibe',
  baseUrl: 'vibe-acp',
  input: ['text'],
  reasoning: false,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: FALLBACK_CONTEXT_WINDOW,
  maxTokens: FALLBACK_MAX_TOKENS,
};

function ctxOf(text: string): TranscriptContext {
  return normalizeContext({
    systemPrompt: 'sys',
    messages: [{ role: 'user', content: text, timestamp: 1 }],
    tools: [],
  });
}

describe('T7 wiring through registerMistralProvider (src/index.ts)', () => {
  it('background refresh re-registers the provider with the FULL new list (registerProvider REPLACES, AGENTS.md §6) and updates the alias map', async () => {
    const fake = makeFakeSpawn({
      modelOptions: [{ value: 'alias-one', name: 'Model One', description: 'api-id-one' }],
    });
    const { pi, registrations } = makeFakePi();
    const provider = registerMistralProvider(
      pi,
      { ...CONFIG, modelRefreshIntervalMs: 25 },
      {
        cwd: CWD,
        spawnChild: fake.spawnChild,
        logDir: LOG_DIR,
        onWarn: () => {},
      }
    );
    try {
      await waitFor(() => registrations.length === 1, 'initial registration');
      expect(registrations[0].config.models.map((m: any) => m.id)).toEqual(['api-id-one']);

      fake.behavior.modelOptions = [
        { value: 'alias-one', name: 'Model One', description: 'api-id-one' },
        { value: 'alias-two', name: 'Model Two', description: 'api-id-two' },
      ];
      await waitFor(() => registrations.length === 2, 'refresh re-registration');
      // the FULL list, not a delta
      expect(registrations[1].name).toBe('mistral-vibe');
      expect(registrations[1].config.models.map((m: any) => m.id)).toEqual([
        'api-id-one',
        'api-id-two',
      ]);
      // the provider's alias map was refreshed too (pool routing key)
      expect(provider.modelAliasFor({ ...WIRED_MODEL, id: 'api-id-two' })).toBe('alias-two');
    } finally {
      await provider.dispose();
    }
  });

  it('a failed background refresh keeps the previous registration (no wipe) and logs an anomaly', async () => {
    const fake = makeFakeSpawn({
      modelOptions: [{ value: 'alias-one', name: 'Model One', description: 'api-id-one' }],
    });
    const { pi, registrations } = makeFakePi();
    const anomalies: string[] = [];
    const provider = registerMistralProvider(
      pi,
      { ...CONFIG, modelRefreshIntervalMs: 25 },
      {
        cwd: CWD,
        spawnChild: fake.spawnChild,
        logDir: LOG_DIR,
        onWarn: () => {},
        onAnomaly: (m) => anomalies.push(m),
      }
    );
    try {
      await waitFor(() => registrations.length === 1, 'initial registration');
      fake.behavior.failInitialize = true; // every refresh spawn now fails
      await sleep(120); // several refresh intervals pass
      expect(registrations).toHaveLength(1); // old list kept, nothing re-registered
      expect(anomalies.some((m) => m.includes('model refresh failed'))).toBe(true);
    } finally {
      await provider.dispose();
    }
  });

  it('runtime usage_update.size on a provider session updates the registered contextWindow (cache per API id, re-register with full list)', async () => {
    const fake = makeFakeSpawn({
      modelOptions: [{ value: 'alias-one', name: 'Model One', description: 'api-id-one' }],
      promptScript: async (params, client) => {
        const update: acp.SessionUpdate = {
          sessionUpdate: 'usage_update',
          used: 0,
          size: 250_000,
        };
        await sendUpdate(client, params.sessionId, update);
        return { stopReason: 'end_turn' };
      },
    });
    const { pi, registrations } = makeFakePi();
    const provider = registerMistralProvider(pi, CONFIG, {
      cwd: CWD,
      spawnChild: fake.spawnChild,
      logDir: LOG_DIR,
      onWarn: () => {},
    });
    try {
      await waitFor(() => registrations.length === 1, 'initial registration');
      expect(registrations[0].config.models[0]).toMatchObject({
        id: 'api-id-one',
        contextWindow: FALLBACK_CONTEXT_WINDOW,
      });

      // one text turn through the registered streamSimple; the fake sends
      // usage_update.size = 250000 for the active model during the prompt
      const stream = registrations[0].config.streamSimple(WIRED_MODEL, ctxOf('hi'), {
        sessionId: 'pi-1',
      } as Partial<SimpleStreamOptions>) as AssistantMessageEventStream;
      for await (const _event of stream) {
        void _event;
      }
      await stream.result();

      await waitFor(() => registrations.length === 2, 'capability re-registration');
      expect(registrations[1].config.models[0]).toMatchObject({
        id: 'api-id-one',
        contextWindow: 250_000,
      });
      expect(registrations[1].config.models).toHaveLength(1); // still the full list
      expect(provider.modelAliasFor(WIRED_MODEL)).toBe('alias-one'); // alias map intact
    } finally {
      await provider.dispose();
    }
  });

  it('dispose() stops the refresh timer — no registrations after provider dispose', async () => {
    const fake = makeFakeSpawn({
      modelOptions: [{ value: 'alias-one', name: 'Model One', description: 'api-id-one' }],
    });
    const { pi, registrations } = makeFakePi();
    const provider = registerMistralProvider(
      pi,
      { ...CONFIG, modelRefreshIntervalMs: 20 },
      {
        cwd: CWD,
        spawnChild: fake.spawnChild,
        logDir: LOG_DIR,
        onWarn: () => {},
      }
    );
    try {
      await waitFor(() => registrations.length === 1, 'initial registration');
      fake.behavior.modelOptions = [
        { value: 'alias-one', name: 'Model One', description: 'api-id-one' },
        { value: 'alias-two', name: 'Model Two', description: 'api-id-two' },
      ];
      await provider.dispose();
      await sleep(80); // several intervals pass
      expect(registrations).toHaveLength(1); // timer stopped with the catalog
    } finally {
      await provider.dispose();
    }
  });
});

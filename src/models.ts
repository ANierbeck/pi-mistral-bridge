/**
 * Model catalog (implementation plan T7, ADR-0005/0007): the model list Pi
 * registers comes from what `vibe-acp` itself reports — the `model` config
 * option of `session/new` (`{id:"model", type:"select", options:[{value:
 * alias, name, description: apiModelId}]}`, `MODEL_CONFIG_OPTION_ID` in
 * src/vibe-protocol.ts). Nothing is hardcoded (AGENTS.md §9).
 *
 * The two option fields have different stability (research doc, Decision 3;
 * ADR-0007): the alias (`value`) is VOLATILE (observed to change between two
 * runs one minute apart), the API model id (`description`) is stable. So:
 *
 * - the registered Pi model id is the **API id** — ADR-0007: "Pi model ids
 *   are built as `<providerName>/<api id>`", so the user-visible id does not
 *   churn on every refresh;
 * - the **alias** is kept in {@link ModelCatalog.aliasMap} (API id → alias)
 *   and is the routing key: the process pool spawns one `vibe-acp` per alias
 *   with `VIBE_ACTIVE_MODEL=<alias>` (ADR-0007), so `provider.streamSimple`
 *   routes to the right process through that map (src/provider.ts
 *   `modelAliasFor`), not by making the alias the Pi id;
 * - every cache (capabilities, alias map) is keyed by the **API id**, never
 *   by the alias.
 *
 * Capability enrichment (context window / max tokens / reasoning / image
 * input) — Vibe 3.1.4 sends none of these on the option, so per model, in
 * precedence order (Vibe-reported first, AGENTS.md §9):
 *   1. extra fields on the option itself, if a future Vibe sends them;
 *   2. `usage_update.size` observed at runtime ({@link ModelCatalog.noteContextSize},
 *      cached per API id);
 *   3. Pi's own builtin registry (`getBuiltinModels("mistral")`, read-only,
 *      no network) matched by id — enrichment never ADDS a model Vibe did not
 *      report;
 *   4. the conservative documented fallbacks {@link FALLBACK_CONTEXT_WINDOW}
 *      / {@link FALLBACK_MAX_TOKENS}.
 * Cost is always 0 (ADR-0003: the bridge reports cost 0 to Pi; Vibe's own
 * `usage_update.cost` is surfaced separately).
 *
 * Refresh: {@link ModelCatalog.startRefresh} re-runs the discovery on the
 * configured interval; on change the FULL list is re-published via `onModels`
 * (the caller re-calls `pi.registerProvider`, which REPLACES the provider's
 * model list — AGENTS.md §6). A failed or empty refresh never wipes a
 * non-empty list; it logs an anomaly and keeps the old one.
 */
import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent';
import type * as acp from '@agentclientprotocol/sdk';
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all';
import {
  AcpClientError,
  defaultDebugLogDir,
  VibeAcpProcess,
  type SpawnChildFn,
} from './acp-client.ts';
import type { BridgeConfig } from './config.ts';

/** Pi's builtin provider name that the bridge must never register or shadow (AGENTS.md §6). */
export const PI_BUILTIN_MISTRAL_PROVIDER = 'mistral';

/**
 * Conservative capability defaults for a discovered model (ADR-0005): until
 * Vibe reports more (option fields or `usage_update.size`) or Pi's registry
 * matches by id, chat models are registered text-only with these documented
 * defaults. Never model-specific numbers (AGENTS.md §9).
 */
export const FALLBACK_CONTEXT_WINDOW = 128_000;
export const FALLBACK_MAX_TOKENS = 8_192;

/** One discovered model: the stable API id, the volatile alias, the display name, option-carried capabilities. */
export interface DiscoveredModel {
  /** The stable upstream API model id (`description` of the `model` option; ADR-0005) — the cache key and the registered Pi model id. */
  apiId: string;
  /** The volatile Vibe alias (`value` of the `model` option) — the process-pool key (`VIBE_ACTIVE_MODEL`, ADR-0007). */
  alias: string;
  /** Display name (`name` of the option, falling back to the alias). */
  name: string;
  /** Capability fields carried on the option itself, if any (empty on vibe-acp 3.1.4). */
  capabilities: ModelCapabilities;
}

/** Capability metadata of one model; every field optional, merged by precedence. */
export interface ModelCapabilities {
  contextWindow?: number | undefined;
  maxTokens?: number | undefined;
  reasoning?: boolean | undefined;
  input?: ('text' | 'image')[] | undefined;
}

/** The subset of Pi's registry model shape the catalog enriches from (by id match). */
export interface RegistryModel {
  id: string;
  reasoning?: boolean | undefined;
  contextWindow?: number | undefined;
  maxTokens?: number | undefined;
  input?: readonly string[] | undefined;
}

export interface DiscoverModelsOptions {
  config: BridgeConfig;
  cwd: string;
  spawnChild?: SpawnChildFn | undefined;
  onAnomaly?: ((message: string) => void) | undefined;
  logDir?: string | undefined;
  /**
   * Abort hook owned by the caller (the catalog): when it fires, the
   * discovery child is killed immediately and discovery rejects. Lets
   * `dispose()` kill an in-flight discovery (no orphan, AGENTS.md §15).
   */
  signal?: AbortSignal | undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Reads capability fields off one `model` config option, if present. vibe-acp
 * 3.1.4 sends only `{value, name, description}` (research doc, Decision 3);
 * if a future Vibe adds capability fields on the option or its `_meta`, they
 * are Vibe-reported and therefore take precedence over every other source.
 */
function capabilitiesFromOption(option: acp.SessionConfigSelectOption): ModelCapabilities {
  const caps: ModelCapabilities = {};
  const raw = option as unknown as Record<string, unknown>;
  const sources: Record<string, unknown>[] = [raw];
  if (isPlainObject(raw._meta)) sources.push(raw._meta);
  for (const source of sources) {
    if (isPositiveNumber(source.contextWindow)) caps.contextWindow = source.contextWindow;
    if (isPositiveNumber(source.maxTokens)) caps.maxTokens = source.maxTokens;
    if (typeof source.reasoning === 'boolean') caps.reasoning = source.reasoning;
    if (Array.isArray(source.input)) {
      const input = source.input.filter(
        (m): m is 'text' | 'image' => m === 'text' || m === 'image'
      );
      if (input.length > 0) caps.input = input;
    }
  }
  return caps;
}

/** Strips `undefined` values so `Object.assign` merge respects precedence. */
function definedOnly(caps: ModelCapabilities | undefined): ModelCapabilities {
  if (!caps) return {};
  const out: ModelCapabilities = {};
  if (caps.contextWindow !== undefined) out.contextWindow = caps.contextWindow;
  if (caps.maxTokens !== undefined) out.maxTokens = caps.maxTokens;
  if (caps.reasoning !== undefined) out.reasoning = caps.reasoning;
  if (caps.input !== undefined) out.input = caps.input;
  return out;
}

/**
 * Reads the model list from one short-lived discovery `vibe-acp` process
 * (ADR-0005): spawned WITHOUT `VIBE_ACTIVE_MODEL` (Vibe's own default model)
 * and without an MCP server, one `session/new`, then the `model` config option
 * via {@link AcpSession.modelOptions} (`MODEL_CONFIG_OPTION_ID`). The process
 * is terminated afterwards — it serves no Pi session.
 *
 * Bounded: the whole discovery is raced against `config.discoveryTimeoutMs`
 * and the optional `signal`; either one kills the child (via the abort hook
 * in {@link VibeAcpProcess.start}) and rejects with a clear error, so a
 * wedged `vibe-acp` can never hang the extension load or outlive its owner.
 */
export async function discoverModels(options: DiscoverModelsOptions): Promise<DiscoveredModel[]> {
  const { config, cwd } = options;
  const timeoutMs = config.discoveryTimeoutMs;
  const controller = new AbortController();
  const onExternalAbort = (): void => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    const proc = await VibeAcpProcess.start({
      vibeAcpPath: config.vibeAcpPath,
      cwd,
      abortWatchdogMs: config.abortWatchdogMs,
      debug: config.debug,
      logDir: options.logDir ?? defaultDebugLogDir(),
      spawnChild: options.spawnChild,
      onAnomaly: options.onAnomaly,
      logFileBase: 'model-discovery',
      signal: controller.signal,
    });
    try {
      const session = await proc.newSession({ cwd });
      return session.modelOptions().map((option) => ({
        alias: option.value,
        apiId:
          typeof option.description === 'string' && option.description.length > 0
            ? option.description
            : option.value,
        name: option.name ?? option.value,
        capabilities: capabilitiesFromOption(option),
      }));
    } finally {
      await proc.terminate('model-discovery-done').catch(() => {
        // already dead
      });
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new AcpClientError(
        'protocol',
        `model discovery was aborted (catalog disposed) or timed out after ${timeoutMs} ms — ` +
          `the discovery vibe-acp child was killed`
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (options.signal) options.signal.removeEventListener('abort', onExternalAbort);
  }
}

/** Pi's own builtin registry of the `mistral` provider — the §9 enrichment source (read-only generated catalog, no network). */
function defaultBuiltinModels(): readonly RegistryModel[] {
  return getBuiltinModels(PI_BUILTIN_MISTRAL_PROVIDER);
}

export interface ModelCatalogOptions {
  config: BridgeConfig;
  /** Pi session cwd, passed to the discovery `session/new`. */
  cwd: string;
  /** Test injection: child spawn. */
  spawnChild?: SpawnChildFn | undefined;
  /** Anomaly sink (refresh failures etc.). */
  onAnomaly?: ((message: string) => void) | undefined;
  /** Debug log dir; defaults to `~/.pi/agent/logs/mistral-bridge/`. */
  logDir?: string | undefined;
  /**
   * Pi registry lookup for capability enrichment (default: Pi's builtin
   * catalog of the `mistral` provider). Test injection.
   */
  builtinModels?: (() => readonly RegistryModel[]) | undefined;
  /**
   * Called whenever the model list or alias map CHANGED (initial discovery,
   * background refresh, runtime capability update) with the FULL new list.
   * The caller re-calls `pi.registerProvider` with it — registerProvider
   * REPLACES the provider's model list (AGENTS.md §6).
   */
  onModels?:
    | ((models: readonly ProviderModelConfig[], aliasByApiId: ReadonlyMap<string, string>) => void)
    | undefined;
}

/** One-line description of a thrown value (never `[object Object]`). */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? 'unknown error';
  } catch {
    return 'unknown error';
  }
}
/** Outcome of the most recent discovery run (initial or background), for the doctor command. */
export interface DiscoveryOutcome {
  ok: boolean;
  /** Epoch ms of the attempt. */
  at: number;
  /** Classified failure message when `ok` is false. */
  error?: string | undefined;
  /** Model count the catalog held after the attempt. */
  modelCount: number;
}

/**
 * The model catalog: owns the discovered model list, the alias map (API id →
 * alias, the pool routing key, ADR-0007) and the per-API-id capability cache;
 * runs the initial discovery and the background refresh.
 */
export class ModelCatalog {
  private readonly options: ModelCatalogOptions;
  private readonly onAnomaly: ((message: string) => void) | undefined;
  private readonly onModels: ModelCatalogOptions['onModels'];
  private readonly abortController = new AbortController();
  private entries: DiscoveredModel[] = [];
  private aliasByApiId = new Map<string, string>();
  private modelsValue: ProviderModelConfig[] = [];
  /** Capability cache keyed by the STABLE API id, never by the alias (ADR-0007). */
  private readonly capabilities = new Map<string, ModelCapabilities>();
  private registry: readonly RegistryModel[] | null = null;
  private timer: NodeJS.Timeout | null = null;
  private discoveryInFlight: Promise<DiscoveredModel[]> | null = null;
  private disposed = false;
  private lastOutcome: DiscoveryOutcome | null = null;

  constructor(options: ModelCatalogOptions) {
    this.options = options;
    this.onAnomaly = options.onAnomaly;
    this.onModels = options.onModels;
  }

  /** The current model list (empty until the first successful discovery). */
  get currentModels(): readonly ProviderModelConfig[] {
    return this.modelsValue;
  }

  /** API model id → Vibe alias (the process-pool key, ADR-0007). */
  get aliasMap(): ReadonlyMap<string, string> {
    return this.aliasByApiId;
  }

  /**
   * Outcome of the most recent discovery attempt (initial or background), or
   * null before the first one settled. Read by `/mistral-bridge.doctor`.
   */
  get lastDiscovery(): DiscoveryOutcome | null {
    return this.lastOutcome;
  }

  /**
   * True after {@link dispose()}. When the catalog is disposed, an in-flight
   * discovery is aborted INTENTIONALLY (its child is killed, AGENTS.md §15),
   * so a rejection carrying the dispose-abort is a quiet shutdown, not a
   * discovery failure — callers must not log it as an error.
   */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * One discovery run: reads the `model` config option from a short-lived
   * discovery process, updates the catalog and publishes the full list via
   * `onModels` when anything changed. Rejects on timeout/abort/failure and
   * when Vibe lists no models — a failed or empty discovery never wipes a
   * non-empty list.
   */
  async discover(): Promise<readonly ProviderModelConfig[]> {
    try {
      const discovered = await this.runDiscovery();
      if (discovered.length === 0) {
        throw new Error(`the 'model' config option of session/new listed no models`);
      }
      this.applyDiscovered(discovered);
      this.recordDiscovery(null);
      return this.currentModels;
    } catch (error) {
      this.recordDiscovery(error);
      throw error;
    }
  }

  /**
   * Background refresh tick: like {@link discover}, but on failure it keeps
   * the old list and only logs an anomaly (never wipes a non-empty list with
   * an empty/failed result).
   */
  async refresh(): Promise<void> {
    if (this.disposed) return;
    try {
      const discovered = await this.runDiscovery();
      if (discovered.length === 0) {
        throw new Error(`the 'model' config option of session/new listed no models`);
      }
      this.applyDiscovered(discovered);
      this.recordDiscovery(null);
    } catch (error) {
      this.recordDiscovery(error);
      if (!this.disposed) {
        this.onAnomaly?.(
          `model refresh failed — keeping the previous model list (${String(error)})`
        );
      }
    }
  }

  /** Records one attempt for {@link lastDiscovery} (`error` null = success). */
  private recordDiscovery(error: unknown): void {
    // A disposed catalog aborts its in-flight discovery on purpose (session
    // shutdown); that is not a discovery failure and must not surface as one.
    if (this.disposed) return;
    this.lastOutcome = {
      ok: error === null,
      at: Date.now(),
      error: error === null ? undefined : describeError(error),
      modelCount: this.modelsValue.length,
    };
  }

  /** Starts the background refresh timer (`config.modelRefreshIntervalMs`, unref'd). */
  startRefresh(): void {
    if (this.disposed || this.timer !== null) return;
    this.timer = setInterval(() => void this.refresh(), this.options.config.modelRefreshIntervalMs);
    this.timer.unref();
  }

  /**
   * Runtime capability observation: `usage_update.size` (the active model's
   * context window, src/vibe-protocol.ts) seen on a provider session. Cached
   * per API id and re-published when a registered model's capabilities
   * changed.
   */
  noteContextSize(apiId: string, contextSize: number): void {
    if (this.disposed) return;
    if (!isPositiveNumber(contextSize)) return;
    const caps = this.capabilities.get(apiId) ?? {};
    if (caps.contextWindow === contextSize) return;
    this.capabilities.set(apiId, { ...caps, contextWindow: contextSize });
    this.republishIfChanged();
  }

  /** Stops the refresh timer and aborts an in-flight discovery (kills its child, AGENTS.md §15). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.abortController.abort();
  }

  // ------------------------------------------------------------- internals

  /** One shared in-flight discovery run (initial + refresh never overlap). */
  private runDiscovery(): Promise<DiscoveredModel[]> {
    if (this.disposed) {
      return Promise.reject(
        new AcpClientError('protocol', 'model catalog is disposed — no discovery runs anymore')
      );
    }
    this.discoveryInFlight ??= discoverModels({
      config: this.options.config,
      cwd: this.options.cwd,
      spawnChild: this.options.spawnChild,
      onAnomaly: this.onAnomaly,
      logDir: this.options.logDir,
      signal: this.abortController.signal,
    }).finally(() => {
      this.discoveryInFlight = null;
    });
    return this.discoveryInFlight;
  }

  /** Installs a fresh discovery result and publishes when anything changed. */
  private applyDiscovered(discovered: DiscoveredModel[]): void {
    const before = this.fingerprint();
    const nextModels = discovered.map((d) => this.toProviderModel(d));
    const nextAliasByApiId = new Map(discovered.map((d) => [d.apiId, d.alias]));
    if (JSON.stringify([nextModels, [...nextAliasByApiId]]) !== before) {
      // Publish BEFORE committing: if onModels throws (registerProvider
      // rejected the list), the catalog keeps the previous state, so the next
      // discovery sees a changed fingerprint and retries the publication
      // instead of leaving Pi with a list the catalog believes it published.
      this.onModels?.(nextModels, nextAliasByApiId);
    }
    this.entries = discovered;
    this.aliasByApiId = nextAliasByApiId;
    this.modelsValue = nextModels;
  }

  /** Re-maps the current entries (capability cache changed) and publishes on change. */
  private republishIfChanged(): void {
    if (this.entries.length === 0) return;
    const before = this.fingerprint();
    const nextModels = this.entries.map((d) => this.toProviderModel(d));
    if (JSON.stringify([nextModels, [...this.aliasByApiId]]) !== before) {
      // Same publish-before-commit order as applyDiscovered.
      this.onModels?.(nextModels, this.aliasByApiId);
    }
    this.modelsValue = nextModels;
  }

  private fingerprint(): string {
    return JSON.stringify([this.modelsValue, [...this.aliasByApiId]]);
  }

  /** The `ProviderModelConfig` for one discovered model: id = API id, cost 0 (ADR-0003), enriched capabilities. */
  toProviderModel(discovered: DiscoveredModel): ProviderModelConfig {
    const caps = this.capabilitiesFor(discovered.apiId, discovered.capabilities);
    return {
      // ADR-0007: the registered Pi model id is the stable API id
      // (`<providerName>/<api id>`); routing to the per-alias pool process
      // happens via aliasMap, not via the id.
      id: discovered.apiId,
      name: discovered.name,
      input: caps.input ?? ['text'],
      reasoning: caps.reasoning ?? false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: caps.contextWindow ?? FALLBACK_CONTEXT_WINDOW,
      maxTokens: caps.maxTokens ?? FALLBACK_MAX_TOKENS,
    };
  }

  /** Merges capability sources by precedence: option fields > runtime cache > Pi registry. */
  private capabilitiesFor(apiId: string, optionCaps: ModelCapabilities): ModelCapabilities {
    const merged: ModelCapabilities = {};
    const registry = this.registryLookup().find((m) => m.id === apiId);
    if (registry) {
      if (isPositiveNumber(registry.contextWindow)) merged.contextWindow = registry.contextWindow;
      if (isPositiveNumber(registry.maxTokens)) merged.maxTokens = registry.maxTokens;
      if (typeof registry.reasoning === 'boolean') merged.reasoning = registry.reasoning;
      if (registry.input) {
        const input = registry.input.filter(
          (m): m is 'text' | 'image' => m === 'text' || m === 'image'
        );
        if (input.length > 0) merged.input = input;
      }
    }
    Object.assign(merged, definedOnly(this.capabilities.get(apiId)));
    Object.assign(merged, definedOnly(optionCaps));
    return merged;
  }

  /** Pi registry lookup, memoized (the builtin catalog is static per process). */
  private registryLookup(): readonly RegistryModel[] {
    this.registry ??= (this.options.builtinModels ?? defaultBuiltinModels)();
    return this.registry;
  }
}

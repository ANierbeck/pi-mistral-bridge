/**
 * pi-mistral-bridge extension entry point (implementation plan T5 slice C2:
 * provider registration + model discovery + lifecycle).
 *
 * The default export loads the bridge config and calls
 * {@link registerMistralProvider}, which:
 *
 * - discovers the model list from the ACP `model` config option of one
 *   short-lived `vibe-acp` process on Vibe's default model (ADR-0005/0007;
 *   `MODEL_CONFIG_OPTION_ID` via `AcpSession.modelOptions()` — no hardcoded
 *   model ids, AGENTS.md §9) and registers the provider with those models,
 *   cost 0, and the custom `streamSimple` of {@link MistralProvider}
 *   (src/provider.ts, ADR-0002);
 * - wires `session_start` / `session_shutdown` to the provider's per-Pi-session
 *   resources so no `vibe-acp` child or bridge socket is orphaned (AGENTS.md
 *   §15).
 *
 * Registration timing: Pi's docs (docs/extensions.md, `pi.registerProvider`)
 * state that calls made after the initial extension load take effect
 * immediately, while async factories are awaited before startup — so the
 * discovery is kicked off async at load (the load is NOT blocked on a
 * `vibe-acp` spawn) and the provider is registered as soon as the list is
 * known; the models then land in the picker without a `/reload`. If discovery
 * fails, nothing is registered and a clear message is logged (the user runs
 * `vibe-acp --setup` if Vibe is not signed in — the bridge never asks for or
 * stores a key, AGENTS.md §14).
 */
import type {
  ExtensionAPI,
  ProviderConfig,
  ProviderModelConfig,
} from '@earendil-works/pi-coding-agent';
import { loadConfig, type BridgeConfig } from './config.ts';
import {
  AcpClientError,
  defaultDebugLogDir,
  VibeAcpProcess,
  type SpawnChildFn,
} from './acp-client.ts';
import { MistralProvider } from './provider.ts';

// ------------------------------------------------------------- registration

/**
 * The custom API id of the registered provider. `streamSimple` is ours, so no
 * built-in API implementation ever runs; the id only labels the models.
 */
export const BRIDGE_API = 'pi-mistral-bridge-acp';

/**
 * Placeholder `baseUrl`/`apiKey` for the legacy `pi.registerProvider(name,
 * config)` form, which requires them when `models` are given (same approach as
 * the reference pi-claude-bridge). Neither is ever used: requests go through
 * `vibe-acp` over ACP, and authentication is Vibe's own (`vibe-acp --setup`,
 * ADR-0005, AGENTS.md §14) — the bridge never asks for or stores a key.
 */
export const BRIDGE_BASE_URL = 'vibe-acp';
export const BRIDGE_API_KEY = 'not-used';

/**
 * Conservative capability defaults for a discovered model (ADR-0005): the
 * `model` config option carries no context window / reasoning / image flags
 * (research doc, Decision 3), so until T7 enriches from `usage_update.size`
 * or Pi's own registry, chat models are registered text-only with these
 * documented defaults. Enrichment never admits a model Vibe did not report.
 */
export const FALLBACK_CONTEXT_WINDOW = 128_000;
export const FALLBACK_MAX_TOKENS = 8_192;

/** Pi's builtin provider name that the bridge must never register or shadow (AGENTS.md §6). */
export const PI_BUILTIN_MISTRAL_PROVIDER = 'mistral';

/** One discovered model: the stable API id, the volatile alias, the display name. */
export interface DiscoveredModel {
  /** The stable upstream API model id (`description` of the `model` option; ADR-0005). */
  apiId: string;
  /** The volatile Vibe alias (`value` of the `model` option) — the process-pool key. */
  alias: string;
  /** Display name (`name` of the option, falling back to the alias). */
  name: string;
}

export interface DiscoverModelsOptions {
  config: BridgeConfig;
  cwd: string;
  spawnChild?: SpawnChildFn | undefined;
  onAnomaly?: ((message: string) => void) | undefined;
  logDir?: string | undefined;
  /**
   * Abort hook owned by the caller (the provider): when it fires, the
   * discovery child is killed immediately and discovery rejects. Lets
   * `dispose()` kill an in-flight discovery (no orphan, AGENTS.md §15).
   */
  signal?: AbortSignal | undefined;
}

/**
 * Reads the model list from one short-lived discovery `vibe-acp` process
 * (ADR-0005): spawned WITHOUT `VIBE_ACTIVE_MODEL` (Vibe's own default model)
 * and without an MCP server, one `session/new`, then the `model` config option
 * via {@link AcpSession.modelOptions} (`MODEL_CONFIG_OPTION_ID`). The process
 * is terminated afterwards — it serves no Pi session. The list is cached
 * in-memory by the caller (the provider's alias map).
 *
 * Bounded: the whole discovery is raced against `config.discoveryTimeoutMs`
 * and the optional `signal`; either one kills the child (via the abort hook
 * in {@link VibeAcpProcess.start}) and rejects with a clear error, so a
 * wedged `vibe-acp` can never hang the extension load or outlive the provider.
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
        `model discovery was aborted (provider disposed) or timed out after ${timeoutMs} ms — ` +
          `the discovery vibe-acp child was killed`
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (options.signal) options.signal.removeEventListener('abort', onExternalAbort);
  }
}

/** The `ProviderModelConfig` for one discovered model: cost 0 (ADR-0003), conservative capabilities. */
export function toProviderModel(discovered: DiscoveredModel): ProviderModelConfig {
  return {
    id: discovered.apiId,
    name: discovered.name,
    input: ['text'],
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: FALLBACK_CONTEXT_WINDOW,
    maxTokens: FALLBACK_MAX_TOKENS,
  };
}

/** Test/deps injection for {@link registerMistralProvider}. */
export interface RegisterMistralProviderDeps {
  /** Pi session cwd; defaults to `process.cwd()`. */
  cwd?: string | undefined;
  /** Test injection: child spawn. */
  spawnChild?: SpawnChildFn | undefined;
  /** Anomaly sink. */
  onAnomaly?: ((message: string) => void) | undefined;
  /** Warning sink for discovery failures; defaults to stderr. */
  onWarn?: ((message: string) => void) | undefined;
  /** Debug log dir; defaults to `~/.pi/agent/logs/mistral-bridge/`. */
  logDir?: string | undefined;
}

/**
 * Wires the bridge into Pi: creates the {@link MistralProvider}, starts the
 * async model discovery, registers the provider once the list is known, and
 * hooks `session_start` / `session_shutdown`. Returns the provider (tests use
 * it to drive `streamSimple` and to dispose).
 */
export function registerMistralProvider(
  pi: ExtensionAPI,
  config: BridgeConfig,
  deps: RegisterMistralProviderDeps = {}
): MistralProvider {
  const cwd = deps.cwd ?? process.cwd();
  const warn: (message: string) => void =
    deps.onWarn ?? ((message: string) => process.stderr.write(`pi-mistral-bridge: ${message}\n`));

  // AGENTS.md §6: the bridge registers only its OWN provider; it must never
  // shadow Pi's builtin `mistral` provider (registerProvider REPLACES the
  // model list of the named provider).
  if (config.providerName === PI_BUILTIN_MISTRAL_PROVIDER) {
    warn(
      `mistral-bridge.json: "providerName" must not be "${PI_BUILTIN_MISTRAL_PROVIDER}" — the bridge ` +
        `never registers or shadows a provider it does not own (AGENTS.md §6); nothing registered`
    );
    // still wire lifecycle for the (unused) provider instance? No: register nothing at all.
    const provider = new MistralProvider({
      config,
      cwd,
      spawnChild: deps.spawnChild,
      onAnomaly: deps.onAnomaly,
      logDir: deps.logDir,
    });
    pi.on('session_shutdown', () => {
      void provider.dispose();
    });
    return provider;
  }

  const provider = new MistralProvider({
    config,
    cwd,
    spawnChild: deps.spawnChild,
    onAnomaly: deps.onAnomaly,
    logDir: deps.logDir,
  });

  // Lazy-but-early discovery (ADR-0005): one vibe-acp process on its default
  // model at extension load, async — the load is not blocked on the spawn.
  // registerProvider after the initial load takes effect immediately (Pi docs),
  // so the models appear in the picker as soon as discovery resolves.
  // The provider OWNS the abort hook: dispose() (session_shutdown) kills the
  // in-flight discovery child, and the provider is checked for disposal again
  // right before registerProvider so a disposed provider never registers.
  const discoveryAbort = new AbortController();
  provider.onDispose(() => discoveryAbort.abort());
  void (async (): Promise<void> => {
    try {
      const discovered = await discoverModels({
        config,
        cwd,
        spawnChild: deps.spawnChild,
        onAnomaly: deps.onAnomaly,
        logDir: deps.logDir,
        signal: discoveryAbort.signal,
      });
      if (discovered.length === 0) {
        throw new Error(`the ${'model'} config option of session/new listed no models`);
      }
      if (provider.isDisposed) return; // disposed during discovery: register nothing
      // cache: API id → alias for the provider's model routing (ADR-0007)
      provider.setAliasByApiId(new Map(discovered.map((d) => [d.apiId, d.alias])));
      const providerConfig: ProviderConfig = {
        name: config.providerName,
        baseUrl: BRIDGE_BASE_URL,
        apiKey: BRIDGE_API_KEY,
        api: BRIDGE_API,
        models: discovered.map(toProviderModel),
        streamSimple: (model, context, options) => provider.streamSimple(model, context, options),
      };
      pi.registerProvider(config.providerName, providerConfig);
    } catch (error) {
      // register NOTHING on failure (an empty models list would replace the
      // provider's list with nothing); the message tells the user what to do
      warn(
        `model discovery failed — no "${config.providerName}" models registered; if Vibe is not ` +
          `signed in run \`vibe-acp --setup\`, then /reload. (${String(error)})`
      );
    }
  })();

  pi.on('session_start', () => {
    void provider.openSession();
  });
  pi.on('session_shutdown', () => {
    void provider.dispose();
  });
  return provider;
}

// ------------------------------------------------------------- entry point

/** Extension factory: load config, wire pool + provider (see module doc). */
export default function (pi: ExtensionAPI): void {
  const config = loadConfig(process.cwd());
  registerMistralProvider(pi, config);
}

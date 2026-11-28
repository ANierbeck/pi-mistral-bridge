/**
 * pi-mistral-bridge extension entry point (implementation plan T5 slice C2:
 * provider registration + model discovery + lifecycle).
 *
 * The default export loads the bridge config and calls
 * {@link registerMistralProvider}, which:
 *
 * - discovers the model list via the {@link ModelCatalog} (src/models.ts,
 *   T7): one short-lived `vibe-acp` process on Vibe's default model reads the
 *   ACP `model` config option (ADR-0005/0007 — no hardcoded model ids,
 *   AGENTS.md §9), and the provider is registered with those models, cost 0,
 *   and the custom `streamSimple` of {@link MistralProvider}
 *   (src/provider.ts, ADR-0002); the catalog refreshes the list in the
 *   background and re-registers the provider with the FULL list on change
 *   (`registerProvider` REPLACES the list, AGENTS.md §6);
 * - wires `session_start` / `session_shutdown` to the provider's per-Pi-session
 *   resources so no `vibe-acp` child or bridge socket is orphaned (AGENTS.md
 *   §15);
 * - refuses a `providerName` that collides with any provider Pi already
 *   registers (the builtin catalog is resolved at runtime from pi-ai's public
 *   `@earendil-works/pi-ai/providers/all` — see {@link reservedProviderNames})
 *   and registers nothing in that case, because `registerProvider` REPLACES a
 *   provider's model list and would shadow it (AGENTS.md §6).
 *
 * When `config.askVibe.enabled` (default true), {@link wireExtension} also
 * registers the AskVibe tool (src/ask-vibe.ts, ADR-0004) — Pi's extension API
 * has no agent-mode registration, so AskVibe is a custom `ask_vibe` tool.
 *
 * Registration timing (startup race fix): Pi awaits an async extension
 * factory before session_start and before queued `registerProvider` calls
 * are flushed (pi-coding-agent docs/extensions.md, "Async factory
 * functions"), so the default export is an async factory that awaits the
 * FIRST model discovery with a bounded timeout (`startupDiscoveryTimeoutMs`,
 * src/config.ts): on success the models are registered before Pi's first
 * render — `pi -p`, `--list-models` and `--model <provider>/<id>` no longer
 * race the discovery and silently fall back to another provider. On timeout
 * a quiet warning is logged and startup continues; the discovery itself is
 * NOT aborted (it stays bounded by `discoveryTimeoutMs`) and the background
 * refresh keeps the list flowing, so the models land in the picker without a
 * `/reload` as soon as discovery finishes. If discovery fails, nothing is
 * registered and a clear message is logged (the user runs
 * `vibe-acp --setup` if Vibe is not signed in — the bridge never asks for or
 * stores a key, AGENTS.md §14).
 */
import type { ExtensionAPI, ProviderConfig } from '@earendil-works/pi-coding-agent';
import { getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';
import { DEFAULT_PROVIDER_NAME, loadConfig, type BridgeConfig } from './config.ts';
import type { SpawnChildFn } from './acp-client.ts';
import { registerBridgeCommands } from './commands.ts';
import { createSessionNotifier, type SessionNotifier } from './notify.ts';
import { MistralProvider } from './provider.ts';
import { registerAskVibeTool, type AskVibeManager, type RegisterAskVibeDeps } from './ask-vibe.ts';
import { ModelCatalog, PI_BUILTIN_MISTRAL_PROVIDER } from './models.ts';
// The capability fallbacks and the reserved builtin provider name live in
// src/models.ts (T7) next to the catalog that uses them; re-exported here so
// the entry-point module keeps its stable public surface.
export {
  FALLBACK_CONTEXT_WINDOW,
  FALLBACK_MAX_TOKENS,
  PI_BUILTIN_MISTRAL_PROVIDER,
} from './models.ts';

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
 * Conservative capability defaults for a discovered model live in
 * src/models.ts ({@link FALLBACK_CONTEXT_WINDOW} / {@link FALLBACK_MAX_TOKENS},
 * ADR-0005); the catalog enriches them from the option's extra fields,
 * `usage_update.size` or Pi's own registry before the provider is registered.
 */

/**
 * Provider names the bridge must never register (AGENTS.md §6):
 * `pi.registerProvider` REPLACES the named provider's model list, so
 * registering an already-registered name would shadow it. The ExtensionAPI
 * has no provider-listing method, so the reserved set is resolved at RUNTIME
 * from pi-ai's public builtin catalog (`@earendil-works/pi-ai/providers/all`,
 * a documented package subpath — no private reach-through), plus `mistral`
 * explicitly in case the catalog ever changes.
 */
export function reservedProviderNames(): ReadonlySet<string> {
  return new Set<string>([...getBuiltinProviders(), PI_BUILTIN_MISTRAL_PROVIDER]);
}

/** Test/deps injection for {@link registerMistralProvider}. */
export interface RegisterMistralProviderDeps {
  /** Pi session cwd; defaults to `process.cwd()`. */
  cwd?: string | undefined;
  /** Test injection: child spawn. */
  spawnChild?: SpawnChildFn | undefined;
  /** Anomaly sink. */
  onAnomaly?: ((message: string) => void) | undefined;
  /** Warning sink for discovery failures; defaults to the session notifier. */
  onWarn?: ((message: string) => void) | undefined;
  /** Debug log dir; defaults to `~/.pi/agent/logs/mistral-bridge/`. */
  logDir?: string | undefined;
  /**
   * Test injection: the warning channel. Defaults to a stderr→`ui.notify`
   * notifier (src/notify.ts), so warnings stop painting over the TUI once the
   * session context is known.
   */
  notifier?: SessionNotifier | undefined;
  /** Home directory for the doctor report's config paths; defaults to `os.homedir()`. */
  home?: string | undefined;
  /** Headless sink for command output (print/RPC mode); defaults to stdout. */
  commandWrite?: ((text: string) => void) | undefined;
}

/**
 * The result of {@link registerProviderWithStartup}: the provider plus the
 * bounded startup wait.
 */
export interface RegisteredBridge {
  /** The registered provider (callers/tests drive `streamSimple` and dispose through it). */
  provider: MistralProvider;
  /**
   * Resolves when the FIRST model discovery has settled (success or failure)
   * or when `config.startupDiscoveryTimeoutMs` elapsed — whichever comes
   * first. Never rejects. On the timeout path a quiet warning was logged and
   * the discovery keeps running in the background; a dispose during the wait
   * resolves it silently (the intentional dispose-abort, commit 828f223).
   */
  startupReady: Promise<void>;
}

/**
 * Bounded await of the first model discovery (startup race fix, see the
 * module doc): races `firstDiscovery` against `config.startupDiscoveryTimeoutMs`.
 * The discovery itself is NOT aborted on timeout — only the wait is bounded —
 * so the models still land via the background discovery/refresh. Never
 * rejects; the timeout path logs a quiet warning (not an error).
 */
async function awaitFirstDiscovery(
  firstDiscovery: Promise<void>,
  config: BridgeConfig,
  warn: (message: string) => void
): Promise<void> {
  let timedOut = false;
  const timeout = new Promise<'timeout'>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      resolve('timeout');
    }, config.startupDiscoveryTimeoutMs);
    timer.unref();
  });
  await Promise.race([
    firstDiscovery.then(
      () => 'discovery' as const,
      () => 'discovery' as const
    ),
    timeout,
  ]);
  if (timedOut) {
    warn(
      `startup model discovery still in progress after ${config.startupDiscoveryTimeoutMs} ms — ` +
        `continuing startup; the "${config.providerName}" models appear as soon as the discovery ` +
        `finishes (the background refresh keeps the list flowing)`
    );
  }
}

/**
 * Wires the bridge provider into Pi: creates the {@link MistralProvider},
 * starts the model discovery, registers the provider once the list is known,
 * hooks `session_start` / `session_shutdown`, and returns the provider
 * together with {@link RegisteredBridge.startupReady} — the bounded await of
 * the first discovery that the async extension factory waits on.
 */
function registerProviderWithStartup(
  pi: ExtensionAPI,
  config: BridgeConfig,
  deps: RegisterMistralProviderDeps = {}
): RegisteredBridge {
  const cwd = deps.cwd ?? process.cwd();
  // One warning channel (src/notify.ts): stderr until `session_start` provides
  // the Pi context, `ctx.ui.notify` afterwards — a raw stderr write while the
  // TUI renders paints over it.
  const notifier = deps.notifier ?? createSessionNotifier();
  const warn: (message: string) => void =
    deps.onWarn ?? ((message: string): void => notifier.warn(message));
  const anomaly = deps.onAnomaly ?? ((message: string): void => notifier.warn(message));

  // AGENTS.md §6: the bridge registers only its OWN provider; it must never
  // shadow any provider Pi already registers (registerProvider REPLACES the
  // model list of the named provider). The reserved names are Pi's builtin
  // providers, resolved at runtime (see reservedProviderNames).
  if (reservedProviderNames().has(config.providerName)) {
    warn(
      `mistral-bridge.json: "providerName" must not be "${config.providerName}" — it collides with a ` +
        `provider Pi already registers, and the bridge never registers or shadows a provider it does ` +
        `not own (AGENTS.md §6); nothing was registered. Choose a unique name (default ` +
        `"${DEFAULT_PROVIDER_NAME}").`
    );
    // Register NOTHING (AGENTS.md §6). The returned provider is an inert
    // placeholder so the caller's lifecycle hooks have a valid object: no
    // discovery spawn, no bridge/pool, no registerProvider call.
    const provider = new MistralProvider({
      config,
      cwd,
      spawnChild: deps.spawnChild,
      onAnomaly: anomaly,
      logDir: deps.logDir,
    });
    // The doctor still explains the state, and the models command points at it.
    registerBridgeCommands(pi, {
      config,
      cwd,
      home: deps.home,
      catalog: null,
      notRegisteredReason:
        `"providerName" is "${config.providerName}", which collides with a provider Pi already ` +
        `registers — nothing was registered (AGENTS.md §6); pick a unique name (default ` +
        `"${DEFAULT_PROVIDER_NAME}") in mistral-bridge.json, then /reload`,
      write: deps.commandWrite,
    });
    pi.on('session_start', (_event, ctx) => {
      notifier.attach({ hasUI: ctx.hasUI, ui: ctx.ui });
      void provider.openSession();
    });
    pi.on('session_shutdown', () => {
      notifier.attach(null);
      void provider.dispose();
    });
    return { provider, startupReady: Promise.resolve() };
  }

  // The catalog is created below; the provider reports runtime
  // `usage_update.size` observations to it (T7 capability cache, per API id).
  const catalogRef: { current: ModelCatalog | null } = { current: null };
  const provider = new MistralProvider({
    config,
    cwd,
    spawnChild: deps.spawnChild,
    onAnomaly: anomaly,
    logDir: deps.logDir,
    onUsageContextSize: (apiId, contextSize): void =>
      catalogRef.current?.noteContextSize(apiId, contextSize),
  });

  // The ModelCatalog (src/models.ts, T7, ADR-0005/0007) owns the model list:
  // one short-lived discovery `vibe-acp` process at extension load (async —
  // the load is not blocked on the spawn) plus a background refresh timer.
  // On EVERY change (initial discovery, refresh, runtime capability update)
  // it publishes the FULL list via onModels and the provider is registered
  // again — registerProvider REPLACES the model list (AGENTS.md §6), so the
  // new call always carries the complete list, never a delta. The catalog
  // also owns the discovery abort: dispose() (session_shutdown) kills an
  // in-flight discovery child, and onModels re-checks isDisposed so a
  // disposed provider never registers.
  const catalog = new ModelCatalog({
    config,
    cwd,
    spawnChild: deps.spawnChild,
    onAnomaly: deps.onAnomaly,
    logDir: deps.logDir,
    onModels: (models, aliasByApiId): void => {
      if (provider.isDisposed) return; // disposed during discovery: register nothing
      // cache: API id → alias for the provider's model routing (ADR-0007)
      provider.setAliasByApiId(aliasByApiId);
      const providerConfig: ProviderConfig = {
        name: config.providerName,
        baseUrl: BRIDGE_BASE_URL,
        apiKey: BRIDGE_API_KEY,
        api: BRIDGE_API,
        models: [...models],
        streamSimple: (model, context, options) => provider.streamSimple(model, context, options),
      };
      pi.registerProvider(config.providerName, providerConfig);
    },
  });
  catalogRef.current = catalog;
  provider.onDispose(() => catalog.dispose());
  catalog.startRefresh();
  // Diagnostics inside Pi (`/mistral-bridge.doctor`, `/mistral-bridge.models`).
  registerBridgeCommands(pi, {
    config,
    cwd,
    home: deps.home,
    catalog,
    write: deps.commandWrite,
  });

  // First discovery (ADR-0005): kicked off at load and awaited by the async
  // extension factory (bounded by `startupDiscoveryTimeoutMs`, see
  // awaitFirstDiscovery), so on success the provider is registered before
  // Pi's first render; the background refresh above keeps the list flowing
  // afterwards. A dispose() during the in-flight discovery (session_shutdown)
  // aborts it intentionally — the abort hook killed the discovery child
  // (AGENTS.md §15). That is a quiet shutdown, not a discovery failure: no
  // warning (commit 828f223).
  const firstDiscovery = (async (): Promise<void> => {
    try {
      await catalog.discover();
    } catch (error) {
      // A dispose() during the in-flight discovery (session_shutdown) aborts it
      // intentionally — the abort hook killed the discovery child (AGENTS.md
      // §15). That is a quiet shutdown, not a discovery failure: no warning.
      if (!catalog.isDisposed) {
        // register NOTHING on failure (an empty models list would replace the
        // provider's list with nothing); the message tells the user what to do
        warn(
          `model discovery failed — no "${config.providerName}" models registered; if Vibe is not ` +
            `signed in run \`vibe-acp --setup\`, then /reload. (${String(error)})`
        );
      }
    }
  })();
  const startupReady = awaitFirstDiscovery(firstDiscovery, config, warn);

  pi.on('session_start', (_event, ctx) => {
    notifier.attach({ hasUI: ctx.hasUI, ui: ctx.ui });
    void provider.openSession();
  });
  pi.on('session_shutdown', () => {
    notifier.attach(null);
    void provider.dispose();
  });
  return { provider, startupReady };
}

/**
 * Wires the bridge provider into Pi (see {@link registerProviderWithStartup})
 * and returns the provider — tests use it to drive `streamSimple` and to
 * dispose. Callers that need the startup wait use {@link wireExtension} /
 * {@link bridgeExtension} instead.
 */
export function registerMistralProvider(
  pi: ExtensionAPI,
  config: BridgeConfig,
  deps: RegisterMistralProviderDeps = {}
): MistralProvider {
  return registerProviderWithStartup(pi, config, deps).provider;
}

// ------------------------------------------------------------- entry point

/** Test/deps injection for {@link wireExtension} (provider + AskVibe). */
export interface WireExtensionDeps extends RegisterMistralProviderDeps, RegisterAskVibeDeps {}

/** The wired extension: provider + AskVibe + the bounded startup wait. */
export interface WiredExtension {
  provider: MistralProvider;
  askVibe: AskVibeManager | null;
  /** Bounded await of the first model discovery (see {@link RegisteredBridge.startupReady}). */
  startupReady: Promise<void>;
}

/**
 * Wires the whole bridge into Pi: the provider mode
 * ({@link registerProviderWithStartup}) and — when `config.askVibe.enabled` —
 * the AskVibe tool ({@link registerAskVibeTool}, ADR-0004). Returns both
 * runtimes plus the startup wait so callers/tests can dispose them and await
 * the first discovery.
 */
export function wireExtension(
  pi: ExtensionAPI,
  config: BridgeConfig,
  deps: WireExtensionDeps = {}
): WiredExtension {
  // One notifier for both runtimes: the AskVibe pool's anomalies must also
  // stop going to stderr once the session context is known (src/notify.ts).
  const notifier = deps.notifier ?? createSessionNotifier();
  const { provider, startupReady } = registerProviderWithStartup(pi, config, {
    ...deps,
    notifier,
  });
  const askVibe = config.askVibe.enabled
    ? registerAskVibeTool(pi, config, {
        cwd: deps.cwd,
        spawnChild: deps.spawnChild,
        onAnomaly: deps.onAnomaly ?? ((message: string): void => notifier.warn(message)),
        logDir: deps.logDir,
      })
    : null;
  return { provider, askVibe, startupReady };
}

/**
 * Async factory core (the default export delegates here): wires provider +
 * AskVibe and awaits the FIRST model discovery bounded by
 * `startupDiscoveryTimeoutMs`, so on a fast discovery the models are
 * registered before Pi's first render (see the module doc); on timeout
 * startup continues with a quiet warning and the background discovery/refresh
 * keeps the models flowing. Returns the wired runtimes so callers/tests can
 * dispose them.
 */
export async function bridgeExtension(
  pi: ExtensionAPI,
  config: BridgeConfig,
  deps: WireExtensionDeps = {}
): Promise<WiredExtension> {
  const wired = wireExtension(pi, config, deps);
  await wired.startupReady;
  return wired;
}

/**
 * Extension factory (async): Pi awaits the returned promise before
 * session_start and before queued registerProvider calls are flushed
 * (pi-coding-agent docs/extensions.md, "Async factory functions") — load
 * config, wire provider + AskVibe, await the first model discovery bounded by
 * `startupDiscoveryTimeoutMs` (see the module doc).
 */
export default async function (pi: ExtensionAPI): Promise<void> {
  await bridgeExtension(pi, loadConfig(process.cwd()));
}

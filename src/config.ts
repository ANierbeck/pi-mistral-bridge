/**
 * Bridge configuration.
 *
 * The bridge owns exactly one config file pair (AGENTS.md §6): a global
 * `~/.pi/agent/mistral-bridge.json` and an optional project override
 * `.pi/mistral-bridge.json` (relative to the Pi session cwd), merged
 * project-over-global. Loading is strictly read-only: the bridge never
 * writes Pi-owned files (models.json, settings.json, ...) and never reads
 * anything under `~/.vibe/` — Vibe's authentication is Vibe's business
 * (AGENTS.md §14).
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Path parts of the global config, relative to the home directory. */
export const GLOBAL_CONFIG_PATH_PARTS = ['.pi', 'agent', 'mistral-bridge.json'] as const;
/** Path parts of the project override, relative to the project cwd. */
export const PROJECT_CONFIG_PATH_PARTS = ['.pi', 'mistral-bridge.json'] as const;

export const DEFAULT_VIBE_ACP_PATH = 'vibe-acp';
export const DEFAULT_PROVIDER_NAME = 'mistral-vibe';
/** ADR-0007: idle reaper for the per-model `vibe-acp` process pool — 10 min. */
export const DEFAULT_PROCESS_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * ADR-0006: Vibe 3.1.4 enforces a hard 60 s per-turn effect budget
 * (`max_elapsed_ms=60_000`, app_server/_runtime.py:2226, verified by the paid
 * run), so Pi tools are pre-emptively timed out at 55 s.
 */
export const DEFAULT_TOOL_PRE_TIMEOUT_MS = 55_000;
/** The hard per-turn budget on Vibe 3.1.4; a pre-timeout above it is a config error. */
export const VIBE_TURN_BUDGET_MS = 60_000;
/**
 * T3 abort watchdog: after `session/cancel`, a pending prompt that does not
 * resolve within this time kills the `vibe-acp` child (a pending
 * `session/request_permission` makes `session/cancel` hang on Vibe 3.1.4 —
 * paid run prompt 3, ADR-0006) and marks the session dirty for rebuild
 * (ADR-0003).
 */
export const DEFAULT_ABORT_WATCHDOG_MS = 5_000;
/**
 * Model-discovery timeout (T5 slice C2): one short-lived `vibe-acp` process at
 * extension load reads the `model` config option (ADR-0005). A hang (e.g. a
 * wedged child) is killed after this time so the extension never blocks on
 * discovery; `dispose()` aborts it even earlier.
 */
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 30_000;
/**
 * Startup race fix: Pi awaits an async extension factory before session_start
 * and before queued registerProvider calls are flushed (pi-coding-agent
 * docs/extensions.md, "Async factory functions"), so the factory awaits the
 * FIRST model discovery with this bound. On timeout a quiet warning is
 * logged and startup continues; the discovery itself is NOT aborted (it is
 * still bounded by `discoveryTimeoutMs`) and keeps running in the background.
 */
export const DEFAULT_STARTUP_DISCOVERY_TIMEOUT_MS = 10_000;
/**
 * T7 background model-list refresh: the catalog re-runs the discovery against
 * `vibe-acp` on this interval and re-registers the provider when the list
 * changed (aliases are volatile, ADR-0007). 30 min default.
 */
export const DEFAULT_MODEL_REFRESH_INTERVAL_MS = 30 * 60 * 1_000;

/** AskVibe modes per ADR-0004 (design: `ask` / `plan` / `edit`, default `ask`). */
export const ASK_VIBE_MODES = ['ask', 'plan', 'edit'] as const;
export type AskVibeMode = (typeof ASK_VIBE_MODES)[number];

export interface AskVibeConfig {
  enabled: boolean;
  defaultMode: AskVibeMode;
  autoApprove: boolean;
}

export interface BridgeConfig {
  vibeAcpPath: string;
  providerName: string;
  askVibe: AskVibeConfig;
  debug: boolean;
  processIdleTimeoutMs: number;
  toolPreTimeoutMs: number;
  abortWatchdogMs: number;
  discoveryTimeoutMs: number;
  startupDiscoveryTimeoutMs: number;
  modelRefreshIntervalMs: number;
}

export interface LoadConfigOptions {
  /** Test injection: home directory. Defaults to `os.homedir()`. */
  home?: string;
  /** Test injection: sink for unknown-key warnings. Defaults to stderr. */
  onWarn?: (message: string) => void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Type guard for AskVibe mode strings (also used to validate tool params at runtime). */
export function isAskVibeMode(value: unknown): value is AskVibeMode {
  return typeof value === 'string' && (ASK_VIBE_MODES as readonly string[]).includes(value);
}

/** Reads and JSON-parses one config file; `undefined` when it does not exist. */
function readConfigFile(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    throw new Error(`mistral-bridge.json at ${path} is not valid JSON: ${String(error)}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(
      `mistral-bridge.json at ${path} must contain a JSON object, got ${typeName(parsed)}`
    );
  }
  return parsed;
}

/** Mutable accumulation of the two config layers before defaults are applied. */
interface ConfigDraft {
  vibeAcpPath?: string;
  providerName?: string;
  debug?: boolean;
  processIdleTimeoutMs?: number;
  toolPreTimeoutMs?: number;
  abortWatchdogMs?: number;
  discoveryTimeoutMs?: number;
  startupDiscoveryTimeoutMs?: number;
  modelRefreshIntervalMs?: number;
  askVibe?: Partial<AskVibeConfig>;
}

function fail(path: string, key: string, expectation: string, actual: unknown): never {
  throw new Error(
    `mistral-bridge.json at ${path}: "${key}" must be ${expectation}, got ${typeName(actual)}`
  );
}

function requirePositiveMs(path: string, key: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail(path, key, 'a positive number (ms)', value);
  }
  return value;
}

/**
 * Validates one parsed config file onto the draft. Wrong types and invalid
 * values throw a clear error naming file, key and expectation; unknown keys
 * only warn (forward compatibility) and are ignored.
 */
function applyLayer(
  draft: ConfigDraft,
  raw: Record<string, unknown>,
  path: string,
  warn: (message: string) => void
): void {
  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case 'vibeAcpPath':
      case 'providerName': {
        if (typeof value !== 'string' || value.length === 0) {
          fail(path, key, 'a non-empty string', value);
        }
        if (key === 'vibeAcpPath') draft.vibeAcpPath = value;
        else draft.providerName = value;
        break;
      }
      case 'debug': {
        if (typeof value !== 'boolean') fail(path, key, 'a boolean', value);
        draft.debug = value;
        break;
      }
      case 'processIdleTimeoutMs': {
        draft.processIdleTimeoutMs = requirePositiveMs(path, key, value);
        break;
      }
      case 'abortWatchdogMs': {
        draft.abortWatchdogMs = requirePositiveMs(path, key, value);
        break;
      }
      case 'discoveryTimeoutMs': {
        draft.discoveryTimeoutMs = requirePositiveMs(path, key, value);
        break;
      }
      case 'startupDiscoveryTimeoutMs': {
        draft.startupDiscoveryTimeoutMs = requirePositiveMs(path, key, value);
        break;
      }
      case 'modelRefreshIntervalMs': {
        draft.modelRefreshIntervalMs = requirePositiveMs(path, key, value);
        break;
      }
      case 'toolPreTimeoutMs': {
        const ms = requirePositiveMs(path, key, value);
        if (ms > VIBE_TURN_BUDGET_MS) {
          throw new Error(
            `mistral-bridge.json at ${path}: "toolPreTimeoutMs" must not exceed ` +
              `${VIBE_TURN_BUDGET_MS} ms — Vibe ${'3.1.4'} enforces a hard 60 s per-turn budget ` +
              `(ADR-0006), got ${ms}`
          );
        }
        draft.toolPreTimeoutMs = ms;
        break;
      }
      case 'askVibe': {
        if (!isPlainObject(value)) fail(path, key, 'an object', value);
        const ask = (draft.askVibe ??= {});
        for (const [subKey, subValue] of Object.entries(value)) {
          switch (subKey) {
            case 'enabled':
            case 'autoApprove': {
              if (typeof subValue !== 'boolean')
                fail(path, `askVibe.${subKey}`, 'a boolean', subValue);
              if (subKey === 'enabled') ask.enabled = subValue;
              else ask.autoApprove = subValue;
              break;
            }
            case 'defaultMode': {
              if (typeof subValue !== 'string' || !isAskVibeMode(subValue)) {
                throw new Error(
                  `mistral-bridge.json at ${path}: "askVibe.defaultMode" must be one of ` +
                    `${ASK_VIBE_MODES.join(' | ')}, got ${JSON.stringify(subValue)}`
                );
              }
              ask.defaultMode = subValue;
              break;
            }
            default:
              warn(`mistral-bridge.json at ${path}: unknown key "askVibe.${subKey}" (ignored)`);
          }
        }
        break;
      }
      default:
        warn(`mistral-bridge.json at ${path}: unknown key "${key}" (ignored)`);
    }
  }
}

function defaultWarn(message: string): void {
  // src/ must not use console (eslint no-console); warnings go to stderr.
  process.stderr.write(`pi-mistral-bridge: ${message}\n`);
}

function deepFreeze<T>(value: T): T {
  if (isPlainObject(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return Object.freeze(value);
}

/**
 * Loads the bridge config: global `<home>/.pi/agent/mistral-bridge.json`, then
 * the project override `<cwd>/.pi/mistral-bridge.json` merged over it, with
 * defaults for everything unset. The result is deeply frozen. Read-only: no
 * file is ever created or modified, and nothing under `~/.vibe/` is read.
 */
export function loadConfig(cwd: string, options: LoadConfigOptions = {}): BridgeConfig {
  const home = options.home ?? homedir();
  const warn = options.onWarn ?? defaultWarn;
  const draft: ConfigDraft = {};

  const globalPath = join(home, ...GLOBAL_CONFIG_PATH_PARTS);
  const globalRaw = readConfigFile(globalPath);
  if (globalRaw !== undefined) applyLayer(draft, globalRaw, globalPath, warn);

  const projectPath = join(cwd, ...PROJECT_CONFIG_PATH_PARTS);
  const projectRaw = readConfigFile(projectPath);
  if (projectRaw !== undefined) applyLayer(draft, projectRaw, projectPath, warn);

  const config: BridgeConfig = {
    vibeAcpPath: draft.vibeAcpPath ?? DEFAULT_VIBE_ACP_PATH,
    providerName: draft.providerName ?? DEFAULT_PROVIDER_NAME,
    askVibe: {
      enabled: draft.askVibe?.enabled ?? true,
      defaultMode: draft.askVibe?.defaultMode ?? 'ask',
      autoApprove: draft.askVibe?.autoApprove ?? false,
    },
    debug: draft.debug ?? false,
    processIdleTimeoutMs: draft.processIdleTimeoutMs ?? DEFAULT_PROCESS_IDLE_TIMEOUT_MS,
    toolPreTimeoutMs: draft.toolPreTimeoutMs ?? DEFAULT_TOOL_PRE_TIMEOUT_MS,
    abortWatchdogMs: draft.abortWatchdogMs ?? DEFAULT_ABORT_WATCHDOG_MS,
    discoveryTimeoutMs: draft.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
    startupDiscoveryTimeoutMs:
      draft.startupDiscoveryTimeoutMs ?? DEFAULT_STARTUP_DISCOVERY_TIMEOUT_MS,
    modelRefreshIntervalMs: draft.modelRefreshIntervalMs ?? DEFAULT_MODEL_REFRESH_INTERVAL_MS,
  };
  return deepFreeze(config);
}

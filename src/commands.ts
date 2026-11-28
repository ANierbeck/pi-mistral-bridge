/**
 * Slash commands for the bridge (pattern taken from pi-antigravity's
 * `/antigravity.doctor`): the bridge's failure modes — no models in the
 * picker, a failing discovery, a provider-name collision — otherwise only
 * reach the user as stderr lines that may never be seen inside the TUI.
 *
 * - `/mistral-bridge.doctor` renders one sanitized report: provider name,
 *   `vibe-acp` command, which config files exist, the effective knobs, the
 *   registered models with their Vibe aliases, the last discovery outcome and
 *   a remediation hint. No token, prompt or transcript content is included.
 * - `/mistral-bridge.models [refresh]` lists the registered models; `refresh`
 *   runs a fresh discovery first (the same code path the 30 min timer uses).
 *
 * Output channel: `ctx.ui.notify` when Pi has a UI, stdout otherwise — never
 * the raw terminal while the TUI renders (same rule as src/notify.ts).
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import {
  GLOBAL_CONFIG_PATH_PARTS,
  PROJECT_CONFIG_PATH_PARTS,
  type BridgeConfig,
} from './config.ts';
import type { DiscoveryOutcome } from './models.ts';
import type { BridgeMessageType } from './notify.ts';

/** Command names (Pi resolves them as `/mistral-bridge.doctor` …). */
export const DOCTOR_COMMAND = 'mistral-bridge.doctor';
export const MODELS_COMMAND = 'mistral-bridge.models';

/** Models listed in the doctor report before the list is summarized. */
export const MAX_MODELS_IN_REPORT = 10;

/** The model fields the diagnostics read (structural, so tests can fake them). */
export interface DiagnosticsModel {
  id: string;
  name?: string | undefined;
}

/** The catalog slice the commands use (structural, so tests can fake it). */
export interface CommandCatalog {
  readonly currentModels: readonly DiagnosticsModel[];
  readonly aliasMap: ReadonlyMap<string, string>;
  readonly lastDiscovery: DiscoveryOutcome | null;
  readonly isDisposed: boolean;
  discover(): Promise<unknown>;
}

export interface DoctorReportInput {
  config: BridgeConfig;
  cwd: string;
  home: string;
  models: readonly DiagnosticsModel[];
  aliasByApiId: ReadonlyMap<string, string>;
  discovery: DiscoveryOutcome | null;
  /** Set when nothing was registered (provider-name collision, AGENTS.md §6). */
  notRegisteredReason?: string | undefined;
  nodeVersion: string;
  /** Injectable clock for deterministic tests. */
  now?: number | undefined;
}

export interface RegisterBridgeCommandsOptions {
  config: BridgeConfig;
  cwd: string;
  home?: string | undefined;
  /** Null when the bridge registered nothing (provider-name collision). */
  catalog: CommandCatalog | null;
  notRegisteredReason?: string | undefined;
  /** Headless sink; defaults to stdout. */
  write?: ((text: string) => void) | undefined;
  nodeVersion?: string | undefined;
}

/** "just now" / "12 s" / "3 min" / "2 h" from an age in milliseconds. */
export function formatAge(ageMs: number): string {
  const seconds = Math.max(0, Math.round(ageMs / 1000));
  if (seconds < 1) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

/** One line for the last discovery attempt. */
export function formatDiscovery(discovery: DiscoveryOutcome | null, now: number): string {
  if (discovery === null) return 'has not finished yet (startup discovery still running)';
  if (discovery.ok) {
    return `ok ${formatAge(now - discovery.at)} — ${discovery.modelCount} model(s) registered`;
  }
  return `failed ${formatAge(now - discovery.at)} — ${discovery.error ?? 'unknown error'}`;
}

/** The config files the bridge reads, in merge order, with existence state. */
export function configFileStates(
  home: string,
  cwd: string
): Array<{ path: string; present: boolean }> {
  return [
    { path: join(home, ...GLOBAL_CONFIG_PATH_PARTS), present: false },
    { path: join(cwd, ...PROJECT_CONFIG_PATH_PARTS), present: false },
  ].map((entry) => ({ ...entry, present: existsSync(entry.path) }));
}

/** Remediation hint for the current state (empty when everything looks fine). */
function doctorHint(input: DoctorReportInput): string | null {
  if (input.notRegisteredReason !== undefined) return input.notRegisteredReason;
  if (input.discovery !== null && !input.discovery.ok) {
    return (
      'the last discovery failed — check `vibe-acp --setup` and the error above, then /reload' +
      (input.models.length > 0
        ? ' (the previously discovered models stay registered until a refresh succeeds)'
        : ' (no models are registered)')
    );
  }
  if (input.models.length > 0) return null;
  if (input.discovery === null) {
    return 'no models yet — if this persists run `vibe-acp --setup`, then /reload';
  }
  return 'discovery reported no models — check the Vibe account/plan and run /reload';
}

/** The `/mistral-bridge.doctor` report (sanitized: no token, no prompt, no history). */
export function formatDoctorReport(input: DoctorReportInput): string {
  const now = input.now ?? Date.now();
  const { config } = input;
  const lines: string[] = [
    'pi-mistral-bridge doctor',
    `provider: ${config.providerName} (address models as ${config.providerName}/<id>)`,
    `vibe-acp: ${config.vibeAcpPath}`,
    `config: ${configFileStates(input.home, input.cwd)
      .map((file) => `${file.path} (${file.present ? 'present' : 'absent'})`)
      .join(', ')}`,
    `ask_vibe: ${
      config.askVibe.enabled
        ? `enabled (default mode ${config.askVibe.defaultMode}, autoApprove ${
            config.askVibe.autoApprove ? 'on' : 'off'
          })`
        : 'disabled'
    }`,
    `debug log: ${config.debug ? 'on (~/.pi/agent/logs/mistral-bridge/, redacted)' : 'off'}`,
    `timeouts: tool ${config.toolPreTimeoutMs} ms, abort ${config.abortWatchdogMs} ms, ` +
      `discovery ${config.discoveryTimeoutMs} ms, startup ${config.startupDiscoveryTimeoutMs} ms, ` +
      `idle ${config.processIdleTimeoutMs} ms, refresh ${config.modelRefreshIntervalMs} ms`,
    `node: ${input.nodeVersion}`,
    `discovery: ${formatDiscovery(input.discovery, now)}`,
    `models: ${input.models.length} registered`,
  ];
  for (const model of input.models.slice(0, MAX_MODELS_IN_REPORT)) {
    const alias = input.aliasByApiId.get(model.id);
    const name = model.name !== undefined && model.name !== model.id ? ` (${model.name})` : '';
    lines.push(`  - ${model.id}${name}${alias !== undefined ? ` → alias ${alias}` : ''}`);
  }
  if (input.models.length > MAX_MODELS_IN_REPORT) {
    lines.push(`  … ${input.models.length - MAX_MODELS_IN_REPORT} more`);
  }
  const hint = doctorHint(input);
  if (hint !== null) lines.push(`hint: ${hint}`);
  return lines.join('\n');
}

/** The `/mistral-bridge.models` list. */
export function formatModelList(
  models: readonly DiagnosticsModel[],
  aliasByApiId: ReadonlyMap<string, string>
): string {
  if (models.length === 0) {
    return 'no models registered — run /mistral-bridge.doctor for the discovery state';
  }
  const lines = [`${models.length} model(s):`];
  for (const model of models) {
    const alias = aliasByApiId.get(model.id);
    const name = model.name !== undefined && model.name !== model.id ? ` (${model.name})` : '';
    lines.push(`  - ${model.id}${name}${alias !== undefined ? ` → alias ${alias}` : ''}`);
  }
  return lines.join('\n');
}

/**
 * Terminal-safe diagnostics text. Config files, model names and discovery
 * errors are untrusted input: escape sequences would be interpreted by a
 * headless terminal, and an error message may echo an `Authorization` header.
 */
export function safeDiagnosticText(text: string): string {
  // stripVTControlCharacters removes ANSI sequences; leftover C0/C1 control
  // characters (BEL, backspace, …) are neutralized in a codepoint loop (a
  // regex over that range trips no-control-regex) while tabs and newlines stay.
  let clean = '';
  for (const char of stripVTControlCharacters(text)) {
    const code = char.codePointAt(0) ?? 0;
    const printable =
      char === '\n' ||
      char === '\r' ||
      char === '\t' ||
      !(code < 0x20 || (code >= 0x7f && code <= 0x9f));
    clean += printable ? char : '?';
  }
  return clean.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>');
}

/** Sends one command report on the channel Pi's mode provides. */
function emit(
  ctx: Pick<ExtensionCommandContext, 'hasUI' | 'ui'>,
  text: string,
  type: BridgeMessageType,
  write: (text: string) => void
): void {
  const safe = safeDiagnosticText(text);
  if (ctx.hasUI) {
    ctx.ui.notify(safe, type);
    return;
  }
  write(`${safe}\n`);
}

/**
 * Registers `/mistral-bridge.doctor` and `/mistral-bridge.models` on the Pi
 * extension API. Safe to call when nothing was registered: `catalog: null`
 * plus `notRegisteredReason` still explains the state.
 */
export function registerBridgeCommands(
  pi: ExtensionAPI,
  options: RegisterBridgeCommandsOptions
): void {
  const write = options.write ?? ((text: string): void => void process.stdout.write(text));
  const home = options.home ?? homedir();
  const nodeVersion = options.nodeVersion ?? process.version;

  pi.registerCommand(DOCTOR_COMMAND, {
    description: 'Show mistral-bridge diagnostics (config, discovery, registered models)',
    handler: (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const catalog = options.catalog;
      const report = formatDoctorReport({
        config: options.config,
        cwd: options.cwd,
        home,
        models: catalog?.currentModels ?? [],
        aliasByApiId: catalog?.aliasMap ?? new Map(),
        discovery: catalog?.lastDiscovery ?? null,
        notRegisteredReason: options.notRegisteredReason,
        nodeVersion,
      });
      emit(ctx, report, 'info', write);
      return Promise.resolve();
    },
  });

  pi.registerCommand(MODELS_COMMAND, {
    description: 'List mistral-bridge models; add "refresh" to run a new discovery',
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const catalog = options.catalog;
      if (catalog === null) {
        emit(
          ctx,
          options.notRegisteredReason ??
            'no models registered — the bridge did not register a provider',
          'warning',
          write
        );
        return;
      }
      if (/(^|\s)(--?)?refresh\b/i.test(args)) {
        if (catalog.isDisposed) {
          emit(ctx, 'the model catalog is disposed (session shutting down)', 'warning', write);
          return;
        }
        try {
          await catalog.discover();
        } catch (error) {
          if (catalog.isDisposed) {
            emit(ctx, 'the model catalog is disposed (session shutting down)', 'warning', write);
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          emit(ctx, `model discovery failed: ${message}`, 'error', write);
          return;
        }
      }
      emit(ctx, formatModelList(catalog.currentModels, catalog.aliasMap), 'info', write);
    },
  });
}

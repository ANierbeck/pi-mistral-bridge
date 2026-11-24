/**
 * AskVibe agent mode (ADR-0004, implementation plan T6): a Pi tool
 * {@link ASK_VIBE_TOOL_NAME} (`ask_vibe`) that delegates a task to Vibe as a
 * full agent with its own tools.
 *
 * Pi's public extension API has no agent-mode registration (`registerAgent`
 * does not exist in `@earendil-works/pi-coding-agent` — checked
 * dist/core/extensions/types.d.ts), so AskVibe is exposed as a custom tool
 * via `pi.registerTool`, exactly ADR-0004's "Option 2: Pi tool AskVibe".
 *
 * Per call (each call is serialized — one sub-agent at a time keeps the
 * permission UI unambiguous):
 *
 * - the AskVibe {@link VibeProcessPool} (its OWN pool, ADR-0007 mechanism,
 *   keyed by model alias with `undefined` = Vibe's default model) provides
 *   the `vibe-acp` process. It is NOT the provider's pool: the provider's
 *   children are spawned with `VIBE_ENABLED_TOOLS` / `VIBE_MCP_SERVERS`
 *   (ADR-0006), which would deny Vibe's builtin tools — AskVibe sessions get
 *   `session/new` with `mcpServers: []` and no tool gate, so Vibe's own
 *   tools run (ADR-0004: "without the Pi MCP server"). The process-level
 *   auto-approve bypass stays OFF (`VIBE_ENABLE_AUTO_APPROVE=false`,
 *   AGENTS.md §15): the bridge never sets it to true. Vibe's MODE-level
 *   policies (ask / plan / accept-edits) are Vibe-internal and sanctioned by
 *   ADR-0004; the bridge still answers every `session/request_permission`
 *   itself (below).
 * - a DEDICATED ephemeral ACP session per call (provider-mode histories never
 *   mix in, ADR-0003 delta logic is untouched — AskVibe uses no session map),
 *   created with `mapAllToolCalls` so Vibe's builtin tool calls stream
 *   through the tool's `onUpdate` as progress.
 * - `session/set_mode` selects the requested mode (`ask`/`plan`/`edit` →
 *   `ask`/`plan`/`accept-edits`, `vibeModeIdFor` in src/vibe-protocol.ts);
 *   default `config.askVibe.defaultMode`. The requested id is first
 *   validated against the session's advertised `modes` (plan was removed in
 *   vibe-acp 3.0.0 and an unknown id is a silent no-op on 3.1.4): an
 *   unavailable mode falls back to the closest safe one (`plan`→`ask`,
 *   `edit`→`accept-edits`→`ask`), and the EFFECTIVE mode is recorded in
 *   `details.vibeModeId` + `details.modeNote` — never a mode that was not
 *   actually set (resolveEffectiveVibeModeId, src/vibe-protocol.ts).
 * - the prompt is the `question` verbatim — deliberately NO Pi transcript
 *   context: the enclosing Pi session may run on another provider, and
 *   shipping its transcript to Mistral via Vibe would leak content the user
 *   never opted into. The calling Pi agent includes whatever context it
 *   deems shareable in `question`.
 * - the answer streams back as the tool result text, capped at
 *   {@link ANSWER_TRUNCATE_AT} with a truncation marker, plus the list of
 *   files Vibe touched (file paths read from tool-call inputs, ADR-0004).
 * - the session is closed after the answer completes (ephemeral); the
 *   process is reused via the pool and reaped by its idle timer (ADR-0007).
 * - abort (`signal`) → `session/cancel` (watchdog inside acp-client) →
 *   error result, session still closed.
 * - errors map exactly like provider mode: quota →
 *   `Mistral Vibe quota exceeded…` prefix, auth → `vibe-acp --setup` hint
 *   (src/acp-client.ts `classifyAcpError`).
 *
 * Permissions (ADR-0004): with a UI, `session/request_permission` is shown
 * via `ctx.ui.select` with Vibe's option labels verbatim plus title and a
 * command/diff preview; without a UI (print mode, subagents) it is rejected,
 * unless the explicit opt-in `askVibe.autoApprove: true` (never the default)
 * answers `allow_once`. Dismissing the dialog answers `cancelled`; a dialog
 * dismissed by the call's abort answers `reject_once` — the call's
 * `AbortSignal` is passed through to `ctx.ui.select` (Pi 1.6.0
 * `ExtensionUIDialogOptions`), so a pending dialog can never outlive the
 * call. The bridge
 * NEVER answers `allow_always` / `allow_always_permanent` (those persist
 * grants into Vibe's config — pinned in src/vibe-protocol.ts): picking one is
 * downgraded to `allow_once` and logged as an anomaly. Every request is
 * answered immediately — never left pending (the `session/cancel` hang on
 * Vibe 3.1.4, ADR-0006).
 */
import * as acp from '@agentclientprotocol/sdk';
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionToolContext,
} from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import {
  AcpClientError,
  classifyAcpError,
  defaultDebugLogDir,
  VibeProcessPool,
  type AcpSession,
  type SpawnChildFn,
  type VibeAcpProcess,
} from './acp-client.ts';
import { ASK_VIBE_MODES, isAskVibeMode, type AskVibeMode, type BridgeConfig } from './config.ts';
import {
  modeStateFromConfigOptions,
  PERMISSION_OPTION_ALLOW_ONCE,
  PERMISSION_OPTION_REJECT_ONCE,
  resolveEffectiveVibeModeId,
  vibeModeIdFor,
} from './vibe-protocol.ts';

/** The Pi tool name (Pi tool names are unprefixed; the `pi__` prefix is only for tools served TO Vibe via the MCP bridge). */
export const ASK_VIBE_TOOL_NAME = 'ask_vibe';

/** Tool-result text cap for the answer; longer answers are cut with a marker. */
export const ANSWER_TRUNCATE_AT = 20_000;

/** Parameters of the `ask_vibe` tool. */
export interface AskVibeParams {
  question: string;
  mode?: AskVibeMode | undefined;
}

/** `details` of the `ask_vibe` tool result (UI rendering + logs). */
export interface AskVibeDetails {
  mode: AskVibeMode;
  /**
   * The Vibe policy id actually in effect — set via `session/set_mode` when
   * the session advertises it, otherwise the session's process default.
   * Never a mode that was not actually set (see {@link modeNote}).
   */
  vibeModeId: string;
  /**
   * Set when the requested mode was not set verbatim (unavailable on this
   * Vibe version → safe fallback, or no modes advertised → process default).
   */
  modeNote?: string | undefined;
  sessionId?: string | undefined;
  stopReason?: string | undefined;
  filesTouched: string[];
  lastTool?: string | undefined;
  answerLength: number;
  truncated: boolean;
  error?: string | undefined;
}

/** Dialog options passed through to `ctx.ui.select` (Pi ExtensionUIDialogOptions; exactOptionalPropertyTypes-safe). */
export interface AskVibeSelectOptions {
  signal?: AbortSignal;
  timeout?: number;
}

/** Per-call hooks the tool `execute` hands to the manager. */
export interface AskVibeRunHooks {
  signal?: AbortSignal | undefined;
  onUpdate?: ((partial: AgentToolResult<AskVibeDetails>) => void) | undefined;
  hasUI: boolean;
  select?:
    | ((
        title: string,
        options: string[],
        opts?: AskVibeSelectOptions
      ) => Promise<string | undefined>)
    | undefined;
}

export interface AskVibeManagerOptions {
  config: BridgeConfig;
  /** The Pi session cwd, passed to `session/new`. */
  cwd: string;
  spawnChild?: SpawnChildFn | undefined;
  onAnomaly?: ((message: string) => void) | undefined;
  logDir?: string | undefined;
}

export interface RegisterAskVibeDeps {
  cwd?: string | undefined;
  spawnChild?: SpawnChildFn | undefined;
  onAnomaly?: ((message: string) => void) | undefined;
  logDir?: string | undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Short preview of a tool call's input for the permission dialog (command / paths / raw JSON, capped). */
function permissionPreview(rawInput: unknown): string {
  if (!isPlainObject(rawInput)) return '';
  const parts: string[] = [];
  for (const key of ['command', 'file_path', 'path', 'pattern']) {
    const value = rawInput[key];
    if (typeof value === 'string' && value.length > 0) parts.push(`${key}: ${value}`);
  }
  if (parts.length === 0) {
    const json = JSON.stringify(rawInput);
    if (json) parts.push(json.length > 400 ? `${json.slice(0, 400)}…` : json);
  }
  return parts.length > 0 ? `\n${parts.join('\n')}` : '';
}

/** Collects the file path of a tool call input (ADR-0004 changed-files list). */
function collectFilePath(rawInput: unknown, files: string[]): void {
  if (!isPlainObject(rawInput)) return;
  const filePath = rawInput['file_path'];
  if (typeof filePath === 'string' && filePath.length > 0 && !files.includes(filePath)) {
    files.push(filePath);
  }
}

/** Formats the final answer: truncation marker beyond the cap + touched-files list. */
function formatAnswer(
  answer: string,
  files: readonly string[]
): { text: string; truncated: boolean } {
  const truncated = answer.length > ANSWER_TRUNCATE_AT;
  let text = truncated
    ? `${answer.slice(0, ANSWER_TRUNCATE_AT)}\n… [ask_vibe: answer truncated at ${ANSWER_TRUNCATE_AT} chars — full answer was ${answer.length} chars]`
    : answer;
  if (files.length > 0) {
    if (text.length > 0 && !text.endsWith('\n')) text += '\n';
    text += `\nFiles touched by Vibe:\n${files.map((f) => `- ${f}`).join('\n')}`;
  }
  if (text.length === 0) text = '(vibe-acp returned no text answer)';
  return { text, truncated };
}

/** The preview text sent in `onUpdate` partials (same cap as the final result). */
function previewText(answer: string): string {
  return answer.length > ANSWER_TRUNCATE_AT ? answer.slice(0, ANSWER_TRUNCATE_AT) : answer;
}

/** Picks a permission option by optionId, falling back to its kind. */
function pickOption(
  options: readonly acp.PermissionOption[],
  optionId: string,
  kind: acp.PermissionOptionKind
): acp.PermissionOption | undefined {
  return options.find((o) => o.optionId === optionId) ?? options.find((o) => o.kind === kind);
}

/**
 * The AskVibe runtime: its own `VibeProcessPool` (no MCP server, ADR-0004)
 * plus the ADR-0004 permission bridge. One instance per extension load;
 * `openSession` / `dispose` follow Pi's `session_start` / `session_shutdown`
 * (src/index.ts) so no `vibe-acp` child is orphaned (AGENTS.md §15).
 */
export class AskVibeManager {
  private readonly options: AskVibeManagerOptions;
  private pool: VibeProcessPool | null = null;
  private disposed = false;
  /** UI state of the CURRENT ask call (calls are serialized; see ask()). */
  private uiState: {
    hasUI: boolean;
    select?: AskVibeRunHooks['select'];
    signal?: AbortSignal | undefined;
  } = { hasUI: false };
  /** Serializes ask() calls: the permission bridge reads uiState per call. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: AskVibeManagerOptions) {
    this.options = options;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** `session_start`: a fresh Pi session gets a fresh pool (mirrors the provider). */
  async openSession(): Promise<void> {
    const pool = this.pool;
    this.pool = null;
    if (pool) await pool.dispose().catch(() => {});
  }

  /** `session_shutdown`: kill every pooled child (no orphans, AGENTS.md §15). */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.openSession();
  }

  private ensurePool(): VibeProcessPool {
    if (this.disposed)
      throw new AcpClientError('protocol', 'AskVibeManager is disposed (session shutdown)');
    if (this.pool) return this.pool;
    this.pool = new VibeProcessPool({
      vibeAcpPath: this.options.config.vibeAcpPath,
      processIdleTimeoutMs: this.options.config.processIdleTimeoutMs,
      abortWatchdogMs: this.options.config.abortWatchdogMs,
      debug: this.options.config.debug,
      // NO mcpServer on purpose (ADR-0004): AskVibe runs Vibe WITHOUT the Pi
      // MCP server and with its own builtin tools enabled — no
      // VIBE_ENABLED_TOOLS gate, no VIBE_MCP_SERVERS.
      cwd: this.options.cwd,
      logDir: this.options.logDir ?? defaultDebugLogDir(),
      spawnChild: this.options.spawnChild,
      onAnomaly: this.options.onAnomaly,
      permissionHandler: (params, proc): Promise<acp.RequestPermissionResponse> =>
        this.handlePermissionRequest(params, proc),
    });
    return this.pool;
  }

  /**
   * Runs one AskVibe call. Calls are serialized through {@link queue} so the
   * per-call UI state read by the permission bridge is unambiguous.
   */
  ask(params: AskVibeParams, hooks: AskVibeRunHooks): Promise<AgentToolResult<AskVibeDetails>> {
    const run = this.queue.then(() => this.runAsk(params, hooks));
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async runAsk(
    params: AskVibeParams,
    hooks: AskVibeRunHooks
  ): Promise<AgentToolResult<AskVibeDetails>> {
    const { config } = this.options;
    const mode = params.mode ?? config.askVibe.defaultMode;
    // requested Vibe policy id; replaced by the EFFECTIVE id once the session
    // reports its modes (an unknown id makes session/set_mode a silent no-op
    // on vibe-acp 3.1.4 — plan was removed in 3.0.0)
    const requestedVibeModeId = vibeModeIdFor(mode);
    const details: AskVibeDetails = {
      mode,
      vibeModeId: requestedVibeModeId,
      filesTouched: [],
      answerLength: 0,
      truncated: false,
    };
    this.uiState = { hasUI: hooks.hasUI, select: hooks.select, signal: hooks.signal };
    let session: AcpSession | null = null;
    try {
      const pool = this.ensurePool();
      // undefined key = Vibe's own default model (no VIBE_ACTIVE_MODEL)
      const proc = await pool.get(undefined);
      session = await proc.newSession({ cwd: this.options.cwd, mapAllToolCalls: true });
      details.sessionId = session.sessionId;

      const onAbort = (): void => {
        void session?.cancel().catch(() => {});
      };
      try {
        // Validate the requested mode against what the session actually
        // advertises (modes field, else the mode config option) and never
        // report a mode that was not actually set: an unknown id makes
        // session/set_mode a silent no-op on vibe-acp 3.1.4 (plan was removed
        // in 3.0.0), so fall back to the closest safe available mode.
        // set_mode runs INSIDE this try so its finally still closes the
        // ephemeral session on failure — a set_mode error must not leak it.
        const modes = session.modes ?? modeStateFromConfigOptions(session.configOptions);
        const resolution = resolveEffectiveVibeModeId(requestedVibeModeId, modes);
        details.vibeModeId = resolution.modeId;
        if (resolution.note) {
          details.modeNote = resolution.note;
          this.options.onAnomaly?.(`ask_vibe: ${resolution.note}`);
        }
        if (resolution.set) {
          try {
            await session.setMode(resolution.modeId);
          } catch (error) {
            const classified = classifyAcpError(error);
            throw new AcpClientError(
              classified.kind,
              `session/set_mode ${JSON.stringify(resolution.modeId)} failed: ${classified.message}`,
              { cause: error }
            );
          }
        }
        const prompt = session.prompt(params.question);
        // wired AFTER the prompt starts so an already-aborted signal still cancels it
        if (hooks.signal?.aborted) onAbort();
        else hooks.signal?.addEventListener('abort', onAbort, { once: true });
        let answer = '';
        for await (const event of prompt) {
          if (event.type === 'text_delta') {
            answer += event.delta;
            details.answerLength = answer.length;
            hooks.onUpdate?.({
              content: [{ type: 'text', text: previewText(answer) }],
              details: { ...details },
            });
          } else if (event.type === 'tool_call') {
            collectFilePath(event.toolCall.rawInput, details.filesTouched);
            details.lastTool = event.toolCall.title ?? event.toolCall.name;
            hooks.onUpdate?.({
              content: [{ type: 'text', text: previewText(answer) }],
              details: { ...details },
            });
          } else if (event.type === 'tool_call_update') {
            hooks.onUpdate?.({
              content: [{ type: 'text', text: previewText(answer) }],
              details: { ...details },
            });
          }
        }
        const result = await prompt.result();
        details.stopReason = result.stopReason;
        if (result.stopReason === 'cancelled') {
          details.error = 'aborted';
          return {
            content: [
              {
                type: 'text',
                text: 'ask_vibe aborted — session/cancel was sent to vibe-acp; partial answer follows if any.',
              },
            ],
            details: { ...details },
            isError: true,
          };
        }
        const formatted = formatAnswer(answer, details.filesTouched);
        details.answerLength = answer.length;
        details.truncated = formatted.truncated;
        return { content: [{ type: 'text', text: formatted.text }], details };
      } catch (error) {
        // prompt + set_mode failures: quota prefix / auth hint / aborted / crashed (acp-client)
        const classified = classifyAcpError(error);
        details.error = classified.kind;
        return { content: [{ type: 'text', text: classified.message }], details, isError: true };
      } finally {
        hooks.signal?.removeEventListener('abort', onAbort);
        // the AskVibe session is ephemeral: always close it after the answer
        // (the pooled process survives, ADR-0007)
        if (session) await session.close().catch(() => {});
      }
    } catch (error) {
      // setup failures: disposed manager, dead child, failed session/new, …
      const classified = classifyAcpError(error);
      details.error = classified.kind;
      return { content: [{ type: 'text', text: classified.message }], details, isError: true };
    } finally {
      this.uiState = { hasUI: false };
    }
  }

  /**
   * ADR-0004 permission bridge (installed as the process `permissionHandler`):
   * with a UI the request is shown via `ctx.ui.select` (Vibe's labels
   * verbatim + title/preview); headless it is rejected unless
   * `askVibe.autoApprove` (explicit opt-in, never default) answers
   * `allow_once`. Persisting options (`allow_always*`) are never answered —
   * downgraded to `allow_once` + anomaly (src/vibe-protocol.ts). Every
   * request is answered — never left pending (ADR-0006 cancel-hang).
   */
  private async handlePermissionRequest(
    params: acp.RequestPermissionRequest,
    proc: VibeAcpProcess
  ): Promise<acp.RequestPermissionResponse> {
    const session = proc.getSession(params.sessionId);
    const info = session?.toolCallInfo(params.toolCall.toolCallId);
    const title = params.toolCall.title ?? info?.title ?? 'Vibe requests permission';
    const allowOnce = pickOption(params.options, PERMISSION_OPTION_ALLOW_ONCE, 'allow_once');
    const rejectOnce = pickOption(params.options, PERMISSION_OPTION_REJECT_ONCE, 'reject_once');
    const selected = (option: acp.PermissionOption): acp.RequestPermissionResponse => ({
      outcome: { outcome: 'selected', optionId: option.optionId },
    });
    const { hasUI, select, signal } = this.uiState;
    if (!hasUI || !select) {
      // headless (print mode / subagents): reject — unless the explicit
      // opt-in flag askVibe.autoApprove is set (ADR-0004)
      if (this.options.config.askVibe.autoApprove && allowOnce) return selected(allowOnce);
      if (rejectOnce) return selected(rejectOnce);
      return { outcome: { outcome: 'cancelled' } };
    }
    const labels = params.options.map((o) => o.name);
    // The call's AbortSignal is passed through (Pi 1.6.0 ExtensionUIDialogOptions),
    // so a pending dialog can never outlive the call: on abort Pi dismisses it.
    // No extra timeout is set — the signal already bounds the dialog to the call.
    const picked = await select(
      `${title}${permissionPreview(info?.rawInput)}`,
      labels,
      signal ? { signal } : undefined
    );
    if (picked === undefined) {
      // Dismissed BY ABORT (not by the user) → answer reject_once per ADR-0006,
      // never leave the request pending (the session/cancel hang on Vibe 3.1.4).
      if (signal?.aborted && rejectOnce) return selected(rejectOnce);
      return { outcome: { outcome: 'cancelled' } };
    }
    const index = labels.indexOf(picked);
    const option = index >= 0 ? params.options[index] : undefined;
    if (!option) return { outcome: { outcome: 'cancelled' } };
    // Persisting grants are refused by kind OR optionId prefix — Vibe must
    // not slip an allow_always* id past on a mismatched kind.
    if (option.kind === 'allow_always' || option.optionId.startsWith('allow_always')) {
      this.options.onAnomaly?.(
        `ask_vibe: downgraded persisting permission option "${option.optionId}" (kind "${option.kind}") to ${PERMISSION_OPTION_ALLOW_ONCE} — ` +
          'the bridge never answers allow_always* grants (src/vibe-protocol.ts)'
      );
      return allowOnce ? selected(allowOnce) : { outcome: { outcome: 'cancelled' } };
    }
    return selected(option);
  }
}

/**
 * Registers the `ask_vibe` Pi tool (ADR-0004 Option 2) and wires the
 * manager's lifecycle to `session_start` / `session_shutdown`. Returns the
 * manager (tests use it; the entry point ignores it).
 */
export function registerAskVibeTool(
  pi: ExtensionAPI,
  config: BridgeConfig,
  deps: RegisterAskVibeDeps = {}
): AskVibeManager {
  const manager = new AskVibeManager({
    config,
    cwd: deps.cwd ?? process.cwd(),
    spawnChild: deps.spawnChild,
    onAnomaly: deps.onAnomaly,
    logDir: deps.logDir,
  });
  pi.registerTool({
    name: ASK_VIBE_TOOL_NAME,
    label: 'Ask Vibe',
    description:
      'Delegate a self-contained task to Mistral Vibe (vibe-acp) as a full agent with its own tools. ' +
      'Runs in the given mode (ask / plan / edit); tool permissions are asked in the UI, or rejected when headless.',
    promptGuidelines: [
      'Use ask_vibe to delegate a self-contained task to Mistral Vibe; put everything Vibe needs to know into `question`.',
    ],
    parameters: Type.Object({
      question: Type.String({
        description:
          'The task or question for Vibe (self-contained — include any context Vibe needs).',
      }),
      mode: Type.Optional(
        StringEnum(ASK_VIBE_MODES, {
          description: 'Vibe mode: "ask" (default), "plan" (read-only), "edit" (may change files).',
        })
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { question: string; mode?: unknown },
      signal: AbortSignal | undefined,
      onUpdate: ((partial: AgentToolResult<AskVibeDetails>) => void) | undefined,
      ctx: ExtensionToolContext
    ): Promise<AgentToolResult<AskVibeDetails>> {
      // StringEnum constrains `mode` at the Pi level; validate again for
      // direct (programmatic) calls — an invalid mode falls back to the
      // configured default instead of failing the call.
      const mode = isAskVibeMode(params.mode) ? params.mode : undefined;
      return manager.ask(
        { question: params.question, mode },
        {
          signal,
          onUpdate,
          hasUI: ctx.hasUI,
          // opts (signal/timeout, Pi 1.6.0 ExtensionUIDialogOptions) pass
          // straight through so the dialog is bound to the call's abort
          select: ctx.hasUI
            ? (title, options, opts): Promise<string | undefined> =>
                ctx.ui.select(title, options, opts)
            : undefined,
        }
      );
    },
  });
  pi.on('session_start', () => {
    void manager.openSession();
  });
  pi.on('session_shutdown', () => {
    void manager.dispose();
  });
  return manager;
}

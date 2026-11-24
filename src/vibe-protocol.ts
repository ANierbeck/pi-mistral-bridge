/**
 * The ONE place that lists every Vibe-specific surface the bridge uses
 * (AGENTS.md §16, ADR-0007): the exact `VIBE_*` env var names and semantics,
 * the ACP `clientInfo`, the Vibe-specific ACP `_meta` / extension fields
 * observed on the wire, and the MCP server naming. Every entry names the
 * Vibe version it was verified against and the evidence file, so a Vibe
 * upgrade has exactly one module to re-check — and the unit tests in
 * test/vibe-protocol.test.ts pin the literal strings, so a rename in a future
 * Vibe version fails loudly here instead of silently at runtime.
 *
 * Verified against `vibe-acp` 3.1.4; evidence:
 * docs/research/2026-11-24-vibe-acp-surface.md, sections "Vibe 3.1.4 re-check"
 * and "Vibe 3.1.4 paid run" (source line refs below are that file's 3.1.4
 * site-packages citations).
 */
import { createRequire } from 'node:module';
import type { Implementation, McpServer } from '@agentclientprotocol/sdk';

/** The `vibe-acp` version every entry in this module was verified against. */
export const VIBE_VERSION_VERIFIED = '3.1.4';
/** Where the observations behind this module live. */
export const VIBE_EVIDENCE_FILE = 'docs/research/2026-11-24-vibe-acp-surface.md';

/**
 * The `VIBE_*` environment variables the bridge sets on the `vibe-acp` child.
 * Vibe's config stack has an env layer (`core/config/layers/environment.py`,
 * `env_prefix="VIBE_"`) ranked above user/project TOML; it is per-process and
 * the only file-free switch (research §d) — the bridge never writes Vibe
 * config files.
 */
export const VIBE_ENV = Object.freeze({
  /**
   * Per-process model selection. The non-persisting alternative to
   * `session/set_config_option {configId:"model"}`, which writes the user's
   * `~/.vibe/config.toml` (research §e). Paid run: every session reported
   * `model.currentValue` = alias. The alias comes from the session's `model`
   * config option, never hardcoded (AGENTS.md §9, ADR-0005).
   */
  ACTIVE_MODEL: 'VIBE_ACTIVE_MODEL',
  /**
   * Session approval policy at creation (`vibe_schema.py:1143-1151`).
   * Stage-1 run `s3-policy-env`: the new session reports `currentModeId:"ask"`.
   */
  DEFAULT_APPROVAL_POLICY: 'VIBE_DEFAULT_APPROVAL_POLICY',
  /**
   * `"false"` removes `auto-approve` from `availableModes` and clamps the
   * bypass (`vibe_schema.py:1193-1201`; run `s3-noauto`). Never auto-approve
   * in provider mode (AGENTS.md §15).
   */
  ENABLE_AUTO_APPROVE: 'VIBE_ENABLE_AUTO_APPROVE',
  /**
   * JSON array of tool-name globs (fnmatch, case-insensitive) matched against
   * the published MCP display name `{server}_{tool}`. Builtins that match no
   * glob are denied by policy (`tool_denied`, `approvalSource:"never"`) without
   * a permission request, but their definitions stay visible to the model
   * (paid run prompt 2). Build from the bridge's MCP server name via
   * {@link buildEnabledToolsGlobs}.
   */
  ENABLED_TOOLS: 'VIBE_ENABLED_TOOLS',
  /**
   * JSON array of env-configured MCP servers; the bridge server as a
   * streamable-http entry with static bearer auth (shape verified by run
   * `s3-envmcp`: discovered with the bearer header, 0 unauthorized). The
   * bridge does NOT set `tool_timeout_sec` here: paid run prompt 1 proved the
   * hardcoded 60 s program budget (`max_elapsed_ms=60_000`,
   * `app_server/_runtime.py:2226`) cancels every MCP tool call first, for
   * ACP-supplied and env-configured servers alike, so a per-server timeout
   * never extends it. Env-configured servers override same-named ACP
   * `mcpServers` entries whole (`vibe_schema.py:1068-1072`) — the bridge uses
   * one server name for both.
   */
  MCP_SERVERS: 'VIBE_MCP_SERVERS',
} as const);

/** The `env_prefix` of Vibe's env config layer (`core/config/layers/environment.py`, research §d). */
export const VIBE_ENV_PREFIX = 'VIBE_';

/**
 * `VIBE_HOME` points at the user's own Vibe installation where their auth
 * lives. The bridge must NEVER set it (relocating it would hide Vibe's auth
 * from the child; AGENTS.md §14, research §d) — but it must not hide an
 * inherited one either: `VIBE_HOME` is the user's own setting, so
 * {@link sanitizeInheritedEnv} passes it through unchanged.
 */
export const VIBE_HOME_ENV_KEY = 'VIBE_HOME';

/**
 * Env keys the bridge must NEVER set on the child. Relocating `VIBE_HOME` for
 * the child would also hide Vibe's own auth from it (research §d; AGENTS.md
 * §14), so it is a hard invariant, pinned by a test on the
 * {@link buildProviderProcessEnv} output.
 */
export const NEVER_SET_ENV_KEYS = Object.freeze([VIBE_HOME_ENV_KEY]);

/**
 * Sanitizes an inherited environment for the `vibe-acp` child: drops every
 * `VIBE_*` key except {@link VIBE_HOME_ENV_KEY}. The child must not inherit
 * arbitrary `VIBE_*` config from the Pi process — e.g. an inherited
 * `VIBE_TOOLS={"x_pi__y":{"permission":"always"}}`,
 * `VIBE_DEFAULT_APPROVAL_POLICY=auto` or `VIBE_ENABLE_AUTO_APPROVE=true`
 * would auto-approve tools in provider mode (AGENTS.md §15). `VIBE_HOME` is
 * the exception: it is the user's own Vibe installation location (their auth
 * lives there), the bridge never sets it itself (§14) but must not hide it.
 * Non-`VIBE_*` vars (PATH, HOME, …) pass through untouched; `undefined`
 * values are dropped.
 */
export function sanitizeInheritedEnv(
  env: Record<string, string | undefined>
): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key.startsWith(VIBE_ENV_PREFIX) && key !== VIBE_HOME_ENV_KEY) continue;
    clean[key] = value;
  }
  return clean;
}

/** Provider-mode approval policy (ADR-0006): the bridge answers every `session/request_permission` itself. */
export const APPROVAL_POLICY_ASK = 'ask';
/** Value for `VIBE_ENABLE_AUTO_APPROVE` in provider mode (AGENTS.md §15). */
export const DISABLE_AUTO_APPROVE = 'false';

/** Prefix of the bridge's MCP tool names as offered to Vibe. */
export const PI_TOOL_PREFIX = 'pi__';

/**
 * Unified-harness display-name prefix for MCP tools: on vibe-acp 3.1.4 a
 * tool of server `<server>` is displayed — and reported in
 * `tool_call._meta.tool_name` — as `mcp_<server>.<tool>` (wire evidence:
 * `spikes/out/*-acp-raw.jsonl`, e.g. `"tool_name":"mcp_pi.pi__echo"`;
 * research doc "MCP naming", `mistral.vibe.mcp-naming/v1`). Pinned so a
 * rename fails loudly here.
 */
export const MCP_DISPLAY_NAME_PREFIX = 'mcp_';

/**
 * The `mcp_<server>.` display-name prefix for a given MCP server (Vibe
 * normalizes the server name, `[^A-Za-z0-9_-]` → `_`, in display names).
 */
export function buildMcpDisplayNamePrefix(mcpServerName: string): string {
  const normalized = mcpServerName.replace(/[^A-Za-z0-9_-]/g, '_');
  return `${MCP_DISPLAY_NAME_PREFIX}${normalized}.`;
}

/**
 * The prefix of `tool_call._meta.tool_name` for tools of the bridge's own
 * MCP server (3.1.4 wire form): `mcp_<server>.pi__<tool>`. Vibe normalizes
 * the server name in display names (`[^A-Za-z0-9_-]` → `_`, research doc
 * "ACP mcpServers"), so the prefix uses the normalized name. Used to map
 * `session/request_permission` toolCallIds to bridge tools (ADR-0006) — a
 * `pi__`-prefixed tool of any OTHER server must not match.
 */
export function buildBridgeToolMetaPrefix(mcpServerName: string): string {
  return `${buildMcpDisplayNamePrefix(mcpServerName)}${PI_TOOL_PREFIX}`;
}

/**
 * The `VIBE_ENABLED_TOOLS` globs for the bridge's own MCP server: the server
 * publishes each Pi tool as `pi__<tool>`, so the published display name is
 * `{server}_pi__<tool>` and the allowlist is `["<server>_pi__*"]` (the paid
 * run used the looser `["pi_*","pislow_*"]`; the tighter glob matches exactly
 * the `pi__` prefix).
 */
export function buildEnabledToolsGlobs(mcpServerName: string): string[] {
  return [`${mcpServerName}_${PI_TOOL_PREFIX}*`];
}

/** Serializes the allowlist globs as the JSON-array env value. */
export function buildEnabledToolsEnvValue(mcpServerName: string): string {
  return JSON.stringify(buildEnabledToolsGlobs(mcpServerName));
}

/** The bridge's loopback MCP server as seen by Vibe. */
export interface BridgeMcpServer {
  name: string;
  url: string;
  /** Per-session random bearer token (AGENTS.md §15). */
  token: string;
}

/**
 * ACP `session/new` `mcpServers` entry for the bridge server: streamable-http
 * only (vibe-acp rejects SSE/ACP transports, `vibe/acp/agent.py:332-339`) with
 * the bearer header sent on every request (paid run: 0 unauthorized). Vibe
 * opens a fresh MCP session per tool call (`_mcp_transport.py:118-126` opens
 * a session inside `call_http`), so the bridge's server must be stateless per
 * call.
 */
export function buildAcpMcpServerEntry(server: BridgeMcpServer): McpServer {
  return {
    type: 'http',
    name: server.name,
    url: server.url,
    headers: [{ name: 'Authorization', value: `Bearer ${server.token}` }],
  };
}

/**
 * Value for `VIBE_MCP_SERVERS`: the same bridge server as an env-configured
 * streamable-http entry with static bearer auth. `tool_timeout_sec` is
 * deliberately absent — see {@link VIBE_ENV}.MCP_SERVERS.
 */
export function buildVibeMcpServersEnvValue(server: BridgeMcpServer): string {
  return JSON.stringify([
    {
      transport: 'streamable-http',
      name: server.name,
      url: server.url,
      auth: { type: 'static', headers: { Authorization: `Bearer ${server.token}` } },
    },
  ]);
}

export interface ProviderProcessEnvParams {
  /** Model alias for `VIBE_ACTIVE_MODEL`, taken from the session's `model` config option (ADR-0005). */
  modelAlias: string;
  mcpServer: BridgeMcpServer;
}

/**
 * The full `VIBE_*` env for a provider-mode `vibe-acp` child (ADR-0006 /
 * ADR-0007). Invariant (AGENTS.md §14): the output never contains a
 * {@link NEVER_SET_ENV_KEYS} key — pinned by
 * `test/vibe-protocol.test.ts`, and enforced on the merged child env in
 * `VibeAcpProcess.start` (src/acp-client.ts), where the check can actually
 * fire. The bridge layers this over {@link sanitizeInheritedEnv} of the
 * inherited `process.env`, never over the raw environment.
 */
export function buildProviderProcessEnv(params: ProviderProcessEnvParams): Record<string, string> {
  return {
    [VIBE_ENV.ACTIVE_MODEL]: params.modelAlias,
    [VIBE_ENV.DEFAULT_APPROVAL_POLICY]: APPROVAL_POLICY_ASK,
    [VIBE_ENV.ENABLE_AUTO_APPROVE]: DISABLE_AUTO_APPROVE,
    [VIBE_ENV.ENABLED_TOOLS]: buildEnabledToolsEnvValue(params.mcpServer.name),
    [VIBE_ENV.MCP_SERVERS]: buildVibeMcpServersEnvValue(params.mcpServer),
  };
}

/**
 * Honest client identification in the ACP `initialize` handshake (AGENTS.md
 * §14): Vibe forwards `clientInfo.name`/`version` unchanged into its own
 * app-server `ClientInfo` and telemetry (`vibe.new_session` client_name /
 * client_version), so the bridge identifies as itself with its real version.
 */
export const ACP_CLIENT_NAME = 'pi-mistral-bridge';

/** Reads the real package version; resolved at runtime, not bundled. */
function readBridgeVersion(): string {
  try {
    // In the shipped package dist/index.js sits next to package.json; in the
    // repo src/ does. A variable specifier keeps esbuild from inlining it.
    const require = createRequire(import.meta.url);
    const pkgPath = '../package.json';
    const pkg = require(pkgPath) as unknown;
    if (typeof pkg === 'object' && pkg !== null && 'version' in pkg) {
      const version: unknown = pkg.version;
      if (typeof version === 'string') return version;
    }
  } catch {
    // fall through to the placeholder below
  }
  return '0.0.0-unknown';
}

/** The `clientInfo` sent in the ACP `initialize` request. */
export function acpClientInfo(): Implementation {
  return { name: ACP_CLIENT_NAME, version: readBridgeVersion() };
}

// --- Vibe-specific ACP `_meta` / extension surfaces observed on the wire (3.1.4) ---

/** `session/new` response `_meta.workspace_trust` = `{status, details}` (observed on every `session/new`, e.g. `{"status":"trusted","details":null}`). */
export const SESSION_NEW_META_WORKSPACE_TRUST = 'workspace_trust';

/**
 * `tool_call._meta.tool_name`: the called tool's display name. For MCP tools
 * on 3.1.4 that is the full `mcp_<server>.<tool>` form (e.g.
 * `"mcp_pi.pi__echo"`, wire evidence `spikes/out/*-acp-raw.jsonl`); builtins
 * carry their own name (`"file_system.bash"`). Used to map a
 * `session/request_permission`'s `toolCallId` back to the preceding
 * `tool_call` (ADR-0006) — see {@link buildBridgeToolMetaPrefix}.
 */
export const TOOL_CALL_META_TOOL_NAME = 'tool_name';

/** `tool_call._meta.effect_kind`, ∈ `"tool" | "shell"`. */
export const TOOL_CALL_META_EFFECT_KIND = 'effect_kind';

/**
 * `tool_call_update` (kind `"execute"`) `rawOutput._meta.approval` =
 * `{approvalSource, approvalType, decision}`. Observed `approvalSource` values:
 * `"never"` (policy-denied builtin), `"user"` (client answered
 * allow_once/reject_once), `"bypass"` (auto-approve — never used by the
 * bridge).
 */
export const TOOL_CALL_UPDATE_RAW_OUTPUT_APPROVAL = 'approval';

/**
 * `usage_update` notification `cost` = `{amount, currency}` — Vibe's own cost
 * accounting (ADR-0003: the bridge reports cost 0 to Pi and uses these only to
 * surface Vibe's usage).
 */
export const USAGE_UPDATE_COST = 'cost';

/**
 * `usage_update._meta` token counters (`agent.py:1768-1800`):
 * promptTokens, completionTokens, cachedTokens (cached read tokens, 3.0.1+),
 * totalTokens, steps. `usage_update.size` (same notification, no `_meta`) is
 * the active model's context window (ADR-0005 capability source).
 */
export const USAGE_UPDATE_META = Object.freeze({
  promptTokens: 'promptTokens',
  completionTokens: 'completionTokens',
  cachedTokens: 'cachedTokens',
  totalTokens: 'totalTokens',
  steps: 'steps',
} as const);

/**
 * Extension notification method `_config/changed` (3.1.1+,
 * `agent.py:409-415`): admin/org config changed. The bridge must ignore
 * extension notifications it does not know.
 */
export const EXT_NOTIFICATION_CONFIG_CHANGED = '_config/changed';

/**
 * The only `session/request_permission` option ids the bridge may answer
 * (ADR-0006): never `allow_always` / `allow_always_permanent` — those persist
 * grants into Vibe's config (`agent.py:934-952`).
 */
export const PERMISSION_OPTION_ALLOW_ONCE = 'allow_once';
export const PERMISSION_OPTION_REJECT_ONCE = 'reject_once';

/**
 * Unified-harness tool-discovery pseudo-tool seen in the model's tool list
 * (paid run prompt 2). It is Vibe's own discovery mechanism, NOT a Pi tool —
 * the bridge must never map it to one.
 */
export const UNIFIED_HARNESS_DISCOVERY_TOOL = 'search_tool_functions';

/**
 * The `session/new` `configOptions` entry id that carries the model list
 * (`{id:"model", category:"model", type:"select", options:[{value: alias,
 * name, description: apiModelId}]}`). ADR-0005/ADR-0007: the model list for
 * `registerProvider` is read from this option; the alias (`value`) is volatile,
 * the API model id (`description`) is the stable key. Pinned so a rename in a
 * future Vibe version fails loudly here.
 */
export const MODEL_CONFIG_OPTION_ID = 'model';

/**
 * The `session/prompt` response `usage` field — an UNSTABLE ACP v1 field that
 * vibe-acp 3.1.4 populates (`{totalTokens, inputTokens, outputTokens,
 * cachedReadTokens}`, cachedReadTokens omitted when 0; paid run prompts 1-2,
 * research §"Vibe 3.1.4 paid run"). The SDK 2.9.1 stable types do not declare
 * it, but it passes through on the wire, so the client reads it via this
 * pinned key.
 */
export const PROMPT_RESPONSE_USAGE = 'usage';

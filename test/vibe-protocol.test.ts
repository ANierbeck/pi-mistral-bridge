import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  ACP_CLIENT_NAME,
  acpClientInfo,
  APPROVAL_POLICY_ASK,
  buildAcpMcpServerEntry,
  buildEnabledToolsEnvValue,
  buildEnabledToolsGlobs,
  buildBridgeToolMetaPrefix,
  buildMcpDisplayNamePrefix,
  buildProviderProcessEnv,
  buildVibeMcpServersEnvValue,
  DISABLE_AUTO_APPROVE,
  EXT_NOTIFICATION_CONFIG_CHANGED,
  NEVER_SET_ENV_KEYS,
  sanitizeInheritedEnv,
  VIBE_ENV_PREFIX,
  VIBE_HOME_ENV_KEY,
  PERMISSION_OPTION_ALLOW_ONCE,
  PERMISSION_OPTION_REJECT_ONCE,
  PI_TOOL_PREFIX,
  SESSION_NEW_META_WORKSPACE_TRUST,
  TOOL_CALL_META_EFFECT_KIND,
  TOOL_CALL_META_TOOL_NAME,
  TOOL_CALL_UPDATE_RAW_OUTPUT_APPROVAL,
  MCP_DISPLAY_NAME_PREFIX,
  MODEL_CONFIG_OPTION_ID,
  PROMPT_RESPONSE_USAGE,
  UNIFIED_HARNESS_DISCOVERY_TOOL,
  USAGE_UPDATE_COST,
  USAGE_UPDATE_META,
  VIBE_ENV,
  VIBE_EVIDENCE_FILE,
  VIBE_VERSION_VERIFIED,
} from '../src/vibe-protocol.ts';

// The shipped bridge identifies itself honestly with its real package version
// (AGENTS.md §14); read the same package.json the implementation reads.
const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

const MCP_SERVER = { name: 'pi', url: 'http://127.0.0.1:4711/mcp', token: 'test-token' };

describe('VIBE_* env key names (pinned so a Vibe rename fails loudly)', () => {
  it('pins every env key the bridge sets, exactly', () => {
    expect(VIBE_ENV).toEqual({
      ACTIVE_MODEL: 'VIBE_ACTIVE_MODEL',
      DEFAULT_APPROVAL_POLICY: 'VIBE_DEFAULT_APPROVAL_POLICY',
      ENABLE_AUTO_APPROVE: 'VIBE_ENABLE_AUTO_APPROVE',
      ENABLED_TOOLS: 'VIBE_ENABLED_TOOLS',
      MCP_SERVERS: 'VIBE_MCP_SERVERS',
    });
  });

  it('pins VIBE_HOME as a key the bridge must never set', () => {
    expect(NEVER_SET_ENV_KEYS).toEqual(['VIBE_HOME']);
  });

  it('records the Vibe version and evidence file every entry was verified against', () => {
    expect(VIBE_VERSION_VERIFIED).toBe('3.1.4');
    expect(VIBE_EVIDENCE_FILE).toBe('docs/research/2026-11-24-vibe-acp-surface.md');
  });
});

describe('allowlist glob builder (VIBE_ENABLED_TOOLS)', () => {
  it('pins the Pi tool prefix', () => {
    expect(PI_TOOL_PREFIX).toBe('pi__');
  });

  it('builds ["<server>_pi__*"] from the MCP server name', () => {
    expect(buildEnabledToolsGlobs('pi')).toEqual(['pi_pi__*']);
    expect(buildEnabledToolsGlobs('bridge')).toEqual(['bridge_pi__*']);
  });

  it('serializes the globs as a JSON array env value', () => {
    expect(buildEnabledToolsEnvValue('pi')).toBe('["pi_pi__*"]');
    expect(JSON.parse(buildEnabledToolsEnvValue('pi'))).toEqual(['pi_pi__*']);
  });
});

describe('MCP server wiring', () => {
  it('builds the ACP session/new mcpServers entry: http + bearer header', () => {
    expect(buildAcpMcpServerEntry(MCP_SERVER)).toEqual({
      type: 'http',
      name: 'pi',
      url: 'http://127.0.0.1:4711/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer test-token' }],
    });
  });

  it('builds the VIBE_MCP_SERVERS env value: streamable-http + static bearer, no tool_timeout_sec', () => {
    const parsed = JSON.parse(buildVibeMcpServersEnvValue(MCP_SERVER)) as unknown[];
    expect(parsed).toEqual([
      {
        transport: 'streamable-http',
        name: 'pi',
        url: 'http://127.0.0.1:4711/mcp',
        auth: { type: 'static', headers: { Authorization: 'Bearer test-token' } },
      },
    ]);
    // Paid run (prompt 1): the hardcoded 60 s program budget fires before any
    // per-server tool_timeout_sec, so the bridge must not set one.
    expect('tool_timeout_sec' in (parsed[0] as object)).toBe(false);
  });
});

describe('provider-mode process env (ADR-0006 / ADR-0007)', () => {
  it('sets exactly the five VIBE_* vars with the verified values', () => {
    const env = buildProviderProcessEnv({ modelAlias: 'devstral-small', mcpServer: MCP_SERVER });
    expect(Object.keys(env).sort()).toEqual(Object.values(VIBE_ENV).sort() as unknown as string[]);
    expect(env[VIBE_ENV.ACTIVE_MODEL]).toBe('devstral-small');
    expect(env[VIBE_ENV.DEFAULT_APPROVAL_POLICY]).toBe('ask');
    expect(env[VIBE_ENV.DEFAULT_APPROVAL_POLICY]).toBe(APPROVAL_POLICY_ASK);
    expect(env[VIBE_ENV.ENABLE_AUTO_APPROVE]).toBe('false');
    expect(env[VIBE_ENV.ENABLE_AUTO_APPROVE]).toBe(DISABLE_AUTO_APPROVE);
    expect(env[VIBE_ENV.ENABLED_TOOLS]).toBe('["pi_pi__*"]');
    expect(JSON.parse(env[VIBE_ENV.MCP_SERVERS])).toHaveLength(1);
  });

  it('never contains a forbidden env key (VIBE_HOME)', () => {
    const env = buildProviderProcessEnv({ modelAlias: 'm', mcpServer: MCP_SERVER });
    for (const key of NEVER_SET_ENV_KEYS) {
      expect(key in env).toBe(false);
    }
  });

  it('omits VIBE_ACTIVE_MODEL / VIBE_ENABLED_TOOLS / VIBE_MCP_SERVERS for a discovery-only process (ADR-0005)', () => {
    const env = buildProviderProcessEnv({});
    expect(env[VIBE_ENV.ACTIVE_MODEL]).toBeUndefined();
    expect(env[VIBE_ENV.ENABLED_TOOLS]).toBeUndefined();
    expect(env[VIBE_ENV.MCP_SERVERS]).toBeUndefined();
    // the permission policy stays provider-mode even without a bridge server
    expect(env[VIBE_ENV.DEFAULT_APPROVAL_POLICY]).toBe(APPROVAL_POLICY_ASK);
    expect(env[VIBE_ENV.ENABLE_AUTO_APPROVE]).toBe(DISABLE_AUTO_APPROVE);
    for (const key of NEVER_SET_ENV_KEYS) {
      expect(key in env).toBe(false);
    }
  });
});

describe('ACP clientInfo (honest identification, AGENTS.md §14)', () => {
  it('pins the client name exactly', () => {
    expect(ACP_CLIENT_NAME).toBe('pi-mistral-bridge');
  });

  it('sends the real package version', () => {
    expect(acpClientInfo()).toEqual({ name: 'pi-mistral-bridge', version: pkg.version });
  });
});

describe('Vibe-specific ACP _meta / extension surfaces (pinned literals)', () => {
  it('pins the session/new workspace_trust _meta key', () => {
    expect(SESSION_NEW_META_WORKSPACE_TRUST).toBe('workspace_trust');
  });

  it('pins the tool_call _meta keys used for permission mapping', () => {
    expect(TOOL_CALL_META_TOOL_NAME).toBe('tool_name');
    expect(TOOL_CALL_META_EFFECT_KIND).toBe('effect_kind');
  });

  it('pins the tool_call_update rawOutput approval _meta key', () => {
    expect(TOOL_CALL_UPDATE_RAW_OUTPUT_APPROVAL).toBe('approval');
  });

  it('pins the usage_update cost field and _meta token counters', () => {
    expect(USAGE_UPDATE_COST).toBe('cost');
    expect(USAGE_UPDATE_META).toEqual({
      promptTokens: 'promptTokens',
      completionTokens: 'completionTokens',
      cachedTokens: 'cachedTokens',
      totalTokens: 'totalTokens',
      steps: 'steps',
    });
  });

  it('pins the _config/changed extension notification method', () => {
    expect(EXT_NOTIFICATION_CONFIG_CHANGED).toBe('_config/changed');
  });

  it('pins the only permission options the bridge may answer', () => {
    expect(PERMISSION_OPTION_ALLOW_ONCE).toBe('allow_once');
    expect(PERMISSION_OPTION_REJECT_ONCE).toBe('reject_once');
  });

  it('pins the unified-harness discovery pseudo-tool that is not a Pi tool', () => {
    expect(UNIFIED_HARNESS_DISCOVERY_TOOL).toBe('search_tool_functions');
  });

  it('pins the session config option id that carries the model list (T7 reads it)', () => {
    expect(MODEL_CONFIG_OPTION_ID).toBe('model');
  });

  it('pins the session/prompt response usage field (unstable ACP v1 field Vibe populates)', () => {
    expect(PROMPT_RESPONSE_USAGE).toBe('usage');
  });
});

describe('sanitizeInheritedEnv (AGENTS.md §15: no inherited VIBE_* reaches the child)', () => {
  it('pins the Vibe env-layer prefix and the VIBE_HOME exception', () => {
    expect(VIBE_ENV_PREFIX).toBe('VIBE_');
    expect(VIBE_HOME_ENV_KEY).toBe('VIBE_HOME');
    expect(NEVER_SET_ENV_KEYS).toEqual([VIBE_HOME_ENV_KEY]);
  });

  it('drops every inherited VIBE_* key except VIBE_HOME (e.g. VIBE_TOOLS auto-approve, auto-approve policy)', () => {
    const env = sanitizeInheritedEnv({
      PATH: '/usr/bin:/bin',
      HOME: '/var/test-home',
      VIBE_TOOLS: '{"x_pi__y":{"permission":"always"}}',
      VIBE_DEFAULT_APPROVAL_POLICY: 'auto',
      VIBE_ENABLE_AUTO_APPROVE: 'true',
      VIBE_ANYTHING_ELSE: '1',
      VIBE_HOME: '/custom/vibe-home',
      UNRELATED: 'keep',
    });
    expect(env).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/var/test-home',
      VIBE_HOME: '/custom/vibe-home',
      UNRELATED: 'keep',
    });
  });

  it('passes an inherited VIBE_HOME through unchanged and drops undefined values', () => {
    const env = sanitizeInheritedEnv({ VIBE_HOME: '/opt/vibe', MAYBE: undefined });
    expect(env).toEqual({ VIBE_HOME: '/opt/vibe' });
    expect(sanitizeInheritedEnv({})).toEqual({});
  });

  it('keeps the buildProviderProcessEnv invariant: its output never contains VIBE_HOME', () => {
    const env = buildProviderProcessEnv({ modelAlias: 'm', mcpServer: MCP_SERVER });
    expect(env).not.toHaveProperty(VIBE_HOME_ENV_KEY);
    for (const key of NEVER_SET_ENV_KEYS) expect(env).not.toHaveProperty(key);
  });
});

describe('bridge tool _meta.tool_name prefix (3.1.4 wire form)', () => {
  it('pins the unified-harness mcp_<server>. display-name prefix and the pi__ tool prefix', () => {
    expect(MCP_DISPLAY_NAME_PREFIX).toBe('mcp_');
    expect(PI_TOOL_PREFIX).toBe('pi__');
  });

  it('builds mcp_<server>.pi__ from the MCP server name, normalizing the name like Vibe', () => {
    // observed on the wire (spikes/out/*-acp-raw.jsonl): "tool_name":"mcp_pi.pi__echo"
    expect(buildBridgeToolMetaPrefix('pi')).toBe('mcp_pi.pi__');
    expect(buildBridgeToolMetaPrefix('pislow')).toBe('mcp_pislow.pi__');
    // Vibe normalizes the server name ([^A-Za-z0-9_-] → _) in display names
    expect(buildBridgeToolMetaPrefix('my server')).toBe('mcp_my_server.pi__');
    expect(buildMcpDisplayNamePrefix('pi')).toBe('mcp_pi.');
    expect(buildMcpDisplayNamePrefix('my server')).toBe('mcp_my_server.');
  });
});

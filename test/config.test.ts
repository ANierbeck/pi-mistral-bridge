import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { BridgeConfig } from '../src/config.ts';
import {
  DEFAULT_ABORT_WATCHDOG_MS,
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  DEFAULT_MODEL_REFRESH_INTERVAL_MS,
  DEFAULT_PROCESS_IDLE_TIMEOUT_MS,
  DEFAULT_PROVIDER_NAME,
  DEFAULT_STARTUP_DISCOVERY_TIMEOUT_MS,
  DEFAULT_TOOL_PRE_TIMEOUT_MS,
  DEFAULT_VIBE_ACP_PATH,
  loadConfig,
  VIBE_TURN_BUDGET_MS,
} from '../src/config.ts';

function makeSandbox(): { root: string; home: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), 'pi-mistral-bridge-config-'));
  const home = join(root, 'home');
  const cwd = join(root, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { root, home, cwd };
}

function writeGlobal(home: string, content: string): void {
  const dir = join(home, '.pi', 'agent');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'mistral-bridge.json'), content);
}

function writeProject(cwd: string, content: string): void {
  const dir = join(cwd, '.pi');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'mistral-bridge.json'), content);
}

function load(cwd: string, home: string, warnings: string[] = []): BridgeConfig {
  return loadConfig(cwd, { home, onWarn: (message) => warnings.push(message) });
}

/** Returns the thrown error message, failing the test when loadConfig does not throw. */
function loadError(cwd: string, home: string): string {
  try {
    load(cwd, home);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected loadConfig to throw, but it returned');
}

describe('config defaults', () => {
  it('exports the documented default constants', () => {
    expect(DEFAULT_VIBE_ACP_PATH).toBe('vibe-acp');
    expect(DEFAULT_PROVIDER_NAME).toBe('mistral-bridge');
    expect(DEFAULT_PROCESS_IDLE_TIMEOUT_MS).toBe(10 * 60 * 1000); // ADR-0007 pool reaper: 10 min
    expect(DEFAULT_TOOL_PRE_TIMEOUT_MS).toBe(55_000); // ADR-0006: pre-empt the hard 60 s budget
    expect(VIBE_TURN_BUDGET_MS).toBe(60_000); // Vibe 3.1.4 hardcoded per-turn budget
    expect(DEFAULT_ABORT_WATCHDOG_MS).toBe(5_000); // T3: kill a hung vibe-acp after session/cancel
    expect(DEFAULT_DISCOVERY_TIMEOUT_MS).toBe(30_000); // T5 C2: kill a hung discovery vibe-acp
    expect(DEFAULT_STARTUP_DISCOVERY_TIMEOUT_MS).toBe(10_000); // startup race fix: bounded await of the first discovery
    expect(DEFAULT_MODEL_REFRESH_INTERVAL_MS).toBe(30 * 60 * 1000); // T7: background model-list refresh
  });

  it('returns the documented defaults when no config file exists', () => {
    const { home, cwd } = makeSandbox();
    expect(load(cwd, home)).toEqual({
      vibeAcpPath: 'vibe-acp',
      providerName: 'mistral-bridge',
      askVibe: { enabled: true, defaultMode: 'ask', autoApprove: false },
      debug: false,
      processIdleTimeoutMs: 600_000,
      toolPreTimeoutMs: 55_000,
      abortWatchdogMs: 5_000,
      discoveryTimeoutMs: 30_000,
      startupDiscoveryTimeoutMs: 10_000,
      modelRefreshIntervalMs: 1_800_000,
    });
  });

  it('returns a deeply frozen object', () => {
    const { home, cwd } = makeSandbox();
    const config = load(cwd, home);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.askVibe)).toBe(true);
    expect(() => {
      (config as unknown as Record<string, unknown>).debug = true;
    }).toThrow(TypeError);
    expect(() => {
      (config.askVibe as unknown as Record<string, unknown>).enabled = false;
    }).toThrow(TypeError);
  });

  it('never writes any file (read-only load)', () => {
    const { root } = makeSandbox();
    const home = join(root, 'no-such-home');
    const cwd = join(root, 'no-such-project');
    expect(load(cwd, home)).toBeDefined();
    expect(existsSync(join(home, '.pi'))).toBe(false);
    expect(existsSync(join(cwd, '.pi'))).toBe(false);
  });

  it('defaults home to os.homedir() (HOME) when not injected', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-mistral-bridge-home-'));
    vi.stubEnv('HOME', root);
    try {
      writeGlobal(root, JSON.stringify({ providerName: 'from-home-env' }));
      const warnings: string[] = [];
      const config = loadConfig(join(root, 'project'), { onWarn: (m) => warnings.push(m) });
      expect(config.providerName).toBe('from-home-env');
      expect(warnings).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('config loading and merge', () => {
  it('applies the global ~/.pi/agent/mistral-bridge.json', () => {
    const { home, cwd } = makeSandbox();
    writeGlobal(home, JSON.stringify({ debug: true, providerName: 'global-name' }));
    const config = load(cwd, home);
    expect(config.debug).toBe(true);
    expect(config.providerName).toBe('global-name');
    expect(config.vibeAcpPath).toBe('vibe-acp'); // untouched keys keep defaults
  });

  it('merges the project .pi/mistral-bridge.json over the global file, deep-merging askVibe', () => {
    const { home, cwd } = makeSandbox();
    writeGlobal(
      home,
      JSON.stringify({
        debug: true,
        providerName: 'global-name',
        askVibe: { enabled: false, autoApprove: true },
      })
    );
    writeProject(
      cwd,
      JSON.stringify({ providerName: 'project-name', askVibe: { defaultMode: 'plan' } })
    );
    const config = load(cwd, home);
    expect(config.providerName).toBe('project-name'); // project wins
    expect(config.debug).toBe(true); // global key survives
    expect(config.askVibe).toEqual({ enabled: false, autoApprove: true, defaultMode: 'plan' });
  });

  it('works with only a project file and no global file', () => {
    const { home, cwd } = makeSandbox();
    writeProject(cwd, JSON.stringify({ toolPreTimeoutMs: 30_000 }));
    const config = load(cwd, home);
    expect(config.toolPreTimeoutMs).toBe(30_000);
    expect(config.debug).toBe(false);
  });
});

describe('config validation', () => {
  it('throws a clear error on a wrong-typed top-level key, naming file and key', () => {
    const { home, cwd } = makeSandbox();
    writeGlobal(home, JSON.stringify({ vibeAcpPath: 42 }));
    const message = loadError(cwd, home);
    expect(message).toContain('mistral-bridge.json');
    expect(message).toContain('"vibeAcpPath"');
    expect(message).toContain('string');
  });

  it('throws on a wrong-typed nested askVibe key', () => {
    const { home, cwd } = makeSandbox();
    writeProject(cwd, JSON.stringify({ askVibe: { enabled: 1 } }));
    const message = loadError(cwd, home);
    expect(message).toContain('askVibe.enabled');
    expect(message).toContain('boolean');
  });

  it('throws on an empty-string providerName', () => {
    const { home, cwd } = makeSandbox();
    writeGlobal(home, JSON.stringify({ providerName: '' }));
    expect(loadError(cwd, home)).toContain('non-empty string');
  });

  it('throws on malformed JSON', () => {
    const { home, cwd } = makeSandbox();
    writeGlobal(home, '{ nope');
    expect(loadError(cwd, home)).toContain('not valid JSON');
  });

  it('throws when the file is not a JSON object', () => {
    const { home, cwd } = makeSandbox();
    writeGlobal(home, '["vibe-acp"]');
    expect(loadError(cwd, home)).toContain('must contain a JSON object');
  });

  it('throws on an unknown askVibe.defaultMode value', () => {
    const { home, cwd } = makeSandbox();
    writeProject(cwd, JSON.stringify({ askVibe: { defaultMode: 'sometimes' } }));
    const message = loadError(cwd, home);
    expect(message).toContain('askVibe.defaultMode');
    expect(message).toContain('ask');
  });

  it('accepts all documented askVibe modes', () => {
    for (const defaultMode of ['ask', 'plan', 'edit'] as const) {
      const { home, cwd } = makeSandbox();
      writeProject(cwd, JSON.stringify({ askVibe: { defaultMode } }));
      expect(load(cwd, home).askVibe.defaultMode).toBe(defaultMode);
    }
  });

  it('rejects toolPreTimeoutMs above the 60 s Vibe budget (ADR-0006) but accepts the boundary', () => {
    const above = makeSandbox();
    writeGlobal(above.home, JSON.stringify({ toolPreTimeoutMs: VIBE_TURN_BUDGET_MS + 1 }));
    const message = loadError(above.cwd, above.home);
    expect(message).toContain('toolPreTimeoutMs');
    expect(message).toContain(String(VIBE_TURN_BUDGET_MS));

    const atBoundary = makeSandbox();
    writeGlobal(atBoundary.home, JSON.stringify({ toolPreTimeoutMs: VIBE_TURN_BUDGET_MS }));
    expect(load(atBoundary.cwd, atBoundary.home).toolPreTimeoutMs).toBe(60_000);
  });

  it('rejects non-positive timeout values', () => {
    const { home, cwd } = makeSandbox();
    writeGlobal(home, JSON.stringify({ toolPreTimeoutMs: 0 }));
    expect(loadError(cwd, home)).toContain('positive number');

    const other = makeSandbox();
    writeProject(other.cwd, JSON.stringify({ processIdleTimeoutMs: -5 }));
    expect(loadError(other.cwd, other.home)).toContain('processIdleTimeoutMs');

    const watchdog = makeSandbox();
    writeProject(watchdog.cwd, JSON.stringify({ abortWatchdogMs: 0 }));
    expect(loadError(watchdog.cwd, watchdog.home)).toContain('abortWatchdogMs');
  });

  it('names the offending value when a timeout is numeric but out of range', () => {
    const zero = makeSandbox();
    writeGlobal(zero.home, JSON.stringify({ abortWatchdogMs: 0 }));
    expect(loadError(zero.cwd, zero.home)).toContain('got 0');

    const negative = makeSandbox();
    writeGlobal(negative.home, JSON.stringify({ processIdleTimeoutMs: -5 }));
    expect(loadError(negative.cwd, negative.home)).toContain('got -5');
  });

  it('rejects timer values above the 32-bit limit Node clamps to 1 ms', () => {
    // Node's timers overflow above 2^31-1 ms: the delay is silently set to
    // 1 ms (TimeoutOverflowWarning), so an idle reaper/refresh interval would
    // fire in a loop. Every duration key must be bounded.
    const keys = [
      'processIdleTimeoutMs',
      'abortWatchdogMs',
      'discoveryTimeoutMs',
      'startupDiscoveryTimeoutMs',
      'modelRefreshIntervalMs',
    ] as const;
    for (const key of keys) {
      const { home, cwd } = makeSandbox();
      writeGlobal(home, JSON.stringify({ [key]: 2_147_483_648 }));
      const message = loadError(cwd, home);
      expect(message).toContain(key);
      expect(message).toContain('2147483647');
    }

    const boundary = makeSandbox();
    writeGlobal(boundary.home, JSON.stringify({ processIdleTimeoutMs: 2_147_483_647 }));
    expect(load(boundary.cwd, boundary.home).processIdleTimeoutMs).toBe(2_147_483_647);
  });

  it('accepts a custom abortWatchdogMs from the project file', () => {
    const { home, cwd } = makeSandbox();
    writeProject(cwd, JSON.stringify({ abortWatchdogMs: 1_500 }));
    expect(load(cwd, home).abortWatchdogMs).toBe(1_500);
  });

  it('accepts a custom discoveryTimeoutMs from the project file and rejects a non-positive one', () => {
    const { home, cwd } = makeSandbox();
    writeProject(cwd, JSON.stringify({ discoveryTimeoutMs: 2_500 }));
    expect(load(cwd, home).discoveryTimeoutMs).toBe(2_500);
    writeProject(cwd, JSON.stringify({ discoveryTimeoutMs: 0 }));
    expect(loadError(cwd, home)).toContain('discoveryTimeoutMs');
  });

  it('accepts a custom startupDiscoveryTimeoutMs from the project file and rejects a non-positive one', () => {
    const { home, cwd } = makeSandbox();
    writeProject(cwd, JSON.stringify({ startupDiscoveryTimeoutMs: 2_500 }));
    expect(load(cwd, home).startupDiscoveryTimeoutMs).toBe(2_500);
    writeProject(cwd, JSON.stringify({ startupDiscoveryTimeoutMs: 0 }));
    expect(loadError(cwd, home)).toContain('startupDiscoveryTimeoutMs');
    writeProject(cwd, JSON.stringify({ startupDiscoveryTimeoutMs: 'soon' }));
    expect(loadError(cwd, home)).toContain('positive number');
  });

  it('accepts a custom modelRefreshIntervalMs from the project file and rejects a non-positive one', () => {
    const { home, cwd } = makeSandbox();
    writeProject(cwd, JSON.stringify({ modelRefreshIntervalMs: 60_000 }));
    expect(load(cwd, home).modelRefreshIntervalMs).toBe(60_000);
    writeProject(cwd, JSON.stringify({ modelRefreshIntervalMs: -1 }));
    expect(loadError(cwd, home)).toContain('modelRefreshIntervalMs');
  });

  it('warns (does not crash) on unknown top-level keys and still loads', () => {
    const { home, cwd } = makeSandbox();
    writeGlobal(home, JSON.stringify({ futureThing: true, debug: true }));
    const warnings: string[] = [];
    const config = load(cwd, home, warnings);
    expect(config.debug).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('futureThing');
    expect(warnings[0]).toContain('mistral-bridge.json');
  });

  it('warns on unknown nested askVibe keys', () => {
    const { home, cwd } = makeSandbox();
    writeProject(cwd, JSON.stringify({ askVibe: { futureSub: 1, enabled: false } }));
    const warnings: string[] = [];
    const config = load(cwd, home, warnings);
    expect(config.askVibe.enabled).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('askVibe.futureSub');
  });
});

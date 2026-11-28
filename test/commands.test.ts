// Unit tests for src/commands.ts (diagnostics commands) and src/notify.ts
// (warning channel). Pure report builders are tested directly; the command
// handlers run against a minimal fake ExtensionAPI, with a fake catalog so no
// vibe-acp child is spawned (AGENTS.md §4).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import {
  DOCTOR_COMMAND,
  MODELS_COMMAND,
  formatAge,
  formatDiscovery,
  formatDoctorReport,
  formatModelList,
  MAX_MODELS_IN_REPORT,
  registerBridgeCommands,
  safeDiagnosticText,
  type CommandCatalog,
  type DiagnosticsModel,
} from '../src/commands.ts';
import type { BridgeConfig } from '../src/config.ts';
import type { DiscoveryOutcome } from '../src/models.ts';
import { createSessionNotifier } from '../src/notify.ts';

const CWD = mkdtempSync(join(tmpdir(), 'pi-mistral-bridge-cmd-cwd-'));
const HOME = mkdtempSync(join(tmpdir(), 'pi-mistral-bridge-cmd-home-'));
const NOW = 1_700_000_000_000;

const CONFIG: BridgeConfig = {
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
};

interface FakeCommand {
  description?: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

interface FakePi {
  pi: ExtensionAPI;
  commands: Map<string, FakeCommand>;
  handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
}

function makeFakePi(): FakePi {
  const commands = new Map<string, FakeCommand>();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = {
    registerCommand: (name: string, options: FakeCommand) => {
      commands.set(name, options);
    },
    on: (event: string, handler: (e: unknown, c: unknown) => unknown) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
  } as unknown as ExtensionAPI;
  return { pi, commands, handlers };
}

interface UiHarness {
  ctx: ExtensionCommandContext;
  notes: Array<{ text: string; type: string | undefined }>;
}

function makeCtx(hasUI: boolean): UiHarness {
  const notes: UiHarness['notes'] = [];
  const ctx = {
    hasUI,
    ui: {
      notify: (text: string, type?: string) => {
        notes.push({ text, type });
      },
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notes };
}

interface FakeCatalogOptions {
  models?: DiagnosticsModel[] | undefined;
  aliasMap?: Map<string, string> | undefined;
  lastDiscovery?: DiscoveryOutcome | null | undefined;
  isDisposed?: boolean | undefined;
}

/** Mutable fake of the catalog slice (the interface fields are readonly). */
class FakeCatalog implements CommandCatalog {
  currentModels: DiagnosticsModel[];
  aliasMap: Map<string, string>;
  lastDiscovery: DiscoveryOutcome | null;
  isDisposed: boolean;
  discoverCalls = 0;
  failDiscover: string | null = null;
  /** Set when the next discovery should settle after the catalog was disposed. */
  disposeOnDiscover = false;
  /** Set to make the next discovery publish this list. */
  nextModels: DiagnosticsModel[] | null = null;

  constructor(options: FakeCatalogOptions = {}) {
    this.currentModels = options.models ?? [
      { id: 'api-one', name: 'Model One' },
      { id: 'api-two', name: 'Model Two' },
    ];
    this.aliasMap =
      options.aliasMap ??
      new Map([
        ['api-one', 'alias-one'],
        ['api-two', 'alias-two'],
      ]);
    this.lastDiscovery = options.lastDiscovery ?? null;
    this.isDisposed = options.isDisposed ?? false;
  }

  async discover(): Promise<readonly unknown[]> {
    this.discoverCalls += 1;
    if (this.disposeOnDiscover) {
      this.isDisposed = true;
      throw new Error('discovery aborted by dispose');
    }
    if (this.failDiscover !== null) throw new Error(this.failDiscover);
    if (this.nextModels !== null) {
      this.currentModels = this.nextModels;
      this.aliasMap = new Map(this.nextModels.map((model) => [model.id, `alias-${model.id}`]));
      this.nextModels = null;
    }
    return this.currentModels;
  }
}

function makeCatalog(options: FakeCatalogOptions = {}): FakeCatalog {
  return new FakeCatalog(options);
}

// ---------------------------------------------------------------- report

describe('formatAge / formatDiscovery', () => {
  it('renders seconds, minutes and hours', () => {
    expect(formatAge(0)).toBe('just now');
    expect(formatAge(400)).toBe('just now');
    expect(formatAge(45_000)).toBe('45 s ago');
    expect(formatAge(5 * 60_000)).toBe('5 min ago');
    expect(formatAge(2 * 3_600_000)).toBe('2 h ago');
  });

  it('describes a pending, a successful and a failed discovery', () => {
    expect(formatDiscovery(null, NOW)).toContain('has not finished yet');
    expect(formatDiscovery({ ok: true, at: NOW - 12_000, modelCount: 3 }, NOW)).toBe(
      'ok 12 s ago — 3 model(s) registered'
    );
    expect(formatDiscovery({ ok: false, at: NOW - 200, error: 'boom', modelCount: 0 }, NOW)).toBe(
      'failed just now — boom'
    );
    expect(formatDiscovery({ ok: false, at: NOW - 1_000, modelCount: 0 }, NOW)).toContain(
      'unknown error'
    );
  });
});

describe('formatDoctorReport', () => {
  it('reports provider, config paths, knobs, models with aliases and the discovery outcome', () => {
    const report = formatDoctorReport({
      config: CONFIG,
      cwd: CWD,
      home: HOME,
      models: [{ id: 'api-one', name: 'Model One' }, { id: 'api-two' }],
      aliasByApiId: new Map([['api-one', 'alias-one']]),
      discovery: { ok: true, at: NOW - 5_000, modelCount: 2 },
      nodeVersion: 'v22.19.0',
      now: NOW,
    });

    expect(report).toContain('pi-mistral-bridge doctor');
    expect(report).toContain('provider: mistral-bridge');
    expect(report).toContain('vibe-acp: vibe-acp');
    const globalConfig = join(HOME, '.pi', 'agent', 'mistral-bridge.json');
    const projectConfig = join(CWD, '.pi', 'mistral-bridge.json');
    expect(report).toContain(`${globalConfig} (absent)`);
    expect(report).toContain(`${projectConfig} (absent)`);
    expect(report).toContain('ask_vibe: enabled (default mode ask, autoApprove off)');
    expect(report).toContain('debug log: off');
    expect(report).toContain('discovery: ok 5 s ago — 2 model(s) registered');
    expect(report).toContain('models: 2 registered');
    expect(report).toContain('  - api-one (Model One) → alias alias-one');
    expect(report).toContain('  - api-two');
    expect(report).toContain('node: v22.19.0');
    // no free hint when models are registered
    expect(report).not.toContain('hint:');
    // sanitized: never a bearer token or an authorization header
    expect(report).not.toMatch(/Bearer|Authorization/i);
  });

  it('summarizes a long model list instead of printing all of it', () => {
    const models = Array.from({ length: MAX_MODELS_IN_REPORT + 2 }, (_, index) => ({
      id: `api-${index}`,
    }));
    const report = formatDoctorReport({
      config: CONFIG,
      cwd: CWD,
      home: HOME,
      models,
      aliasByApiId: new Map(),
      discovery: null,
      nodeVersion: 'v22.19.0',
      now: NOW,
    });
    expect(report).toContain(`models: ${MAX_MODELS_IN_REPORT + 2} registered`);
    expect(report).toContain(`  - api-${MAX_MODELS_IN_REPORT - 1}`);
    expect(report).not.toContain(`  - api-${MAX_MODELS_IN_REPORT}\n`);
    expect(report).toContain('… 2 more');
  });

  it('hints at vibe-acp --setup when nothing is registered after a failed discovery', () => {
    const report = formatDoctorReport({
      config: CONFIG,
      cwd: CWD,
      home: HOME,
      models: [],
      aliasByApiId: new Map(),
      discovery: { ok: false, at: NOW, error: 'initialize failed', modelCount: 0 },
      nodeVersion: 'v22.19.0',
      now: NOW,
    });
    expect(report).toContain('discovery: failed just now — initialize failed');
    expect(report).toContain('vibe-acp --setup');
  });

  it('reports a provider-name collision as the reason nothing was registered', () => {
    const report = formatDoctorReport({
      config: CONFIG,
      cwd: CWD,
      home: HOME,
      models: [],
      aliasByApiId: new Map(),
      discovery: null,
      notRegisteredReason: 'collides with a provider Pi already registers',
      nodeVersion: 'v22.19.0',
      now: NOW,
    });
    expect(report).toContain('hint: collides with a provider Pi already registers');
  });

  it('still hints at a failed refresh when older models remain registered', () => {
    const report = formatDoctorReport({
      config: CONFIG,
      cwd: CWD,
      home: HOME,
      models: [{ id: 'api-one', name: 'Model One' }],
      aliasByApiId: new Map(),
      discovery: { ok: false, at: NOW, error: 'refresh blew up', modelCount: 1 },
      nodeVersion: 'v22.19.0',
      now: NOW,
    });
    expect(report).toContain('models: 1 registered');
    expect(report).toContain('hint: the last discovery failed');
    expect(report).toContain('stay registered until a refresh succeeds');
  });

  it('reports the startup-discovery and refresh timings', () => {
    const report = formatDoctorReport({
      config: CONFIG,
      cwd: CWD,
      home: HOME,
      models: [],
      aliasByApiId: new Map(),
      discovery: null,
      nodeVersion: 'v22.19.0',
      now: NOW,
    });
    expect(report).toContain(`startup ${CONFIG.startupDiscoveryTimeoutMs} ms`);
    expect(report).toContain(`refresh ${CONFIG.modelRefreshIntervalMs} ms`);
  });
});

describe('safeDiagnosticText', () => {
  it('strips terminal escapes and control characters', () => {
    const text = safeDiagnosticText('a\u001b[31mred\u001b[0m b\u0007c\nd');
    expect(text).toBe('ared b?c\nd');
  });

  it('redacts bearer tokens', () => {
    expect(safeDiagnosticText('Authorization: Bearer abc.def-123')).toBe(
      'Authorization: Bearer <redacted>'
    );
  });
});

describe('formatModelList', () => {
  it('lists every model with its alias', () => {
    const text = formatModelList(
      [{ id: 'api-one', name: 'Model One' }, { id: 'api-two' }],
      new Map([['api-two', 'alias-two']])
    );
    expect(text).toContain('2 model(s):');
    expect(text).toContain('- api-one (Model One)');
    expect(text).toContain('- api-two → alias alias-two');
  });

  it('points at the doctor when nothing is registered', () => {
    expect(formatModelList([], new Map())).toContain('/mistral-bridge.doctor');
  });
});

// --------------------------------------------------------------- commands

describe('registerBridgeCommands', () => {
  it('registers both commands with descriptions', () => {
    const fake = makeFakePi();
    registerBridgeCommands(fake.pi, {
      config: CONFIG,
      cwd: CWD,
      home: HOME,
      catalog: makeCatalog(),
      write: () => {},
    });
    expect([...fake.commands.keys()]).toEqual([DOCTOR_COMMAND, MODELS_COMMAND]);
    expect(fake.commands.get(DOCTOR_COMMAND)?.description).toContain('diagnostics');
    expect(fake.commands.get(MODELS_COMMAND)?.description).toContain('refresh');
  });

  it('doctor emits through ui.notify when Pi has a UI, and to the sink headless', async () => {
    const fake = makeFakePi();
    const written: string[] = [];
    registerBridgeCommands(fake.pi, {
      config: CONFIG,
      cwd: CWD,
      home: HOME,
      catalog: makeCatalog(),
      write: (text) => written.push(text),
    });
    const doctor = fake.commands.get(DOCTOR_COMMAND)?.handler;
    if (!doctor) throw new Error('doctor command not registered');

    const withUi = makeCtx(true);
    await doctor('', withUi.ctx);
    expect(withUi.notes).toHaveLength(1);
    expect(withUi.notes[0].text).toContain('pi-mistral-bridge doctor');
    expect(withUi.notes[0].type).toBe('info');
    expect(written).toHaveLength(0);

    const headless = makeCtx(false);
    await doctor('', headless.ctx);
    expect(headless.notes).toHaveLength(0);
    expect(written).toHaveLength(1);
    expect(written[0]).toContain('pi-mistral-bridge doctor');
  });

  it('models lists the catalog without a discovery unless "refresh" is passed', async () => {
    const fake = makeFakePi();
    const catalog = makeCatalog();
    const written: string[] = [];
    registerBridgeCommands(fake.pi, {
      config: CONFIG,
      cwd: CWD,
      home: HOME,
      catalog,
      write: (text) => written.push(text),
    });
    const models = fake.commands.get(MODELS_COMMAND)?.handler;
    if (!models) throw new Error('models command not registered');

    await models('', makeCtx(false).ctx);
    expect(catalog.discoverCalls).toBe(0);
    expect(written.at(-1)).toContain('- api-one (Model One) → alias alias-one');
  });

  it('models --refresh runs a discovery first and reports a failure as an error', async () => {
    const fake = makeFakePi();
    const catalog = makeCatalog();
    const written: string[] = [];
    registerBridgeCommands(fake.pi, {
      config: CONFIG,
      cwd: CWD,
      home: HOME,
      catalog,
      write: (text) => written.push(text),
    });
    const models = fake.commands.get(MODELS_COMMAND)?.handler;
    if (!models) throw new Error('models command not registered');

    await models('--refresh', makeCtx(false).ctx);
    expect(catalog.discoverCalls).toBe(1);
    expect(written.at(-1)).toContain('2 model(s):');

    // the refreshed list is what gets printed, not the pre-discovery one
    catalog.nextModels = [{ id: 'api-fresh', name: 'Fresh' }];
    await models('refresh', makeCtx(false).ctx);
    expect(catalog.discoverCalls).toBe(2);
    expect(written.at(-1)).toContain('api-fresh');
    expect(written.at(-1)).not.toContain('api-one');

    catalog.failDiscover = 'discovery exploded';
    const withUi = makeCtx(true);
    await models('refresh', withUi.ctx);
    expect(catalog.discoverCalls).toBe(3);
    expect(withUi.notes.at(-1)?.text).toContain('discovery exploded');
    expect(withUi.notes.at(-1)?.type).toBe('error');
  });

  it('treats a discovery aborted by shutdown as a warning, not a failure', async () => {
    const fake = makeFakePi();
    const catalog = makeCatalog();
    catalog.disposeOnDiscover = true;
    const withUi = makeCtx(true);
    registerBridgeCommands(fake.pi, {
      config: CONFIG,
      cwd: CWD,
      home: HOME,
      catalog,
      write: () => {},
    });
    const models = fake.commands.get(MODELS_COMMAND)?.handler;
    if (!models) throw new Error('models command not registered');
    await models('--refresh', withUi.ctx);
    expect(withUi.notes.at(-1)?.text).toContain('shutting down');
    expect(withUi.notes.at(-1)?.type).toBe('warning');
  });

  it('sanitizes untrusted fields on the headless channel', async () => {
    const fake = makeFakePi();
    const written: string[] = [];
    const catalog = makeCatalog({ models: [{ id: 'api\u001b[31mx', name: 'N\u0007ame' }] });
    registerBridgeCommands(fake.pi, {
      config: CONFIG,
      cwd: CWD,
      home: HOME,
      catalog,
      write: (text) => written.push(text),
    });
    const models = fake.commands.get(MODELS_COMMAND)?.handler;
    if (!models) throw new Error('models command not registered');
    await models('', makeCtx(false).ctx);
    expect(written.at(-1)).not.toContain('\u001b');
    expect(written.at(-1)).not.toContain('\u0007');
  });

  it('models refuses to refresh a disposed catalog', async () => {
    const fake = makeFakePi();
    const catalog = makeCatalog({ isDisposed: true });
    const withUi = makeCtx(true);
    registerBridgeCommands(fake.pi, {
      config: CONFIG,
      cwd: CWD,
      home: HOME,
      catalog,
      write: () => {},
    });
    const models = fake.commands.get(MODELS_COMMAND)?.handler;
    if (!models) throw new Error('models command not registered');
    await models('--refresh', withUi.ctx);
    expect(catalog.discoverCalls).toBe(0);
    expect(withUi.notes.at(-1)?.text).toContain('disposed');
  });

  it('explains the collision when no catalog exists (AGENTS.md §6)', async () => {
    const fake = makeFakePi();
    const withUi = makeCtx(true);
    registerBridgeCommands(fake.pi, {
      config: CONFIG,
      cwd: CWD,
      home: HOME,
      catalog: null,
      notRegisteredReason: 'providerName collides: nothing was registered',
      write: () => {},
    });
    const models = fake.commands.get(MODELS_COMMAND)?.handler;
    const doctor = fake.commands.get(DOCTOR_COMMAND)?.handler;
    if (!models || !doctor) throw new Error('commands not registered');

    await models('', withUi.ctx);
    expect(withUi.notes.at(-1)?.text).toContain('providerName collides');
    expect(withUi.notes.at(-1)?.type).toBe('warning');

    await doctor('', withUi.ctx);
    expect(withUi.notes.at(-1)?.text).toContain('models: 0 registered');
    expect(withUi.notes.at(-1)?.text).toContain('hint: providerName collides');
  });
});

// ---------------------------------------------------------------- notifier

describe('createSessionNotifier', () => {
  it('writes to the headless sink until a UI session is attached', () => {
    const written: string[] = [];
    const notifier = createSessionNotifier({ write: (text) => written.push(text) });
    notifier.warn('no session yet');
    expect(written).toEqual(['pi-mistral-bridge: no session yet\n']);

    const notes: string[] = [];
    notifier.attach({ hasUI: true, ui: { notify: (text) => notes.push(text) } });
    notifier.warn('rendered by Pi');
    expect(notes).toEqual(['rendered by Pi']);
    expect(written).toHaveLength(1);

    notifier.attach({ hasUI: false, ui: { notify: (text) => notes.push(text) } });
    notifier.warn('print mode');
    expect(written.at(-1)).toBe('pi-mistral-bridge: print mode\n');

    notifier.attach(null);
    notifier.warn('detached');
    expect(written.at(-1)).toBe('pi-mistral-bridge: detached\n');
  });
});

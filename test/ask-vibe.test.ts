// Unit tests for src/ask-vibe.ts (T6, ADR-0004): the AskVibe Pi tool. The ACP
// side runs against the shared in-process fake ACP agent
// (test/helpers/fake-acp-agent.ts, AGENTS.md §4: no real vibe-acp, no network
// beyond loopback); `pi` and the tool `ctx` (ui.select / hasUI) are minimal
// fakes capturing registrations and dialogs.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import * as acp from '@agentclientprotocol/sdk';
import type { ExtensionAPI, ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import type { BridgeConfig } from '../src/config.ts';
import { QUOTA_ERROR_PREFIX, AUTH_ERROR_HINT } from '../src/acp-client.ts';
import {
  ANSWER_TRUNCATE_AT,
  ASK_VIBE_TOOL_NAME,
  registerAskVibeTool,
  type AskVibeManager,
} from '../src/ask-vibe.ts';
import {
  PERMISSION_OPTION_ALLOW_ONCE,
  PERMISSION_OPTION_REJECT_ONCE,
  TOOL_CALL_META_TOOL_NAME,
  VIBE_ENV,
} from '../src/vibe-protocol.ts';
import {
  makeFakeSpawn,
  requestPermission,
  sendUpdate,
  type FakeAgent,
  type FakeBehavior,
  type FakeSpawnHarness,
  type PromptScript,
} from './helpers/fake-acp-agent.ts';

const CWD = mkdtempSync(join(tmpdir(), 'pi-mistral-bridge-askvibe-cwd-'));
const LOG_DIR = mkdtempSync(join(tmpdir(), 'pi-mistral-bridge-askvibe-logs-'));

const CONFIG: BridgeConfig = {
  vibeAcpPath: 'vibe-acp',
  providerName: 'mistral-bridge',
  askVibe: { enabled: true, defaultMode: 'ask', autoApprove: false },
  debug: false,
  processIdleTimeoutMs: 600_000,
  toolPreTimeoutMs: 1_500,
  abortWatchdogMs: 5_000,
  discoveryTimeoutMs: 30_000,
  startupDiscoveryTimeoutMs: 30_000,
  modelRefreshIntervalMs: 600_000,
};

// ------------------------------------------------------------------- fake pi

interface FakePi {
  pi: ExtensionAPI;
  tools: Array<{ name: string; definition: any }>;
  handlers: Map<string, (event: any, ctx: any) => unknown>;
}

function makeFakePi(): FakePi {
  const tools: FakePi['tools'] = [];
  const handlers: FakePi['handlers'] = new Map();
  const pi = {
    registerTool: (definition: any) => {
      tools.push({ name: definition.name, definition });
    },
    on: (event: string, handler: (event: any, ctx: any) => unknown) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
  } as unknown as ExtensionAPI;
  return { pi, tools, handlers };
}

interface FakeUi {
  ctx: ExtensionToolContext;
  selectCalls: Array<{ title: string; options: string[]; opts?: unknown }>;
  pick: (title: string, options: string[]) => Promise<string | undefined>;
}

function makeCtx(
  opts: {
    hasUI?: boolean;
    pick?: (options: string[], dialogOpts?: unknown) => string | undefined;
    /** When set, select hangs until the passed AbortSignal fires (simulates Pi dismissing the dialog on abort). */
    hangOnSignal?: boolean;
  } = {}
): FakeUi {
  const selectCalls: FakeUi['selectCalls'] = [];
  const pick = opts.pick ?? ((options: string[]): string | undefined => options[0]);
  const select = async (
    title: string,
    options: string[],
    dialogOpts?: { signal?: AbortSignal }
  ): Promise<string | undefined> => {
    selectCalls.push({ title, options, opts: dialogOpts });
    if (opts.hangOnSignal && dialogOpts?.signal) {
      return new Promise<string | undefined>((resolve) => {
        dialogOpts.signal!.addEventListener('abort', () => resolve(undefined), { once: true });
      });
    }
    return pick(options, dialogOpts);
  };
  const hasUI = opts.hasUI ?? false;
  const ctx = {
    hasUI,
    ui: {
      select,
      confirm: async () => false,
      input: async () => undefined,
      notify: () => undefined,
    },
    cwd: CWD,
  } as unknown as ExtensionToolContext;
  return { ctx, selectCalls, pick: async (_t, options) => pick(options) };
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(5);
  }
}

// ------------------------------------------------------------------- harness

interface Harness {
  fake: FakeSpawnHarness;
  manager: AskVibeManager;
  fakePi: FakePi;
  anomalies: string[];
}

function makeHarness(behavior: FakeBehavior = {}, config: BridgeConfig = CONFIG): Harness {
  const fake = makeFakeSpawn(behavior);
  const anomalies: string[] = [];
  const fakePi = makeFakePi();
  const manager = registerAskVibeTool(fakePi.pi, config, {
    cwd: CWD,
    spawnChild: fake.spawnChild,
    logDir: LOG_DIR,
    onAnomaly: (m) => anomalies.push(m),
  });
  return { fake, manager, fakePi, anomalies };
}

interface ExecHooks {
  signal?: AbortSignal | undefined;
  onUpdate?: ((partial: any) => void) | undefined;
  ctx?: ExtensionToolContext;
}

async function execAsk(
  h: Harness,
  params: { question: string; mode?: 'ask' | 'plan' | 'edit' },
  hooks: ExecHooks = {}
): Promise<any> {
  const tool = h.fakePi.tools.find((t) => t.name === ASK_VIBE_TOOL_NAME);
  if (!tool) throw new Error(`${ASK_VIBE_TOOL_NAME} was not registered`);
  return tool.definition.execute(
    'call-1',
    params,
    hooks.signal,
    hooks.onUpdate,
    hooks.ctx ?? makeCtx().ctx
  );
}

/** A fake turn that streams one text chunk and ends. */
const answerScript = (text: string): PromptScript => {
  return async (params, agent) => {
    await sendUpdate(agent, params.sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
    });
    return { stopReason: 'end_turn' };
  };
};

const recorded = (h: Harness, method: string): any[] =>
  h.fake.agents.flatMap((a) => a.recorded.filter((r) => r.method === method));

// --------------------------------------------------------------------- tests

describe('ask_vibe tool registration + basic ask (ADR-0004)', () => {
  it('registers the ask_vibe tool and answers the question on a fresh ephemeral ACP session (set_mode ask, no MCP server, session closed after)', async () => {
    const h = makeHarness({ promptScript: answerScript('The answer is 4.') });
    try {
      expect(h.fakePi.tools.map((t) => t.name)).toEqual([ASK_VIBE_TOOL_NAME]);
      expect(ASK_VIBE_TOOL_NAME).toBe('ask_vibe');

      const result = await execAsk(h, { question: 'What is 2+2?' });
      expect(result.isError).toBeUndefined();
      expect(result.content).toEqual([{ type: 'text', text: 'The answer is 4.' }]);
      expect(result.details).toMatchObject({ mode: 'ask', vibeModeId: 'ask', answerLength: 16 });

      // the AskVibe child serves NO Pi tools and runs on Vibe's default model:
      // no VIBE_MCP_SERVERS / VIBE_ENABLED_TOOLS / VIBE_ACTIVE_MODEL, and the
      // process-level auto-approve bypass stays OFF (AGENTS.md §15)
      const env = h.fake.spawns[0].env;
      expect(VIBE_ENV.MCP_SERVERS in env).toBe(false);
      expect(VIBE_ENV.ENABLED_TOOLS in env).toBe(false);
      expect(VIBE_ENV.ACTIVE_MODEL in env).toBe(false);
      expect(env[VIBE_ENV.ENABLE_AUTO_APPROVE]).toBe('false');
      expect(env[VIBE_ENV.DEFAULT_APPROVAL_POLICY]).toBe('ask');

      const newReq = recorded(h, 'session/new')[0];
      expect(newReq.params.mcpServers).toEqual([]);
      expect(newReq.params.cwd).toBe(CWD);
      // mode set via session/set_mode before the prompt
      const setMode = recorded(h, 'session/set_mode')[0];
      expect(setMode.params).toEqual({ sessionId: 'sess-1', modeId: 'ask' });
      const order = h.fake.agents[0].recorded.map((r) => r.method);
      expect(order.indexOf('session/set_mode')).toBeLessThan(order.indexOf('session/prompt'));
      // the question is the prompt, verbatim, on a FRESH session
      const promptReq = recorded(h, 'session/prompt')[0];
      expect(promptReq.params.sessionId).toBe('sess-1');
      expect(promptReq.params.prompt).toEqual([{ type: 'text', text: 'What is 2+2?' }]);
      // the ephemeral session is closed after the answer (process stays alive)
      expect(recorded(h, 'session/close').map((r) => r.params)).toEqual([{ sessionId: 'sess-1' }]);
      expect(h.fake.children[0].killedWith).toEqual([]);
    } finally {
      await h.manager.dispose();
    }
  });

  it('maps the mode param via session/set_mode (edit → accept-edits; plan is unavailable on 3.1.4 → falls back to ask) and uses askVibe.defaultMode from config when omitted', async () => {
    const h = makeHarness({ promptScript: answerScript('ok') });
    const h2 = makeHarness(
      { promptScript: answerScript('ok') },
      {
        ...CONFIG,
        askVibe: { enabled: true, defaultMode: 'plan', autoApprove: false },
      }
    );
    try {
      const r1 = await execAsk(h, { question: 'q1', mode: 'plan' });
      await execAsk(h, { question: 'q2', mode: 'edit' });
      await execAsk(h, { question: 'q3' }); // default 'ask' from CONFIG
      const r4 = await execAsk(h2, { question: 'q4' }); // default 'plan' from config
      // the fake advertises ask + accept-edits only (3.1.4 reality): plan
      // falls back to ask and is recorded as such — never reported as set
      const modes = recorded(h, 'session/set_mode').map((r) => r.params.modeId);
      expect(modes).toEqual(['ask', 'accept-edits', 'ask']);
      expect(r1.details.vibeModeId).toBe('ask');
      expect(r1.details.modeNote).toMatch(/plan/);
      expect(recorded(h2, 'session/set_mode').map((r) => r.params.modeId)).toEqual(['ask']);
      expect(r4.details.vibeModeId).toBe('ask');
    } finally {
      await h.manager.dispose();
      await h2.manager.dispose();
    }
  });

  it('mode fallback: requesting plan against a session advertising only ask/accept-edits sets ask and records the effective mode in details (plan is gone since vibe-acp 3.0.0)', async () => {
    // the fake advertises exactly ask + accept-edits (no plan — 3.1.4 reality)
    const h = makeHarness({ promptScript: answerScript('ok') });
    try {
      const result = await execAsk(h, { question: 'q', mode: 'plan' });
      const setMode = recorded(h, 'session/set_mode');
      expect(setMode).toHaveLength(1);
      expect(setMode[0].params.modeId).toBe('ask'); // NOT plan — never report an unset mode
      expect(result.isError).toBeUndefined();
      expect(result.details.mode).toBe('plan'); // requested mode preserved
      expect(result.details.vibeModeId).toBe('ask'); // the effective mode actually set
      expect(result.details.modeNote).toMatch(/plan/);
      expect(result.details.modeNote).toMatch(/ask/);
      expect(h.anomalies.some((m) => /plan/.test(m) && /ask/.test(m))).toBe(true);
    } finally {
      await h.manager.dispose();
    }
  });

  it('mode fallback: edit falls back to ask when accept-edits is not advertised', async () => {
    const h = makeHarness({
      promptScript: answerScript('ok'),
      availableModes: [{ id: 'ask', name: 'Ask' }],
    });
    try {
      const result = await execAsk(h, { question: 'q', mode: 'edit' });
      expect(recorded(h, 'session/set_mode')[0].params.modeId).toBe('ask');
      expect(result.details.vibeModeId).toBe('ask');
      expect(result.details.modeNote).toMatch(/accept-edits/);
    } finally {
      await h.manager.dispose();
    }
  });

  it('mode resolution: a session advertising NO modes keeps the process default (no set_mode call) and notes it', async () => {
    const h = makeHarness({ promptScript: answerScript('ok'), availableModes: [] });
    try {
      const result = await execAsk(h, { question: 'q', mode: 'plan' });
      expect(recorded(h, 'session/set_mode')).toHaveLength(0);
      expect(result.details.vibeModeId).toBe('ask'); // the session's currentModeId
      expect(result.details.modeNote).toMatch(/process default|availableModes/i);
    } finally {
      await h.manager.dispose();
    }
  });

  it('mode resolution: without a modes field, the mode config option supplies current/available modes (edit → ask fallback)', async () => {
    const h = makeHarness({ promptScript: answerScript('ok'), omitModes: true });
    try {
      const result = await execAsk(h, { question: 'q', mode: 'edit' });
      // the fake's mode config option advertises only 'ask'
      expect(recorded(h, 'session/set_mode')[0].params.modeId).toBe('ask');
      expect(result.details.vibeModeId).toBe('ask');
    } finally {
      await h.manager.dispose();
    }
  });

  it('uses a FRESH ACP session per call but reuses the pooled vibe-acp process (ADR-0007)', async () => {
    const h = makeHarness({ promptScript: answerScript('again') });
    try {
      await execAsk(h, { question: 'first' });
      await execAsk(h, { question: 'second' });
      expect(h.fake.children).toHaveLength(1); // one process, pooled
      expect(recorded(h, 'session/new')).toHaveLength(2);
      expect(recorded(h, 'session/close')).toHaveLength(2);
      const sessionIds = recorded(h, 'session/prompt').map((r) => r.params.sessionId);
      expect(new Set(sessionIds).size).toBe(2); // distinct ephemeral sessions
      expect(h.fake.children[0].killedWith).toEqual([]); // still alive
    } finally {
      await h.manager.dispose();
    }
  });

  it('dispose() kills the pooled child and later calls fail with an error result (no orphan, AGENTS.md §15)', async () => {
    const h = makeHarness({ promptScript: answerScript('ok') });
    await execAsk(h, { question: 'q' });
    await h.manager.dispose();
    expect(h.fake.children[0].killedWith.length).toBeGreaterThan(0);
    const result = await execAsk(h, { question: 'after dispose' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/disposed/);
  });
});

describe('ask_vibe answer formatting', () => {
  it('truncates a long answer at ANSWER_TRUNCATE_AT with a marker and records it in details', async () => {
    const long = 'x'.repeat(ANSWER_TRUNCATE_AT + 5_000);
    const h = makeHarness({ promptScript: answerScript(long) });
    try {
      expect(ANSWER_TRUNCATE_AT).toBe(20_000);
      const result = await execAsk(h, { question: 'long please' });
      const text = result.content[0].text;
      expect(text.length).toBeLessThan(long.length);
      expect(text).toContain('truncated');
      expect(text).toContain(String(ANSWER_TRUNCATE_AT));
      expect(text.startsWith('x'.repeat(1_000))).toBe(true);
      expect(result.details.truncated).toBe(true);
      expect(result.details.answerLength).toBe(long.length);
    } finally {
      await h.manager.dispose();
    }
  });

  it('lists the files Vibe touched (from tool-call locations) and streams progress via onUpdate', async () => {
    const script: PromptScript = async (params, agent) => {
      await sendUpdate(agent, params.sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'write_file',
        status: 'in_progress',
        rawInput: { file_path: '/tmp/changed.ts', content: '...' },
        _meta: { [TOOL_CALL_META_TOOL_NAME]: 'file_system.write' },
      });
      await sendUpdate(agent, params.sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
      });
      await sendUpdate(agent, params.sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'I changed the file.' },
      });
      return { stopReason: 'end_turn' };
    };
    const h = makeHarness({ promptScript: script });
    try {
      const updates: any[] = [];
      const result = await execAsk(
        h,
        { question: 'edit it' },
        { onUpdate: (p) => updates.push(p) }
      );
      expect(updates.length).toBeGreaterThan(0);
      // progress carried the tool call (builtin, mapped via mapAllToolCalls)
      expect(updates.some((u) => u.details?.lastTool === 'write_file')).toBe(true);
      // final result: answer + changed-files summary (ADR-0004)
      expect(result.content[0].text).toContain('I changed the file.');
      expect(result.content[0].text).toContain('/tmp/changed.ts');
      expect(result.details.filesTouched).toEqual(['/tmp/changed.ts']);
    } finally {
      await h.manager.dispose();
    }
  });
});

describe('ask_vibe error mapping (same as provider mode)', () => {
  it('session/set_mode failure → error result with the set_mode hint AND the ephemeral session is still closed (no leaked session)', async () => {
    const h = makeHarness({
      promptScript: answerScript('ok'),
      failSetMode: 'fake set_mode failure',
    });
    try {
      const result = await execAsk(h, { question: 'q' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/session\/set_mode/);
      expect(result.content[0].text).toMatch(/fake set_mode failure/);
      expect(result.details.error).toBe('protocol');
      expect(recorded(h, 'session/prompt')).toHaveLength(0); // never prompted
      // the ephemeral session must NOT leak on a set_mode failure
      expect(recorded(h, 'session/close').map((r) => r.params)).toEqual([{ sessionId: 'sess-1' }]);
    } finally {
      await h.manager.dispose();
    }
  });

  it('surfaces quota errors with the stable prefix as an error result', async () => {
    const h = makeHarness({
      promptScript: async () => {
        throw new acp.RequestError(-32000, 'HTTP 429: Mistral quota exceeded, retry later');
      },
    });
    try {
      const result = await execAsk(h, { question: 'q' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(QUOTA_ERROR_PREFIX);
      expect(recorded(h, 'session/close')).toHaveLength(1); // session still closed
    } finally {
      await h.manager.dispose();
    }
  });

  it('surfaces auth errors with the vibe-acp --setup hint', async () => {
    const h = makeHarness({
      promptScript: async () => {
        throw acp.RequestError.authRequired('not signed in');
      },
    });
    try {
      const result = await execAsk(h, { question: 'q' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(AUTH_ERROR_HINT);
    } finally {
      await h.manager.dispose();
    }
  });

  it('abort mid-ask → session/cancel, error result, session closed', async () => {
    let resolvePrompt!: (r: acp.PromptResponse) => void;
    const script: PromptScript = () =>
      new Promise<acp.PromptResponse>((resolve) => {
        resolvePrompt = resolve;
      });
    const h = makeHarness({
      promptScript: script,
      onCancel: () => resolvePrompt({ stopReason: 'cancelled' }),
    });
    try {
      const controller = new AbortController();
      const promise = execAsk(h, { question: 'work on it' }, { signal: controller.signal });
      await waitFor(() => recorded(h, 'session/prompt').length === 1, 'prompt sent');
      controller.abort();
      const result = await promise;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/abort/i);
      expect(recorded(h, 'session/cancel')).toHaveLength(1);
      expect(recorded(h, 'session/close')).toHaveLength(1); // no leaked session
    } finally {
      await h.manager.dispose();
    }
  });
});

describe('ask_vibe permission bridge (ADR-0004: UI select, headless reject, autoApprove opt-in)', () => {
  const permissionScript: PromptScript = async (params, agent, fake) => {
    await sendUpdate(agent, params.sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: 'write_file',
      status: 'pending',
      rawInput: { file_path: '/tmp/secret.ts', command: 'rm -rf /' },
      _meta: { [TOOL_CALL_META_TOOL_NAME]: 'file_system.write' },
    });
    await requestPermission(fake, params.sessionId, 'tc-1');
    return { stopReason: 'end_turn' };
  };

  it('with a UI: shows Vibe’s options via ctx.ui.select (title + preview) and answers the picked option', async () => {
    const h = makeHarness({ promptScript: permissionScript });
    try {
      const ui = makeCtx({
        hasUI: true,
        pick: (options) => options.find((o) => o === 'Allow once'),
      });
      const result = await execAsk(h, { question: 'do it' }, { ctx: ui.ctx });
      expect(result.isError).toBeUndefined();
      // the dialog showed Vibe's option labels verbatim plus title/preview
      expect(ui.selectCalls).toHaveLength(1);
      expect(ui.selectCalls[0].options).toEqual([
        'Allow once',
        'Allow always',
        'Allow always',
        'Reject once',
      ]);
      expect(ui.selectCalls[0].title).toContain('write_file');
      expect(ui.selectCalls[0].title).toContain('/tmp/secret.ts');
      const decision = h.fake.agents[0].permissionRequests[0]?.response;
      expect(decision).toEqual({
        outcome: { outcome: 'selected', optionId: PERMISSION_OPTION_ALLOW_ONCE },
      });
    } finally {
      await h.manager.dispose();
    }
  });

  it('with a UI: picking a persisting option (allow_always) is downgraded to allow_once + anomaly (never answered verbatim)', async () => {
    const h = makeHarness({ promptScript: permissionScript });
    try {
      const ui = makeCtx({ hasUI: true, pick: (options) => options[1] }); // 'Allow always'
      await execAsk(h, { question: 'do it' }, { ctx: ui.ctx });
      const decision = h.fake.agents[0].permissionRequests[0]?.response;
      expect(decision).toEqual({
        outcome: { outcome: 'selected', optionId: PERMISSION_OPTION_ALLOW_ONCE },
      });
      expect(h.anomalies.some((m) => m.includes('allow_once') && m.includes('downgrad'))).toBe(
        true
      );
    } finally {
      await h.manager.dispose();
    }
  });

  it('abort during the permission dialog: the call signal is passed to ctx.ui.select (Pi 1.6.0 ExtensionUIDialogOptions) and the request is answered reject_once — never left pending', async () => {
    const h = makeHarness({ promptScript: permissionScript });
    try {
      const controller = new AbortController();
      const ui = makeCtx({ hasUI: true, hangOnSignal: true }); // dialog only resolves when aborted
      const resultPromise = execAsk(
        h,
        { question: 'do it' },
        { ctx: ui.ctx, signal: controller.signal }
      );
      await waitFor(() => ui.selectCalls.length === 1, 'permission dialog shown');
      controller.abort();
      await resultPromise;
      // the dialog received the call's AbortSignal, so it can never outlive the call
      expect(ui.selectCalls[0].opts).toMatchObject({ signal: controller.signal });
      // dismissed BY ABORT → reject_once per ADR-0006 (user dismiss → cancelled)
      expect(h.fake.agents[0].permissionRequests[0]?.response).toEqual({
        outcome: { outcome: 'selected', optionId: PERMISSION_OPTION_REJECT_ONCE },
      });
      expect(recorded(h, 'session/close')).toHaveLength(1); // session still closed
    } finally {
      await h.manager.dispose();
    }
  });

  it('with a UI: dismissing the dialog answers cancelled (never left pending)', async () => {
    const h = makeHarness({ promptScript: permissionScript });
    try {
      const ui = makeCtx({ hasUI: true, pick: () => undefined });
      await execAsk(h, { question: 'do it' }, { ctx: ui.ctx });
      const decision = h.fake.agents[0].permissionRequests[0]?.response;
      expect(decision).toEqual({ outcome: { outcome: 'cancelled' } });
    } finally {
      await h.manager.dispose();
    }
  });

  it('headless (no UI): the request is rejected (ADR-0004) — session/close still happens', async () => {
    const h = makeHarness({ promptScript: permissionScript });
    try {
      const result = await execAsk(
        h,
        { question: 'do it' },
        { ctx: makeCtx({ hasUI: false }).ctx }
      );
      expect(result.isError).toBeUndefined();
      const decision = h.fake.agents[0].permissionRequests[0]?.response;
      expect(decision).toEqual({
        outcome: { outcome: 'selected', optionId: PERMISSION_OPTION_REJECT_ONCE },
      });
      expect(recorded(h, 'session/close')).toHaveLength(1);
    } finally {
      await h.manager.dispose();
    }
  });

  it('headless + askVibe.autoApprove=true (explicit opt-in): allow_once', async () => {
    const h = makeHarness(
      { promptScript: permissionScript },
      { ...CONFIG, askVibe: { enabled: true, defaultMode: 'ask', autoApprove: true } }
    );
    try {
      const result = await execAsk(
        h,
        { question: 'do it' },
        { ctx: makeCtx({ hasUI: false }).ctx }
      );
      expect(result.isError).toBeUndefined();
      const decision = h.fake.agents[0].permissionRequests[0]?.response;
      expect(decision).toEqual({
        outcome: { outcome: 'selected', optionId: PERMISSION_OPTION_ALLOW_ONCE },
      });
    } finally {
      await h.manager.dispose();
    }
  });
});

// ------------------------------------------------- T6 slice 2b: edge branches

/** Sends a session/request_permission with custom options (pickOption kind-fallback etc.). */
async function requestPermissionWith(
  fake: FakeAgent,
  sessionId: string,
  toolCallId: string,
  options: acp.PermissionOption[]
): Promise<unknown> {
  const response = await fake.agentCtx!.request(acp.CLIENT_METHODS.session_request_permission, {
    sessionId,
    toolCall: { toolCallId },
    options,
  });
  fake.permissionRequests.push({ params: { sessionId, toolCallId }, response });
  return response;
}

describe('ask_vibe edge branches', () => {
  it('returns a placeholder when Vibe answers with no text, and caps onUpdate previews', async () => {
    const long = 'y'.repeat(ANSWER_TRUNCATE_AT + 100);
    const h = makeHarness({
      promptScript: async (params, agent) => {
        await sendUpdate(agent, params.sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: long },
        });
        return { stopReason: 'end_turn' };
      },
    });
    const hEmpty = makeHarness({ promptScript: async () => ({ stopReason: 'end_turn' }) });
    try {
      const updates: any[] = [];
      const result = await execAsk(h, { question: 'long' }, { onUpdate: (p) => updates.push(p) });
      expect(result.details.truncated).toBe(true);
      // every onUpdate preview is capped at ANSWER_TRUNCATE_AT
      for (const u of updates)
        expect(u.content[0].text.length).toBeLessThanOrEqual(ANSWER_TRUNCATE_AT);
      const empty = await execAsk(hEmpty, { question: 'nothing' });
      expect(empty.content[0].text).toBe('(vibe-acp returned no text answer)');
    } finally {
      await h.manager.dispose();
      await hEmpty.manager.dispose();
    }
  });

  it('permission dialog preview: no rawInput → title only; unknown keys → JSON fallback; long JSON capped', async () => {
    const script: PromptScript = async (params, agent, fake) => {
      await sendUpdate(agent, params.sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'no-input-tool',
        status: 'pending',
      });
      await requestPermissionWith(fake, params.sessionId, 't1', [
        { optionId: PERMISSION_OPTION_ALLOW_ONCE, name: 'Allow once', kind: 'allow_once' },
        { optionId: PERMISSION_OPTION_REJECT_ONCE, name: 'Reject once', kind: 'reject_once' },
      ]);
      await sendUpdate(agent, params.sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 't2',
        title: 'json-tool',
        status: 'pending',
        rawInput: { some_weird_key: 'z'.repeat(500) },
      });
      await requestPermissionWith(fake, params.sessionId, 't2', [
        { optionId: PERMISSION_OPTION_ALLOW_ONCE, name: 'Allow once', kind: 'allow_once' },
        { optionId: PERMISSION_OPTION_REJECT_ONCE, name: 'Reject once', kind: 'reject_once' },
      ]);
      return { stopReason: 'end_turn' };
    };
    const h = makeHarness({ promptScript: script });
    try {
      const ui = makeCtx({ hasUI: true, pick: (o) => o[0] });
      await execAsk(h, { question: 'q' }, { ctx: ui.ctx });
      expect(ui.selectCalls[0].title).toBe('no-input-tool'); // no preview appended
      expect(ui.selectCalls[1].title).toContain('json-tool');
      expect(ui.selectCalls[1].title).toContain('some_weird_key');
      expect(ui.selectCalls[1].title).toContain('…'); // JSON capped at 400 chars
      expect(ui.selectCalls[1].title.length).toBeLessThan(500);
    } finally {
      await h.manager.dispose();
    }
  });

  it('pickOption falls back to the option KIND when the optionId is absent (answers the kind-matched option)', async () => {
    const script: PromptScript = async (params, agent, fake) => {
      await sendUpdate(agent, params.sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'kind-tool',
        status: 'pending',
      });
      // optionIds deliberately NOT allow_once/reject_once — only kinds match
      await requestPermissionWith(fake, params.sessionId, 't1', [
        { optionId: 'custom-allow', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'custom-reject', name: 'Reject once', kind: 'reject_once' },
      ]);
      return { stopReason: 'end_turn' };
    };
    const h = makeHarness({ promptScript: script });
    try {
      const ui = makeCtx({ hasUI: true, pick: (o) => o[0] });
      await execAsk(h, { question: 'q' }, { ctx: ui.ctx });
      expect(h.fake.agents[0].permissionRequests[0]?.response).toEqual({
        outcome: { outcome: 'selected', optionId: 'custom-allow' },
      });
    } finally {
      await h.manager.dispose();
    }
  });

  it('persisting permission detected by optionId prefix (allow_always*) even when kind says allow_once → downgraded to allow_once + anomaly, never answered verbatim', async () => {
    const script: PromptScript = async (params, agent, fake) => {
      await sendUpdate(agent, params.sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 't',
        status: 'pending',
      });
      await requestPermissionWith(fake, params.sessionId, 't1', [
        { optionId: 'allow_always_custom', name: 'Allow always', kind: 'allow_once' },
        { optionId: PERMISSION_OPTION_ALLOW_ONCE, name: 'Allow once', kind: 'allow_once' },
        { optionId: PERMISSION_OPTION_REJECT_ONCE, name: 'Reject once', kind: 'reject_once' },
      ]);
      return { stopReason: 'end_turn' };
    };
    const h = makeHarness({ promptScript: script });
    try {
      const ui = makeCtx({ hasUI: true, pick: (o) => o[0] }); // picks 'Allow always'
      await execAsk(h, { question: 'q' }, { ctx: ui.ctx });
      expect(h.fake.agents[0].permissionRequests[0]?.response).toEqual({
        outcome: { outcome: 'selected', optionId: PERMISSION_OPTION_ALLOW_ONCE },
      });
      expect(
        h.anomalies.some((m) => m.includes('downgrad') && m.includes('allow_always_custom'))
      ).toBe(true);
    } finally {
      await h.manager.dispose();
    }
  });

  it('headless with NO reject_once option answers cancelled (never pending); UI picking an unknown label → cancelled; allow_always without allow_once → cancelled + anomaly', async () => {
    const script: PromptScript = async (params, agent, fake) => {
      await sendUpdate(agent, params.sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'only-always',
        status: 'pending',
      });
      await requestPermissionWith(fake, params.sessionId, 't1', [
        { optionId: 'allow_always', name: 'Allow always', kind: 'allow_always' },
      ]);
      return { stopReason: 'end_turn' };
    };
    // headless, no reject option, autoApprove off → cancelled
    const h1 = makeHarness({ promptScript: script });
    // UI picking a label that is not in the list → cancelled
    const h2 = makeHarness({
      promptScript: async (params, agent, fake) => {
        await sendUpdate(agent, params.sessionId, {
          sessionUpdate: 'tool_call',
          toolCallId: 't1',
          title: 't',
          status: 'pending',
        });
        await requestPermissionWith(fake, params.sessionId, 't1', [
          { optionId: PERMISSION_OPTION_ALLOW_ONCE, name: 'Allow once', kind: 'allow_once' },
          { optionId: PERMISSION_OPTION_REJECT_ONCE, name: 'Reject once', kind: 'reject_once' },
        ]);
        return { stopReason: 'end_turn' };
      },
    });
    // UI picking allow_always when NO allow_once option exists → cancelled + anomaly
    const h3 = makeHarness({ promptScript: script });
    try {
      await execAsk(h1, { question: 'q' }, { ctx: makeCtx({ hasUI: false }).ctx });
      expect(h1.fake.agents[0].permissionRequests[0]?.response).toEqual({
        outcome: { outcome: 'cancelled' },
      });

      const ui2 = makeCtx({ hasUI: true, pick: () => 'Not in the list' });
      await execAsk(h2, { question: 'q' }, { ctx: ui2.ctx });
      expect(h2.fake.agents[0].permissionRequests[0]?.response).toEqual({
        outcome: { outcome: 'cancelled' },
      });

      const ui3 = makeCtx({ hasUI: true, pick: (o) => o[0] });
      await execAsk(h3, { question: 'q' }, { ctx: ui3.ctx });
      expect(h3.fake.agents[0].permissionRequests[0]?.response).toEqual({
        outcome: { outcome: 'cancelled' },
      });
      expect(h3.anomalies.some((m) => m.includes('downgrad'))).toBe(true);
    } finally {
      await h1.manager.dispose();
      await h2.manager.dispose();
      await h3.manager.dispose();
    }
  });

  it('an already-aborted signal cancels the prompt (session/cancel), returns an error result and closes the session', async () => {
    let resolvePrompt!: (r: acp.PromptResponse) => void;
    const script: PromptScript = () =>
      new Promise<acp.PromptResponse>((resolve) => {
        resolvePrompt = resolve;
      });
    const h = makeHarness({
      promptScript: script,
      onCancel: () => resolvePrompt({ stopReason: 'cancelled' }),
    });
    try {
      const controller = new AbortController();
      controller.abort();
      const result = await execAsk(h, { question: 'q' }, { signal: controller.signal });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/abort/i);
      expect(recorded(h, 'session/cancel')).toHaveLength(1);
      expect(recorded(h, 'session/close')).toHaveLength(1);
    } finally {
      await h.manager.dispose();
    }
  });

  it('session_start disposes the old pool (child killed) and the next ask respawns; session_shutdown disposes the manager (isDisposed)', async () => {
    const h = makeHarness({ promptScript: answerScript('ok') });
    try {
      expect(h.manager.isDisposed).toBe(false);
      await execAsk(h, { question: 'one' });
      expect(h.fake.children).toHaveLength(1);
      // Pi session_start → fresh pool for the new Pi session
      const onStart = h.fakePi.handlers.get('session_start');
      expect(onStart).toBeDefined();
      await (onStart as (e: unknown, ctx: unknown) => unknown)({}, {});
      await waitFor(
        () => h.fake.children[0].killedWith.length > 0,
        'old child killed on session_start'
      );
      // next ask respawns a fresh process
      await execAsk(h, { question: 'two' });
      expect(h.fake.children).toHaveLength(2);
      // Pi session_shutdown → manager disposed
      const onShutdown = h.fakePi.handlers.get('session_shutdown');
      await (onShutdown as (e: unknown, ctx: unknown) => unknown)({}, {});
      await waitFor(() => h.manager.isDisposed, 'manager disposed');
      expect(h.fake.children[1].killedWith.length).toBeGreaterThan(0);
    } finally {
      await h.manager.dispose();
    }
  });

  it('ignores tool calls without a file_path in the changed-files list', async () => {
    const script: PromptScript = async (params, agent) => {
      await sendUpdate(agent, params.sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'bash',
        status: 'in_progress',
        rawInput: { command: 'ls' }, // no file_path
      });
      await sendUpdate(agent, params.sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 't2',
        title: 'read',
        status: 'in_progress', // no rawInput at all
      });
      await sendUpdate(agent, params.sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'done' },
      });
      return { stopReason: 'end_turn' };
    };
    const h = makeHarness({ promptScript: script });
    try {
      const result = await execAsk(h, { question: 'q' });
      expect(result.details.filesTouched).toEqual([]);
      expect(result.content[0].text).not.toContain('Files touched');
      expect(result.content[0].text).toBe('done');
    } finally {
      await h.manager.dispose();
    }
  });
});

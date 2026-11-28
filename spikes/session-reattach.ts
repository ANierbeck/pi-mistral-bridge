// Step 1 of docs/plans/2026-11-28-per-model-session-resume.md — ZERO prompts, costs no allowance.
//
//   npx tsx spikes/session-reattach.ts [--label NAME] [--alias-a devstral-small]
//
// Q1a  same process: session/new -> session/close -> session/load | session/resume; and load/resume of a
//      session that was NOT closed.
// Q1b  SIGKILL the process (no session/close), spawn a new one with the same alias, load/resume the ids.
// Q2   spawn a process with VIBE_ACTIVE_MODEL=<alias B> (first other alias Vibe lists) and load a session
//      created under alias A: which model do the returned configOptions report? (read only)
// Q3   every session/update received during each load / resume (kinds and counts only).
//
// HARD LIMITS: this script never sends `session/prompt` and never sends any `session/set_*` request
// (a `model` write would persist into the user's ~/.vibe/config.toml, AGENTS.md section 14, ADR-0007).
// Every request goes through `guarded`, which throws before sending anything outside a short allowlist.
// Process config is env-only, as in provider mode (spikes/README Stage 3). Vibe credentials and
// ~/.vibe/ are never read. Raw ACP wire logs go to spikes/out/ (git-ignored).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { OUT_DIR, WORKTREE_DIR, iso, openSession, parseArgs, sleep, type SpikeSession } from "./lib.ts";

const { flags } = parseArgs(process.argv.slice(2));
const label = typeof flags["label"] === "string" ? flags["label"] : "reattach";
const aliasA = typeof flags["alias-a"] === "string" ? flags["alias-a"] : "devstral-small";
const stamp = iso().replace(/[:.]/g, "-");

const ALLOWED_METHODS = new Set(["session/new", "session/close", "session/load", "session/resume"]);
const FLUSH_MS = 600;

function guarded(session: SpikeSession, method: string, params: Record<string, unknown>): Promise<any> {
  if (!ALLOWED_METHODS.has(method)) throw new Error(`session-reattach must not send ${method}`);
  return (session.ctx as any).request(method, params);
}

const mcpServersFor = (s: SpikeSession) => [
  { type: "http", name: "pi", url: s.mcp.url, headers: [{ name: "Authorization", value: `Bearer ${s.mcp.token}` }] },
];

interface Outcome {
  step: string;
  method: string;
  ok: boolean;
  elapsedMs: number;
  error?: { code?: unknown; message?: string; data?: unknown };
  responseKeys?: string[];
  modelCurrentValue?: string | null;
  modeCurrentValue?: string | null;
  updateKinds: Record<string, number>;
}

const results: Outcome[] = [];

const modelOption = (resp: any): any => (resp?.configOptions ?? []).find((o: any) => o?.id === "model");
const modeOption = (resp: any): any => (resp?.configOptions ?? []).find((o: any) => o?.id === "mode");

async function run(session: SpikeSession, step: string, method: string, params: Record<string, unknown>): Promise<any> {
  const from = session.updates.length;
  const t0 = Date.now();
  let outcome: Outcome;
  let response: any;
  try {
    response = await guarded(session, method, params);
    outcome = {
      step,
      method,
      ok: true,
      elapsedMs: Date.now() - t0,
      responseKeys: Object.keys(response ?? {}),
      modelCurrentValue: modelOption(response)?.currentValue ?? null,
      modeCurrentValue: modeOption(response)?.currentValue ?? null,
      updateKinds: {},
    };
  } catch (e: any) {
    outcome = {
      step,
      method,
      ok: false,
      elapsedMs: Date.now() - t0,
      error: { code: e?.code, message: e?.message ?? String(e), data: e?.data },
      updateKinds: {},
    };
  }
  await sleep(FLUSH_MS); // let in-flight session/update notifications land
  for (const u of session.updates.slice(from)) {
    const kind = u.update.sessionUpdate;
    outcome.updateKinds[kind] = (outcome.updateKinds[kind] ?? 0) + 1;
  }
  results.push(outcome);
  session.eventLog.write({ ev: "reattach_step", ...outcome });
  console.log(
    `[${label}] ${step}: ${method} -> ${outcome.ok ? "ok" : `ERROR ${JSON.stringify(outcome.error)}`} updates=${JSON.stringify(outcome.updateKinds)}`,
  );
  return response;
}

const newSession = (s: SpikeSession, step: string): Promise<string> =>
  run(s, step, "session/new", { cwd: WORKTREE_DIR, mcpServers: mcpServersFor(s) }).then((r) => r.sessionId as string);

const reattach = (s: SpikeSession, step: string, method: "session/load" | "session/resume", id: string) =>
  run(s, step, method, { sessionId: id, cwd: WORKTREE_DIR, mcpServers: mcpServersFor(s) });

const providerEnv = (alias: string): Record<string, string> => ({
  VIBE_ENABLE_AUTO_APPROVE: "false",
  VIBE_DEFAULT_APPROVAL_POLICY: "ask",
  VIBE_ENABLED_TOOLS: '["pi_*"]',
  VIBE_ACTIVE_MODEL: alias,
});

const spawned: SpikeSession[] = [];
const spawn = async (name: string, alias: string): Promise<SpikeSession> => {
  const s = await openSession({ runId: `${stamp}-${label}-${name}`, vibeEnv: providerEnv(alias), vibeArgs: [], slowMs: 45_000 });
  spawned.push(s);
  console.log(`[${label}] ${name}: spawned vibe-acp pid ${s.child.pid} alias ${alias}`);
  return s;
};

const ids: Record<string, string> = {};
let aliasB = "";
let capabilities: unknown;
let modelOptionValues: string[] = [];

try {
  // ------------------------------------------------------------------ P1: alias A
  const p1 = await spawn("p1", aliasA);
  capabilities = (p1.initializeResponse as any).agentCapabilities;
  const opt = modelOption(p1.newSessionResponse);
  modelOptionValues = (opt?.options ?? []).map((o: any) => String(o.value));
  if (!modelOptionValues.includes(aliasA)) throw new Error(`alias A ${aliasA} not offered by Vibe`);
  aliasB = modelOptionValues.find((v) => v !== aliasA) ?? "";
  if (!aliasB) throw new Error("Vibe reports no second model alias");
  console.log(`[${label}] p1 model option currentValue=${opt?.currentValue}; ${modelOptionValues.length} aliases; B=${aliasB}`);

  // Q1a — same process
  ids.closedLoad = await newSession(p1, "q1a-new closedLoad");
  await run(p1, "q1a-close closedLoad", "session/close", { sessionId: ids.closedLoad });
  await reattach(p1, "q1a-load after close", "session/load", ids.closedLoad);

  ids.closedResume = await newSession(p1, "q1a-new closedResume");
  await run(p1, "q1a-close closedResume", "session/close", { sessionId: ids.closedResume });
  await reattach(p1, "q1a-resume after close", "session/resume", ids.closedResume);

  ids.openLoad = await newSession(p1, "q1a-new openLoad");
  await reattach(p1, "q1a-load NOT closed", "session/load", ids.openLoad);
  ids.openResume = await newSession(p1, "q1a-new openResume");
  await reattach(p1, "q1a-resume NOT closed", "session/resume", ids.openResume);

  // Sessions kept for after the restart (Q1b) and for the model-alias check (Q2); never touched in P1 again.
  ids.restartClosedLoad = await newSession(p1, "prep restartClosedLoad");
  await run(p1, "prep-close restartClosedLoad", "session/close", { sessionId: ids.restartClosedLoad });
  ids.restartClosedResume = await newSession(p1, "prep restartClosedResume");
  await run(p1, "prep-close restartClosedResume", "session/close", { sessionId: ids.restartClosedResume });
  ids.restartOpenLoad = await newSession(p1, "prep restartOpenLoad (left open)");
  ids.restartOpenResume = await newSession(p1, "prep restartOpenResume (left open)");
  ids.q2Load = await newSession(p1, "prep q2Load");
  await run(p1, "prep-close q2Load", "session/close", { sessionId: ids.q2Load });
  ids.q2Resume = await newSession(p1, "prep q2Resume");
  await run(p1, "prep-close q2Resume", "session/close", { sessionId: ids.q2Resume });

  // Q1b — crash the process (no session/close), then a fresh process with the same alias
  const pid1 = p1.child.pid;
  p1.child.kill("SIGKILL");
  await new Promise((r) => p1.child.once("exit", r));
  console.log(`[${label}] p1 pid ${pid1} SIGKILLed`);
  await p1.shutdown();

  const p2 = await spawn("p2", aliasA);
  await reattach(p2, "q1b-load closed+restart", "session/load", ids.restartClosedLoad);
  await reattach(p2, "q1b-resume closed+restart", "session/resume", ids.restartClosedResume);
  await reattach(p2, "q1b-load open-at-kill+restart", "session/load", ids.restartOpenLoad);
  await reattach(p2, "q1b-resume open-at-kill+restart", "session/resume", ids.restartOpenResume);
  await p2.shutdown();

  // Q2 — process on alias B loads sessions created under alias A
  const p3 = await spawn("p3", aliasB);
  const p3Model = modelOption(p3.newSessionResponse);
  console.log(`[${label}] p3 (alias B=${aliasB}) own session/new model currentValue=${p3Model?.currentValue}`);
  await reattach(p3, "q2-load created under A", "session/load", ids.q2Load);
  await reattach(p3, "q2-resume created under A", "session/resume", ids.q2Resume);
  await p3.shutdown();

  const summary = {
    label,
    iso: iso(),
    vibeAcpAgentCapabilities: capabilities,
    aliasA,
    aliasB,
    aliasCount: modelOptionValues.length,
    p3OwnNewSessionModelCurrentValue: p3Model?.currentValue ?? null,
    steps: results,
  };
  const out = join(OUT_DIR, `${stamp}-${label}-result.json`);
  writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(`[${label}] result: ${out}`);
  console.log(JSON.stringify({ aliasA, aliasB, capabilities, p3OwnNewSession: p3Model?.currentValue, results }, null, 2));
} finally {
  for (const s of spawned.filter((x) => x.child.exitCode === null && x.child.signalCode === null)) {
    try {
      await s.shutdown();
    } catch {
      /* already down */
    }
  }
  const leftover = spawned.filter((s) => s.child.exitCode === null && s.child.signalCode === null);
  console.log(`[${label}] spawned pids: ${spawned.map((s) => s.child.pid).join(",")}; still running: ${leftover.length}`);
}

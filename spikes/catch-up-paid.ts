// Step 2 of docs/plans/2026-11-28-per-model-session-resume.md — PAID (owner-approved 2026-11-28, budget 10).
// Every run without --dry-run spends Mistral allowance. Never run it without the owner's go for that run.
//
//   npx tsx spikes/catch-up-paid.ts --run C|R|L --label <x> [--reattach open|load|resume] [--dry-run]
//
//   C  catch-up: prompt 1 asks for a real pi__echo call; the session is then reattached (`open` = kept open
//      and reused as is; `load` / `resume` = session/close, then session/load | session/resume on the same
//      process); prompt 2 = catch-up lead-in + HISTORY_PREAMBLE + a foreign turn rendered by the bridge's
//      0.1.3 renderTranscript + a new user message that needs a real pi__read_note call. 2 prompts.
//   R  rebuild baseline: the SAME full history (prompt-1 turn + foreign turn + new user message) as one
//      rebuild prompt on a fresh session: system prompt + HISTORY_PREAMBLE + transcript, mirroring
//      openNewSession in src/provider.ts. 1 prompt.
//   L  restart: prompt 1 (a codeword, one real pi__echo call), then SIGKILL the process, spawn a new one,
//      reattach the same session id via --reattach load|resume, prompt 2 can only be answered from the
//      pre-restart history. 2 prompts. (Plan table counts L as 1 prompt; the pre-restart prompt is needed.)
//   A failed reattach stops the run (no fallback prompt) and is recorded: that is a finding, not an error.
//
// Budget: spikes/out/prompt-count-catchup.json, CATCHUP_MAX_PROMPTS = 10 (its own constant; lib.ts's
// MAX_PROMPTS = 3 and its counter are untouched). A prompt is reserved BEFORE it is sent, failed sends
// count, the 11th is refused. `--dry-run` does everything except `session/prompt` and uses no budget.
//
// Process config is env-only, as in provider mode (spikes/README Stage 3): VIBE_ENABLE_AUTO_APPROVE=false,
// VIBE_DEFAULT_APPROVAL_POLICY=ask, VIBE_ENABLED_TOOLS=["pi_*"], VIBE_ACTIVE_MODEL=devstral-small.
// NEVER session/set_*: every request goes through `request`, an allowlist that excludes them.
//
// Imports from ../src/transcript.ts (read-only): renderTranscript, HISTORY_PREAMBLE,
// findImitatedToolCallText — no shape is copied. The catch-up lead-in sentence is spike-local text
// (the bridge has no catch-up preamble yet). Fixtures are synthetic; nothing of the owner's is used.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { OUT_DIR, WORKTREE_DIR, iso, now, openSession, parseArgs, sleep, type PermissionContext, type SpikeSession } from "./lib.ts";
import { HISTORY_PREAMBLE, findImitatedToolCallText, renderTranscript } from "../src/transcript.ts";

// ---------------------------------------------------------------- budget

const CATCHUP_MAX_PROMPTS = 10;
const COUNTER_PATH = join(OUT_DIR, "prompt-count-catchup.json");

function readCounter(): { count: number; log: Array<{ label: string; at: string }> } {
  return existsSync(COUNTER_PATH) ? JSON.parse(readFileSync(COUNTER_PATH, "utf8")) : { count: 0, log: [] };
}

/** Reserve one session/prompt from the catch-up budget BEFORE sending it; throws when it is exhausted. */
function reserveCatchupPrompt(label: string): number {
  const { count, log } = readCounter();
  if (count >= CATCHUP_MAX_PROMPTS) throw new Error(`catch-up prompt budget exhausted (${count}/${CATCHUP_MAX_PROMPTS})`);
  writeFileSync(COUNTER_PATH, JSON.stringify({ count: count + 1, log: [...log, { label, at: iso() }] }, null, 2));
  return count + 1;
}

// ---------------------------------------------------------------- args

const { flags } = parseArgs(process.argv.slice(2));
const run = String(flags["run"] ?? "");
if (!["C", "R", "L"].includes(run)) throw new Error("--run C|R|L required");
const label = typeof flags["label"] === "string" ? flags["label"] : "x";
const dryRun = flags["dry-run"] === true;
const reattachMode = typeof flags["reattach"] === "string" ? flags["reattach"] : undefined;
if (run !== "R") {
  if (!reattachMode || !["open", "load", "resume"].includes(reattachMode))
    throw new Error("--reattach open|load|resume required for C and L");
  if (run === "L" && reattachMode === "open") throw new Error("--run L kills the process: --reattach load|resume");
}
const modelAlias = "devstral-small";
const promptTimeoutMs = 240_000;
const runId = `${iso().replace(/[:.]/g, "-")}-catchup-${run}-${label}${dryRun ? "-dry" : ""}`;

// ---------------------------------------------------------------- synthetic fixtures

const noteCode = (key: string): string => `ORCHID-${key.length * 7}`; // mirrors pi__read_note in lib.ts
const ECHO_WORD = "lantern-47";
const CODEWORD = "teal-orbit-91";
const FOREIGN_KEY = "archive-2";
const NEW_KEY = "harbor-9";
const SYSTEM_PROMPT = "You are a coding assistant running inside a terminal agent. Use the provided tools when a request needs them.";
/** Spike-local lead-in; the bridge has no catch-up preamble yet. */
const CATCHUP_LEAD =
  "This conversation continued while you were not answering. The log below contains only the part you have not seen yet.";

const TOOL_HINT = 'the tool of the MCP server named "pi" whose name ends with "pi__%" (it may be listed as "pi_pi__%" or "mcp_pi.pi__%")';
const toolRef = (name: string): string => TOOL_HINT.replaceAll("%", name);

const echoPrompt = (word: string, remember: boolean): string =>
  (remember ? `Remember this project codeword for later: ${word}. ` : "") +
  `Call ${toolRef("echo")} exactly once, with text "${word}". Then answer with exactly the word DONE.`;

const msg = (m: Record<string, unknown>) => m as never;

/** Pi-format messages of the first turn on model A (prompt 1 of run C, first part of the R history). */
const firstTurn = [
  msg({ role: "user", content: echoPrompt(ECHO_WORD, false) }),
  msg({
    role: "assistant",
    content: [{ type: "toolCall", id: "call_c1", name: "echo", arguments: { text: ECHO_WORD } }],
  }),
  msg({ role: "toolResult", toolCallId: "call_c1", toolName: "echo", content: [{ type: "text", text: ECHO_WORD }], isError: false }),
  msg({ role: "assistant", content: [{ type: "text", text: "DONE" }] }),
];
/** A turn another model served in between (the "foreign" turn), with a tool-call record. */
const foreignTurn = [
  msg({ role: "user", content: `Look up the note called ${FOREIGN_KEY} and tell me its vault code word.` }),
  msg({
    role: "assistant",
    content: [{ type: "toolCall", id: "call_f1", name: "read_note", arguments: { key: FOREIGN_KEY } }],
  }),
  msg({
    role: "toolResult",
    toolCallId: "call_f1",
    toolName: "read_note",
    content: [{ type: "text", text: `note ${FOREIGN_KEY}: the vault code word is ${noteCode(FOREIGN_KEY)}` }],
    isError: false,
  }),
  msg({ role: "assistant", content: [{ type: "text", text: `The vault code word in ${FOREIGN_KEY} is ${noteCode(FOREIGN_KEY)}.` }] }),
];
const newUser = msg({
  role: "user",
  content: `Now use the note tool to look up the note called ${NEW_KEY} and tell me its vault code word.`,
});

const catchUpPromptText = `${CATCHUP_LEAD}\n\n${HISTORY_PREAMBLE}\n\n${renderTranscript([...foreignTurn, newUser])}`;
const rebuildPromptText = `${SYSTEM_PROMPT}\n\n${HISTORY_PREAMBLE}\n\n${renderTranscript([...firstTurn, ...foreignTurn, newUser])}`;
const restartQuestion =
  "What was the project codeword I asked you to remember earlier? Answer with only the codeword. Do not call any tool.";

// ---------------------------------------------------------------- ACP plumbing

const ALLOWED_METHODS = new Set(["session/new", "session/close", "session/load", "session/resume"]);
const request = (s: SpikeSession, method: string, params: Record<string, unknown>): Promise<any> => {
  if (!ALLOWED_METHODS.has(method)) throw new Error(`catch-up-paid must not send ${method} through request()`);
  return (s.ctx as any).request(method, params);
};
const mcpServersFor = (s: SpikeSession) => [
  { type: "http", name: "pi", url: s.mcp.url, headers: [{ name: "Authorization", value: `Bearer ${s.mcp.token}` }] },
];

const SPIKE_TOOL_RE = /pi__(echo|read_note)/;
const onPermissionRequest = async (params: any, ctx: PermissionContext): Promise<any> => {
  const toolCallId = params?.toolCall?.toolCallId;
  const call = ctx.updates
    .map((u) => u.update as Record<string, any>)
    .find((x) => x.sessionUpdate === "tool_call" && x.toolCallId === toolCallId);
  const names = [call?.title, call?._meta?.tool_name, call?._meta?.toolName, call?.rawInput?.name].filter(Boolean).map(String);
  const pick = (kind: string) => (params?.options ?? []).find((o: any) => o.kind === kind);
  const allow = names.some((n) => SPIKE_TOOL_RE.test(n)) ? pick("allow_once") : undefined;
  const choice = allow ?? pick("reject_once") ?? pick("reject_always");
  ctx.eventLog.write({ ev: "permission_decision", toolCallId, tool: names, decision: allow ? "allow_once" : "reject" });
  return choice ? { outcome: { outcome: "selected" as const, optionId: choice.optionId } } : { outcome: { outcome: "cancelled" as const } };
};

const providerEnv: Record<string, string> = {
  VIBE_ACTIVE_MODEL: modelAlias,
  VIBE_ENABLE_AUTO_APPROVE: "false",
  VIBE_DEFAULT_APPROVAL_POLICY: "ask",
  VIBE_ENABLED_TOOLS: '["pi_*"]',
};
const spawned: SpikeSession[] = [];
let processCount = 0;
const spawnProcess = async (): Promise<SpikeSession> => {
  const s = await openSession({
    runId: `${runId}-p${++processCount}`,
    vibeEnv: providerEnv,
    vibeArgs: [],
    slowMs: 45_000,
    onPermissionRequest,
  });
  spawned.push(s);
  console.log(`[${run}/${label}] spawned vibe-acp pid ${s.child.pid} (process ${processCount})`);
  return s;
};

// ---------------------------------------------------------------- prompt step

interface PromptResult {
  name: string;
  skippedDryRun: boolean;
  promptNumber: number | null;
  promptChars: number;
  wallMs: number | null;
  stopReason: string | null;
  failure: string | null;
  promptResponse: unknown;
  replyText: string;
  realToolCallsAcp: Array<{ toolCallId: string; name: string }>;
  realToolCallsMcp: Record<string, number>;
  imitatedToolCallText: boolean;
  deadTurn: boolean;
  usageUpdates: unknown[];
  checks: Record<string, boolean | string>;
}
const promptResults: PromptResult[] = [];

/** Sends one session/prompt after reserving budget; in --dry-run records the plan and sends nothing. */
async function promptStep(
  s: SpikeSession,
  sessionId: string,
  name: string,
  text: string,
  check: (reply: string) => Record<string, boolean | string>,
): Promise<PromptResult> {
  const base = { name, promptChars: text.length };
  if (dryRun) {
    const skipped: PromptResult = {
      ...base,
      skippedDryRun: true,
      promptNumber: null,
      wallMs: null,
      stopReason: null,
      failure: null,
      promptResponse: null,
      replyText: "",
      realToolCallsAcp: [],
      realToolCallsMcp: {},
      imitatedToolCallText: false,
      deadTurn: false,
      usageUpdates: [],
      checks: {},
    };
    promptResults.push(skipped);
    console.log(`[${run}/${label}] DRY RUN: would send prompt "${name}" (${text.length} chars); no session/prompt, no budget used`);
    return skipped;
  }
  const n = reserveCatchupPrompt(`${run}/${label}/${name}`); // budget gate BEFORE the send; failed sends count
  s.eventLog.write({ ev: "prompt_reserved", n, of: CATCHUP_MAX_PROMPTS, name, text });
  console.log(`[${run}/${label}] prompt ${n}/${CATCHUP_MAX_PROMPTS} "${name}" sending (${text.length} chars)`);
  const from = s.updates.length;
  const t0 = now();
  let response: any = null;
  let failure: string | null = null;
  const guard = setTimeout(() => void s.ctx.notify("session/cancel", { sessionId }), promptTimeoutMs);
  try {
    response = await (s.ctx as any).request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  } catch (e) {
    failure = String(e);
  } finally {
    clearTimeout(guard);
  }
  const t1 = now();
  await sleep(1500); // trailing updates + MCP log flush
  const window = s.updates.slice(from).map((u) => u.update as Record<string, any>);
  const replyText = window
    .filter((x) => x.sessionUpdate === "agent_message_chunk" && x.content?.type === "text")
    .map((x) => String(x.content.text))
    .join("");
  const acpCalls = new Map<string, string>();
  for (const x of window) {
    if (x.sessionUpdate === "tool_call") acpCalls.set(String(x.toolCallId), String(x.title ?? x._meta?.tool_name ?? ""));
  }
  const mcpCalls: Record<string, number> = {};
  const mcpPath = join(OUT_DIR, `${s.runId}-mcp.jsonl`);
  if (existsSync(mcpPath)) {
    for (const line of readFileSync(mcpPath, "utf8").split("\n").filter(Boolean)) {
      const r = JSON.parse(line) as { ev: string; ms: number; tool?: string };
      if (r.ev === "tool_exec_start" && r.ms >= t0 && r.ms <= t1 + 1500 && r.tool) mcpCalls[r.tool] = (mcpCalls[r.tool] ?? 0) + 1;
    }
  }
  const realToolCalls = Math.max(
    acpCalls.size,
    Object.values(mcpCalls).reduce((a, b) => a + b, 0),
  );
  const textContent = [{ type: "text", text: replyText }];
  const realBlocks = Array.from({ length: realToolCalls }, (_, i) => ({ type: "toolCall", id: `r${i}`, name: "x", arguments: {} }));
  const result: PromptResult = {
    ...base,
    skippedDryRun: false,
    promptNumber: n,
    wallMs: t1 - t0,
    stopReason: response?.stopReason ?? null,
    failure,
    promptResponse: response,
    replyText,
    realToolCallsAcp: [...acpCalls].map(([toolCallId, toolName]) => ({ toolCallId, name: toolName })),
    realToolCallsMcp: mcpCalls,
    imitatedToolCallText: findImitatedToolCallText(textContent as never),
    deadTurn: findImitatedToolCallText([...realBlocks, ...textContent] as never),
    usageUpdates: window.filter((x) => x.sessionUpdate === "usage_update"),
    checks: check(replyText),
  };
  promptResults.push(result);
  s.eventLog.write({ ev: "prompt_result", ...result });
  console.log(
    `[${run}/${label}] "${name}": stop=${result.stopReason} wall=${result.wallMs}ms toolCalls acp=${acpCalls.size} mcp=${JSON.stringify(mcpCalls)} imitated=${result.imitatedToolCallText} failure=${failure ?? "none"}`,
  );
  return result;
}

interface ReattachResult {
  mode: string;
  ok: boolean;
  error?: { code?: unknown; message?: string };
  updateKinds: Record<string, number>;
  modelCurrentValue: string | null;
}
let reattachResult: ReattachResult | undefined;

async function reattach(s: SpikeSession, sessionId: string, mode: "load" | "resume", closeFirst: boolean): Promise<boolean> {
  const from = s.updates.length;
  let outcome: ReattachResult = { mode, ok: false, updateKinds: {}, modelCurrentValue: null };
  try {
    if (closeFirst) await request(s, "session/close", { sessionId });
    const res = await request(s, mode === "load" ? "session/load" : "session/resume", {
      sessionId,
      cwd: WORKTREE_DIR,
      mcpServers: mcpServersFor(s),
    });
    const modelOpt = (res?.configOptions ?? []).find((o: any) => o?.id === "model");
    outcome = { ...outcome, ok: true, modelCurrentValue: modelOpt?.currentValue ?? null };
  } catch (e: any) {
    outcome = { ...outcome, error: { code: e?.code, message: e?.message ?? String(e) } };
  }
  await sleep(600);
  for (const u of s.updates.slice(from)) {
    const kind = u.update.sessionUpdate;
    outcome.updateKinds[kind] = (outcome.updateKinds[kind] ?? 0) + 1;
  }
  reattachResult = outcome;
  s.eventLog.write({ ev: "reattach_result", ...outcome });
  console.log(
    `[${run}/${label}] reattach ${mode}: ${outcome.ok ? "ok" : `FAILED ${JSON.stringify(outcome.error)}`} updates=${JSON.stringify(outcome.updateKinds)}`,
  );
  return outcome.ok;
}

// ---------------------------------------------------------------- the runs

const lower = (s: string): string => s.toLowerCase();
const mentions = (reply: string, what: string): boolean => lower(reply).includes(lower(what));
const catchUpChecks = (reply: string) => ({
  answerHasNewCode: mentions(reply, noteCode(NEW_KEY)),
  answerHasForeignCode: mentions(reply, noteCode(FOREIGN_KEY)),
});

let stopNote: string | null = null;
let selfCheck: Record<string, boolean> = {};

// wiring proof that needs no prompt: the imitation detector flags the 0.1.3-forbidden shape and passes the records
selfCheck = {
  detectorFlagsImitatedText: findImitatedToolCallText([{ type: "text", text: '[tool pi__echo {"text":"x"}]' }] as never),
  detectorIgnoresPastRecord: !findImitatedToolCallText([
    { type: "text", text: "--- past tool call pi__echo ---\n{}\n--- end past tool call ---" },
  ] as never),
  catchUpPromptHasRecords:
    catchUpPromptText.includes(`--- past tool call pi__read_note ---`) && catchUpPromptText.includes("--- past tool result pi__read_note"),
  rebuildPromptHasSystemAndPreamble: rebuildPromptText.startsWith(SYSTEM_PROMPT) && rebuildPromptText.includes(HISTORY_PREAMBLE),
};

try {
  let session = await spawnProcess();
  let sessionId = session.sessionId;

  if (run === "R") {
    await promptStep(session, sessionId, "rebuild", rebuildPromptText, catchUpChecks);
  } else {
    const first = await promptStep(
      session,
      sessionId,
      "first",
      run === "L" ? echoPrompt(CODEWORD, true) : echoPrompt(ECHO_WORD, false),
      (reply) => ({
        echoed: run === "L" ? true : mentions(reply, "done"),
      }),
    );
    if (!dryRun && (first.failure || first.stopReason !== "end_turn")) {
      stopNote = `first prompt did not end cleanly (failure=${first.failure ?? "none"}, stop=${first.stopReason})`;
    } else if (run === "C") {
      const ok = reattachMode === "open" ? true : await reattach(session, sessionId, reattachMode as "load" | "resume", true);
      if (ok) await promptStep(session, sessionId, "catch-up", catchUpPromptText, catchUpChecks);
      else stopNote = `reattach ${reattachMode} failed; no catch-up prompt sent`;
    } else {
      // L: crash the process (no session/close), new process, reattach the old id
      const pid = session.child.pid;
      session.child.kill("SIGKILL");
      await new Promise((r) => session.child.once("exit", r));
      await session.shutdown();
      console.log(`[${run}/${label}] pid ${pid} SIGKILLed`);
      session = await spawnProcess();
      const ok = await reattach(session, sessionId, reattachMode as "load" | "resume", false);
      if (ok)
        await promptStep(session, sessionId, "after-restart", restartQuestion, (reply) => ({
          answerHasCodeword: mentions(reply, CODEWORD),
        }));
      else stopNote = `reattach ${reattachMode} after restart failed; no prompt sent`;
    }
  }
} finally {
  for (const s of spawned.filter((x) => x.child.exitCode === null && x.child.signalCode === null)) {
    await s.shutdown().catch(() => {});
  }
  const result = {
    runId,
    run,
    label,
    reattachMode: reattachMode ?? null,
    dryRun,
    modelAlias,
    iso: iso(),
    budget: { max: CATCHUP_MAX_PROMPTS, usedAfterRun: readCounter().count },
    selfCheck,
    reattach: reattachResult ?? null,
    stopNote,
    promptTexts: dryRun ? { catchUp: catchUpPromptText, rebuild: rebuildPromptText } : undefined,
    prompts: promptResults,
    spawnedPids: spawned.map((s) => s.child.pid),
    stillRunning: spawned.filter((s) => s.child.exitCode === null && s.child.signalCode === null).length,
  };
  const out = join(OUT_DIR, `${runId}-result.json`);
  writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(`[${run}/${label}] result: ${out}`);
  console.log(
    JSON.stringify(
      {
        ...result,
        promptTexts: undefined,
        prompts: promptResults.map((p) => ({ ...p, promptResponse: undefined, replyText: p.replyText.slice(0, 300) })),
      },
      null,
      2,
    ),
  );
}

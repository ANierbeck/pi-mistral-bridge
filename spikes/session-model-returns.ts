// Step 0 of docs/plans/2026-11-28-per-model-session-resume.md — free, local, read-only.
//
//   npx tsx spikes/session-model-returns.ts [--from 2026-11-18] [--to 2026-11-28] [--bridge-providers mistral-bridge]
//
// Scans Pi session files (~/.pi/agent/sessions/**/*.jsonl) and counts how often a Pi session enters a
// bridge model (provider "mistral-bridge") after a different model, and how many of those entries are
// RETURNS to a model already used earlier in the same session (the only case where resuming a
// per-model ACP session could help).
//
// Privacy (AGENTS.md section 8): prints a counts table (JSON) to stdout and nothing else. No text,
// path, session id or cwd is printed, logged or written anywhere.
//
// Method notes (the counts are only as good as these):
// - Excluded as subagent sessions, by path only: `subagent-artifacts/` (transcript copies) and
//   `<session>/<uuid>/run-N/session.jsonl` (child-run sessions, headers carry `parentSession`).
// - Sequence = assistant messages with provider + model in FILE order (chronological append order;
//   abandoned /tree branches are included because the bridge saw those messages too).
// - An event is counted only if its message timestamp is inside [from, to] (UTC, inclusive); earlier
//   entries of the same file still feed the "model used before" state.
// - Timestamp of a message = `message.timestamp` (ms). It is not necessarily the END of the response,
//   so the 10 min gap is approximate.
// - "Inside one turn" = no `user` message entry between the previous assistant message and this one
//   (tool results do not start a turn; custom messages are not treated as user messages).
// - "Compaction since last use" = a `compaction` entry between the model's last assistant message and
//   this one.
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";

const IDLE_WINDOW_MS = 10 * 60 * 1000;

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? (args[at + 1] as string) : fallback;
};
// default = the bridge's provider name; a comma list also counts renamed provider labels (--bridge-providers a,b)
const bridgeProviders = new Set(flag("bridge-providers", "mistral-bridge").split(","));
const fromMs = Date.parse(`${flag("from", "2026-11-18")}T00:00:00.000Z`);
const toMs = Date.parse(`${flag("to", "2026-11-28")}T23:59:59.999Z`);

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.name.endsWith(".jsonl")) yield path;
  }
}

const isSubagentFile = (rel: string): boolean => rel.split(sep).includes("subagent-artifacts") || /(^|[\\/])run-\d+[\\/]/.test(rel);

const root = join(homedir(), ".pi/agent/sessions");

const counts = {
  filesScanned: 0,
  filesExcludedSubagent: 0,
  filesWithBridgeAssistantInRange: 0,
  entriesIntoBridgeModelAfterDifferentModel: 0,
  firstEntryOfThatModel: 0,
  returnToModelUsedEarlier: 0,
  returns: {
    gapAtMost10min: 0,
    gapOver10min: 0,
    insideOneTurn: 0,
    atTurnStart: 0,
    compactionSinceLastUse: 0,
    // the combination the proposal can actually serve: no compaction, within the idle window
    noCompactionAndAtMost10min: 0,
    noCompactionAndAtMost10minAtTurnStart: 0,
  },
  entriesInsideOneTurnAll: 0,
  entriesAtTurnStartAll: 0,
};

for (const path of walk(root)) {
  if (isSubagentFile(relative(root, path))) {
    counts.filesExcludedSubagent++;
    continue;
  }
  counts.filesScanned++;

  let previousModel: string | undefined;
  let userSincePreviousAssistant = false;
  let compactionsSeen = 0;
  const lastUse = new Map<string, { ms: number; compactions: number }>();
  let bridgeInRange = false;

  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "compaction") {
      compactionsSeen++;
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message?.role === "user") {
      userSincePreviousAssistant = true;
      continue;
    }
    if (message?.role !== "assistant" || !message.provider || !message.model) continue;

    const model = `${message.provider}/${message.model}`;
    const ms = typeof message.timestamp === "number" ? message.timestamp : Date.parse(entry.timestamp);
    const inRange = ms >= fromMs && ms <= toMs;
    const isBridge = bridgeProviders.has(message.provider);
    if (isBridge && inRange) bridgeInRange = true;

    if (inRange && isBridge && previousModel !== undefined && previousModel !== model) {
      counts.entriesIntoBridgeModelAfterDifferentModel++;
      const insideTurn = !userSincePreviousAssistant;
      if (insideTurn) counts.entriesInsideOneTurnAll++;
      else counts.entriesAtTurnStartAll++;

      const earlier = lastUse.get(model);
      if (!earlier) {
        counts.firstEntryOfThatModel++;
      } else {
        counts.returnToModelUsedEarlier++;
        const atMost10 = ms - earlier.ms <= IDLE_WINDOW_MS;
        const compacted = compactionsSeen > earlier.compactions;
        if (atMost10) counts.returns.gapAtMost10min++;
        else counts.returns.gapOver10min++;
        if (insideTurn) counts.returns.insideOneTurn++;
        else counts.returns.atTurnStart++;
        if (compacted) counts.returns.compactionSinceLastUse++;
        if (!compacted && atMost10) {
          counts.returns.noCompactionAndAtMost10min++;
          if (!insideTurn) counts.returns.noCompactionAndAtMost10minAtTurnStart++;
        }
      }
    }

    lastUse.set(model, { ms, compactions: compactionsSeen });
    previousModel = model;
    userSincePreviousAssistant = false;
  }
  if (bridgeInRange) counts.filesWithBridgeAssistantInRange++;
}

console.log(JSON.stringify(counts, null, 2));

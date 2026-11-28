# Per-process debug log files

- **Status:** done — 2026-11-28 (red-first: the name tests red against the
  shared names; all gates green; fix commit 753ea1e)
- **Problem:** With `debug: true` every Pi process that loads the bridge
  writes to the same file names under `~/.pi/agent/logs/mistral-bridge/`:
  `mcp-bridge.jsonl` (`src/provider.ts`), `model-discovery.jsonl`
  (`src/models.ts`) and `vibe-acp-<alias>-<n>.jsonl` (`src/acp-client.ts`,
  where `<n>` is a per-process spawn counter, so the first process of every
  Pi instance is `-1`). The owner runs several Pi processes at once (main
  session, router session, subagents), so their lines interleave in one file
  without any process marker. JSON-RPC ids and the bridge's turn counters
  then collide, and the logs cannot be attributed to a process. This was
  observed while analysing [the late-wave defect](2026-11-28-late-mcp-call-waves.md):
  one `vibe-acp-…-1.jsonl` file holds four `initialize` handshakes within six
  seconds, and an analysis of the shared `mcp-bridge.jsonl` produced
  misleading counts that had to be retracted.
- **Solution:** Every debug log file name carries the writing process id:
  `mcp-bridge-<pid>.jsonl`, `model-discovery-<pid>.jsonl`,
  `vibe-acp-<alias>-<pid>-<n>.jsonl`. One helper builds the file name, so
  every writer uses the same rule. Redaction, the directory and the
  debug-off default are unchanged (§15).
- **Open decisions:** none. Old shared files are left alone (the bridge never
  deletes user files); README documents the new names.
- **Verified against:** `main` @ 71c9e90. File names checked in
  `src/acp-client.ts` (`AcpDebugLog` builds `${fileBase}.jsonl`; the pool
  passes `vibe-acp-${alias}-${++spawnCounter}`), `src/models.ts`
  (`logFileBase: 'model-discovery'`) and `src/provider.ts`
  (`appendFileSync(join(logDir, 'mcp-bridge.jsonl'), …)`). Interleaving
  checked in the owner's local log directory (counts only, §8).

## Tasks

- [x] T1 (red) — tests that pin the new names: `AcpDebugLog`/pool file name
  contains the pid; the provider's bridge logger writes
  `mcp-bridge-<pid>.jsonl`; model discovery writes
  `model-discovery-<pid>.jsonl`. Observed RED against the current names.
- [x] T2 — one exported helper (e.g. `debugLogFileName(base, pid)` in
  `src/acp-client.ts` next to `defaultDebugLogDir`) used by all three
  writers; pid injectable for tests, default `process.pid`. As built:
  `debugLogFileName(base, pid, sequence?)`; the pool passes its spawn counter
  as `sequence` so the name keeps the `<alias>-<pid>-<n>` order.
- [x] T3 — README debug-log section names the new pattern.
- [x] T4 — gates as in AGENTS.md §4; CHANGELOG `## Unreleased` (Fixed).

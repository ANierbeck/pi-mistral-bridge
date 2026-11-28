# Provider mode: enable Vibe's read-only `read_file` builtin

- **Status:** approved — 2026-11-28 (owner decisions in chat: fixed set, no
  configuration; `read_file` only, because `grep` does not exist on the 3.1.4
  unified harness; flagged reads are rejected). [ADR-0011](../adr/0011-provider-mode-read-file-builtin.md) accepted
  2026-11-28; the owner approved the paid T6 run (at most 2 prompts).
- **Problem:** In provider mode every Vibe builtin is denied by policy
  (ADR-0006). Models still call them: in the owner's logs 149 `read_file`
  attempts failed with `tool_denied`, and each failure costs a model step.
  Pi's own `read` tool already gives the model the same capability, so
  denying the builtin buys no safety.
- **Solution:** Add `read_file` to the `VIBE_ENABLED_TOOLS` globs through one
  constant in `src/vibe-protocol.ts`. Nothing else changes in behaviour:
  writes, shell and processes stay denied; the permission bridge keeps
  approving only bridge tools, so a flagged read is rejected; builtin
  notifications stay off the Pi stream. The mechanism, evidence and
  rejected options are in ADR-0011.
- **Open decisions:** none.
- **Verified against:** `main` @ 71c9e90, `vibe-acp` 3.1.4 (installed package
  source, files named in ADR-0011), pi 1.7.0. Code: `buildEnabledToolsGlobs`
  / `buildEnabledToolsEnvValue` (`src/vibe-protocol.ts`), their tests
  (`test/vibe-protocol.test.ts`, expecting `['pi_pi__*']`),
  `providerPermissionRequest` and `isBridgeToolName` plus its safety doc
  comment (`src/acp-client.ts`), the provider path of `mapUpdate`, which
  drops non-bridge tool calls (`src/acp-client.ts`). AskVibe
  (`src/ask-vibe.ts`) has no MCP server and no tool gate, so it is not
  affected. Not checked: Vibe's behaviour for reads outside the session
  cwd. T6 would answer that.

## Tasks

- [ ] T1 (red) — `test/vibe-protocol.test.ts`: `buildEnabledToolsGlobs('pi')`
  equals `['pi_pi__*', 'read_file']`; `buildEnabledToolsEnvValue('pi')` is
  the matching JSON array; the spawn env carries it. RED against the current
  globs.
- [ ] T2 — `src/vibe-protocol.ts`: exported constant (e.g.
  `PROVIDER_ENABLED_BUILTIN_TOOLS = ['read_file'] as const`) with a doc
  comment that cites ADR-0011 and the Vibe 3.1.4 source locations;
  `buildEnabledToolsGlobs` appends it; update the function doc comment.
- [ ] T3 (pin) — `test/acp-client.test.ts`: in provider mode, a `tool_call`
  with `_meta.tool_name: "read_file"` followed by `session/request_permission`
  for its id is answered `reject_once`, and the anomaly sink is called.
  It is a pin, not red, if the current code already does this; say so.
- [ ] T4 (pin) — `test/acp-client.test.ts`: provider-mode `tool_call` /
  `tool_call_update` notifications for `read_file` produce no tool event
  for the provider (same pin rule).
- [ ] T5 — docs: `isBridgeToolName` safety comment (ADR-0011 Consequences),
  the `mapUpdate` provider-path comment, AGENTS.md §15 (one exception:
  `read_file`, ADR-0011), README provider-mode tool section, CHANGELOG
  `## Unreleased` (Changed).
- [ ] T6 (owner-gated, paid) — only with the owner's explicit go for this
  run: `MISTRAL_BRIDGE_IT=1`, one prompt on one model, asking the model to
  read a synthetic file in a temp cwd with Vibe's `read_file`. Pass when
  the `tool_call_update` is `completed` without a permission request.
  Budget: at most 2 prompts.
- [ ] T7 — gates as in AGENTS.md §4 plus `npm run test:coverage` and
  `npm run build`.

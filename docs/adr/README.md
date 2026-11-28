# Architecture Decision Records

ADRs record architecture decisions as they were made. Rules (AGENTS.md §12):

- An ADR starts as **Proposed** and may be edited while proposed.
- It becomes **Accepted** when the owner agrees; the Status line names the
  date.
- An accepted ADR is **never edited again**. Corrections, clarifications and
  reversals are new ADRs that cite the old one.
- An ADR never cites forward. This index is the only place that records
  supersession.

## Index

| ADR | Title | Status | Superseded by |
|-----|-------|--------|---------------|
| [0001](0001-drive-vibe-through-acp.md) | Drive Mistral Vibe through ACP (`vibe-acp`) | Accepted | — |
| [0002](0002-provider-mode-pi-owns-the-agent-loop.md) | Provider mode: Pi owns the agent loop, Pi tools via MCP | Accepted | Partially amended by [0006](0006-provider-mode-permissions-and-tool-gating.md) (permission handling); partially amended by [0009](0009-provider-name-default-mistral-bridge.md) (default provider name) |
| [0003](0003-history-delta-with-rebuild-fallback.md) | History: delta prompts with rebuild fallback | Accepted | Partially amended by [0008](0008-implementation-deviations.md) (cwd is not a rebuild trigger; sessions keyed by Pi sessionId only) |
| [0004](0004-askvibe-agent-mode-and-permission-bridge.md) | AskVibe agent mode and permission bridge | Accepted | Partially amended by [0008](0008-implementation-deviations.md) — all three AskVibe deviations: tool params are `question` + `mode` only (no `model`/`continue`; Vibe's default model on a fresh ephemeral session, no resume); `mode` validated against the session's advertised `availableModes` with safe fallback (`plan`→`ask` on vibe-acp ≥ 3.0, never smart/auto-approve) and the effective mode reported in details; `allow_always*` permission options downgraded to `allow_once` + logged anomaly, never persisted |
| [0005](0005-models-and-auth-come-from-vibe.md) | Models and authentication come from Vibe | Accepted | Partially superseded by [0007](0007-process-model-and-env-based-configuration.md) (model selection via env per process instead of session/set_config_option); partially amended by [0008](0008-implementation-deviations.md) (no cache file — in-memory catalog re-discovered on every Pi start) |
| [0006](0006-provider-mode-permissions-and-tool-gating.md) | Provider mode: permission bridge, tool gating, 60 s effect budget | Accepted | — |
| [0007](0007-process-model-and-env-based-configuration.md) | One process per model; configuration via process env | Accepted | — |
| [0008](0008-implementation-deviations.md) | Implementation-round deviations accepted as amendments to ADR-0003/0004/0005 | Accepted | — |
| [0009](0009-provider-name-default-mistral-bridge.md) | Default provider name `mistral-bridge` (amends ADR-0002) | Accepted | — |
| [0010](0010-bridge-failure-feedback.md) | Bridge failure feedback contract (dead-turn detection, one corrective retry, `mistral-bridge:` prefix) | Accepted | — |
| [0011](0011-diagnostics-commands-and-warning-routing.md) | Diagnostics commands and warning routing (`/mistral-bridge.doctor`, `/mistral-bridge.models`, session notifier) | Proposed | — |

## Template

```markdown
# NNNN — <Title>

## Status

Proposed (YYYY-MM-DD).        <!-- or: Accepted (YYYY-MM-DD). -->

## Context

What forces are at play; what problem needs a decision. Facts are checked
against code, tool versions or sources, and the source is named.

## Decision Drivers

- ...

## Options Considered

1. **Option A** — pros / cons
2. **Option B** — pros / cons

## Decision

What we do, stated so that a reviewer can check code against it.

## Consequences

What becomes easier, what becomes harder, what risk we accept, what must be
verified later.
```

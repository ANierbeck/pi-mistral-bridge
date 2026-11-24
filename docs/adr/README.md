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
| [0002](0002-provider-mode-pi-owns-the-agent-loop.md) | Provider mode: Pi owns the agent loop, Pi tools via MCP | Accepted | Partially amended by [0006](0006-provider-mode-permissions-and-tool-gating.md) (permission handling) |
| [0003](0003-history-delta-with-rebuild-fallback.md) | History: delta prompts with rebuild fallback | Accepted | — |
| [0004](0004-askvibe-agent-mode-and-permission-bridge.md) | AskVibe agent mode and permission bridge | Accepted | — |
| [0005](0005-models-and-auth-come-from-vibe.md) | Models and authentication come from Vibe | Accepted | Partially superseded by [0007](0007-process-model-and-env-based-configuration.md) (model selection via env per process instead of session/set_config_option; in-memory catalog, no cache file) |
| [0006](0006-provider-mode-permissions-and-tool-gating.md) | Provider mode: permission bridge, tool gating, 60 s effect budget | Accepted | — |
| [0007](0007-process-model-and-env-based-configuration.md) | One process per model; configuration via process env | Accepted | — |

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

# 0005 — Models and authentication come from Vibe

## Status

Accepted (2026-11-24).

## Context

Pi needs a model list for the provider registration (ADR-0002). Which
Mistral models a user may use through Vibe depends on their plan and on
Vibe's configuration, and it changes over time. A hardcoded list goes stale
and can offer models that do not work for the user.

Vibe 2.25.8 sends session config options to ACP clients and supports
`session/set_config_option` (verified in `vibe/acp/agent.py`); the model
selector is expected to be one of these options — to be confirmed by the
spike.

Authentication: Vibe manages its own credentials (`vibe-acp --setup`, ACP
`authenticate`). ADR-0001 forbids the bridge from touching them.

## Decision Drivers

- No hardcoded models (AGENTS.md §9).
- Never handle Mistral credentials (AGENTS.md §14).
- Pi should list models at startup without a slow or costly call.

## Options Considered

1. **Hardcoded model list** — stale, violates AGENTS.md §9.
2. **Pi's builtin `mistral` catalog** — Pi's view of the Mistral API, not of
   what Vibe offers; may list models Vibe does not serve.
3. **Ask Vibe** — read the model option from an ACP session's config
   options; cache the last known list for fast startup.

## Decision

Option 3.

- On first need, the bridge starts `vibe-acp`, opens a short-lived session
  (no prompt is sent, so no model usage) and reads the model config option.
  The resulting list is registered as the provider's models and cached under
  the bridge's own cache file, so the next Pi start can register
  immediately and refresh in the background.
- Metadata Vibe does not provide (context window, reasoning, image input) is
  enriched from Pi's registry by id where a match exists, else a
  conservative documented default is used. Enrichment never admits a model.
- Switching models uses `session/set_config_option`; if that fails, the
  session is rebuilt (ADR-0003).
- If `vibe-acp` reports that authentication is required, the bridge surfaces
  a clear error telling the user to run `vibe-acp --setup`; it never asks for
  or stores a key itself.

## Consequences

- The model list matches what the user's Vibe actually serves.
- The very first start needs a running `vibe-acp` to obtain models; until
  then the provider has an empty list or the cached one.
- If Vibe does not expose models as a config option, this ADR's mechanism
  fails and a new ADR must decide the replacement.

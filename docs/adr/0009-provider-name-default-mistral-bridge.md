# 0009 — Default provider name `mistral-bridge`

## Status

Proposed (2026-11-24). Amends ADR-0002 (default provider name).

## Context

ADR-0002 has the bridge register its own Pi provider under the default name
`mistral-vibe`, so bridge models are addressed as `mistral-vibe/<apiModelId>`.
The owner decided (2026-11-24) that the provider should be visibly identified
as a bridge: `mistral-vibe/…` collides conceptually with Mistral's own
`vibe-acp` naming, and next to Pi's builtin `mistral` provider the two names
invite confusion about which provider actually serves a model. The
bridge-provider pattern (an external agent exposed as a Pi model provider)
follows the pi-claude-bridge project, where the provider is named after the
bridge itself. The project/package name `pi-mistral-bridge` is unchanged;
only the registered provider's default name changes.

## Decision Drivers

- The provider name should say what the provider is: a bridge to an external
  agent — not Mistral's own tool, and not Pi's builtin HTTP provider.
- Users with a custom `providerName` in `mistral-bridge.json` are unaffected;
  only the default changes.
- The `providerName` config key remains the override (AGENTS.md §6: the
  bridge registers only its own provider, always with the full model list),
  and the runtime reserved-name collision check applies to the configured
  name as before.

## Options Considered

1. **Keep `mistral-vibe`** — no change, but the name misidentifies the
   provider as Vibe itself and sits confusingly next to Pi's builtin
   `mistral` provider.
2. **`mistral-bridge`** — names the bridge (the project name minus the
   `pi-` prefix), the same convention as pi-claude-bridge;
   `mistral-bridge/<apiModelId>` is unambiguous in `--model`, `/model` and
   `pi -p`.
3. **Derive the name from the package name at runtime** — more machinery for
   no user-visible gain; a constant default plus the existing `providerName`
   override is simpler and testable.

## Decision

The default value of the `providerName` config key is `mistral-bridge`
(`DEFAULT_PROVIDER_NAME` in src/config.ts). Bridge models are addressed as
`mistral-bridge/<apiModelId>` everywhere (`--model`, `/model`, `pi -p`, …).
The `providerName` config key is unchanged and still overrides the default,
and the reserved-name collision check (Pi's builtin providers, resolved at
runtime) guards the configured name exactly as before.

## Consequences

- README, the config reference, tests and the design/implementation plans
  are updated to the new default; the collision warning in src/index.ts
  follows the constant automatically.
- Users who set a custom `providerName` are unaffected.
- Anyone who already addressed models as `mistral-vibe/<id>` (development
  builds before this change) must switch to `mistral-bridge/<id>` — or set
  `"providerName": "mistral-vibe"` explicitly to keep the old name.
- `mistral-bridge` must not collide with a Pi builtin provider name; the
  runtime reserved-name check already guards that, and a unit test pins that
  the default name is not in the reserved set.

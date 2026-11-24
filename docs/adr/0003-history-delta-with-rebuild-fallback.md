# 0003 — History: delta prompts with rebuild fallback

## Status

Accepted (2026-11-24).

## Context

Pi passes the full conversation (`context.messages`) on every
`streamSimple` call. A Vibe ACP session, in contrast, keeps its own history
and accepts only the *next* prompt. Pi can also rewrite history: compaction,
`/tree` navigation, forks, a changed system prompt, a model switch, a new cwd,
or simply a Pi restart with a resumed session.

`pi-claude-bridge` keeps the two in sync by writing Claude Code's native
session files and resuming them. Vibe has a session store too, but its
on-disk format is internal and undocumented (AGENTS.md §16).

Every token re-sent to Vibe consumes the owner's allowance, and re-sending
the whole history on every turn also defeats prompt caching.

## Decision Drivers

- Minimise tokens per turn (allowance, latency, caching).
- Never let Vibe answer on a history that differs from Pi's.
- Depend only on ACP, not on Vibe's storage format.
- Simple, testable logic.

## Options Considered

1. **Fresh ACP session per turn with the full transcript** — always correct,
   trivial; but full history cost on every turn, no caching.
2. **Native session sync** (write Vibe session files, `session/load`) — best
   fidelity, real tool-call structure; but coupled to an undocumented format
   and the most code.
3. **Delta with rebuild fallback** — one long-lived ACP session per Pi
   session; send only the new user turn while Pi's history is a known prefix
   of what Vibe has seen; on divergence, start a fresh ACP session seeded
   with a compact transcript.

## Decision

Option 3.

- The bridge keeps, per Pi session, a digest of the Pi message prefix the ACP
  session has seen, plus the system prompt digest, model, and cwd.
- **Continuation:** trailing `toolResult`s that match parked MCP calls are
  delivered (ADR-0002); nothing new is prompted.
- **Delta:** if the history before the new user message matches the recorded
  digest, only the new user message (text and image blocks) is sent with
  `session/prompt`.
- **Rebuild:** on any mismatch — compaction, tree/fork, changed system
  prompt, cwd, a model change that cannot be applied with
  `set_config_option`, a crashed `vibe-acp`, a Pi restart — the bridge closes
  the old ACP session, opens a new one, and sends one prompt containing Pi's
  system prompt, a compact transcript of the history (full text; tool calls
  as name plus arguments; large tool outputs truncated with a marker), and
  the current user message.
- The digest logic and the transcript renderer are pure functions with unit
  tests.

## Consequences

- Normal turns cost only the new content; rebuilds cost one history replay.
- After a rebuild, Vibe sees prior tool use as text, not as structured tool
  calls — acceptable for continuation quality, and the trade-off for not
  depending on Vibe's storage format.
- If rebuild quality turns out insufficient in practice, native session sync
  can be revisited in a new ADR.

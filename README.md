# pi-mistral-bridge

A Pi coding-agent extension that makes Mistral models usable inside Pi by
driving the official Mistral Vibe harness (`vibe-acp`) over the Agent Client
Protocol (ACP). It has two modes:

- **Provider mode** — Mistral models appear in Pi's model picker; Pi owns the
  agent loop and every tool call is executed by Pi.
- **AskVibe** — a Pi tool that delegates a task to Vibe as a sub-agent with
  Vibe's own tools.

- Design: [docs/plans/2026-11-24-pi-mistral-bridge-design.md](docs/plans/2026-11-24-pi-mistral-bridge-design.md)
- Architecture decisions (ADRs): [docs/adr/](docs/adr/)
- Implementation plan (T1–T8): [docs/plans/2026-11-24-implementation.md](docs/plans/2026-11-24-implementation.md)
- Spike evidence: [docs/research/2026-11-24-vibe-acp-surface.md](docs/research/2026-11-24-vibe-acp-surface.md)

The architecture is modeled on
[pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge).

**Status: pre-alpha, local scaffold.** Only the repository scaffolding exists
so far (build, tests, lint/format gates, pre-push secret scanning, CI); the
extension entry point is a placeholder stub and the bridge itself lands in
tasks T2–T7 of the implementation plan. There are intentionally no install
instructions yet.

**Not affiliated with Mistral.** This is an independent bridge. It talks to
Mistral only through your own `vibe-acp` process over ACP — it never calls
the Mistral HTTP API directly — so usage is consumed via your own Vibe
setup, exactly as when you run Vibe yourself.

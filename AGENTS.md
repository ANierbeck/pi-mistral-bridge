# Agent Rules — pi-mistral-bridge

> These are **hard rules** for any AI agent working in this repo. Pi loads
> `AGENTS.md` (and `CLAUDE.md`, which only points here) automatically at
> session start, so these apply to every session, every agent, every fork.
> Violating them is a process failure, not a style preference.

## 0. What this project is

`pi-mistral-bridge` is a Pi extension that makes Mistral models usable inside
Pi by driving the official Mistral Vibe harness (`vibe-acp`) over the Agent
Client Protocol (ACP). It has two modes:

- **Provider mode** — Mistral models appear in Pi's model picker. Pi owns the
  agent loop; Pi's tools are offered to Vibe through a local MCP server and
  every tool call is executed by Pi (ADR-0002).
- **AskVibe agent mode** — a Pi tool that delegates a task to Vibe as a
  sub-agent with Vibe's own tools; Vibe's permission requests are bridged to
  Pi's UI (ADR-0004).

The architecture is decided in `docs/adr/` and the current design lives in
`docs/plans/2026-11-24-pi-mistral-bridge-design.md`. Read both before
changing behaviour.

## 1. Release & Publish — REQUIRES EXPLICIT USER APPROVAL

**The user decides when software is released. Not the agent.**

- **Never** create a git tag, a GitHub Release, or run `npm publish` (directly
  *or* via a workflow trigger such as `gh release create`) without the user's
  **explicit, release-specific** approval naming the concrete version (e.g.
  "release 0.1.0"). "ok", "weiter so", "like last time" or a green CI are
  **not** approval.
- The normal flow **stops after** "commit + PR + verify CI green + verify
  reviews + merge" (§8). Tag / release / publish is **always a question to
  the user** with the concrete version number.
- A published npm version **cannot be deleted**. If unsure whether something
  counts as a release action: **ask first, do not act.**
- **Code review must be clean before a release is even proposed.** Use the
  `requesting-code-review` skill from the pi-superpowers extension (its
  location is in the session's skill listing), fill in every placeholder of
  its `code-reviewer.md` template (`{WHAT_WAS_IMPLEMENTED}`,
  `{PLAN_OR_REQUIREMENTS}`, `{DESCRIPTION}`, `{BASE_SHA}`, `{HEAD_SHA}`) and
  dispatch it with the `subagent` tool using the builtin `reviewer` agent.
  `{BASE_SHA}` is the last release tag, or `origin/main` if none exists.
  No Critical or Important findings may remain open. A clean review is a
  prerequisite, not a substitute for the user's go-ahead.
- Release builds ship with debug logging **off** by default (`debug: false`
  in the shipped defaults).
- Before a release is proposed, include the current `npm audit` summary and
  the `vibe-acp` version the release was verified against (§10).

## 2. Single source of truth for rules

- Rules that govern agent behaviour belong **here** (versioned, reviewable,
  loaded every session) — not only in agent memory. Memory may reinforce a
  rule but never replaces it.
- If a rule needs to change, change this file in a commit.

## 3. Documentation language

- **All documentation and comments are in English** — code comments, JSDoc,
  Markdown (README, CHANGELOG, plans, ADRs, this file), commit messages, type
  definitions, log and error messages. Rationale: international project.
- User-facing chat with the owner in his own language is fine — that is conversation,
  not project documentation.

## 4. Tests & verification before push (TDD)

- **Red-first is mandatory.** Every regression test for a new feature or bug
  fix must be observed **RED against the unfixed implementation** before the
  implementation lands, and the report names the red evidence. A test that
  has never failed is untested itself.
- Before every commit: `npx tsc --noEmit` clean, `npm run lint` clean,
  `npm run format:check` clean, `npx vitest run` green.
- **Coverage thresholds in `vitest.config.ts` are floors.** They are set from
  the first green measurement (rounded down) and **never lowered** to unblock
  a run — add tests instead. Raising them is welcome.
- **Unit tests never touch the network and never spawn the real
  `vibe-acp`.** The ACP side is exercised against an in-process fake ACP agent
  over in-memory streams; the MCP bridge against a real MCP client on
  loopback.
- **Integration tests against the real `vibe-acp` consume the owner's Mistral
  allowance.** They run only with `MISTRAL_BRIDGE_IT=1`, never in CI, never
  automatically, and **only after the owner approved that specific run**.
  The report states what was run and roughly how many turns it cost.
- `spikes/` holds throw-away research scripts. They are not shipped, not
  covered, not imported by `src/`. Findings that matter move into an ADR or
  `docs/research/`; a spike script is never the documentation of a decision.

## 5. Commit conventions

- Conventional-Commits prefixes: `fix:`, `feat:`, `test:`, `docs:`,
  `refactor:`, `chore:`, `release prep:`.
- Batch related changes into one commit; don't split one logical change
  across many tiny commits.
- The body explains *why* (the problem, the symptom, the evidence), not just
  *what*, and lists the gates that were run (§4).

## 6. Pi integration boundaries

- `pi.registerProvider(name, { models })` **replaces** the provider's model
  list, it does not merge. The bridge registers only **its own** provider
  (default name `mistral-bridge`, configurable) and always with the full,
  current model list.
- Never register, rename or shadow a provider the bridge does not own
  (especially Pi's builtin `mistral` provider). Never write to Pi's
  `models.json`, `settings.json` or any other Pi-owned file. The bridge's own
  configuration lives in `mistral-bridge.json` (global under `~/.pi/agent/`,
  project override under `.pi/`).
- Use only Pi's public extension API (`@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-ai`). If a private reach-through becomes unavoidable,
  it needs an ADR and a test that fails when the internal disappears.

## 7. Boyscout Rule — leave the code better than you found it

- Defects, smells, dead code or misleading names/comments found while
  changing or reviewing code are **fixed too** — reporting alone is not
  enough. This includes Minor and cosmetic findings.
- Every fix meets the same bars (§4, §5). Small local cleanups may ride along
  in the task's commit; anything standalone gets its own `fix:`/`refactor:`
  commit naming the defect and where it was found.
- The only escape is a blocker that needs a release (§1) or owner decision —
  then the finding goes to the owner with a concrete plan. Size alone is
  never a blocker.

## 8. Protected `main` & secret scanning

- `main` is protected: no direct pushes, no force pushes, no deletion. Every
  change lands through a pull request whose required checks are green
  (`test`, `secret-scan`). No admin bypass — agents act with the owner's
  token.
- Flow: feature branch → `git push -u origin <branch>` → `gh pr create` →
  required checks green → **read and resolve every review** → `gh pr merge`.
- **Read every review before merging**, including advisory bot reviews.
  Fetch all three endpoints with `gh api --paginate`:
  `repos/<owner>/<repo>/pulls/<n>/reviews`,
  `repos/<owner>/<repo>/pulls/<n>/comments`,
  `repos/<owner>/<repo>/issues/<n>/comments`. Every finding is fixed (with §4
  bars) or explicitly justified to the owner as not-a-defect.
- **The repository is public: every push is a publication.** The versioned
  pre-push hook (`.githooks/pre-push`, wired by `npm install` via
  `core.hooksPath`) scans every commit being pushed, not just the final tree.
  **Never bypass it** (`--no-verify`) and never edit or disable the hook, the
  CI job or the ruleset to get a push through — fix the offending commit
  instead.
- Forbidden references (home paths, private hosts, webhook URLs, personal
  data, the owner's other private projects) are maintained in ONE list,
  `scripts/forbidden-patterns.ts`. Generic credentials are gitleaks' job; a
  false positive goes to `.gitleaksignore` with a comment.
- Debug logs, fixtures and test snapshots must never contain real prompts,
  API keys, tokens or session content from the owner's machine. Fixtures are
  synthetic.
- History rewrites require the owner's explicit instruction.

## 9. No hardcoded models

- Shipped source and shipped defaults must not name a concrete Mistral model
  in any position where it admits, selects, ranks or excludes a model. The
  model list is **derived from what `vibe-acp` reports** for the session
  (its model config option) — see ADR-0005.
- Capability metadata Pi needs (context window, reasoning, image input) is
  taken from what Vibe reports; where Vibe reports nothing, the bridge may
  enrich from Pi's own registry (`getModels("mistral")`) by matching id, and
  otherwise uses a conservative documented default. Enrichment never admits a
  model Vibe did not report.
- Tests may use model literals freely.

## 10. Dependencies, host versions and security alerts

- Every Dependabot alert and every `npm audit` finding is evaluated **per
  alert**: reachability (dev vs runtime, bundled into `dist/` or not),
  exploit preconditions versus how this repo uses the package, then the fix
  path (in-range lock refresh → targeted bump → `overrides` → planned major
  round → documented accepted risk). Read the lock diff — `npm audit fix` can
  "fix" by downgrading. Dismissing an alert requires the owner's go.
- Verification bar for dependency changes: `tsc`, `vitest run`,
  `npm run test:coverage` with thresholds unchanged, `npm run build`.
- **Check the pi devDependencies against the installed pi** (`pi --version`
  vs `npm ls @earendil-works/pi-coding-agent`) at the start of larger work
  rounds and before every release proposal. On mismatch: deliberate
  alignment round.
- **Check the `vibe-acp` version** (`vibe-acp --version`) at the same points.
  The bridge depends on the ACP surface of a moving external tool; the
  version it was last verified against is recorded in the README. A new
  Vibe version is a reason to re-run the (owner-approved) integration tests.
- Keep the runtime dependency set minimal. Every new runtime dependency is
  justified in the commit body.

## 11. Plans: one problem, one plan

- A plan document in `docs/plans/` addresses exactly ONE problem and its
  solution. A second problem gets its own plan; plans link each other.
- Every plan starts with: **Status** (proposed / approved / in progress /
  done / superseded — with a date), **Problem**, **Solution**, **Open
  decisions**, **Verified against** (the commit / tool versions the
  current-state claims were checked against). Claims are checked against
  code, config and logs, never written from memory; what was not checked is
  said so.
- A plan is not a lab notebook: measurements and spike results go to
  `docs/research/` and the plan links them. Progress updates the Status line
  and ticks off steps.
- A plan that drives work is committed. An uncommitted plan does not exist
  for the next session.

## 12. ADRs are immutable once accepted

- Architecture decisions are recorded in `docs/adr/NNNN-<slug>.md` using the
  template in `docs/adr/README.md`.
- An ADR starts as **Proposed** and may be edited freely while proposed.
  It becomes **Accepted** only when the owner has agreed to it; the status
  line names the date.
- **Once accepted, an ADR is never edited** — not for a wording fix, not for
  "see also", not for a "superseded" marker, not for its Status line.
- To clarify, correct or reverse a decision, write a NEW ADR that cites the
  old one. The old text stays as history; the new ADR changes future
  behaviour only.
- Citations run one way: plans, code comments and newer ADRs may cite an
  ADR; an ADR never cites forward. The index in `docs/adr/README.md` is the
  only place that records which ADR supersedes which.

## 13. Model use: the controller plans, subagents on cheaper models implement

- **Owner rule 2026-11-24: every implementation in a session runs in
  subagents on a cheaper model.** The session's own (expensive) model is the
  *controller*: it plans, writes fully specified task briefs, decides,
  reviews and runs the final verification. It does not write production
  code, tests or spike scripts itself.
- Model choice (owner rule 2026-11-24, supersedes hand-pinning):
  subagents (`worker`, `reviewer`, `scout`) run on the dynamic model
  router, model ref `router/dynamic`, which picks a model per request.
  Pin a concrete model only on the owner's explicit request. The
  controller's model is reserved for planning, gating reviews (§1) and the
  final judgement. Name the model ref used in the report.
- Mechanical steps — gate runs, log scans, searches, bulk reads, applying a
  fully specified edit — go to the cheapest capable worker
  (`worker_step`, `bulk_read`, or a subagent).
- This rule is the standing authorisation for subagent delegation required
  by the subagent guidance. Dispatch with the `subagent` tool (builtin
  `worker` for implementation, `reviewer` for reviews, `scout` for recon) —
  never with `pi -p` from bash.
- **One writer per worktree.** Parallel implementers only in separate
  worktrees (§17), and only for tasks that share no files.
- A task brief is self-contained: goal, files, constraints from this file
  (§4 red-first, §14–§16), acceptance criteria, the exact gate commands, and
  — for anything that talks to the real `vibe-acp` — an explicit allowance
  budget (max prompts, which model) that the subagent must not exceed.
- The controller never trusts a subagent's "done": it reads the diff and
  re-runs (or has a worker re-run) the gates before accepting a task
  (`verification-before-completion`).

## 14. Stay on the sanctioned Mistral path

The project exists because Mistral counts usage from third-party harnesses
against the small API allowance from 2026-12-01, while stating that *"the use
of Mistral harnesses via ACP with third-party tools is accepted"* (ADR-0001).
The bridge must stay on exactly that path:

- Talk to Mistral **only through the `vibe-acp` process** and only through
  the ACP protocol and its documented extension methods.
- **Never** read, copy, extract or forward Vibe's credentials (API keys,
  OAuth tokens, keychain entries, `~/.vibe/` auth files). Authentication is
  Vibe's business (`vibe-acp --setup`).
- **Never** call Mistral's HTTP API directly, never spoof a client identity,
  user agent or telemetry, never patch, monkey-patch or wrap Vibe's Python
  code, and never disable Vibe's own telemetry or usage reporting from the
  bridge.
- Be honest in the ACP `initialize` handshake: identify as
  `pi-mistral-bridge` with its real version.
- If Mistral's terms, the announcement or Vibe's behaviour change in a way
  that puts provider mode (ADR-0002) outside what is accepted, **stop and
  tell the owner** — do not look for a workaround.

## 15. Bridge security invariants

- The MCP bridge server listens on **loopback only** (`127.0.0.1`), on a
  random port, and requires a per-session random bearer token. It serves
  only the tools of the Pi session it belongs to.
- In provider mode, Vibe's own tools are gated off via the process env
  allowlist (ADR-0006), with one exception: the read-only `read_file`
  builtin, which Vibe resolves itself (ADR-0011). A Vibe permission request in provider mode is
  **answered immediately, never left pending** (a pending request makes
  `session/cancel` hang on Vibe 3.1.4): `allow_once` if the toolCallId maps
  to one of the bridge's own MCP tools, otherwise `reject_once` **and log**
  the anomaly. `auto-approve` is never used in provider mode
  (`VIBE_ENABLE_AUTO_APPROVE=false`).
- Long Pi tools in provider mode: Vibe enforces a hard 60 s per-turn effect
  budget, so the bridge pre-emptively times Pi tools out at ~55 s and returns
  a "killed at budget" result; MCP handlers de-duplicate repeated calls by a
  deterministic request id (ADR-0006).
- In AskVibe mode, permission requests go to Pi's UI. Without a UI
  (print mode, subagents) they are **rejected**. Auto-approve exists only as
  an explicit opt-in config flag and is never the default (ADR-0004).
- Debug logs redact authorization headers and tokens and are written only
  when `debug` is enabled, under `~/.pi/agent/logs/mistral-bridge/`.
- Child processes are always cleaned up: on Pi session shutdown, on abort,
  and on extension reload. No orphaned `vibe-acp` processes.

## 16. Depend on the protocol, not on Vibe's internals

- The contract with Vibe is ACP (`@agentclientprotocol/sdk`) plus
  `vibe-acp`'s documented CLI flags. Do not depend on Vibe's on-disk session
  format, its Python modules or undocumented files under `~/.vibe/`.
- Reading Vibe's installed source to understand behaviour is fine for
  research; cite the Vibe version and file in `docs/research/` and turn
  load-bearing findings into an integration test or an ADR.
- Every Vibe-specific ACP extension method or `_meta` field the bridge uses
  is listed in one module (`src/vibe-protocol.ts`) so a Vibe upgrade has one
  place to check.

## 17. Development workflow: pi-superpowers skills, adapted to this repo

The pi-superpowers skills (paths in the session's skill listing) are the
default workflow. **Where a skill conflicts with this file, this file wins.**

| Phase | Skill | How it is used here |
|-------|-------|---------------------|
| New feature / behaviour change | `brainstorming` | One question at a time; result is a design in `docs/plans/` (§11) and, for architecture choices, Proposed ADRs (§12). No code before the owner approved the design. |
| Plan | `writing-plans` | Saved as `docs/plans/YYYY-MM-DD-<topic>.md`. The §11 headers (Status, Problem, Solution, Open decisions, Verified against) come first, then the skill's task list. One problem per plan. Committed before execution. |
| Isolate | `using-git-worktrees` | Project-local `.worktrees/<branch>` (already in `.gitignore`). Branch names `feat/…`, `fix/…`, `docs/…`, `spike/…`. Baseline gates must be green before the first task. |
| Execute | `subagent-driven-development` | **Default.** Implementer = builtin `worker` on a cheaper model (§13); spec reviewer and code-quality reviewer = builtin `reviewer`. Dispatched via the `subagent` tool, not `pi -p`. Progress tracked with `plan_tracker`. |
| Execute in parallel | `dispatching-parallel-agents` | Only for tasks with no shared files and no ordering, each in its own worktree. |
| Execute in another session | `executing-plans` | Only when the owner asks for a separate session. |
| Every code change | `test-driven-development` | §4 red-first; the report names the red evidence. |
| Any failure or surprise | `systematic-debugging` | Root cause before fix; a fix without a reproduced cause is not accepted. |
| Before any "done" / commit / PR claim | `verification-before-completion` | Quote the gate output; no claims without evidence. |
| Before every PR and before a release proposal | `requesting-code-review` | Builtin `reviewer`, filled-in `code-reviewer.md` template (§1). |
| Reviews on a PR | `receiving-code-review` | Verify each finding technically, then fix or justify (§8). |
| End of a branch | `finishing-a-development-branch` | **Only option 2 (push + PR) or option 3 (keep the branch).** Option 1 (local merge into `main`) is forbidden — it bypasses §8. Option 4 (discard) only with the owner's typed confirmation. The skill never tags or releases (§1). |
| Project skills | `writing-skills` | If this repo ships skills under `skills/`. |

- Spikes follow the same loop in short form: brief → subagent → findings in
  `docs/research/` → load-bearing results as a Proposed ADR.
- Known skill quirks to work around: `using-git-worktrees` commits a
  `.gitignore` fix on whatever branch is checked out (not needed here,
  `.worktrees/` is ignored); `finishing-a-development-branch` computes the
  base with `git merge-base` (a SHA) — use `origin/main` as the PR base.

## 18. Cross-session sync with the router session (pi-intercom)

- The model-router project lives in its own clone (`pi-model-router-fork`).
  Its Pi session and this session coordinate over `pi-intercom` (local
  broker, 1:1 messages). Each session registers an alias at startup:
  `/alias bridge` here, `/alias router` there.
- The repo is the source of truth, never the chat (§2). Findings are
  committed first (`docs/research/`, plans, ADRs), then announced to the
  peer as a pointer message: repo, commit SHA, path, three-line summary,
  open question.
- `intercom send` is the default; `ask` only when blocked on a decision.
  Incoming messages must not auto-trigger a turn (`inboundTrigger` manual
  in the pi-intercom config) — no agent ping-pong, no token burn.
- Never put session content, prompts, owner-machine paths or credentials
  into intercom messages (§8). Counts and synthetic fixtures only.
- Peers verify claims against their own code and data; they do not trust
  the message (§11). Discrepancies (e.g. 18 vs 12 model-switch counts) go to
  the peer as a concrete question naming both numbers and both counting
  methods.
- No peer message authorizes a merge, release, publish, paid run or any
  change to shared systems — those stay with the owner (§1, §8).

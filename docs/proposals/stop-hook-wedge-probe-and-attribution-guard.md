# Reinstall agent Stop hooks on worktree reuse — wedge probe + attribution guard

## Goal

Remote pair-mode orchestration can enter an infinite **interrupt loop with zero
forward progress**: a coder agent's `*.stop.json` stays frozen at a prior phase
token, so its turn lifecycle never settles, so the runner re-dispatches it every
cycle, and each re-dispatch keystroke lands mid-work and interrupts the coder —
preventing its Stop hook from ever firing, which perpetuates the loop. This was
observed 2026-06-25 on minipc-wsl running OCANNL CUDA task-7d2ed931 (rounds 1→4
burned in ~4 minutes with nothing committed). It is currently why CUDA tasks are
paused.

This proposal makes the wedge **detectable and bounded** rather than silent and
infinite, and closes the latent stop-hook misattribution hole that can *cause*
the frozen record. Relates to gh-ludics-609, task-5f1333a3 (sibling, kept
independent — see Scope).

## Acceptance Criteria

1. **Resolution-order confirmation is documented and tested.** The proposal's
   investigation already confirmed (against `src/orchestration/index.ts`
   `orchOnStop`) that provider-based attribution (gh-597/598) runs *before* the
   marker-file and env-var (`LUDICS_AGENT_NAME`) fallbacks and sets `agentName`
   first — so the env var **cannot** override provider attribution for a
   *distinct-provider* pair. A test asserts this ordering: an `orchOnStop`
   invocation for a shared-worktree pair with `provider="claude-code"` and
   `LUDICS_AGENT_NAME=reviewer` in the environment writes **`coder.stop.json`**,
   not `reviewer.stop.json`. (This nails down the resolved-Q1 question and locks
   the behavior against regression.)

2. **Same-provider shared-worktree pairs no longer misattribute silently.** When
   a shared-worktree pair cannot be disambiguated by provider (both agents have
   the same provider — the acknowledged follow-up at `orchOnStop`'s
   `// Same-provider pairs remain ambiguous here` branch), the stop record must
   **not** silently fall through to marker/env last-writer-wins attribution
   (which routes both agents' stops to the same name and freezes the other's
   record). Either: this configuration is rejected at setup (AC 3), or the
   ambiguous fall-through refuses to write rather than mis-writing. A test covers
   a same-provider shared-worktree pair and asserts no cross-attributed record.

3. **Setup-time stop-attribution guard fails loud.** At slot start, before
   booting the agent CLIs, orchestration verifies that each participating agent's
   Stop record will be **unambiguously attributable** for its worktree+provider.
   In particular, a shared-worktree (pair) configuration whose agents cannot be
   provider-disambiguated is rejected via the existing setup-failure path (the
   `slot_setup_failed`-style throw that `createWorktrees` "project checkout not
   found" already rides), emitting a diagnostic event that names *which* check
   failed — never booting the agents into the silent interrupt loop. The guard
   branches on provider so a Codex-only worktree (no `.claude` Stop hook; uses
   `~/.codex/config.toml` `notify`) is not failed for a "missing claude Stop
   hook," and a distinct-provider pair (the standard claude-code coder + codex
   reviewer) passes.

4. **Runtime wedge probe detects the never-advancing stop record and HOLDS.**
   The runner detects an agent whose turn lifecycle stays `dispatched`/`running`
   while no stop record with the **current** `phaseToken` ever appears across
   **N ≥ 2** dispatch cycles (the stop record is absent or its `phaseToken` never
   advances to the current token). On confirmation it **stops re-dispatching that
   agent and HOLDS** — the slot is left attached for manual recovery, and a loud,
   health-check-visible warning is emitted naming the agent and the operator
   diagnostic (`ls -la .peer-sync/*.stop.json` → one agent's file frozen). It
   does **not** force-settle (which would advance the phase on no real work) and
   does **not** auto-abort (resolved Q2 = option C).

5. **The probe keys on stop-record / `phaseToken` staleness across dispatches —
   never wall-clock alone.** A legitimately long single turn (e.g. multi-minute
   `OCANNL_BACKEND=cuda dune runtest`) is dispatched once, has not been
   re-dispatched, and will fire its Stop when done — it must **not** trip the
   hold. A test exercises a long-running-but-healthy turn (single dispatch, no
   advancing-token re-dispatch) and asserts no hold; a companion test exercises
   K ≥ N re-dispatches with a never-current stop record and asserts the hold +
   warning fire.

6. **The global Stop hook stays silent and zero-cost outside Ludics work.** The
   user-flagged side-effect — the global `~/.claude/settings.json` Stop hook fires
   on **every** claude-code session stop, including non-Ludics work — is
   regression-locked: when `ludics-on-stop` resolves no peer-sync marker and the
   cwd is outside the harness directory, both the `orch on-stop` and `mag on-stop`
   paths no-op (exit 0, no output, no state mutation). A test asserts `mag
   on-stop` with a non-harness cwd returns without writing the stop-hook
   timestamp, popping the queue, or emitting a decision. (The `mag on-stop`
   handler already guards on `cwd.startsWith(harnessDir())`; this AC locks it.)

7. **No regression for the working paths.** Distinct-provider pair attribution,
   duo-mode (separate worktrees) attribution, single-turn settlement, and normal
   round advancement are unchanged. Existing orchestration lifecycle/attribution
   tests pass.

## Context

How the pieces fit today:

- **Stop-hook script** `templates/hooks/ludics-on-stop.sh` — the global,
  per-machine hook installed once by `installStopHook` (`src/init.ts`) into
  `~/.claude/settings.json` (`Stop → ~/.local/bin/ludics-on-stop`) and into
  Codex `notify`. It resolves the peer-sync dir (env `LUDICS_PEER_SYNC_DIR` →
  `.ludics-orchestration.json` marker walk-up), passes the invoking `provider`
  (`claude-code`/`codex`) as a 4th arg, and `exec`s `ludics orch on-stop`. Outside
  any Ludics worktree (no marker resolves), the claude path falls through to
  `ludics mag on-stop`.

- **Attribution** `orchOnStop` (`src/orchestration/index.ts`) resolves the agent
  in this order: (1) `worktrees.json` cwd match — one match wins; **>1 match
  (shared pair worktree) + invoking provider → filter by the per-agent
  `${name}-agent` provider marker**; (2) `.ludics-orchestration.json` marker file
  *only if still unresolved*; (3) env `LUDICS_AGENT_NAME` *only if still
  unresolved*; (4) single active status-file agent *only if still unresolved*.
  The explicit `// Same-provider pairs remain ambiguous here and fall through to
  the marker/env/status attribution below` comment marks the known hole. It then
  `writeStopHookRecord` with the current `phase` + `phaseToken`.

- **Per-worktree setup** `writeAgentMarkerFiles` (`src/orchestration/peer-sync.ts`)
  writes, per agent name, the `.ludics-orchestration.json` marker and a
  `.claude/settings.local.json` whose SessionStart hook injects
  `LUDICS_PEER_SYNC_DIR` / `LUDICS_AGENT_NAME`. In **pair mode both agents share
  one worktree**, so these are written twice to the same path and the **last
  writer (reviewer) wins** — the marker and `settings.local.json` end up carrying
  `LUDICS_AGENT_NAME=reviewer`. This is *harmless for distinct-provider pairs*
  (provider attribution resolves first, env is never consulted) but is exactly
  the last-writer-wins surface that misattributes a *same-provider* pair (AC 2).
  `initPeerSync` writes the per-name `${name}-agent` provider markers and the
  role-based `coder-agent`/`reviewer-agent` markers.

- **Lifecycle / loop** `dispatchPhase` mints a fresh `phaseToken` each phase and
  sets each agent's `turnLifecycle.state="dispatched"` (`AgentTurnLifecycle` in
  `src/orchestration/state.ts`, fields `phaseToken`, `state`, `lastStopHookAt`,
  the `settledNoSignal*` counters). `refreshAgentTransportState`
  (`transport-tmux.ts` / `transport-t3code.ts`) settles the lifecycle only when
  `readStopHookRecord(...).phaseToken === lc.phaseToken`. `isAgentDone`
  (`phases.ts`) returns `false` for `dispatched`/`running`, so a frozen stop
  record (old token) means the agent is never "done", `allAgentsDone` never
  trips, and the round never advances. `detectAgentInconsistencies`
  (`runner.ts`) emits the recurring `peer-sync says "<X>-done" but turn lifecycle
  is "running"` warning each tick — the natural signal to count for the probe.
  `detectAndNudgeSettledNoSignal` (`runner.ts`) escalates static-pane stalls
  (nudge → "Continue." → full re-dispatch via `composeSkillMessage` →
  `force-settle` via `interruptAgent` after `SETTLED_NO_SIGNAL_MAX_NUDGE_ATTEMPTS`)
  — the re-dispatch (nudge #3) is what interrupts the coder.

- **Mag no-op** `mag on-stop` (`src/mag.ts`) already early-returns when `cwd` is
  set and `!cwd.startsWith(harnessDir())` — the existing guard behind AC 6.

**Why the observed wedge is hook-FIRING, not attribution:** the wedged pair was
claude-code coder + codex reviewer (distinct providers), so provider attribution
*would* route the coder's stop to `coder.stop.json` correctly. The record stayed
frozen because the coder's Stop hook **never fired** — it was being interrupted
mid-turn by the re-dispatch keystrokes, so its turn never ended naturally. No
attribution scheme produces a record for a hook that never fires; only a runtime
probe (AC 4/5) catches it. The attribution work (AC 2/3) closes the *adjacent*
same-provider hole that produces the identical frozen-record symptom from a
different cause.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

- **AC 1/2 (attribution):** add tests around `orchOnStop` for the ordering
  guarantee and the same-provider ambiguity. For AC 2, prefer making the
  ambiguous shared-worktree, same-provider fall-through **refuse to write**
  (return without a record) rather than mis-write — combined with the AC 3 setup
  guard rejecting the config up front, so the refusal is a defense-in-depth net
  rather than the primary remedy.

- **AC 3 (setup guard):** add a `verifyStopHookAttribution()`-style helper called
  from the adapter slot-start sequence (alongside `writeAgentMarkerFiles`, in
  both `src/adapters/tmux-adapter.ts` and `src/adapters/t3code.ts`), throwing the
  existing setup-failure error with a machine-attributed diagnostic. Branch on
  provider so Codex-only and distinct-provider pairs pass.

- **AC 4/5 (runtime probe):** add per-agent wedge-tracking fields to
  `AgentTurnLifecycle` (e.g. a re-dispatch count and the last stop-record token
  observed), incremented where the phase re-dispatches an agent whose lifecycle
  is still unsettled. When the count crosses N (≥ 2) with no current-token stop
  record, set a hold state and stop re-dispatching that agent (gate the
  re-dispatch in `detectAndNudgeSettledNoSignal` and the phase dispatch on the
  hold flag), emitting an `orchestration_warning` (health-check-visible). Persist
  the new fields through `migrateState` (additive, default-safe — see the state
  migration test-triple convention). Reuse the existing
  `peer-sync says …-done but turn lifecycle is running` inconsistency as the
  counting signal; do **not** introduce a wall-clock threshold.

The HOLD is a new terminal-for-this-phase posture, not a lifecycle `error`/
`settled` — the slot stays attached and the runner stops nudging/redispatching
until an operator intervenes (consistent with resolved Q2 = C).

## Scope

**In scope:** setup-time stop-attribution guard, the same-provider ambiguity
refusal, the runtime stale-`phaseToken` wedge probe with HOLD response, and the
outside-Ludics no-op regression lock. Touches `src/orchestration/index.ts`,
`runner.ts`, `state.ts`, `peer-sync.ts`, the two adapters, `src/mag.ts` (test
only), and orchestration tests.

**Out of scope / explicitly NOT this task:**
- The `addWorktree` reuse rebase short-circuit (`src/orchestration/worktrees.ts`)
  — that is **task-5f1333a3**, kept as an independent PR (resolved Q3). The
  Context's original "reuse short-circuit skips hook install" premise is
  **refuted**: ludics never installs a per-worktree Stop hook (it's global), and
  `writeAgentMarkerFiles` runs unconditionally every setup, not gated by the
  reuse short-circuit. This task does not touch that short-circuit.
- Guarding *global* `~/.claude/settings.json` Stop-hook presence or a
  per-worktree `.claude/settings.json` override — resolved Q1 confirmed all three
  machines have the correct global hook and no per-worktree override clears it;
  neither is the trigger.
- Operational redeploy mechanics (`ludics init` + the minipc-wsl on-stop jq PATH
  patch) — those are deploy steps, not code changes here.

**Dependencies:** none blocking. Relates to gh-ludics-609 (stale-worker
mis-execution family) and task-5f1333a3 (sibling worktree-reuse fix).

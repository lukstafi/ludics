# Orchestration survives a tmux-server restart: detect & recover vanished sessions, and make `slot resume` rewrite `tmux-slot-N.json`

## Goal

When the tmux **server** dies (an opaque wedge, not a reboot/OOM/signal) while
the ludics daemons and orchestration runner processes survive, every
`sN_<role>_<task>` agent session vanishes at once — but the runners keep
driving the now-dead panes for hours, and the documented recovery
(`ludics slot N resume`) cannot rebuild the slot. Two distinct, independently
observable defects (both confirmed in a live `mac-studio` incident on
2026-06-06) are in scope:

1. **Runners spin blind into vanished sessions.** A runner whose tmux session
   no longer exists keeps dispatching prompts and `settled-no-signal` nudges
   into the void instead of detecting "my session disappeared" and recovering.
2. **`ludics slot N resume` cannot recover the slot.** `resume` recreates
   sessions/CLIs/ttyds but never writes `orchestration/tmux-slot-N.json` when
   that file is absent (exactly the post-tmux-server-restart state), so the
   runner it spawns trips its own sibling-state self-guard and exits with
   `sibling state missing after 5000ms grace — exiting` on every attempt.

The trigger (the wedged tmux server) is **out of fix scope** — but it is the
reason defect (1) cannot rely on any external signal: an opaque tmux-server
failure produces none, so "session vanished" must be a first-class, polled,
recoverable condition.

Issue: https://github.com/lukstafi/ludics/issues/559

## Acceptance Criteria

### Defect (B) — `resume` writes the sibling file unconditionally

1. After `ludics slot N resume` completes for a tmux-orchestrated slot whose
   `orchestration/tmux-slot-N.json` was **absent** at the start of resume
   (post-tmux-server-restart, or post-`stop` which calls
   `removeTmuxSlotState`), the file **exists** and its
   `orchestration.pid` equals the live runner pid that `resume` just spawned
   (the return value of `startOrchestrationProcess`).
2. The reconstructed `tmux-slot-N.json` carries the full `TmuxSlotState`
   shape: `slot`, `ttydPids` (the pids `resume` collected during its
   per-agent ttyd reconciliation), and
   `orchestration.{stateFile, mode, pid}` derived from the persisted
   `OrchestrationState` (`stateFile` from `stateFilePath`, `mode` from
   `orchState.mode`), mirroring the unconditional write in `start()` in
   `src/adapters/tmux-adapter.ts`.
3. When `tmux-slot-N.json` is already **present** at resume time, the existing
   behavior is preserved: the file is patched in place (ttyd pids updated, then
   `orchestration.pid` set to the new runner pid) — resume must not regress the
   present-file path or discard fields it does not manage (e.g.
   `ttydRestartCounts`).
4. A regression test asserts (B): with `startOrchestrationProcess` spied to
   return a known pid and no pre-existing `tmux-slot-N.json`, after `slotResume`
   the file exists and `orchestration.pid` matches the spied pid. The existing
   `spyOn(orchProcess, "startOrchestrationProcess")` seam in
   `src/slots/index.test.ts` is the precedent.

### Defect (A) — vanished-session detection & recovery in the runner

5. The runner poll loop (`pollUntilDone` in `src/orchestration/runner.ts`)
   gains a **slot-level** vanished-session check that runs on each tick
   **before** `detectAndNudgeSettledNoSignal` and `detectAndNudgeHungAgents`,
   so a vanished session is never misclassified as settled-no-signal. The
   check applies only when `state.backend === "tmux"`.
6. Detection is **slot-scoped**: if **any** participating agent's tmux session
   is missing (`!tmuxHasSession(tmuxSessionName(slot, agent.name, taskId))`),
   the whole slot is treated as vanished. (Per the precipitating incident, the
   tmux server takes every session at once; a single slot-scoped recovery
   avoids racing per-agent recoveries.) A dead **agent CLI inside a live
   session** is NOT a vanished session — that case stays with the existing
   `isAgentAlive`/`sendTurn` reboot path.
7. On detection, the runner **recreates all sessions for the slot** via the
   adapter boot path (`startTmuxAgentSessionsForOrchestratedSlot`, which kills
   any stale session, recreates the session, restarts ttyd, and boots the
   agent CLI fresh per agent), and **rewrites `tmux-slot-N.json`** with the new
   ttyd pids (and the runner's own pid as `orchestration.pid`) so the slot
   stays trackable by `stop`/`clear`.
8. **Orderly resume, not restart.** After recreation the orchestration loop
   continues from its **persisted phase/turn** — it must NOT replay the
   conversation from the top or re-send prompts/turns it has already sent. The
   recreated agent CLI is re-prompted only for the current phase, the same way
   `resume`'s reboot path behaves. (In-pane scrollback is lost on recreation —
   accepted, identical to `resume`.)
9. **Bounded retry then escalate.** Recreation is attempted at most a small,
   env-tunable number of times (default **2**, in the
   `LUDICS_RUNNER_STARTUP_GRACE_MS` style — e.g.
   `LUDICS_RUNNER_VANISHED_RETRY_MAX`), with backoff between attempts. If after
   the budget is exhausted a participating session still cannot be
   re-established (e.g. the tmux server is wedged present-but-unresponsive and
   recreation keeps failing), the runner **escalates** via the
   `handleEscalation` notify mechanism (priority-5 `ludics notify outgoing` +
   slot liveness flip) and **halts** — it does not nudge a corpse and does not
   retry forever.
10. A structured event is emitted on recovery (a recreation attempt and/or a
    successful recovery), following the existing orchestration event
    conventions (cf. `ttyd_restarted`, `orchestration_lock_reclaimed`,
    `escalation_requested`), so the dashboard and event log record the
    recovery. The escalation path reuses the `escalation_requested` /
    `notifyOutgoing` machinery rather than inventing a parallel notify.
11. Recovery does not spawn duplicate ttyds: recreation reuses the same
    port-allocation discipline as the existing boot/resume paths (one ttyd per
    agent per role port).
12. Tests cover (A): (a) a vanished session (mocked `tmuxHasSession` → false
    for a participating agent) triggers a single slot-scoped recreate; (b) a
    live session with a dead CLI does NOT trigger the vanished-session path;
    (c) exhausting the retry budget escalates (asserts `notifyOutgoing`
    priority-5 + halt) rather than looping; (d) the vanished check runs before
    the settled-no-signal detector (so a vanished session is not nudged as
    settled).

### General

13. Existing orchestration and slot tests continue to pass; `bun test` is green.
    If the runner gains a new persisted/config field, it ships with the
    state-migration test triple (positive backfill + negative control + JSON
    round-trip) per the `lint:state-migration` guard. *(A plain env-var knob
    with no persisted-state shape change does not require a migrator.)*

## Context

How things work now, by symbol (line numbers omitted — they drift):

**Defect (B): `slotResume` in `src/slots/index.ts`.** The tmux branch reconciles
sessions/ttyds, accumulating `newTtydPids`, then writes them only inside
`if (tmuxState) { writeTmuxSlotState({ ...tmuxState, ttydPids: newTtydPids }, ...) }`.
Later, after `const newPid = await startOrchestrationProcess(...)`, the tmux
branch again guards the pid write: `const tmuxState = readTmuxSlotState(...);
if (tmuxState) { writeTmuxSlotState({ ...tmuxState, orchestration: {
...tmuxState.orchestration!, pid: newPid } }, ...) }`. When
`tmux-slot-N.json` is absent, `readTmuxSlotState` returns `null`, both `if`
blocks are skipped, and **no sibling file is ever written** — the runner then
spawns, finds no sibling, and exits on the 5000ms startup grace. The t3code
branch in the same function is the contrast: it **throws**
(`persisted t3code state has no orchestration record`) rather than failing open.

The canonical correct write is `start()` in `src/adapters/tmux-adapter.ts`:
after `const pid = await startOrchestrationProcess(...)` it does an
**unconditional** `writeTmuxSlotState({ slot, ttydPids, orchestration: {
stateFile: stateFilePath(slot, harnessDir), mode: orchestration.mode, pid }
})`. The fix for (B) is to make `resume` perform the same unconditional
post-`startOrchestrationProcess` bookkeeping, reconstructing the full
`TmuxSlotState` from `orchState` + the `newTtydPids` it just collected when the
file is absent, while preserving the in-place patch when the file is present.

- `TmuxSlotState` shape, `readTmuxSlotState`, `writeTmuxSlotState`,
  `removeTmuxSlotState`, `stateFilePath` — `src/adapters/tmux-adapter.ts`
  (and `stateFilePath` re-exported from `src/orchestration/state.ts`).
- The runner self-guard that exits on a missing sibling is the
  `while (state.phase !== "done")` block in `runOrchestration`
  (`src/orchestration/runner.ts`) — it logs `sibling state missing after
  ${startupGraceMs}ms grace — exiting`. A *dead-pid* lock is auto-reclaimed
  (gh-ludics-509); a *missing file* is fail-closed by design, so the (B) fix
  belongs in `resume`, not the guard.

**Defect (A): the poll loop in `pollUntilDone` (`src/orchestration/runner.ts`).**
It already has a per-tick "ensure infrastructure healthy" hook,
`await ensureTtydAlive(state)`, sitting alongside
`detectAndNudgeSettledNoSignal` and `detectAndNudgeHungAgents`. A
session-existence guard is the natural sibling of `ensureTtydAlive`, and must
run **before** the settled/hung detectors.

Why a dead session reads as "settled": `TmuxTransport.refreshAgentTransportState`
(`src/orchestration/transport-tmux.ts`) calls `tmuxCapture(target, 50)`; on a
missing session `tmuxCapture` returns `null` (see `tmuxCapture` in
`src/adapters/tmux.ts` — non-zero `has-session`/`capture-pane` exit → null),
so `lastPaneHash`/`lastPaneChangeAt` stop advancing, the pane looks static, and
`detectAndNudgeSettledNoSignal` fires `orchestration_settled_no_signal_nudge_sent`
forever while `sendTurn` pastes into a dead target.

Recovery primitives, all in `src/adapters/tmux-adapter.ts`:
- `tmuxHasSession(name)` (in `src/adapters/tmux.ts`) — exit 0 = exists; the
  detection predicate. Session name via `tmuxSessionName(slot, agentName,
  taskId)`.
- `startTmuxAgentSessionsForOrchestratedSlot(slot, agents, peerSyncDir,
  taskId, startTtydEnabled, orchCfg)` — the slot-scoped recreate primitive:
  for each agent it calls `createTmuxAgentSession` (kills any stale session,
  recreates it), `startTtyd`, and `bootAgentCli`, returning the new
  `ttydPids` record. This is exactly the slot-level boot the recovery needs;
  it is what `start()` calls.
- `agentPortRole`, `startTtyd`, `writeTmuxSlotState` — already imported into
  the runner (`src/orchestration/runner.ts` top imports).

Escalation precedent: `handleEscalation` in `src/orchestration/runner.ts`
fires a priority-5 `notifyOutgoing(message, 5, title)` + flips slot liveness
(`setSlotLivenessOnData(data, "escalated")`) + persists state. `notifyOutgoing`
is already imported. The (A) give-up path should reuse this machinery.

`OrchestrationState` (`src/orchestration/state.ts`) carries everything
recovery needs without reconstruction: `slot`, `taskId`, `agents`
(`AgentConfig[]` with `name`/`worktreePath`/`role`), `peerSyncDir`, `mode`,
`backend`, and `harnessDir`. The agents array is the same shape
`startTmuxAgentSessionsForOrchestratedSlot` consumes.

Persisted-turn tracking for AC8: each agent's `agentStates[name].turnLifecycle`
records dispatch/settle state; the loop already advances from
`state.phase`/`state.round` rather than replaying. Recreation must reset only
the in-pane CLI (re-boot + re-prompt for the *current* phase, as `resume` does
by setting `turnLifecycle = null` and `phaseDispatched = false` before
`startOrchestrationProcess`) — it must not rewind `state.phase` or re-send
prior phases' turns.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

Per the memory note on duo-vs-pair for shared refactors, (A) and (B) share the
"recreate slot sessions + rewrite `tmux-slot-N.json`" surface, so this is a
**pair** task (thin open surfaces atop a shared helper), not duo.

- **(B), small and self-contained:** make `resume`'s post-`startOrchestrationProcess`
  tmux write unconditional. When `tmux-slot-N.json` is absent, reconstruct the
  full `TmuxSlotState` (`slot`, `ttydPids: newTtydPids`, `orchestration: {
  stateFile: stateFilePath(slotNum, ctx.harnessDir), mode: orchState.mode, pid:
  newPid }}`), mirroring `start()`; when present, keep the existing in-place
  patch so fields like `ttydRestartCounts` survive. The earlier ttyd-pids write
  in the same function should likewise not silently no-op when the file is
  absent (fold it into the single unconditional write, or write a minimal file
  first).
- **(A):** add a `detectAndRecoverVanishedSession(state, transport)` (or
  similarly named) helper next to `ensureTtydAlive`, called in `pollUntilDone`
  before the settled/hung detectors. It: (1) returns early unless
  `state.backend === "tmux"`; (2) checks `tmuxHasSession` for each
  participating agent and treats the slot as vanished if any is missing; (3)
  on vanish, calls `startTmuxAgentSessionsForOrchestratedSlot` for the slot,
  rewrites `tmux-slot-N.json` with the new ttyd pids + own pid, emits a
  recovery event, and lets the loop carry on from `state.phase`; (4) tracks a
  per-incident retry counter against the env-tunable budget (default 2) and,
  on exhaustion, escalates via the `handleEscalation` path and signals the
  loop to halt (mirror the existing `checkEscalationHalt`/`return` pattern so
  no further phase-advance work runs).

Factor the shared "recreate sessions for this slot + rewrite sibling file"
logic so both `resume` and the runner recovery call it, rather than duplicating
the boot+write sequence.

## Scope

**In scope:**
- (B) unconditional sibling-file write in `slotResume` (`src/slots/index.ts`),
  reconstructing `TmuxSlotState` when absent; regression test.
- (A) slot-level vanished-session detection + bounded-retry recreate +
  escalate-on-give-up in the runner (`src/orchestration/runner.ts`), reusing
  `startTmuxAgentSessionsForOrchestratedSlot` and the `handleEscalation`/
  `notifyOutgoing` machinery; tests.
- An env-tunable retry-budget knob (default 2).

**Out of scope:**
- The trigger itself — the wedged tmux server / suspected `getpwuid` spin /
  ttyd reconnect-storm root cause. The fix makes "session vanished" a
  recoverable runtime condition regardless of why the server died.
- The runner self-guard's missing-file fail-closed behavior — that is correct;
  the fix is to ensure `resume` writes the file (B).
- gh-ludics-509 (stale sibling-PID lock auto-reclaim) — already `done` and
  distinct; this task does not touch the dead-pid reclaim branch beyond
  coexisting with it.

**Dependencies:** none open. Distinct from gh-ludics-509 (done); no other task
overlaps.

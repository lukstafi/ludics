# Worker orchestration runner: cgroup-escape so the detached runner outlives the keepalive

## Goal

On a federation **worker** (minipc-wsl, Linux), a remote `--pair` tmux
orchestration never advances past `phase: setup`. The worker keepalive
(`ludics-mag.service`, a `Type=oneshot` systemd unit fired every ~2 min by
`ludics-mag.timer`) detects the orchestrator dead every tick and auto-resumes
it; each resume spawns a fresh runner that logs `starting …` +
`reclaiming stale lock from dead pid <prev>`, then **dies silently** (no stack,
no error in its log) and is re-detected dead on the next tick. Result: a
2-min-forever resume loop, pid churning, phase never leaving `setup`.

Source issue: https://github.com/lukstafi/ludics/issues/584

### Confirmed root cause

The runner is **not crashing — it is being killed**. `startOrchestrationProcess`
(`src/orchestration/process.ts`) spawns the runner `setsid`-detached:

```ts
Bun.spawn(setsidWrap(ludicsSelfCommand(["orch", "run-internal", String(slot)])), {
  stdin: "ignore", stdout: "ignore", stderr: logFd,
  env: { ...process.env, LUDICS_HARNESS_DIR: harnessDir },
});
```

`setsid` escapes the controlling tty but **not the systemd cgroup**. The
worker keepalive is a `Type=oneshot` unit (`Consumed 1.9s`), and systemd's
default `KillMode=control-group` reaps the *entire* cgroup — including the
detached, `unref()`'d runner — the moment the oneshot's main process exits.
On the **controller** (mac-studio, launchd long-running keepalive, no systemd
cgroup) the identical runner survives → the bug is worker-systemd-specific.

The silence in the runner's own log is consistent: an *external* SIGTERM from
systemd leaves no `uncaughtException` stack, no `process.exit(1)` — the runner
reclaims the lock, then is killed mid-flight. The full root-cause analysis is
posted as a comment on issue #584.

This is the **third and final-known layer** of the remote-orchestration bug
series. Siblings #579 (controller-local path shipped to worker — done, PR #583)
and #580 (resume reads stale worker-local harness — done, PR #581) are fixed
and deployed. This issue is a *consequence of #580 working*: auto-resume now
**succeeds**, but the runner it spawns can't persist → success + dying-runner =
a tight resume loop instead of the old one-shot refusal. **#580's auto-resume
is correct; this fixes the runner-lifetime layer beneath it.**

This blocks `task-66a3bbff` (cudajit byte-offset) and the whole CUDA chain,
since minipc-wsl is the federation's only CUDA host. The fix itself is ludics
framework code, buildable and testable on mac-studio.

## Acceptance Criteria

1. **The detached runner survives the worker keepalive oneshot exit.** The
   `setsid`-detached runner is **not** reaped when `ludics-mag.service`
   finishes, so an orchestration started or resumed by the worker keepalive
   keeps running and advances past `setup` (operator-verified live on
   minipc-wsl; see AC 7). On Linux this is delivered by the generated unit's
   `KillMode=process` (AC 2), which kills only the keepalive's main process on
   oneshot exit and leaves the detached descendant alive.

2. **The cgroup escape is delivered by the generated systemd unit; the TS spawn
   path keeps the pid-preserving `setsid` wrapper.** *(Design note — supersedes
   the original Q2 "both layers" plan, per PR #586 review.)* The original plan
   also wrapped the runner in `systemd-run --user --scope` in
   `src/orchestration/process.ts`. That mechanism is **incompatible** with the
   runner's pid-based sibling self-guard: `systemd-run --scope` runs the command
   under a long-lived supervisor, so `Bun.spawn`'s pid is the **wrapper**, not
   the runner. `slotResume` persists that wrapper pid as the sibling
   orchestration pid, and the runner's self-guard (`src/orchestration/runner.ts`)
   then exits on the live-pid mismatch (`recordedPid !== process.pid` with a
   *live* `recordedPid`; the gh-509 reclaim only triggers for a *dead* recorded
   pid). A transient scope's `MainPID` is not reliably queryable to recover the
   real runner pid, so the TS-layer cgroup escape is **dropped** in favor of:
   - **Generated systemd unit** (`src/triggers.ts`, the `mag` keepalive unit):
     `KillMode=process` so a detached descendant is not reaped on oneshot exit.
     This is the load-bearing fix (the proposal's own Approach §2 already noted
     `KillMode=process` "protects *any* keepalive descendant from cgroup reaping
     … [when] the fallback `setsid` path is taken").
   - **TS spawn path** (`src/orchestration/process.ts`): retains the existing
     `setsid`/perl wrapper, which `exec`s the runner in place so `proc.pid` is
     the runner's real pid (required by the self-guard and liveness checks), and
     additionally captures stdout (AC 6).

3. **Controller / standalone behavior is unchanged.** macOS (launchd) keepalive,
   the long-lived controller `mag start`, and standalone runs spawn the runner
   exactly as before (`setsid`/perl, unchanged). `KillMode=process` is added
   only to the Linux-generated `mag` unit, so non-Linux nodes are untouched by
   construction.

4. **Resume-loop circuit-breaker with escalation** (Q3 → yes, in this task):
   `maybeResumeDeadOrchestrators` (`src/mag.ts`) detects when a slot has been
   resumed across **N consecutive ticks while remaining in the same phase with
   no advance**, and on the Nth such tick **stops re-spawning** and **escalates
   a priority notification** (and a structured event) instead of looping
   forever. A slot that legitimately advances phase between ticks resets the
   counter and is never throttled.

5. **No-regression on the existing resume machinery.** The circuit-breaker and
   spawn change must not regress: the #559 defect-B sibling-state write, the
   #580 controller-live `freshSlots` override, the #509 dead-pid lock reclaim,
   or the existing `interrupted`/`escalated` liveness skips. The 1-resume-per-
   invocation rate limit is preserved.

6. **Runner stdout is captured** (cheap visibility bonus, not gating):
   `startOrchestrationProcess` no longer discards the runner's stdout — it is
   redirected to the same per-slot log fd (merged with stderr) so future
   silent-death diagnosis doesn't require guessing which sink was used.

7. **The cgroup behavior is operator-verified live** on the Linux worker
   (minipc-wsl): after re-init regenerates the `KillMode=process` unit, a remote
   `--pair` orchestration started from the controller advances past `setup` and
   the runner pid is stable across keepalive ticks. The proposal calls this out
   explicitly as an operator step — the in-repo tests assert the falsifiable
   *proxies* (`KillMode=process` unit body + circuit-breaker + stdout capture),
   since the cgroup reaping itself can only be reproduced under systemd.

## Context

### Where the runner is spawned (the load-bearing fix site)

`startOrchestrationProcess(slot, harnessDir, taskId)` in
`src/orchestration/process.ts` is the **single** detached-spawn site, shared by
fresh `start` and `slotResume`. It currently wraps the command in `setsidWrap`
(`src/orchestration/util.ts`) and spawns with `stdout: "ignore"`,
`stderr: logFd`. The command itself is built by `ludicsSelfCommand` — on the
worker, ludics runs as the compiled self-contained binary, so the re-spawn is
`[process.execPath, "orch", "run-internal", N]` (no `bun` on PATH required;
verified not the bug).

### Where the worker's `ludics-mag.service` is generated

`src/triggers.ts`, `installSimpleTriggers()`, the **Mag keepalive** block
(around line 457). The non-darwin branch writes:

```
[Service]
Type=oneshot
ExecStart=${bin} mag start
```

with a companion `ludics-mag.timer` (`OnUnitActiveSec=<keepalive_interval>s`).
This is the unit whose `KillMode=control-group` default reaps the runner. The
unit body is the string passed as `systemdServiceBody` to
`installSimpleTrigger`; `writeSystemdUnit` writes it verbatim under
`~/.config/systemd/user/`.

### Who actually runs `maybeResumeDeadOrchestrators` on a worker

`workerKeepalive()` (`src/mag.ts`, ~line 3619) runs in a **fresh oneshot
process every tick** and calls `maybeResumeDeadOrchestrators(freshSlots)`
directly (controller-live slots over HTTP, per #580). The controller path
(`magStart` keepalive, ~line 3759) calls it with no args. **Implication for
the circuit-breaker:** because the worker keepalive is a separate process each
tick, an in-memory counter resets every tick and is useless — the
no-progress counter **must persist on disk**. The natural home is the per-slot
orchestration state read each tick via `readOrchestrationState(slotNum)` (e.g.
new optional fields tracking the last-resumed phase and the consecutive
no-advance resume count), or an equivalent per-slot sidecar; the implementer
chooses, but the persisted shape ships with a migration test triple per the
state-migration convention (positive backfill + negative control + JSON
round-trip).

### Existing escalation conventions to reuse (don't invent)

- **Liveness marker:** `SlotLiveness = "alive" | "interrupted" | "escalated" |
  null` (`src/slots/types.ts`). `markSlotSetupFailed` (`src/slots/index.ts`)
  is the model for "mark slot, reset task status, emit event": it sets liveness
  via `setSlotLivenessOnData`, clears `sessionStarted`, emits a structured
  event, and journals. The keepalive auto-loops (`maybeAutoStartSlots`,
  `maybeUnstickAssignedSlots`) already **skip** slots whose liveness is
  `interrupted` or `escalated` — so marking the wedged slot `escalated` is the
  established way to stop Mag from silently re-touching it; only an explicit
  `ludics slot N resume` clears it.
- **Priority notification:** `notifyOutgoing(message, priority, title)`
  (`src/notify.ts`) is the user-facing push (priority is the ntfy 1–5 scale).
- **Structured event + worker HTTP forward:** `emitEvent` (`src/events.ts`) —
  on a worker this **forwards over HTTP to the controller** (`clusterPostEvent`)
  rather than writing local `journal/events.jsonl`. This matters for testing
  (see below): on a worker the event does not land in the local journal.

### What `setup` is (rules out a setup-logic bug)

`setup` is a no-op dispatch phase: `enterPhase` sets `phaseDispatched` and
returns; `participatesInPhase`/`agentParticipatesInPhase` return false for
`setup` (`src/orchestration/phases.ts`). No agent is prompted. So the death is
not a setup code path failing — it's the runner process not living long enough
to fall through to `evaluateTransition` → `nextAfterPrework` (which would move
`setup → gather/plan`). Consistent with external SIGTERM.

## Approach

The user resolved the design (task #584 Questions, 2026-06-22): implement the
cgroup-escape fix directly (no logging-first round), in **both** the unit and
the TS spawn path, plus a circuit-breaker with escalation, plus the stdout
capture. The skeleton below is straightforward; the agents own the details.

### 1. TS spawn path — Linux cgroup-escape branch (`src/orchestration/process.ts`)

> **⚠️ Superseded by AC 2 (PR #586 review).** This `systemd-run --scope`
> approach was found incompatible with the runner's pid-based sibling
> self-guard (the wrapper pid would be persisted and the runner would exit on
> the live-pid mismatch). The cgroup escape is delivered solely by the unit's
> `KillMode=process` (§2); the TS spawn path keeps the pid-preserving `setsid`
> wrapper and only adds stdout capture (§4). The original sketch is retained
> below for the analysis trail.

Move the runner into its own transient scope so it leaves the keepalive's
cgroup. The cleanest mechanism is `systemd-run --user --scope --collect`:

```
systemd-run --user --scope --collect <ludicsSelfCommand...>
```

`--scope` runs the command in a transient *scope* unit (its own cgroup, not a
child of `ludics-mag.service`); `--collect` garbage-collects the scope when the
runner exits. This survives the oneshot keepalive exit. Detect availability at
runtime: Linux **and** `Bun.which("systemd-run")` resolves **and** a user
systemd instance is present (a `systemd-run --user` smoke is acceptable, or
gate on `$XDG_RUNTIME_DIR`/`DBUS_SESSION_BUS_ADDRESS`). When unavailable, fall
back to the current `setsidWrap` path. Mirror the existing `setsidWrap` seam
design: factor a small pure helper (e.g.
`runnerLaunchCommand(command, { platform, systemdRunPath, hasUserSystemd })`)
that returns the final argv, defaulting its inputs from the environment but
accepting explicit overrides so tests can drive each branch without touching
the real OS — exactly how `setsidWrap(cmd, resolvedSetsid?)` is already tested
in `util.test.ts`. macOS keeps the `setsid`/perl wrapper untouched.

> Note: the runner is launched as a transient scope, **not** a transient
> service — a scope is created by the *calling* process and the runner is its
> own main process, which keeps `Bun.spawn`'s pid/exit semantics (the 500ms
> immediate-exit check in `startOrchestrationProcess` still works). Confirm the
> pid returned is the runner's, not a wrapper's, when validating live.

### 2. Generated unit hardening (`src/triggers.ts`)

In the `mag` keepalive `systemdServiceBody`, add a `KillMode` that does not
reap descendants on oneshot exit — `KillMode=process` (kill only the main
process, leave the scope/children) is the simplest. With layer (1) already
moving the runner into its own scope, this is belt-and-suspenders: it protects
*any* keepalive descendant from cgroup reaping even if `systemd-run` is
unavailable and the fallback `setsid` path is taken. Keep the change minimal
and scoped to the `mag` unit body (other oneshot units — health, morning,
watch triggers — intentionally have no long-lived descendants and are left
alone). `ludics init` regenerates the unit; the worker re-inits to pick it up
(call out as an operator step).

### 3. Circuit-breaker with escalation (`src/mag.ts`,
`maybeResumeDeadOrchestrators`)

Before resuming a dead orchestrator, consult persisted per-slot no-progress
state (see Context — must survive across oneshot ticks):

- Compare the slot's current `(taskId, phase)` against the last-resumed
  `(taskId, phase)`. If unchanged, increment a consecutive-no-advance counter;
  if the phase advanced (or task changed), reset to 0 and record the new phase.
- If the counter reaches a threshold **N** (suggest N = 3, i.e. ~6 min of
  pure no-progress at a 2-min cadence — pick a constant; expose as a named
  const, not a magic number), **do not resume**. Instead:
  - mark the slot `escalated` (reusing the `setSlotLivenessOnData` /
    `markSlotSetupFailed`-style pattern so the other auto-loops stop touching
    it and only `ludics slot N resume` clears it),
  - `notifyOutgoing(...)` a priority notification naming slot, task, phase, and
    the dead-runner symptom, and
  - `emitEvent({ event_type: "orchestration_resume_circuit_break", ... })`.
- The threshold key is **"same phase + no advance"**, never merely "resumed
  again" — a genuinely recovering slot that advances phase between ticks must
  never be throttled (edge case from the task).

Record/update the no-progress state on the resume path (and reset it when the
slot clears or the phase advances) so the counter reflects reality.

### 4. stdout capture (`src/orchestration/process.ts`)

Redirect the runner's stdout to the same `logFd` (or merge stdout into stderr)
so `console.log`/child-stdout is no longer discarded. Trivial; closes the
visibility gap that made this hard to diagnose.

### Tests

Build/verify: `bun run build` then `bun test` in `~/ludics`.

1. ~~**Per-OS spawn shape** (`runnerLaunchCommand`)~~ — **superseded (AC 2):** the
   `systemd-run` branch was dropped, so there is no per-OS spawn-shape helper.
   The falsifiable proxy for "the runner escapes the parent cgroup" is instead
   the **`KillMode=process` unit-body test** (`src/triggers.test.ts`): the
   generated `mag` `systemdServiceBody` contains `KillMode=process`, and no
   other oneshot body does (scope negative-control). The stdout-capture test
   (`src/orchestration/process.test.ts`) additionally asserts the runner's real
   pid is returned and stdout/stderr share the per-slot log fd.

2. **Circuit-breaker** (extend `src/mag.test.ts`): seed a slot with a dead
   orchestrator pid and persisted no-progress state at the threshold; assert
   `maybeResumeDeadOrchestrators` **does not** call `slotResume`, marks the
   slot `escalated`, and emits the escalation. **Test via the console/event
   seam, not `journal/events.jsonl`** — on a worker `emitEvent` forwards over
   HTTP, so intercept `console.error`/the notify call/the `clusterPostEvent`
   POST rather than asserting on the local journal (per #580's lesson). Also
   assert the positive control: a slot that advanced phase between ticks resets
   the counter and **is** resumed (counter never trips for legitimate recovery).

3. **stdout capture**: assert `startOrchestrationProcess` no longer passes
   `stdout: "ignore"` — stdout is directed to the per-slot log fd (mock/seam
   the spawn and inspect the stdio options).

4. **State-migration triple** for any new persisted no-progress fields:
   positive backfill (old state without the fields parses + defaults), negative
   control, and a JSON round-trip (the `lint:state-migration` convention).

### Operator steps (live, cannot be unit-tested)

- Re-init the worker (`bun run build` on the node or sync the binary, then
  `ludics init --no-triggers` as appropriate, plus a triggers refresh so the
  hardened `ludics-mag.service` is regenerated and reloaded).
- Launch a remote `--pair` orchestration onto minipc-wsl and confirm the runner
  pid is **stable across keepalive ticks** and the phase advances past `setup`.

## Scope

In: cgroup-escape (TS spawn path + generated `ludics-mag.service`),
resume-loop circuit-breaker with escalation, runner stdout capture, the tests
above. Out: any broader orchestration redesign, changes to other oneshot units,
the t3code transport, or the #559/#580/#509 mechanisms beyond not regressing
them.

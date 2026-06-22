# test-health: capability-gated suite runs with routed remote execution

## Goal

The test-health pre-hook (`runAllTestHealth` → `checkProjectTestHealth`) runs each
project's `test_command` on whatever machine Mag's keepalive is on — currently the
always-on leader **mac-studio** (`gpu: apple-silicon`, `os: macos`). It does **not**
consult the project's declared `requirements`. A project that structurally cannot
build on the current host (e.g. **ocaml-cudajit**, `requirements: { gpu: nvidia }`)
runs anyway, fails to even compile, is flagged red, and auto-files a "Fix broken test
suite" task that is a pure false positive — concretely `task-3124de24`, which this task
`blocks`.

Make test-health **capability-aware**:

1. **Gate** each suite on whether the current host satisfies the project's
   `requirements` (mirroring `selectMachineForSlot`'s per-key exact-equality matching).
2. When the current host can't satisfy the requirements but a cluster worker can,
   **route** the suite to a capable worker rather than running it locally and flagging
   red.
3. When no capable worker is reachable — or the host's capabilities are unprovable —
   **skip** as `requirements-unmet` (visible skip line, no test run, **no failure task
   filed**) instead of running.

The absolute invariant across all paths: a suite that did not actually run, or ran on
an incapable/unreachable host for capability/connectivity reasons, must **never** file a
"Fix broken test suite" task.

Issue: https://github.com/lukstafi/ludics/issues/578

## Open Question (blocks the routing AC — needs a decision before implementation)

**The "ceiling" (routed remote execution) has no reusable primitive in ludics today,
and the one that fits the synchronous test-health caller does not yet exist.** This is a
genuine sizing fork, so it is surfaced rather than guessed.

ludics has **no SSH path and no "run command on machine X, collect stdout+exit"
primitive**. Verified: `ssh` appears in the source only as a comment in `cluster.ts` and
in a lint blocklist (`scripts/lint-template-safety.ts`); it is never spawned. All
cross-machine work goes through a **pure-pull, asynchronous intent model**:

- The controller records an intent (`start | stop | resume`, a hardcoded whitelist) for
  `slot N` on `machine M` (`ensureRemoteMachineReachable` in `src/slots/index.ts`).
- The worker's *own* keepalive polls `GET /api/cluster/intents`, executes the slot op
  **locally**, reports back via `POST /cluster/signal`, and deletes the intent
  (`processSlotIntents` in `src/mag.ts`).
- The cluster HTTP surface (`handleClusterRequest` in `src/cluster-http.ts`) is
  state-sync only — heartbeat, signal, journal, events, orchestration-state, task/slot
  updates, intents. **No endpoint accepts an arbitrary command or returns its
  stdout/exit code.**

`checkProjectTestHealth`, by contrast, is **synchronous** and runs inside the
controller's keepalive tick (`safeSyncOutput([...], { timeout: 300_000 })`), returning a
pass/fail to the batch loop immediately. There is no architecture-shaped way to "route
the suite to minipc-wsl and get the result back in this same synchronous call" without
new machinery. The two candidate shapes differ enough in size and risk that the user
should pick:

- **Option A — new SSH exec primitive (synchronous).** Add a `runRemoteCommand(machine,
  cmd, { timeout })` helper (a thin `safeSyncOutput(["ssh", host, ...])` wrapper, reusing
  `ClusterMachine.host` + the existing passwordless-SSH fabric documented for minipc-wsl).
  test-health calls it inline and gets stdout/exit synchronously, exactly like the local
  path. **Pros:** fits the current synchronous caller with no async/polling redesign;
  routing result is immediate; smallest behavioral surface. **Cons:** introduces the
  *first* SSH dependency into a codebase that deliberately avoided one (the intent model
  exists precisely to not require SSH from the controller); ties test-health's
  correctness to SSH reachability + remote env parity (e.g. `eval $(opam env)` resolving
  on the worker); needs its own timeout/error classification so an SSH/connectivity
  failure degrades to *skip*, never to a fix-task.

- **Option B — reuse the intent/signal model (asynchronous).** Add a `test-health`
  intent action; the controller records it for the capable worker, the worker runs the
  suite in its own keepalive and reports pass/fail via the signal channel; results land
  on a later controller tick (a `mag/test-health.json`-style remote-result store).
  **Pros:** no new SSH dependency; reuses the proven, auth'd HTTP fabric; consistent with
  how every other cross-machine action works. **Cons:** substantially larger — new intent
  action (breaking the hardcoded `start|stop|resume` whitelist + `parsePendingIntent`
  validation), new result-collection plumbing, and a redesign of test-health from
  "synchronous run-now" to "dispatch-and-reconcile-later"; the red/green verdict for a
  routed project becomes eventually-consistent across ticks rather than known within the
  call.

**Recommendation:** **Option A** for this task. It matches the synchronous caller, is by
far the smaller change, and the federation already provisions passwordless SSH to the
worker (minipc-wsl) for exactly this kind of remote build/test. Option B's
intent-whitelist break + async reconcile is a disproportionate redesign for a
nightly-cadence health probe whose only consumer is a skip/route/fail verdict. The ACs
below are written assuming Option A; if the user prefers B, AC4–AC6 (routing) change
shape and effort grows further.

A secondary decision rides on this: **how aggressively to attempt routing.** The
recommendation is to route only to an **online** (`heartbeatIsFresh`) eligible worker —
matching `selectMachineForSlot`'s AC10 "require a fresh-heartbeat machine for
requirement-gated work" — and to degrade to skip-not-fail when the only capable worker is
offline. (A nightly probe should not block on waking an offline box.)

## Acceptance Criteria

1. **Capability predicate.** A new exported helper in `src/health.ts` (e.g.
   `requirementsSatisfiedByCurrentHost(project)`) evaluates `project.requirements`
   against `clusterCurrentMachine()` using **exactly** `selectMachineForSlot`'s
   semantics: for each *present* requirement key (`os`, `gpu`), the current machine
   satisfies it iff `currentMachine[key] === reqs[key]` (exact string equality, per key,
   only when the key is present). A project with no `requirements` (or an empty
   requirements object) is always satisfied. The helper returns a discriminated result
   distinguishing *satisfied* / *unmet-but-host-known* / *host-unknown* (so the three
   callers below can branch without recomputing).

2. **Unknown-capability host skips (Q2 → b).** When `clusterEnabled()` is false, or
   `clusterCurrentMachine()` returns `undefined` (current host doesn't resolve to a
   `cluster.machines` entry), a project that **has** any `requirements` skips as
   `{ skipped: true, reason: "requirements-unmet" }` — capabilities are unprovable, so an
   unprovable requirement is treated as unsatisfied. A project with **no** requirements is
   unaffected and runs as today (this clause must not disable test-health for
   requirement-free projects on standalone hosts).

3. **Capability-met runs unchanged (positive path).** When the current host satisfies all
   present requirements, `checkProjectTestHealth` proceeds exactly as today (path
   resolution → command detection → rate-limit gate → run → pass/fail → fix-task on real
   failure). Concretely, **ocaml-metal** (`gpu: apple-silicon`) on mac-studio
   (`gpu: apple-silicon`) runs with no behavior change.

4. **Routed remote execution (Q1 ceiling; Option A unless the open question is resolved
   to B).** When the current host does **not** satisfy a project's requirements but a
   cluster machine does, `checkProjectTestHealth` selects a capable worker and runs the
   suite there instead of locally:
   - Worker selection mirrors `selectMachineForSlot`'s filter (`m.os === reqs.os` and/or
     `m.gpu === reqs.gpu` for each present key) and routes **only** to a worker whose
     heartbeat is fresh (`heartbeatIsFresh`). Selection is capability-driven, never
     hardcoded per project.
   - A successful remote run (worker reachable, command completed) yields the same
     `{ skipped: false, passed, duration, failures }` result as a local run, updates
     `mag/test-health.json` for the project, and **files a fix-task only on a genuine
     non-zero test exit** — identical semantics to the local path.
   - The remote run carries the project's `test_command` and runs in the project's
     checkout on the worker; a per-run timeout no shorter than the local 300s applies.

5. **Routing degrades to skip-not-fail, never to a false positive.** If routing cannot
   complete for a **capability/connectivity** reason — no eligible worker exists in
   config, every eligible worker is offline (`heartbeatIsFresh` false), or the remote
   invocation fails to *establish/transport* (SSH/connection error, non-test failure) —
   `checkProjectTestHealth` returns `{ skipped: true, reason: "requirements-unmet" }`,
   does **not** mutate `mag/test-health.json`, and does **not** call `tasksCreate`. Only a
   remote run that actually executed the suite and observed a real non-zero test result
   files a fix-task.

6. **No false positive for ocaml-cudajit on mac-studio.** With the current cluster
   config, running test-health on mac-studio for **ocaml-cudajit**
   (`requirements: { gpu: nvidia }`) results in either a routed run on a reachable
   nvidia worker (minipc-wsl, when online) or a `requirements-unmet` skip (when no nvidia
   worker is online) — in **no** case does it run-and-fail locally or auto-file the
   false-positive fix-task. (This is what unblocks `task-3124de24`.)

7. **Precedence preserved.** The capability gate is evaluated **after** the existing
   `postponed` and `t3code-integration-paused` guards and **before** path resolution /
   command detection / execution. A `postponed` project stays `postponed` regardless of
   capability; a paused-t3code project stays `t3code-integration-paused`; these win over
   `requirements-unmet`. (E.g. **ocaml-hipjit** is both `postponed: true` and
   `requirements: { gpu: amd }` — it must report `postponed`, not `requirements-unmet`.)

8. **Batch-loop visible skip line.** `runAllTestHealth` surfaces a `requirements-unmet`
   skip through the existing `[test-health] <name>: skipped (<reason>)` line, reading
   exactly `[test-health] <name>: skipped (requirements-unmet)` so the monitoring surfaces
   that parse that format pick it up. (The skip may flow through the generic
   `if (result.skipped)` branch already in the loop; a dedicated pre-dispatch batch guard
   is **not** required — unlike postponed/t3code, capability evaluation is cheap and has
   no path-resolution cost to avoid. Implementer's choice, but the visible-line format is
   fixed.)

9. **Test coverage** (extend `src/health.test.ts`, controlling the current host via
   `LUDICS_CLUSTER_MACHINE_NAME` + a scratch `LUDICS_CONFIG` carrying `cluster.machines`,
   per the `cluster.test.ts` pattern; reuse the postponed/t3code tests' no-`tasksCreate` /
   no-state-mutation / `_runAllTestHealthDispatch` assertions). At minimum:
   - **Capability-met → runs** (current host's gpu matches the requirement → not skipped
     for `requirements-unmet`; falls through to the normal path).
   - **Capability-unmet, capable worker online → routes** (remote run injectable via a
     test seam so no real SSH/network is needed; assert a remote run occurred and that a
     real remote test failure *does* file a fix-task while a connectivity failure does
     *not*).
   - **Capability-unmet, no eligible/online worker → skips** `requirements-unmet`, no
     `tasksCreate`, no `mag/test-health.json` mutation.
   - **Unknown host** (`LUDICS_CLUSTER_MACHINE_NAME` set to a non-configured name, or
     cluster disabled) with a requirement-gated project → skips `requirements-unmet`;
     **and** a requirement-free project on the same unknown host → still runs (negative
     control for AC2).
   - **Precedence**: a `postponed` (or paused-t3code) project that is *also*
     requirement-gated reports the `postponed` / `t3code-integration-paused` reason, not
     `requirements-unmet`.
   - **No-false-positive guarantee**: across the skip/route-degrade paths, `tasksCreate`
     is never invoked (mirror the existing postponed-test observation approach).
   - The remote-exec helper (if Option A) gets its own unit test for the
     **skip-on-connectivity-failure** classification (a non-zero/timed-out *transport*
     result must map to skip, never to a fix-task).

## Context

### Current entry points (`src/health.ts`)

`checkProjectTestHealth(project, options?)` runs an ordered set of skip guards, each
returning `{ skipped: true, reason }` and short-circuiting before any work that depends
on the current host:

```
postponed → t3code-integration-paused → path-not-found → no-test-command → rate-limited
```

then runs the suite (`safeSyncOutput(["sh","-c", testCmd], { cwd, timeout: 300_000 })`)
and, on a non-zero result, calls
`tasksCreate("Fix broken test suite: " + project.name, project.name, "A")`. The new
**capability gate slots in right after `t3code-integration-paused`** (AC7 precedence) —
it neither resolves the project path nor runs anything, so it is cheap and host-only.

`runAllTestHealth(options?)` is the batch loop. It mirrors the `postponed` and
`t3code-integration-paused` guards as **pre-dispatch** short-circuits (they avoid even
path resolution, which has cost), then dispatches through the
`_runAllTestHealthDispatch.fn` seam and surfaces any returned skip via a generic
`if (result.skipped) console.error("[test-health] " + name + ": skipped (" + reason + ")")`
branch. A `requirements-unmet` skip can ride that generic branch (AC8) — the test seam
(`_runAllTestHealthDispatch`) and the `captureConsoleError` helper already exist for
asserting it.

### Matching semantics to mirror (`src/cluster.ts`)

`selectMachineForSlot(task)` is the canonical requirement matcher and the
worker-selection source (AC1, AC4):

```ts
let eligible = [...machines];
const reqs = task.requirements;
if (reqs) {
  if (reqs.os)  eligible = eligible.filter((m) => m.os  === reqs.os);
  if (reqs.gpu) eligible = eligible.filter((m) => m.gpu === reqs.gpu);
  if (eligible.length === 0) return null;          // nobody capable
}
const online = eligible.filter((m) => heartbeatIsFresh(m.name));
// AC10: requirement-gated tasks require an ONLINE eligible machine, else block.
```

The capability predicate (AC1) is the *current-host* projection of this: for each present
requirement key, `clusterCurrentMachine()[key] === reqs[key]`.
`clusterCurrentMachine()` resolves the current host (Tailscale DNS → hostname → name
match) and **honors `LUDICS_CLUSTER_MACHINE_NAME`** (the test seam used throughout
`cluster.test.ts`); it returns `undefined` when the cluster is disabled or the host
doesn't match a configured machine (AC2). `heartbeatIsFresh(name)` (15-min default TTL)
gates "online" for routing (AC4/AC5).

### Requirements live on the project (no task merge)

`src/config.ts`: `ProjectConfig.requirements?: { os?: string; gpu?: string }`, already
loaded. Test-health is **project-scoped — there is no task in scope** — so the effective
requirements are simply `project.requirements`; `mergeRequirements(task, project)` (the
per-key override merge in `mag.ts`) is **not** called here. The issue's "task-level
overrides project-level" note is about keeping *semantics* consistent with slot
assignment, not about a merge to perform in this code path.

### Live config data (current `config.yaml`)

Projects with requirements:
- **ocaml-cudajit** — `requirements.gpu: nvidia` (the false-positive driver).
- **ocaml-metal** — `requirements.gpu: apple-silicon` (positive path on mac-studio).
- **ocaml-hipjit** — `requirements.gpu: amd` **and** `postponed: true` (precedence
  fixture; already skipped as postponed).

Cluster machines (note the corrected capability data — the elaboration's tentative
design predates the latest `config.yaml`):

| name        | os    | gpu           | role   | always_on |
|-------------|-------|---------------|--------|-----------|
| mac-studio  | macos | apple-silicon | leader | true      |
| macbook-pro | macos | apple-silicon | console| false     |
| asus-amd-wsl| linux | amd           | worker | false     |
| minipc-wsl  | linux | nvidia        | worker | false     |

Implications worth encoding in tests: `os` values are `macos`/`linux` (not `darwin`);
**macbook-pro now declares `gpu: apple-silicon`** (it is *not* the empty-gpu machine the
elaboration assumed). The only nvidia host is **minipc-wsl**, and it is `always_on:
false` — so ocaml-cudajit routing depends on minipc-wsl being online (else AC5 skip).

### Why routing has no existing primitive (the Open Question, in code)

- **No SSH in source.** `ssh` appears only as a `cluster.ts` comment and a
  `scripts/lint-template-safety.ts` blocklist entry — never spawned.
- **Cross-machine = async intents.** `ensureRemoteMachineReachable` (`src/slots/index.ts`)
  records a `start|stop|resume` intent; the worker's keepalive `processSlotIntents`
  (`src/mag.ts`) polls `GET /api/cluster/intents`, runs the op **locally**, signals back
  via `POST /cluster/signal`, deletes the intent. The action set is a hardcoded whitelist
  validated by `parsePendingIntent`.
- **No exec endpoint.** `handleClusterRequest` (`src/cluster-http.ts`) routes only
  state-sync POSTs/GETs; none accept a command or return stdout/exit.
- **Local exec primitive** is `safeSyncOutput(cmd, { cwd, timeout })` in `src/spawn.ts` —
  **local-only**; there is no remote analogue.

Hence Option A proposes a *new* thin `runRemoteCommand` SSH wrapper (the smallest thing
that lets the **synchronous** test-health caller route and get a result back), and Option
B proposes the larger async intent-extension path. The recommendation is A; the user's
call on the Open Question determines the final shape of AC4–AC6.

## Approach

Included because the floor is mechanical and the ceiling's shape is pinned by the
recommended Option A; the only genuinely open creative choice is escalated as the Open
Question above.

1. **Predicate + reasons (AC1, AC2).** Add `requirementsSatisfiedByCurrentHost(project)`
   to `src/health.ts`, returning `"satisfied" | "unmet" | "host-unknown"`. Insert the
   guard in `checkProjectTestHealth` immediately after the `t3code-integration-paused`
   guard: on `"unmet"` or `"host-unknown"`, fall into the routing/skip branch; on
   `"satisfied"`, continue to the existing path-resolution code unchanged.

2. **Routing (AC4, AC5) — Option A.** When the predicate is `"unmet"` and an eligible
   **online** worker exists, run the suite remotely via a new `runRemoteCommand(machine,
   testCmd, { cwd: remoteCheckout, timeout })` in (e.g.) `src/remote.ts`, a
   `safeSyncOutput(["ssh", machine.host, ...])` wrapper. Map its result the same way the
   local run is mapped (pass/fail → state + fix-task). Classify transport failures
   (ssh exit, timeout, non-test error) as **skip**, returning `requirements-unmet`
   without touching state or `tasksCreate`. When the predicate is `"unmet"`/`"host-unknown"`
   and **no** eligible online worker exists, return the `requirements-unmet` skip directly.

3. **Batch line (AC8).** No new pre-dispatch guard; the existing generic
   `if (result.skipped)` branch renders `skipped (requirements-unmet)`.

4. **Tests (AC9).** Extend `src/health.test.ts`; inject the remote-exec via a
   `_runAllTestHealthDispatch`-style seam (or a module-level injectable
   `runRemoteCommand` holder) so no real SSH/network runs in CI; reuse
   `LUDICS_CLUSTER_MACHINE_NAME` + scratch `LUDICS_CONFIG` for host/capability control and
   the existing no-`tasksCreate` / no-state-mutation assertions.

## Notes

- 2026-06-22: Proposal drafted. The routing "ceiling" (Q1) has **no reusable primitive**
  in ludics — verified there is no SSH path and no run-command HTTP endpoint; all
  cross-machine work is async intent-based while test-health is synchronous. Surfaced as
  an **Open Question** (Option A new-SSH-helper vs Option B async-intent-extension) with a
  recommendation of **A**; ACs are written for A. This is the one decision that should be
  confirmed before implementation, since it changes the size and shape of AC4–AC6.
- Corrected stale cluster data from the elaboration's tentative design: `os` is
  `macos`/`linux`, and macbook-pro declares `gpu: apple-silicon` (not empty).

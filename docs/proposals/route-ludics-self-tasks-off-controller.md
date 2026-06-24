# Route ludics self-tasks off the watched controller node

## Goal

Orchestrating a **ludics self-task** (a task whose `project == ludics`, i.e.
ludics modifying its own source) on the **controller node** (mac-studio) takes
the live controller down. Diagnosed live 2026-06-24
([lukstafi/ludics#602](https://github.com/lukstafi/ludics/issues/602)): the
dashboard (`com.ludics.dashboard`, port 7678) was bootout (unloaded, not
re-bootstrapped) **twice**, and `~/.local/bin/ludics` was repointed from
`~/ludics/bin/ludics` to a task worktree's `~/ludics-<task>-s1/bin/ludics`.

Root mechanism (per the task's Tentative Design): when an agent's per-task
worktree runs `ludics init` (the documented post-build verify step), init's
**global** side effects fire against the host it runs on — `symlinkBinary`
repoints the global `~/.local/bin/ludics` (unconditional, even under
`--no-triggers`), and `triggersInstall` can `disable`/`bootout` the controller's
launchd units. mac-studio is the node the user **watches** (its dashboard is a
side monitor), so the blast radius lands exactly where it hurts most.

This proposal implements the user-chosen fix (**fix 2**, conditional machine
routing in `selectMachineForSlot`): keep ludics self-tasks **off** the watched
controller whenever a non-controller worker is live, falling back to the
controller only when no worker is available (user is away). It deliberately
does **not** implement the worktree-aware-`ludics init` fix (fix 1) — see
*Scope*.

## Acceptance Criteria

These criteria express intent at the **routing decision** (`selectMachineForSlot`
return value), not at observable side effects like the dashboard. Cluster state
is driven in tests via `LUDICS_CLUSTER_MACHINE_NAME` (current-machine override)
and the heartbeat directory (`heartbeatsDir()`), exactly as the existing
`cluster.test.ts` "online gating + routing" block does.

- **(a) Live console → console.** For a task with `project: "ludics"` (no hard
  `requirements`), when the **console node** (the configured non-controller node
  selected per the *Approach*) has a **fresh heartbeat**, `selectMachineForSlot`
  returns that console node — even when the controller (mac-studio, `always_on`)
  is also online. This overrides the current `always_on`-first preference, which
  today would pick mac-studio.

- **(b) Console down → controller.** For the same `project: "ludics"` task, when
  **no** eligible console/worker node has a fresh heartbeat,
  `selectMachineForSlot` falls back to the controller (today's behaviour) and
  does **not** return `null` (a ludics self-task with no hard requirements must
  remain assignable so work isn't blocked while the user is away).

- **(c) Non-ludics routing unchanged.** For a task whose `project` is **not**
  `ludics` (case-insensitively), `selectMachineForSlot` returns exactly what it
  returns today — the self-task preference must not perturb any other project's
  selection (verified for at least one no-requirements project and the existing
  always_on/load-balance paths).

- **(d) Hard requirements still win.** A `gpu: nvidia` task still routes to the
  online nvidia worker (minipc-wsl) and is still **blocked** (`null`) when that
  worker is offline — i.e. the existing requirement filter + AC10 online-gate
  (`cluster.test.ts`: "routes a gpu:nvidia task…", "blocks a gpu:nvidia task…")
  are unchanged. The ludics-self preference **composes with**, never overrides,
  the requirement filter: a hypothetical ludics task carrying a hard requirement
  is still constrained to requirement-eligible machines first, and the console
  preference only re-ranks **within** that eligible+online pool.

- **(e) Self-task preference is requirement-subordinate by construction.** The
  preference is applied to the already-requirement-filtered, online pool — never
  to the raw machine list — so it cannot resurrect a requirement-ineligible
  machine. (Tested by giving a `project: "ludics"` task a `gpu` requirement the
  console node does not satisfy and confirming routing still respects the
  requirement.)

- **Tests** live in `src/cluster.test.ts` alongside the existing
  `selectMachineForSlot — online gating + routing` describe block and reuse its
  `beforeEach`/`afterEach` heartbeat + `LUDICS_CLUSTER_MACHINE_NAME` fixture
  scaffolding (current machine pinned to `mac-studio`, the leader).

## Context

How routing works today (all in `src/cluster.ts`):

- `selectMachineForSlot(_task: { project, effort, requirements? })` is the single
  routing entrypoint. Callers in `src/mag.ts` (slot auto-assign) and
  `src/health.ts` already pass `{ project: task.project, effort, requirements }`,
  so `project` is **already available** at the decision point — no signature
  change is needed to read it.
- Current algorithm:
  1. `clusterEnabled()` guard → `""` (single-machine no-op) when not federated.
  2. Requirement filter (`reqs.os`, `reqs.gpu`) by **exact equality** over **all**
     machines → `null` if nothing eligible.
  3. `online = eligible.filter(heartbeatIsFresh)`.
  4. **AC10 gate**: for tasks *with* requirements, `null` when `online` is empty
     (don't stamp a slot that idles waiting for an offline worker).
  5. `pool = online.length > 0 ? online : eligible`.
  6. **Primary signal**: prefer `always_on` machines; tiebreak prefer
     **non-current** for load balance. Else prefer non-current; else `pool[0]`.

  Step 6 is exactly what routes a no-requirements ludics task to mac-studio
  today: mac-studio is the only `always_on: true` machine and (when the task is
  driven from mac-studio) the `remote = alwaysOn.find(m => m.name !== current)`
  lookup misses, so `alwaysOn[0]` (mac-studio) is returned.

- **Liveness signal** = `heartbeatIsFresh(nodeName)`: reads
  `heartbeatsDir()/<node>.json`, compares `data.epoch` against now, fresh when
  `(now - epoch) < HEARTBEAT_TIMEOUT`. `HEARTBEAT_TIMEOUT` defaults to **900 s
  (15 min)** (`process.env.LUDICS_HEARTBEAT_TIMEOUT`). This is the **real,
  existing** freshness signal the proposal reuses verbatim — no new threshold is
  introduced (see resolved question (ii)).

- **Cluster config** (`config.yaml`, `cluster.machines`), confirmed:
  - `mac-studio` — `role: leader`, `always_on: true`, `gpu: apple-silicon`
    (the controller / watched dashboard host).
  - `macbook-pro` — `role: console`, `always_on: false`, `gpu: apple-silicon`
    (the failover controller / worker; the **console node**).
  - `asus-amd-wsl` — `role: worker`, `gpu: amd`.
  - `minipc-wsl` — `role: worker`, `gpu: nvidia` (reserved for nvidia work).
  - `ClusterMachine.role` is parsed and carried through (`src/cluster.ts`,
    `clusterConfig()`); `resolveController()` already keys off `role === "leader"`.

- **Project-name matching**: task `project` is stored lowercase (`"ludics"`),
  and the codebase compares project names case-insensitively elsewhere
  (`config.ts` uses `projectName.toLowerCase()` throughout). The self-task test
  should therefore be `_task.project.toLowerCase() === "ludics"`.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

In `selectMachineForSlot`, **after** the requirement filter + online gate
compute `pool` (i.e. after step 5, operating on the requirement-eligible,
prefer-online pool — so the preference is structurally subordinate to hard
requirements), insert a ludics-self-task preference **before** the existing
`always_on`/load-balance ranking (step 6):

```
const isLudicsSelfTask = _task.project.toLowerCase() === "ludics";
if (isLudicsSelfTask) {
  // Prefer a live non-controller node so self-modification can't disrupt the
  // watched controller. Restrict to FRESH-heartbeat candidates from `online`
  // (not `pool`, which may have fallen back to offline `eligible`): the whole
  // point is "route off the controller only when a worker is actually up".
  const consolePref = online.filter(
    (m) => m.role !== "leader" && m.role === "console",
  );
  if (consolePref.length > 0) return consolePref[0]!.name;
  // else: fall through to the existing ranking → controller fallback (AC b).
}
```

Then leave step 6 untouched as the fallback.

**Resolved question (i) — what is the "console node"?** Recommendation: prefer
the machine with **`role === "console"`** (macbook-pro), not "any non-controller
node". Rationale:

- macbook-pro is the designated failover/console host — the intended off-desk
  worker for general macOS work.
- The other non-controller nodes are Linux WSL workers **reserved for GPU work**
  (minipc-wsl = nvidia, asus-amd-wsl = amd) and are an awkward host for a
  general macOS-built ludics self-task (cross-OS build/verify friction, and they
  carry their own temp init patches per `MEMORY.md`). Routing a self-task there
  would be a surprising default.
- Keying on the explicit `role: "console"` config field is the clearest,
  most-maintainable signal and degrades correctly: if macbook-pro is down, the
  preference yields nothing and we fall back to the controller (AC b) rather than
  silently landing on an nvidia box.

If the user later wants self-tasks to be able to land on *any* live
non-controller node, the filter generalizes to `m.role !== "leader"` — but the
narrower `role === "console"` default is recommended now.

**Resolved question (ii) — freshness threshold for "up".** Recommendation:
**reuse `heartbeatIsFresh` / `HEARTBEAT_TIMEOUT` (900 s) unchanged.** It is the
cluster's established single source of truth for liveness (the same gate AC10
and `selectOnlineCapableMachine` use); introducing a second, self-task-specific
threshold would fragment the liveness model and surprise operators. No new
constant.

**Why insert before step 6, not replace it:** step 6's `always_on`-first rule is
correct for *every other* project (keep work on the always-on controller for
reliability). Only ludics self-tasks invert that preference. Scoping the new
branch to `isLudicsSelfTask` guarantees AC (c).

## Scope

**In scope**

- Ludics-self-task routing preference inside `selectMachineForSlot`
  (`src/cluster.ts`), composing with — not overriding — the existing requirement
  filter and online gate.
- Tests in `src/cluster.test.ts` covering AC (a)–(e).

**Out of scope (explicit)**

- **Fix 1 — worktree-aware `ludics init`** (redirect `symlinkBinary` /
  `triggersInstall` global mutations to worktree-local targets). The user took
  this out of scope. It remains the deferred follow-up **if the accepted
  residual ever needs closing** (clean even on controller-fallback), but is not
  implemented here.
- Any change to the `ludics init` / build-verify path or the CLAUDE.md "Ludics
  build sequence" prescription — moot under fix 2, since `ludics init` keeps
  running fully on whichever node the task lands on (dogfooding value preserved).
- Idempotent controller-unit re-bootstrap (task's fix 3) — separate concern, not
  required by this routing change.

**Accepted residual (carried verbatim from the task — honest about what fix 2
does NOT solve).** Fix 2 *relocates* the hazard; it does not eliminate it:

- (a) **Console down → controller fallback still bounces the mac-studio
  dashboard.** Explicitly accepted as low-impact: a down console means the user
  is away from the desk and isn't watching the dashboard.
- (b) **On the console node (macbook-pro), the self-task still disrupts *that*
  node's ludics install** (its `~/.local/bin/ludics` symlink / launchd units).
  Tolerable: macbook-pro is a worker/failover, not the watched-dashboard host.

**Dependencies**: none. Repo is on `main`. The routing change is self-contained
within `src/cluster.ts` + its test file.

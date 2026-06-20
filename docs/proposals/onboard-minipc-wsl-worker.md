# Onboard minipc-wsl as a Ludics CUDA worker node

## Goal

Make `minipc-wsl` — the federation's only NVIDIA/CUDA host (RTX 3050 Ti via WSL2
passthrough, CUDA 12.8, OCaml 5.4.0, 24 cores) — a first-class Ludics **worker**
that the `mac-studio` controller can assign slots to and drive over the federation
v2 HTTP-pull loop. This unblocks running CUDA / `ocaml-cudajit` work (starting with
the pool-allocator fix, task-6abfb6a9) through normal orchestration instead of
ad-hoc SSH.

`minipc-wsl` is already declared in `config.yaml` under `cluster.machines`
(`role: worker, gpu: nvidia`), passwordless SSH from `mac-studio` is established,
and the node already has `~/ocannl-staging` and a CUDA toolchain. It is missing:
**bun**, a built + `init`'d Ludics checkout, and the worker keepalive actually
running. This is the **first real remote-worker onboarding** in the federation
(`asus-amd-wsl` was declared but never onboarded), so it is expected to surface
framework gaps; per CLAUDE.md, those are fixed in-repo and may spin off separate
`lukstafi/ludics` issues.

## Acceptance Criteria

This task has two intertwined deliverables: the **operational onboarding** of the
node, and the **framework changes** in `lukstafi/ludics` that this first onboarding
requires and that the resolved questions mandate. Worker-only scoping is a hard
constraint throughout: the node must never perform controller / leader duties.

### A. minipc-wsl runs as a registered worker

1. On `minipc-wsl`, `ludics cluster status` reports `Role: worker` and
   `Mag permission: BLOCKED (defer to controller)`. The node self-identifies via
   its Tailscale hostname matching the `minipc-wsl` entry in `cluster.machines`
   (verifiable: `hostnameTailscale()` resolves and `clusterCurrentMachineName()`
   returns `minipc-wsl`, not `null`).
2. The `mag` keepalive trigger fires on a recurring interval on the node (the
   systemd-user timer is active and actually invoked — see §C for the WSL2
   persistence requirement), so the node heartbeats. After it runs at least once,
   `ludics cluster status` on **mac-studio** shows `minipc-wsl` as `online`
   (fresh heartbeat).
3. The node reaches the controller's dashboard server at
   `mac-studio.tail5fa567.ts.net:<dashboard port>` over Tailscale: a worker
   keepalive tick successfully GETs slot + intent state (no transport error in the
   keepalive log).
4. A slot stamped with `machine: minipc-wsl` and started by the controller is
   picked up by the worker keepalive (`processSlotIntents`) and a session is
   launched **locally on minipc-wsl** (tmux session present on the node). The
   node has the runtime this requires: `tmux`, the agent CLI(s) it will run, and a
   working opam/dune toolchain for the project under test.
5. The node's session bootstrap can `git clone`/`pull` the state repo and project
   repos non-interactively (SSH git remotes + the node's key registered with
   GitHub), so keepalive-driven operations don't block on auth prompts.

### B. CUDA-task routing reaches minipc-wsl

6. A task carrying `requirements: { gpu: nvidia }` in its frontmatter routes to
   `minipc-wsl` via `selectMachineForSlot` (and is *not* routed to a non-NVIDIA
   machine). task-6abfb6a9 (the CUDA pool-allocator fix) already carries this
   requirement and is the concrete validation target. Routing is **per-task
   `requirements`**, not a project-level default (resolved question #2).

### C. Framework gaps productized into ludics (worker-only safe)

These are the gaps this first onboarding surfaces; per resolved question #1 they
are fixed in `lukstafi/ludics`, not papered over with one-off node edits.

7. **Worker-only trigger installation — no controller duties on a worker.**
   Today `installSimpleTriggers()` (`src/triggers.ts`) installs the **dashboard
   server**, **morning briefing**, **health check**, and **ntfy-subscribe** units
   on *every* node regardless of `clusterRole()`. On a worker node these are
   leader-only duties and constitute split-brain pollution (e.g. a second dashboard
   server, duplicate briefings/health checks). After this change, when
   `clusterRole()` is `worker`, `ludics init` installs **only** the worker-relevant
   triggers (`mag` keepalive, `cluster` heartbeat, `startup`, session
   adoption/sweeper, t3code cleanup) and skips controller-only ones. Verifiable on
   `minipc-wsl`: no `ludics-dashboard`, `ludics-morning`, `ludics-health`, or
   `ludics-ntfy-subscribe` systemd-user unit is enabled. (The runtime
   `clusterShouldRunMag()` guard in `magStart` already prevents the Mag *session*
   from starting on a worker; this AC extends the same role-gating to *which units
   get installed in the first place* so a worker never even schedules controller
   work.)
8. **WSL2 / systemd-user persistence.** The `mag` keepalive timer must actually
   fire under WSL2. This requires systemd as PID 1 (`/etc/wsl.conf`
   `[boot] systemd=true`) and a lingering / persistently-running user session so
   `systemctl --user` timers survive logout. The onboarding flow detects this
   precondition and either configures it or fails loud with a clear remediation
   message (rather than silently installing a timer that never runs and leaving the
   node "declared but dead"). The exact productization surface (setup.sh step,
   doctor check, or both) is a design choice for the coder; the **observable
   requirement** is that after onboarding, a fresh WSL session brings the keepalive
   timer up automatically and the node heartbeats without manual `systemctl`
   intervention.
9. **Onboarding / cluster doctor checks.** `ludics doctor` (`magDoctor`) and/or
   `ludics cluster status` gain checks that make worker-onboarding state legible:
   at minimum, on a node that resolves to a cluster machine, surface (a) whether
   this node self-identifies (`clusterCurrentMachineName()` non-null), (b) its
   resolved role, (c) controller reachability over HTTP, and (d) on a worker, that
   the keepalive timer is installed and active. A missing/misconfigured item is
   reported as a failure with remediation text, consistent with the existing
   `magDoctor` style.
10. **Worker-online dispatch gating** (resolved question #3). Change
    `selectMachineForSlot` (`src/cluster.ts`) so a task **auto-assigns only when a
    suitable worker is online** (fresh heartbeat). Today, when no eligible machine
    has a fresh heartbeat, it falls back to `eligible` and stamps the task onto a
    slot that then sits idle waiting for an offline worker to wake. After this
    change, if no eligible machine is online, the task is **blocked from
    assignment** rather than stamped onto an idle slot — the auto-start / launch
    path treats this as "no machine available right now" and retries later.
    Standalone (`!clusterEnabled()`) and same-machine (no `requirements`) behaviour
    is unchanged. This is a discrete framework change and is the strongest
    candidate to spin off as its own `lukstafi/ludics` issue (resolved question #3
    explicitly flags it as a candidate spin-off); the proposal records it here for
    completeness, but it may be implemented under a separate issue/PR if the coder
    finds the onboarding lands cleaner without it.

### Verification reachability note

Onboarding ACs in §A are verified by running commands **on minipc-wsl** (or from
`mac-studio` over SSH/Tailscale), not by a git SHA in the `~/ludics` worktree:
`minipc-wsl`'s filesystem and the federation HTTP state are outside the `~/ludics`
project git context. The framework-change ACs (§C) *are* verifiable from the
`~/ludics` worktree (code + tests). Keep these two evidence channels distinct:
SHA/test evidence for §C, live-node command output for §A/§B.

## Context

### How worker registration works (no dedicated enroll step)

Worker "registration" is declarative + emergent — there is no
`ludics register-worker` command:

- **Declaration**: the node is listed under `cluster.machines` in
  `config.yaml`. Already present for `minipc-wsl`.
- **Self-identification**: `clusterCurrentMachine()` / `clusterRole()`
  (`src/cluster.ts`) match `hostnameTailscale()` (`src/network.ts`) against
  `machines[].host`/`.name`. `minipc-wsl`'s Tailscale prefix matches the `name`
  entry; `clusterRole()` returns `worker`, so `clusterIsController()` /
  `clusterShouldRunMag()` are false.
- **The keepalive running *is* the registration**: the `mag` trigger
  (`installSimpleTrigger("mag", …)` in `src/triggers.ts`; systemd-user timer on
  Linux, every `keepalive_interval` = 60s) calls `magStart` → on a worker →
  `workerKeepalive()` (`src/mag.ts`). The node becomes "registered" the moment its
  keepalive starts heartbeating and polling.

### Federation v2 — pure HTTP pull from the worker

`workerKeepalive()` (`src/mag.ts`), every tick:
- `clusterGetSlots()` (`src/cluster-http.ts`) — HTTP GET fresh slot state from the
  controller, held in-memory only, never written to the worker's harness.
- `processSlotIntents(freshSlots)` — `clusterGetIntents()` HTTP GET pending
  intents; for intents whose `machine === currentMachine` and `epoch` within
  900 s, runs `slotStart`/`slotStop`/`slotResume` locally (one per tick), then
  `clusterDeleteIntent()` to ack. Uses `setWorkerSlotsOverride(freshSlots)` so
  slot ops use controller state instead of the stale local harness.
- `publishTerminalState()` + `maybeResumeDeadOrchestrators()` — local session
  liveness; heartbeats POSTed to the controller (`heartbeatPublish()`).

The controller endpoints live in `src/dashboard-server.ts`
(`handleClusterRequest`, `/cluster/*` + `/api/cluster/*`), default port 7678
(`machineDashboardPort` → `config.dashboard.port`). Client base URL is
`machineBaseUrl` (`src/cluster-http.ts`); controller resolved by
`resolveController()` (the single `role: leader` machine = mac-studio).

**Directionality**: the worker initiates *all* cross-node HTTP. It needs **no
inbound HTTP server**; the controller never SSHes/HTTPs into the worker to drive
sessions — it stamps an intent the worker pulls. SSH is retained only for
`remotePing` diagnostics.

### Slot dispatch & GPU routing

Slots are global (in `slots/`, not partitioned per machine); the target machine is
chosen at dispatch by `selectMachineForSlot(task)` (`src/cluster.ts`) and stamped
as `machine` on a free slot. It filters `cluster.machines` by
`task.requirements.{os,gpu}` (exact `m.gpu === reqs.gpu`); if none match it returns
`null` and the task is skipped. Among eligible it prefers online (fresh-heartbeat)
machines, then `always_on`, tiebreaking to a non-current machine. `requirements`
is the merge of task frontmatter and project config
(`mergeRequirements(taskFm, projectReqs)` in `src/mag.ts`).

### Trigger installation (the worker-only gap)

`installSimpleTriggers()` (`src/triggers.ts`) is called by `runInit`. It installs
`startup`, `mag`, `dashboard`, `ntfy-subscribe`, `sync`, `morning`, `health`,
`sessions`, `sessions-sweep`, `t3code-cleanup`, plus the `cluster` heartbeat
(via `installIntervalTrigger("cluster", …)` just before). **None of these install
calls are role-gated** — only the `mag` keepalive self-gates at *runtime* via
`clusterShouldRunMag()` inside `magStart`. So a worker today would install a
dashboard server unit, morning-briefing timer, and health-check timer. AC #7
closes this by role-gating *installation*.

### bootstrap (`setup.sh`)

`setup.sh` installs bun, tmux, tailscale, gh, ttyd; runs `bun install && bun run
build`; runs `bin/ludics init --no-triggers --no-dashboard`; clones t3code-ludics
and project repos. `ludics init` (`src/init.ts`: `runInit`, `ensureConfig`,
`cloneStateRepo`) writes the pointer config `~/.config/ludics/config.yaml`, clones
the state repo so `harness/config.yaml` is present, symlinks the binary, and
installs triggers. Per the federation-setup memory, non-interactive contexts need
SSH git remotes + the node's key registered with GitHub (`gh ssh-key add`) — `gh`
HTTPS creds don't work under launchd/systemd.

### Code pointers (by symbol — line numbers drift)

- `src/cluster.ts`: `clusterCurrentMachine`, `clusterRole`, `clusterIsController`,
  `clusterShouldRunMag`, `resolveController`, `heartbeatPublish`,
  `heartbeatIsFresh`, `selectMachineForSlot`, `runCluster`.
- `src/cluster-http.ts`: `machineBaseUrl`, `machineDashboardPort`,
  `clusterGetSlots`, `clusterGetIntents`, `clusterDeleteIntent`, `clusterHttpPost`.
- `src/dashboard-server.ts`: `handleClusterRequest`.
- `src/mag.ts`: `workerKeepalive`, `processSlotIntents`, `magStart` (worker
  branch), `mergeRequirements`, `magDoctor`.
- `src/slots/index.ts`: `slotStart`/`slotStop`/`slotResume`,
  `setWorkerSlotsOverride`.
- `src/triggers.ts`: `installSimpleTriggers`, `installSimpleTrigger`,
  `installIntervalTrigger`, `writeSystemdUnit`, `enableSystemdUnit`,
  `triggersInstall`.
- `src/init.ts`: `runInit`, `ensureConfig`, `cloneStateRepo`. `src/config.ts`:
  `resolveConfigPath`, `pointerConfigPath`. `setup.sh`.

### Edge cases / risks

- **WSL2 lifecycle**: distro/systemd stops when no process runs or the host
  sleeps → the worker silently drops offline. `always_on: false` is correct; the
  user brings the node up around dispatch. AC #10's online-gating ensures tasks
  don't get stamped onto a slot waiting for a sleeping worker.
- **No shared HTTP secret configured**: `cluster.secret` is absent; cross-node
  HTTP runs unauthenticated over the Tailscale tailnet (the trust boundary).
  Flagged for awareness, not in scope to change here.
- **Controller dashboard server must be up**: workers fetch state from
  `mac-studio:7678`; if `ludics dashboard serve` isn't running on the controller,
  the worker keepalive gets no state and idles.
- **Stale federation artifacts**: `federation/heartbeats/*.json` and
  `federation/slot-intents/*.json` in the harness are April relics of the older
  state-repo intent model (superseded by HTTP pull) — not live state.

## Approach

*Suggested approach — agents may deviate if they find a better path.* The two
deliverable classes warrant different handling:

- **§C framework changes** are the code work and carry the tests. AC #7 (role-gated
  trigger install) and AC #10 (online-gating dispatch) are bounded, well-specified
  edits with clear pre/post behaviour and unit-test surface (existing patterns:
  `selectMachineForSlot` already has the `online`/`eligible` split to tighten;
  trigger install already branches on platform — add a role branch). AC #8 (WSL
  persistence) and AC #9 (doctor checks) have a design choice in *where* the
  surface lives (setup.sh vs doctor) — coders pick, but the observable requirement
  is fixed.
- **§A/§B operational onboarding** is run-on-the-node work (SSH to minipc-wsl, run
  the worker-mode bootstrap, configure WSL systemd, register the SSH key, verify
  heartbeat + a test slot launch). It validates the §C changes end-to-end and is
  the acceptance gate for the whole task.

Recommended order: land §C framework changes first (they gate a *clean* worker
onboarding — without AC #7 the node installs controller units), then run the
operational onboarding against the fixed binary. AC #10's online-gating, being the
flagged spin-off candidate, may be deferred to its own issue/PR if it complicates
the onboarding landing.

## Scope

**In scope**: the worker-only framework changes (§C: role-gated trigger install,
WSL systemd persistence, doctor/cluster onboarding checks, online-gating dispatch),
the operational onboarding of minipc-wsl (§A), and confirming CUDA-task routing
reaches it (§B). Worker-only safety (no controller/leader duties on the node) is a
hard constraint.

**Out of scope**: onboarding `asus-amd-wsl` or any other node; configuring
`cluster.secret` / HTTP auth; project-level `requirements` defaults (routing stays
per-task); changing the federation transport (HTTP pull stays). Framework-gap
productization may spin off separate `lukstafi/ludics` issues — particularly AC #10
(worker-online dispatch gating), which resolved question #3 explicitly flags as a
candidate spin-off.

**Dependencies**: relates to task-02a97261 and task-6abfb6a9; task-6abfb6a9 (CUDA
pool-allocator fix) is the concrete validation target for §B and already carries
`requirements: { gpu: nvidia }`.

### Scope split (accepted in pair-work review)

The §C **framework changes** (ACs 7–10) are delivered and test-backed under
task-ce21c233. The §A **operational onboarding** (ACs 1–5) and the **live arm of
§B** (AC 6 validation in the real federation) are live-node checks that can only
be run on `minipc-wsl` / from `mac-studio` over Tailscale — outside any coding
worktree's git+test context (see the *Verification reachability note* above).
With reviewer agreement, those operational ACs are carved into the linked
follow-up **task-7eab5162** (`status: needs-confirmation`,
`relates_to: [task-ce21c233]`), to be completed against the binary built from the
framework changes. This PR's acceptance is therefore scoped to §C; the unit-level
routing invariant behind AC 6 is verified here (`src/cluster.test.ts`).

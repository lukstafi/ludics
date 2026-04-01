# Federation Runtime: Remote Orchestrators, Controller Failover, State Sync

## Goal

Ludics has federation config (machine roles, Tailscale transport, heartbeat-based leader election) but no runtime mechanics. Workers can't run on remote machines, the controller role doesn't fail over, and state stays local. This task implements the runtime layer so ludics can distribute work across multiple machines connected via Tailscale.

## Acceptance Criteria

1. **Remote slot dispatch**: The controller can start a slot on a remote machine via SSH/Tailscale-exec. The orchestrator process and agents run locally on the target machine. The command is equivalent to `ssh <host> ludics slot N start`.

2. **Worker autonomy after launch**: Once started, a worker slot survives tunnel breaks. Loss of connectivity to the controller does not crash or halt the worker agent. Workers run autonomously until their task completes or is explicitly stopped.

3. **Controller failover**: When the leader machine goes offline (detected via stale heartbeat), the console machine automatically takes over controller duties (mag, dashboard, triggers). When the leader comes back, the console yields back. Only the active controller runs periodic triggers (except the federation tick trigger, which runs everywhere).

4. **State sync via git**: The controller owns the state repo and pushes changes. Workers do not push to the state repo. State changes from workers flow back to the controller through a messaging/signaling channel (not git push from workers).

5. **Batch state commits**: Replace per-action `stateCommit` micro-commits with batch commit+push at natural checkpoints: briefing completion, shutdown, controller handoff, and optionally health-check. File writes accumulate between checkpoints. `events.jsonl` provides fine-grained observability instead of git history.

6. **Slot-to-machine assignment**: The controller assigns slots to machines. Config `federation.machines` already has `role`, `always_on`, and `gpu` fields. Slot assignment should respect machine availability (online heartbeat) and optionally GPU affinity.

7. **Startup role determination**: The startup trigger runs federation logic first: if this machine is a worker and a controller is already online, it skips mag/dashboard startup. If this machine should be the controller per seniority rules, it takes over.

## Context

### Existing Federation Infrastructure

- **`src/federation.ts`**: Heartbeat publish/check, seniority-based leader election (`computeLeader` iterates `networkNodes()` in config order, picks first online), leader file persistence, `federationShouldRunMag()` gate, federation tick (pull, heartbeat, elect, commit, push).

- **`src/network.ts`**: Tailscale hostname detection, node config parsing (`networkNodes()` returns `{name, tailscale_hostname}[]`), node-to-hostname resolution (`networkNodeHostname()`), current node identification via Tailscale status JSON.

- **`src/state.ts`**: `stateCommit(msg)` does git add -A + commit. `statePull()` with auto-stash. `statePush()`. `stateFullSync()` = pull + commit + push.

- **`src/mag.ts`**: Keepalive loop calls `federationShouldRunMag()` to gate mag operations. Slot auto-fill, auto-start, resume logic all run within keepalive. Uses `stateCommit` at ~8 call sites in `src/slots/index.ts`.

- **`src/slots/index.ts`**: `slotStart()` calls `runAdapterAction("start", ctx)`. `slotResume()` recovers crashed sessions. Both are local-only today. `stateCommit()` called after assign, clear, note, and other mutations.

- **`src/triggers.ts`**: Installs launchd plists for each trigger. Federation trigger already defined (`action: federation tick`, default interval 300s). Triggers run on every machine where installed.

- **Config reference** (`templates/config.reference.yaml`): `federation.transport` (local/tailscale/ssh), `federation.machines[]` with name/host/os/role/always_on/gpu fields. `network.nodes[]` used by current election code (separate from `federation.machines` -- these may need unification).

### Key Architecture Points

- Adapter layer (`src/adapters/`) abstracts session lifecycle. The tmux adapter (`tmux-adapter.ts`) manages tmux sessions locally. For remote dispatch, the adapter call needs to be wrapped in an SSH/Tailscale-exec invocation.

- Orchestration state (`src/orchestration/state.ts`) persists per-slot phase state to disk. For remote workers, this state lives on the worker machine, not the controller.

- The `ludicsSelfCommand()` helper in `mag.ts` constructs the correct `ludics` invocation for the current runtime (compiled binary vs script mode). Remote dispatch needs an analogous mechanism for the remote machine's binary path.

## Scope

### In scope

- Remote slot start/stop/resume via SSH or Tailscale-exec
- Controller failover and failback (leader <-> console)
- Trigger suppression on non-controller machines
- Batch state commits replacing micro-commits
- Worker-to-controller result signaling (mechanism TBD by implementer -- options include ntfy, SSH reverse exec, or polling)
- Slot-to-machine assignment tracking in slots.md (which machine owns each slot)
- Startup trigger integration with federation role determination

### Out of scope

- GUI/dashboard changes for multi-machine visibility (follow-up task)
- Cross-machine worktree sharing or file sync (workers use local checkouts)
- Windows support (all machines are macOS/Linux)
- Automatic project checkout on remote machines (assumed pre-cloned)
- `network.nodes` / `federation.machines` config unification (can be addressed separately)

### Dependencies

- Relates to task-6295b54e (tmux adapter, completed) -- federation builds on the tmux adapter as execution substrate
- Requires Tailscale to be installed and connected on all participating machines
- Requires ludics to be installed on all participating machines

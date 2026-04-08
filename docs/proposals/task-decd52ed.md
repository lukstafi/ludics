# Proposal: Refactor Federation to Cluster — Static Controller, No Election

**Task**: task-decd52ed  
**Project**: ludics  
**Priority**: A  
**Effort**: medium

---

## Goal

Simplify multi-machine coordination by removing dynamic leader election and renaming "federation" to "cluster" throughout the codebase, config, CLI, and harness directories. The controller is statically determined by the machine with `role: "leader"` in config; no runtime election, no `leader.json`, no console failover. HTTP transport and worker heartbeats are preserved.

---

## Acceptance Criteria

### Phase 1 — Rename (mechanical)
- [ ] `src/federation.ts` renamed to `src/cluster.ts`; `src/federation-http.ts` renamed to `src/cluster-http.ts`
- [ ] All `federation*` exported symbols renamed to `cluster*` (e.g. `federationEnabled` → `clusterEnabled`, `FederationMachine` → `ClusterMachine`, `FederationConfig` → `ClusterConfig`, `runFederation` → `runCluster`)
- [ ] `federation:` config YAML key renamed to `cluster:` in `src/config.ts` (`LudicsFullConfig.federation` → `LudicsFullConfig.cluster`) and in `federationConfig()` → `clusterConfig()` reads `config.cluster`
- [ ] HTTP URL paths renamed: `/federation/heartbeat` → `/cluster/heartbeat`, `/federation/signal` → `/cluster/signal`, `/api/federation/*` → `/api/cluster/*`
- [ ] CLI entry renamed: `federation: runFederation` → `cluster: runCluster` in `src/index.ts`; help text updated
- [ ] Harness path strings updated: `"harness/federation/..."` → `"harness/cluster/..."` in `src/state.ts` and any other callers
- [ ] Dashboard server routing updated: `pathname.startsWith("/federation/")` → `pathname.startsWith("/cluster/")` in `src/dashboard-server.ts`
- [ ] All other callers updated (imports and call sites): `src/mag.ts`, `src/dashboard.ts`, `src/events.ts`, `src/journal.ts`, `src/notify.ts`, `src/remote.ts`, `src/sessions/index.ts`, `src/orchestration/runner.ts`, `src/orchestration/state.ts`, `src/slots/index.ts`, `src/tasks/index.ts`, `src/network.ts`, `src/init.ts`
- [ ] Test files renamed: `federation.test.ts` → `cluster.test.ts`, `federation-http.test.ts` → `cluster-http.test.ts`; all internal symbol references updated
- [ ] `bun run build` passes with no errors; `bun test` passes

### Phase 2 — Remove election logic
- [ ] Deleted from `src/cluster.ts`: `computeController()`, `updateLeader()`, `currentLeader()`, `currentTerm()`, `clusterElect()` (was `federationElect()`), `clusterIsLeader()` (was `federationIsLeader()`), `leaderFile()`
- [ ] `clusterRole()` simplified: returns `"controller"` iff `machine.role === "leader"`, no console failover branch
- [ ] `resolveControllerCandidates()` renamed to `resolveController()` and simplified to return the single leader machine from config (no consoles fallback)
- [ ] `elect` subcommand removed from `runCluster()` CLI dispatcher; help text updated
- [ ] Election-related events removed: no more `federation_leader_change`, `federation_failover`, `federation_failback` emits
- [ ] `handleGetLeader()` deleted from `src/cluster-http.ts`; `/api/cluster/leader` endpoint removed from dispatcher
- [ ] `resolveAndPost()` and `resolveAndGet()` in `src/cluster-http.ts` simplified to call the single controller (no candidates loop)
- [ ] `heartbeatPublish()` updated: posts to single controller via `resolveController()`, not a candidates list
- [ ] `bun run build` passes; `bun test` passes

### Phase 3 — Add statePull at init
- [ ] In `src/init.ts` step 10 (now "Cluster init"), `statePull()` is called before `clusterTick()`
- [ ] `clusterTick()` reduced to: publish heartbeat + log message; no election call, no failover/failback detection block
- [ ] `bun run build` passes; `bun test` passes

### Phase 4 — Harness cleanup
- [ ] `harness/federation/` directory renamed to `harness/cluster/` (or created fresh if absent)
- [ ] `harness/federation/leader.json` deleted (if present)
- [ ] `config.yaml` `federation:` key renamed to `cluster:`
- [ ] Harness changes committed to git

### Overall
- [ ] `ludics cluster status` displays current node, its role, and per-machine heartbeat status (no "term" line, no console failover warning)
- [ ] `ludics cluster ping <machine>` works
- [ ] Worker nodes can POST heartbeats and signals to controller via `/cluster/*` HTTP paths
- [ ] No references to `federation` remain in `src/` (verified with `grep -r federation src/`)

---

## Context

Federation v2 (task-75af4974, completed) introduced HTTP-based cross-node coordination, eliminating the need for git commits as the transport medium. The election layer on top — `leader.json`, `computeController()`, console failover — adds complexity that has caused real operational pain with essentially no practical benefit: in practice, users switch controllers by changing config and restarting, not by waiting for automatic failover.

**Code surface** (verified):
- `src/federation.ts` (601 lines): election functions at lines ~142–336; `federationTick()` at lines ~385–419 contains election and failover detection; `federationRole()` at lines ~344–373 has console failover branch; `resolveControllerCandidates()` at lines ~325–330 returns leaders + consoles
- `src/federation-http.ts` (676 lines): `resolveAndPost()`/`resolveAndGet()` iterate over candidates; `handleGetLeader()` at line ~535; HTTP dispatcher at line ~345
- `src/config.ts` line ~72: `federation?` field in `LudicsFullConfig`
- `src/init.ts` line ~140: step 10 calls `federationTick()`
- `src/index.ts` line ~36: `federation: runFederation` dispatch; help text at line ~224 includes `federation elect`
- `src/dashboard-server.ts` line ~156: routing for `/federation/` and `/api/federation/`
- 338 total "federation" references across `src/` — majority are symbol uses, not separate concepts

**What is preserved**:
- `heartbeatPublish()`, `heartbeatIsFresh()`, `heartbeatsDir()`, `HEARTBEAT_TIMEOUT` — worker health monitoring still needs heartbeats
- `selectMachineForSlot()` — unchanged logic, just renamed internals
- All HTTP endpoints (renamed to `/cluster/*`) — cross-node delivery mechanism unchanged
- `clusterEnabled()`, `clusterMachines()`, `clusterCurrentMachine()`, `clusterCurrentMachineName()` — cluster membership detection unchanged

---

## Approach

The work is structured as four sequential phases to keep each diff reviewable and independently testable.

### Phase 1 — Rename (mechanical, low-risk)

Pure identifier and path renaming across all files; no logic changes.

1. Rename files: `federation.ts` → `cluster.ts`, `federation-http.ts` → `cluster-http.ts`
2. Global symbol rename: `federation*` → `cluster*`, `Federation*` → `Cluster*`
3. Update `src/config.ts`: `LudicsFullConfig.federation` → `LudicsFullConfig.cluster`; update `clusterConfig()` to read `config.cluster` (with compat: still accept `config.federation` if `config.cluster` absent, to ease migration)
4. Update HTTP URL paths in dispatcher and client helpers: `/federation/` → `/cluster/`, `/api/federation/` → `/api/cluster/`
5. Update `src/index.ts`: map key `federation` → `cluster`, help text
6. Update `src/dashboard-server.ts`: routing `startsWith("/federation/")` → `startsWith("/cluster/")`
7. Update `src/state.ts` path strings
8. Rename test files and update all internal references

### Phase 2 — Remove election logic

Delete the election layer. All deletions are in `src/cluster.ts` and `src/cluster-http.ts`.

1. Delete: `computeController()`, `updateLeader()`, `currentLeader()`, `currentTerm()`, `clusterElect()`, `clusterIsLeader()`, `leaderFile()`
2. Simplify `clusterRole()`:
   ```typescript
   export function clusterRole(): "controller" | "worker" | "standalone" {
     if (!clusterEnabled()) return "standalone";
     const machine = clusterCurrentMachine();
     if (!machine) return "worker";
     return machine.role === "leader" ? "controller" : "worker";
   }
   ```
3. Rename `resolveControllerCandidates()` → `resolveController()`: return `machines.find(m => m.role === "leader") ?? null` (single machine, not array)
4. Simplify `resolveAndPost()` and `resolveAndGet()` to call `resolveController()` directly — no loop over candidates
5. Update `heartbeatPublish()` to use `resolveController()` instead of candidates loop
6. Remove `elect` case from `runCluster()` CLI dispatcher
7. Delete `handleGetLeader()` and remove `/api/cluster/leader` from GET dispatcher
8. Remove `emitEvent` calls for `federation_leader_change`, `federation_failover`, `federation_failback`

### Phase 3 — statePull at init + simplify clusterTick

1. In `src/init.ts`, import `statePull` from `./state.ts` (already exists) and call it in step 10 before `clusterTick()`:
   ```typescript
   // 10. Cluster init
   console.log("\n--- Cluster ---");
   try {
     await statePull();
     await clusterTick();
   } catch (err) { ... }
   ```
2. Simplify `clusterTick()`: keep `heartbeatPublish()` call and log lines; delete the `prevController`, `controller = clusterElect()` block, and the failover/failback detection block entirely.

### Phase 4 — Harness cleanup

1. `mv harness/federation/ harness/cluster/` (or create if absent)
2. `rm -f harness/cluster/leader.json`
3. Edit `config.yaml`: `federation:` → `cluster:`
4. `git add -A && git commit -m "chore: rename federation → cluster in harness"`

**Migration note**: Nodes running older Ludics versions will send heartbeats/signals to `/federation/*` paths which will 404 on updated controllers. Since controller and all workers update together (same `git pull` + `ludics init`), this is acceptable as a clean break. No backward-compat shim is needed.

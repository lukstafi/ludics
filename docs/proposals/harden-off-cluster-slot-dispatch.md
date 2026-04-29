# Harden off-cluster slot start/stop/resume

## Goal

Replace the misleading `"assigned machine X is offline — cannot start"` error
that off-cluster hosts hit on `ludics slot N start/stop/resume` with a clear,
loud diagnostic that explains the situation and points at concrete recovery
paths.

After [task-e3295f1e](https://github.com/lukstafi/ludics/issues?q=task-e3295f1e)
made `slotAssign` fall back to the leader's machine name when the current host
is not in `cluster.machines`, an off-cluster CLI invocation of `slot start` (or
stop / resume) follows this path:

- `isRemoteMachine(leader)` returns `true` (fail-closed when
  `clusterCurrentMachineName()` is `null`),
- `ensureRemoteMachineReachable(...)` calls `heartbeatIsFresh(leader)`,
- the off-cluster host has no local copy of the leader's heartbeat, so
  `heartbeatIsFresh` returns `false`,
- the function throws `slot N: assigned machine <leader> is offline — cannot start`.

The leader is not offline — *this* host has no way to observe its heartbeat.
The diagnostic is wrong and gives the operator no obvious recovery path.

User directive (2026-04-29): running on an off-cluster machine should be a
failure announced quickly and loudly. Don't overcomplicate it.

## Acceptance Criteria

- When `clusterEnabled()` is `true` and `clusterCurrentMachineName()` is `null`
  (i.e. cluster is configured but this host is not in `cluster.machines`),
  invoking `slotStart`, `slotStop` (without `force`), or `slotResume` on a slot
  whose `machine` field names a remote node throws an error that:
  - states clearly that this host is not in `cluster.machines`,
  - names the assigned machine,
  - lists three recovery paths: run from the configured node, use the dashboard
    launch button, or re-assign with `--machine <thisHost>`.
- The error replaces the misleading `"... offline — cannot ..."` string in the
  off-cluster scenario; it must fire **before** `heartbeatIsFresh` so the user
  never sees the stale "offline" message off-cluster.
- `slotStop(N, force=true)` continues to work off-cluster with no new throw —
  the force path already skips `ensureRemoteMachineReachable`, and the new
  guard must inherit that escape hatch for free.
- On-cluster behaviour is unchanged: when this host is a configured cluster
  node, the existing `heartbeatIsFresh` + `clusterMachine` checks still gate
  remote dispatch with the same error messages.
- Standalone (non-cluster) usage is unchanged: `clusterEnabled()` is `false`,
  so the new guard is inert. Existing `"no cluster config for machine X"` /
  `"offline — cannot start"` test assertions still hold for the no-cluster
  case (the misleading-when-off-cluster error only matters when a cluster *is*
  configured).
- New tests cover: off-cluster `slotStart` / `slotStop` / `slotResume` throwing
  the new diagnostic, and `slotStop(N, true)` succeeding off-cluster.
- `bun run typecheck && bun run lint && bun run build && bun test` all pass.

## Context

### Where things live

- `src/slots/index.ts`
  - `ensureRemoteMachineReachable(slotNum, machine, action, adapter, intentPayload)` —
    the choke point for non-force remote dispatch. Currently checks
    `heartbeatIsFresh` then `clusterMachine`, then records an intent. **The new
    guard goes at the top of this function.**
  - `slotStart`, `slotStop`, `slotResume` — three call sites that take the
    `if (ctx.machine && isRemoteMachine(ctx.machine)) { ... await ensureRemoteMachineReachable(...) }`
    branch. No edits needed at the call sites; they inherit the new behaviour
    by virtue of the choke-point change.
  - `slotStop` non-force vs force branches — the force branch logs
    `force-clearing local state (skipping remote stop on <machine>)` and
    bypasses `ensureRemoteMachineReachable` entirely, so placing the guard
    inside `ensureRemoteMachineReachable` preserves the force escape hatch
    automatically.
  - `defaultAssignMachine` — round-3 stderr warning at assign-time. Stays as
    is; complementary to the new guard (warns at assign-time; the new guard
    catches the operation-time case where the warning was missed or where the
    assign ran on the leader but the start runs on a laptop).

- `src/cluster.ts`
  - `clusterEnabled()` — true when the harness config has a `cluster:` block.
  - `clusterCurrentMachineName()` — returns the current host's name from
    `cluster.machines` if a match is found, otherwise `null`. The pair
    `clusterEnabled() === true && clusterCurrentMachineName() === null` is
    exactly the "cluster configured but this host is not in it" condition.
  - `heartbeatIsFresh`, `clusterMachine` — already imported into
    `src/slots/index.ts`.

- `src/remote.ts`
  - `isRemoteMachine` fail-closed behaviour stays. Flipping it would
    re-introduce the original silent-local-execution bug (the dashboard
    correctness gain from task-e3295f1e relies on this).

### Today's call graph (off-cluster)

```
slotStart(N)
  → readSlot(N) → ctx.machine = "<leader>"        (defaultAssignMachine fallback)
  → isRemoteMachine("<leader>")  → true           (clusterCurrentMachineName() === null, fail-closed)
  → ensureRemoteMachineReachable(N, "<leader>", "start", ...)
      → heartbeatIsFresh("<leader>") → false       (no local heartbeat publishing off-cluster)
      → throw "slot N: assigned machine <leader> is offline — cannot start"
```

The throw happens before any intent is written, so there are no orphan files
on the off-cluster filesystem — the only damage is the misleading message.

### Test surface

`src/slots/index.test.ts` already has:

- a `writeConfig(homeDir, { cluster: true })` helper that emits a `cluster:`
  block with one machine `worker-a` (host `worker-a.test.local`),
- a `"remote slot dispatch via HTTP"` describe block (around line 1317) that
  arranges `clusterMachine("worker-a")` to resolve and `heartbeatIsFresh` to
  return true/false depending on test setup,
- a `"slotAssign machine default in federated setup"` describe block (around
  line 1739) that exercises the leader-fallback path the new tests pivot off.

The existing tests at 1322 and 1345 (`"remote slotStart fails fast when no
cluster config for machine"` / `"... when machine is offline"`) run **without**
`cluster: true`, so `clusterEnabled() === false` and the new guard is inert
for them — their assertions on `"no cluster config for machine"` and
`"offline — cannot start"` continue to hold.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

Single-site guard at the top of `ensureRemoteMachineReachable` in
`src/slots/index.ts`:

```ts
async function ensureRemoteMachineReachable(
  slotNum: number,
  machine: string,
  action: "start" | "stop" | "resume",
  adapter: string,
  intentPayload: Record<string, unknown>,
): Promise<void> {
  // Off-cluster guard: cluster configured but this host is not in it.
  // Fires before heartbeatIsFresh so the misleading "offline" diagnostic
  // is replaced. force-stop skips this function entirely, preserving
  // its escape hatch for free.
  if (clusterEnabled() && clusterCurrentMachineName() === null) {
    throw new Error(
      `slot ${slotNum}: this host is not in cluster.machines; cannot ${action} on "${machine}". ` +
      `Run from "${machine}" (or another configured cluster node), use the dashboard launch button, ` +
      `or re-assign with --machine <thisHost> to make the slot local.`
    );
  }

  if (!heartbeatIsFresh(machine)) {
    throw new Error(`slot ${slotNum}: assigned machine ${machine} is offline — cannot ${action}`);
  }
  // ... rest unchanged ...
}
```

Notes:

- `clusterEnabled` and `clusterCurrentMachineName` need to be added to the
  existing `import { heartbeatIsFresh, clusterMachine } from "../cluster.ts"`
  at the top of `src/slots/index.ts` (or the worker can choose a small local
  `assertCanDispatchRemote()` helper — purely cosmetic).
- The error wording above is a starting point; lean terse — "punchy", not
  chatty — while keeping all three recovery paths the user named.
- No new flags. No `--machine self`. The recovery story is "re-assign with
  `--machine <thisHost>`", which works today because `slotAssign` accepts any
  string for `--machine` with no code change.

### Tests to add

Inside the existing `"remote slot dispatch via HTTP"` describe block (or a
new sibling describe `"off-cluster guard"`), with
`process.env.LUDICS_CONFIG = writeConfig(TMP, { cluster: true })` set so
`clusterEnabled()` returns true. The fixture's only machine is
`worker-a` / `worker-a.test.local`, neither of which matches the test runner's
hostname, so `clusterCurrentMachineName()` returns `null` — exactly the
off-cluster condition.

1. **`slotStart` off-cluster throws the new diagnostic.** Assign slot 1 with
   `--machine worker-a`, freshen the heartbeat (so the test would otherwise
   reach the heartbeat check), call `slotStart(1)`. Expect throw matching
   `/this host is not in cluster.machines/`.
2. **`slotStop` (non-force) off-cluster throws the new diagnostic.** Same
   setup, call `slotStop(1, false, false)`. Expect throw matching
   `/this host is not in cluster.machines/`.
3. **`slotResume` off-cluster throws the new diagnostic.** Same setup, call
   `slotResume(1)`. Expect throw matching `/this host is not in cluster.machines/`.
4. **`slotStop(N, force=true)` off-cluster succeeds.** Same setup, call
   `slotStop(1, true, false)`. Expect no throw, `sessionStarted` cleared, no
   intent recorded — same shape as the existing
   `"remote slotStop with --force does not write intent, clears state"` test
   (line ~1397), now also under cluster-enabled config.

Existing tests in the `"remote slot dispatch via HTTP"` block keep their
current assertions; they exercise a no-cluster fixture where the new guard is
inert.

## Scope

In scope:

- `src/slots/index.ts` — guard inside `ensureRemoteMachineReachable`,
  ~5–15 LOC.
- `src/slots/index.test.ts` — 3–4 new test cases under cluster-enabled
  fixture, ~25–40 LOC.
- Optional: a one-line `CHANGELOG.md` entry under "federation" / "fixed" if
  the project keeps a changelog cadence; the worker may judge.

Out of scope:

- Auto-routing remote dispatches to the leader via HTTP from off-cluster hosts
  (option 2 in the elaboration). Not filed as a follow-up — if it turns out to
  be needed, file then.
- Any new CLI flag (`--machine self` or similar). Re-assigning with
  `--machine <thisHost>` is the documented recovery path and needs no code.
- Reverting the leader-fallback default from task-e3295f1e. The dashboard
  correctness gain is real; this task only closes the operational gap.
- Touching `isRemoteMachine`'s fail-closed behaviour in `src/remote.ts`. The
  fail-closed branch is what surfaces the off-cluster case as "remote" and
  routes it into the new guard.

Dependencies: none. task-e3295f1e is already merged; this task layers on top.

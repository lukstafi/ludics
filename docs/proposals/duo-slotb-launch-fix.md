# Fix hierarchical-duo second-slot (slotB) launch on remote workers

## Goal

Launching a task in **hierarchical-duo** mode on a remote worker brings up the
second slot (slotB) in a completely broken state while the first slot (slotA)
is healthy. Observed live launching `task-55a11fa3` as duo across slots 3
(slotA) + 4 (slotB) on the `minipc-wsl` remote worker (tmux adapter).

The root defect: slotB's `slotStart` runs on the worker with **empty
`adapterArgs`**, which trips an auto-fill that silently regenerates a *default
pair* string — discarding the swapped providers and `--duo-peer-slot`. That
default is then persisted back to the controller, turning a transient empty
read into durable corruption. Every downstream symptom (agents in `$HOME`,
unswapped providers, `duoPeerSlot=None`, missing per-phase work prompts,
reviewer self-exit, empty Terminals enumeration) cascades from this.

A second, separable defect: the `ludics orch on-stop` stop-hook fires with an
empty `cwd`, producing a usage error. This appears on healthy slotA too, so it
is independent of the slotB launch defect and is fixed defensively here.

Link: https://github.com/lukstafi/ludics/issues/589
Related: gh-ludics-590 (owns the jq-resolution / hook-PATH / fail-loud-when-jq-missing
install surface — kept disjoint from this task's defensive blank-`cwd` guard).

## Acceptance Criteria

### Part A — slotB auto-fill must not clobber duo args (fail-loud safety net)

1. When a slot's `adapterArgs` are missing/empty/whitespace **and** the slot is
   part of a hierarchical-duo assignment, `autoFillAdapterArgs`
   (`src/slots/index.ts`) does **not** regenerate a default pair string.
   Instead it surfaces an error (or refuses to auto-fill) so the launch fails
   loudly rather than starting an orchestration with the wrong providers and a
   missing `--duo-peer-slot`. The auto-fill guard distinguishes "operator wants
   defaults" (a genuinely solo/standalone slot) from "duo slotB delivery
   failure".
2. When the auto-fill is refused for a duo slot, the wrong default args are
   **not** persisted back to the controller via `clusterPostSlotUpdate`
   (`slotStart` in `src/slots/index.ts`). A transient empty read must not become
   durable corruption of the controller's slot state.
3. The duo-membership signal that drives criteria 1–2 is robust enough that a
   standalone/solo slot with deliberately empty args still auto-fills as before
   (no regression to the existing auto-fill behaviour for non-duo slots).

### Part B — delivery hardening so slotB's expanded args reach the worker

4. slotB's expanded adapter args (swapped `--coder`/`--reviewer` plus
   `--duo-peer-slot=<peer>`, as produced by `expandDuoSlots` in
   `src/slots/duo-expand.ts`) reliably reach the worker before launch. This is
   achieved by an atomic two-slot publish on the controller and/or by having
   the worker re-fetch the specific slot's args at `slotStart` rather than
   trusting the up-front `freshSlots` snapshot fetched in `processSlotIntents`
   (`src/mag.ts`). After the fix, slotB on a remote worker comes up with the
   correct swapped providers and `duoPeerSlot` set to the peer slot number.
5. The tmux adapter's per-agent `worktreePath` is never `undefined`: the
   `setup.agentWorktrees[agent.name]!` non-null assertion in
   `src/adapters/tmux-adapter.ts` `start()` is replaced with an explicit check
   that fails loud if an agent name has no worktree key (so a key mismatch
   surfaces as an error instead of silently launching a tmux session in
   `$HOME`). Confirm the `setup.agentWorktrees` keys match the swapped agent
   names for a duo slotB.

### Part C — defensive blank-`cwd` guard for `orch on-stop` (symptom 5)

6. `templates/hooks/ludics-on-stop.sh` does not `exec ... orch on-stop` with an
   empty `$cwd`: when `$cwd` is blank (from any cause), the hook either skips the
   orchestration exec or supplies a safe default, so the agent stop does not
   produce a `usage: ludics orch on-stop` error. This guard is independent of
   gh-ludics-590's jq/PATH fix — a blank `cwd` from *any* cause is handled
   gracefully.
7. `orchOnStop` (`src/orchestration/index.ts`) arg handling is hardened so an
   empty/missing `cwd` is handled gracefully (e.g. falls back to peer-sync
   resolution via env var / marker file, or exits 0 silently) rather than
   printing a usage error and `exit(1)`.

### Part D — regression coverage

8. A test reproduces the slotB defect at the unit level: it simulates the worker
   override path (`setWorkerSlotsOverride` with slotB's args missing from the
   fetched snapshot) and asserts that, post-fix, the launch either fails loud
   (Part A) or resolves slotB's correct duo args (Part B) — not the silent
   default-pair fallback. A negative control confirms a genuine solo slot with
   empty args still auto-fills.

### AC verification reachability

All AC-named paths (`src/slots/index.ts`, `src/slots/duo-expand.ts`,
`src/mag.ts`, `src/adapters/tmux-adapter.ts`, `src/orchestration/index.ts`,
`templates/hooks/ludics-on-stop.sh`) live inside `git -C /Users/lukstafi/ludics`'s
introspection reach, so commit-SHA / diff evidence against those paths is valid;
no find/grep-over-subtree fallback is required.

## Context

### How duo launch works today

- **Expansion (correct).** `expandDuoSlots` (`src/slots/duo-expand.ts`) emits
  two pair-mode arg strings: slotA gets `--coder <coder> --reviewer <reviewer>
  --duo-peer-slot=<slotB>`, slotB gets the **swapped** `--coder <reviewer>
  --reviewer <coder> --duo-peer-slot=<slotA>`. `stripModeAndRoleFlags` preserves
  phase/effort extras. This is not the bug.
- **Assignment (symmetric).** Both the manual handler (the `isDuoAssign` block
  in `src/slots/index.ts`, two `slotAssign` calls with `expansion.slotA.args` /
  `expansion.slotB.args`) and the auto-fill duo path (the `isDuo` block in
  `src/mag.ts`) write both slots symmetrically. The controller's slot state ends
  up correct.
- **Worker intent processing.** On the worker, `processSlotIntents`
  (`src/mag.ts`) fetches the full controller snapshot via `clusterGetSlots`
  (`src/cluster-http.ts` → `/api/cluster/slots/json`), calls
  `setWorkerSlotsOverride(freshSlots)`, then `slotStart(slotNum)` per pending
  intent. `readSlot` (`src/slots/index.ts`) returns
  `workerSlotsOverride.get(slotNum) ?? readSlotJson(slotNum)` — falling through
  to the **stale local** `slot-N.json` when the override map lacks the slot
  (gh-ludics-580 family).

### The trap

`autoFillAdapterArgs` (`src/slots/index.ts`) early-returns `null` only when
`ctx.adapterArgs.trim()` is non-empty:

```ts
if (!(ctx.mode === "t3code" || ctx.mode === "tmux") || ctx.adapterArgs.trim()) {
  return null;
}
```

When `ctx.adapterArgs` is empty/whitespace it does *not* return null — it calls
`selectOrchestrationFlagsForTask(content, effort)`, producing a plain
`--pair --coder <default> --reviewer <default>` with **no `--duo-peer-slot`**.
`makeAdapterContext` reads `data.adapterArgs ?? ""`, so an empty override entry
(or a fall-through to stale local state) yields exactly this. `slotStart` then,
on a worker, persists the wrong default back:

```ts
clusterPostSlotUpdate(slotNum, { adapterArgs: autoFill.args })
```

So a transient empty read becomes durable controller corruption.

### Cascade

- `parseOrchestrationAdapterArgs` (`src/adapters/t3code.ts`) parses the *wrong*
  default string correctly → wrong coder/reviewer, `duoPeerSlot=undefined`.
- `tmux-adapter.ts` `start()` resolves `worktreePath:
  setup.agentWorktrees[agent.name]!` against default-config agent names; the `!`
  masks a missing key → tmux session with no cwd → `$HOME` (symptom 1).
- `src/orchestration/phases.ts` merge-phase gating keys on
  `state.duoPeerSlot != null`; with `duoPeerSlot=None`, slotB is mis-routed as a
  regular pair → wrong sentinel/work-prompt sequence (symptom 2).
- `generateTerminals()` (`src/dashboard.ts`) enumerates a slot only when
  `mode === "tmux" && sessionStarted`, reading controller-local slot json. If
  slotB's start partially failed, its `sessionStarted` write-back never lands →
  empty enumeration (symptom 7). This is a downstream consequence; fixing the
  root cause restores it.

### on-stop hook (symptom 5)

`templates/hooks/ludics-on-stop.sh` derives `cwd` from `$PWD` (Codex) or the
Claude Code Stop-hook JSON `.cwd`, then `exec "$ludics_bin" orch on-stop "$cwd"
"$peer_sync_dir" "$hook_event_name"`. When `$cwd` is empty, `orchOnStop`
(`src/orchestration/index.ts`) hits `if (!cwd) { ...usage...; process.exit(1); }`.
Appears on healthy slotA too (the worker keepalive drives phase advancement
independently of the stop hook there), so it is independent of the slotB defect.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

The two-part fix (fail-loud safety net + delivery hardening) and the disjoint
hook guard were resolved with the user (task questions 1–2). Concrete shape:

- **Part A:** in `autoFillAdapterArgs`, before regenerating defaults, detect
  that the slot is a duo member whose args failed to arrive — e.g. a persisted
  duo marker on the slot, or detecting the assignment was duo via slot state —
  and refuse (throw a clear error) instead of auto-filling. Guard the
  `clusterPostSlotUpdate` write-back in `slotStart` so a refused/duo slot never
  persists default args.
- **Part B:** prefer making the worker re-fetch the specific slot's
  controller-live args at `slotStart` (or publish both duo slots atomically so
  `freshSlots` can never observe a half-written pair). Drop the masking `!` in
  `tmux-adapter.ts` for an explicit fail-loud check.
- **Part C:** guard the shell hook to not exec `orch on-stop` with a blank
  `cwd`, and make `orchOnStop` treat empty `cwd` as "resolve via env/marker or
  no-op exit 0" instead of usage-error `exit(1)`.

The duo-membership signal is the key design choice (how does a worker-side
`autoFillAdapterArgs` know a slot is duo when its args are empty?) — left to the
coder/reviewer to design, hence not skipping the plan phase.

## Scope

**In scope:**
- Fail-loud safety net in `autoFillAdapterArgs` + `slotStart` write-back guard.
- Delivery hardening so slotB's duo args reach the worker (atomic publish and/or
  worker re-fetch).
- Drop the `worktreePath` `!` non-null assertion in `tmux-adapter.ts` for an
  explicit fail-loud check.
- Defensive blank-`cwd` guard in `ludics-on-stop.sh` + `orchOnStop` arg
  hardening.
- Regression test for the worker override / duo-slotB path with a solo negative
  control.

**Out of scope:**
- gh-ludics-590's jq-resolution / hook-PATH / fail-loud-when-jq-missing install
  surface (the *install/PATH* cause of the empty cwd on minipc-wsl). This task
  owns only the *defensive* blank-`cwd` handling so a blank cwd from any cause
  is graceful.
- Broader hardening of `generateTerminals`' single-`sessionStarted`-round-trip
  fragility (symptom 7 is a cascade; the root-cause fix restores it). A
  standalone terminal-enumeration robustness improvement is not required here.

**Dependencies:** none blocking; relates to gh-ludics-590 (kept disjoint) and the
gh-ludics-579/580 worker-state family (the override/stale-local read path this
fix hardens).

# Fix tmux/runner cleanup leak on slot clear and reassignment

## Goal

On slot reassignment or clear, the harness currently orphans the prior assignment's
`ludics orch run-internal <slot>` runner, its task-agent tmux sessions, and its
ttyd wrappers. The zombie runner keeps persisting stale state to
`orchestration/slot-<N>.json`, which flips the "no session / setup" signals read
by `mag.ts:maybeAutoStartSlots`, which then re-spawns coder + reviewer agents —
multiplying the leak every cycle.

Observed 2026-04-22 on a live system: 13 task-agent tmux sessions alive when only
3 slots were assigned; 6 zombie `orch run-internal` processes writing state under
the live runners' feet; 6 orphaned ttyd wrappers. Manual `kill -TERM` + `tmux
kill-session` was required to restore coherent state; `mag/queue-hold` sentinel
was needed as a band-aid to stop re-spawning during cleanup.

No GitHub issue — internal debugging observation. Priority A because the leak is
cost- and state-corruption-multiplicative.

## Acceptance Criteria

1. **`slotClear` reaps prior runner before unlinking state**: calling
   `slotClear(N, ...)` on a slot whose `data.process !== "(empty)"` terminates
   the `orch run-internal <slot>` process (SIGTERM to `orchestration.pid` from
   `tmux-slot-<N>.json` or `t3code/slot-<N>.json`) and kills any associated
   `ttyd` wrappers *before* the slot JSON, `orchestration/slot-<N>.json`,
   `tmux-slot-<N>.json`, and `t3code/slot-<N>.json` are unlinked. An
   already-empty slot remains a no-op.

2. **`slotAssign` reaps prior runner on reassignment**: when `slotAssign(N, ...)`
   is called on a slot whose current `data.task` differs from the new `taskId`
   (and `data.process !== "(empty)"`), the prior assignment's runner + tmux
   sessions + ttyd processes are reaped before the new slot JSON is written and
   before the stale orchestration state files are unlinked. Assigning to an
   already-empty slot skips the stop call.

3. **Tmux adapter path fixed**: the above reaping works for slots whose prior
   `mode === "tmux"` — verified by the absence of stray `orch run-internal`
   processes and task-agent tmux sessions after clear/reassign, plus the
   `tmux-slot-<N>.json` file removed.

4. **T3code adapter path fixed**: the above reaping works for slots whose prior
   `mode === "t3code"` — verified by the absence of stray `orch run-internal`
   processes after clear/reassign, plus the `t3code/slot-<N>.json` file removed
   (aside from the existing behaviour of writing `t3code_threads` to the task
   frontmatter before clear).

5. **`slotClear` becomes async**: the function's signature is
   `async function slotClear(...)` returning `Promise<void>`. All call sites
   (approximately 12 — in `mag.ts`, `cluster-http.ts`, `dashboard-server.ts`,
   `tasks/index.ts`, `slots/index.ts`) are updated to `await slotClear(...)`.
   `tasksAbandon` in `tasks/index.ts` becomes async and its callers are updated
   transitively.

6. **`slotClear` passes `force=true` to internal `slotStop`**: remote-owned
   slots are force-cleared locally rather than blocking on an unreachable
   remote; this matches the "I don't care about preserving state" semantics of
   clear. Partial failure inside `slotStop` is caught, logged to the journal,
   and does not prevent the follow-on state unlinks from completing.

7. **Runner self-guard added to `runOrchestration`**: the top of the while-loop
   body in `src/orchestration/runner.ts:runOrchestration` reads the sibling
   slot state (`readTmuxSlotState(slot)` for tmux backend,
   `readSlotState(slot, harnessDir)` for t3code) and exits cleanly when either
   the sibling state file is missing or its `orchestration.pid` differs from
   `process.pid`. This defends against any residual code path that deletes
   sibling state without signaling the runner.

8. **`maybeAutoStartSlots` stops misfiring**: no behavioural change is made to
   `mag.ts:maybeAutoStartSlots`. Post-fix, on a stable system under load with
   slot assignments/clears/reassignments, it does not re-spawn coder+reviewer
   pairs spuriously.

9. **Tests cover the contract**:
   - Unit test: `slotClear` on a non-empty slot invokes `adapter.stop()` with
     `force=true` before unlinking slot state files; no-ops on an empty slot.
   - Unit test: `slotAssign` on a non-empty slot with a different taskId
     invokes `adapter.stop()` for the prior task; clean-slot assign does not.
   - Runner self-guard test: a runner whose `tmux-slot-<N>.json` is overwritten
     with a different PID exits on the next loop iteration.
   - Integration test (at least for tmux backend): a real or sandbox-harness
     `orch run-internal` is reaped within ~2s of `slotClear`.

10. **No regressions**:
    - Duo peer link clearing (`clearDuoPeerLink`) still runs before the stop
      call, so the sibling slot doesn't try to coordinate with a dying runner.
    - Remote slot clear still works (no hang on unreachable remote, per AC 6).
    - Existing `slotStop` semantics unchanged for other callers
      (`slotSetMode`, dashboard stop buttons, CLI `slot stop`).

## Context

### Verified bug site

`src/slots/index.ts:slotClear(slotNum, finalStatus)` (approx L357) writes an
empty slot JSON, then does three `unlinkSync` calls against
`orchestration/slot-<N>.json`, `orchestration/tmux-slot-<N>.json`, and
`t3code/slot-<N>.json`. Critically, `tmux-slot-<N>.json` holds the
`orchestration.pid` and `ttydPids` map the adapter's `stop()` needs to reap
processes. Because `slotClear` unlinks it without calling `slotStop` /
`adapter.stop` first, the runner and ttyds become orphaned; the zombie runner
then re-creates `orchestration/slot-<N>.json` on its next `persistState` tick,
corrupting the live slot's state.

`src/slots/index.ts:slotAssign(...)` (approx L237) has the analogous bug: when
`oldData.task && oldData.task !== taskId` it updates the prior task's
frontmatter (L309–319) but never calls `slotStop`; it then writes the new slot
JSON and unlinks the stale `orchestration/slot-<N>.json` and
`tmux-slot-<N>.json` files (L325–332) — again leaking the prior runner, tmux
sessions, and ttyds.

### Adapter stop paths already do the right thing

Both adapter `stop` functions are already correct — the fix is to route
`slotClear`/`slotAssign` through them instead of bypassing them:

- `src/adapters/tmux-adapter.ts:stop` (approx L563) reads
  `tmux-slot-<N>.json`, calls `killPid(slotState.orchestration.pid)`, calls
  `killTtydForSlot(ctx.slot)`, queues tmux session names + worktrees +
  branches + peer-sync link into `recordDeferredCleanup`, then
  `removeOrchestrationState` + `removeTmuxSlotState`.
- `src/adapters/t3code.ts:stop` (approx L1082) follows the same pattern with
  `thread.session.stop` broadcast and `readSlotState`-based PID reaping.

`slotStop` (approx L844 of `src/slots/index.ts`) wraps the adapter via
`runAdapterAction("stop", ctx, { preserveState })`, and already supports a
`force` flag that skips remote dispatch (L856–865) and always runs local
cleanup.

### Call sites requiring `await slotClear(...)` update

From `grep -rn "slotClear" src/ --include="*.ts"`:

- `src/mag.ts` — L873, L2755, L3425, L3542, L3579 (all in async contexts)
- `src/cluster-http.ts` — L459 (async HTTP handler)
- `src/dashboard-server.ts` — L180, L272 (async request handlers)
- `src/tasks/index.ts` — L604 (inside sync `tasksAbandon`; this function
  becomes async, and its callers must be audited)
- `src/slots/index.ts` — L1352 (inside an existing async function)

### Runner self-guard location

`src/orchestration/runner.ts:runOrchestration` (approx L1495) — the
`while (state.phase !== "done")` loop (approx L1504). The guard goes at the
top of the loop body, before `await enterPhase(state, transport)`, using
`readTmuxSlotState` / `readSlotState` + a `state.backend` branch to pick the
right sibling-state reader.

### Out of scope

- No `ludics reap-orphans` CLI command (user-resolved question #3: runners
  don't survive a system restart, and the leak class is eliminated at source).
- No redesign of adapter lifecycle or explicit supervisor process.
- No dashboard UI for leaked-session inspection.
- No cleanup of the ttyd-by-PID precision change (using `slotState.ttydPids`
  directly instead of `pkill -f "ttyd.*--port"`); the existing pkill path
  works correctly even on port re-use.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

Straightforward by user resolution of the elaboration questions (2026-04-23):

1. **Make `slotClear` async** and have it delegate to `slotStop`:
   - Signature: `export async function slotClear(slotNum: number, finalStatus: string = "ready"): Promise<void>`.
   - After `clearDuoPeerLink(slotNum)` and the t3code thread-id save block,
     but before the existing `writeSlotJson(slotNum, emptySlotData(slotNum))`,
     insert:
     ```ts
     if (data.process !== "(empty)") {
       try {
         await slotStop(slotNum, /* force */ true, /* preserveState */ false);
       } catch (err) {
         journalAppend("slot", `Slot ${slotNum} clear: slotStop failed: ${String(err)}`);
       }
     }
     ```
   - Since `slotStop` with `preserveState=false` already calls
     `removeOrchestrationState` and `removeTmuxSlotState`, the subsequent
     `unlinkSync` calls become redundant best-effort safety nets — keep them
     wrapped in `try { unlinkSync(...) } catch {}` so they remain no-ops on
     missing files.

2. **Update `slotAssign` to reap the prior assignment**:
   - Before the `writeSlotJson(slotNum, data)` call (approx L321), after the
     frontmatter-update block for the old task (L307–319), add:
     ```ts
     if (oldData.process !== "(empty)" && oldData.task !== taskId) {
       try {
         await slotStop(slotNum, /* force */ true, /* preserveState */ false);
       } catch (err) {
         journalAppend("slot", `Slot ${slotNum} assign: slotStop of prior task failed: ${String(err)}`);
       }
     }
     ```
   - This requires `slotAssign` to become `async function slotAssign(...)`.
     Audit and update its call sites; they're in `src/slots/index.ts` itself
     (L563, L599, L626, L1329, L1330, L1342) and likely a handful of other
     places — search via `grep -rn "slotAssign" src/ --include="*.ts"`.

3. **Update all `slotClear` / `slotAssign` call sites** to `await` the
   returned promise. `tasksAbandon` becomes `async function tasksAbandon(...)`
   — audit and update its callers.

4. **Add runner self-guard** at the top of the `while (state.phase !== "done")`
   loop in `src/orchestration/runner.ts:runOrchestration`:
   ```ts
   // Self-guard: if a slotClear/slotAssign already reaped us (or should have),
   // exit cleanly so we don't corrupt the new runner's state.
   {
     const sibling = state.backend === "t3code"
       ? readSlotState(state.slot, harnessDir())
       : readTmuxSlotState(state.slot, harnessDir());
     if (!sibling || sibling.orchestration?.pid !== process.pid) {
       console.error(`ludics: runner slot ${state.slot}: sibling state missing or PID mismatch — exiting`);
       return;
     }
   }
   ```
   Verify the exact `state.backend` discriminator name and the shape of the
   t3code sibling state's `orchestration.pid` field against
   `src/orchestration/state.ts` types before committing.

5. **Tests**: extend `src/slots/index.test.ts` with mocked-adapter coverage
   for AC 9 bullets 1 and 2; add a minimal runner self-guard test (can be a
   unit test that constructs a fake state + tmux-slot-N.json on disk and
   calls `runOrchestration` with a stub transport that advances one phase).
   Integration coverage can reuse existing tmux adapter test scaffolding.

6. **Verify after build**: `bun run build && ludics init --no-triggers`,
   then run an end-to-end slot clear + reassign cycle; confirm no leftover
   `ps aux | grep "orch run-internal"` entries and no stray
   `tmux list-sessions` task-agent rows.

## Scope

**In scope**: `src/slots/index.ts` (`slotClear`, `slotAssign`, propagated
async), `src/orchestration/runner.ts` (self-guard), `src/tasks/index.ts`
(`tasksAbandon` + callers), `src/mag.ts` + `src/cluster-http.ts` +
`src/dashboard-server.ts` (await-site updates), tests covering the above.

**Out of scope**: `ludics reap-orphans` CLI, adapter lifecycle redesign,
dashboard leaked-session UI, ttyd-by-PID precision change. No behavioural
change to `mag.ts:maybeAutoStartSlots`. Cleanup of pre-existing zombies is
manual (already performed 2026-04-22) — the fix prevents future accumulation
only.

**Dependencies**: independent of in-flight tasks task-d1932b8f (upstream
workflow simplify), task-da8b6dff (solo mode), task-21b4c850 (template
refactor), task-9b8ff839 (priority D), gh-ludics-309 (plan skip for small).
Touches adapter-facing slot code, not phase graph or templates — no collisions
expected.

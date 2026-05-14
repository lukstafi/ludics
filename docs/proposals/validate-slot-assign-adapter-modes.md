# Validate slot-assign adapter modes; drop legacy agent adapters; add `slot N reset`

**Task**: gh-ludics-524
**Related**: gh-ludics-411 (string→union boundary validator pattern), gh-ludics-186

## Goal

`ludics slot N assign <task-id> -a <mode>` accepts any string as the adapter
mode without validating it against the runtime-supported set. Only `tmux`,
`t3code`, and `manual` are operationally valid. Phantom values from
earlier-session task frontmatter — `agent-claude`, `agent-codex`,
`agent-pair-codex`, `agent-pair-claude`, `agent-duo`, `claude-code` — survive
assign and fail later at `slot start` with confusing errors ("Executable not
found in $PATH" for registered-but-dead adapters, "adapter not found" for
unregistered strings). The failed start trips `markSlotSetupFailed`, leaving
the slot stuck at `liveness: interrupted` with no clean recovery verb
(`slot resume` refuses with "resume only supports t3code and tmux").

Per the user's resolved questions (task Notes, 2026-05-14), the fix is:
1. **Reject** invalid `-a` values at assign time against the canonical set
   `{tmux, t3code, manual}` — no Translate alias table.
2. **Remove** the obsoleted `agent-claude` / `agent-codex` adapter code
   entirely (superseded by solo mode on `tmux`/`t3code`).
3. Keep `claude-ai` / `chatgpt-com` registered, but make them surface a clear
   `NOT IMPLEMENTED YET` error rather than a generic failure.
4. Migrate the ~12 stale task frontmatter files (phantom `adapter:` → `null`)
   as its own commit.
5. Add `ludics slot N reset` to clear `liveness: interrupted` (and
   `sessionStarted`) regardless of adapter.

Issue: https://github.com/lukstafi/ludics/issues/524

## Acceptance Criteria

1. **Assign-time adapter validation rejects non-canonical modes.**
   `ludics slot N assign <task> -a <mode>` errors out before any slot
   mutation when `<mode>` is not one of `tmux`, `t3code`, `manual`. The error
   message names the rejected value and lists the valid set. Verifiable:
   `ludics slot 1 assign some-task -a agent-pair-codex` exits non-zero with a
   message naming the canonical set; the slot file is not modified and no
   `interrupted` marker is created. The canonical set is exposed as a single
   named constant (e.g. `VALID_ASSIGN_ADAPTERS`) — not a literal repeated
   across call sites.

2. **Validation covers programmatic assign callers, not just the CLI.**
   The validator runs inside `slotAssign` (the shared funnel reached by the
   CLI `assign`/`preempt` cases, the dashboard HTTP `POST /api/slots/:n/assign`
   path, and mag's auto-fill/re-assign flows), so an invalid adapter is
   rejected uniformly regardless of entry point. Verifiable: a unit test
   calling `slotAssign(...)` directly with a phantom adapter throws.

3. **The three canonical adapters still assign successfully.**
   `ludics slot N assign <task> -a tmux`, `-a t3code`, and `-a manual` (and
   the no-`-a` default of `manual`) all succeed as before. Verifiable: a
   positive unit test per canonical adapter.

4. **Legacy `agent-claude` / `agent-codex` adapter code is removed.**
   `src/adapters/agent-claude.ts`, `src/adapters/agent-codex.ts`, and
   `src/adapters/agent-session.ts` are deleted, along with their registration
   in `src/adapters/index.ts`'s `adapters` record and any now-dead imports.
   The session-sweeper code that exists only to harvest these modes' tmux
   sessions (`agent-claude` / `agent-codex` branches in `src/sessions/sweep.ts`
   and `src/sessions/sweep-state.ts`) is removed or narrowed so `SweepMode` no
   longer includes the dropped modes. Verifiable: `grep -rn "agent-claude\|agent-codex"`
   over `src/` returns no live (non-test, non-historical-comment) references to
   the adapter modules; `bun test` passes; the project typechecks.

5. **`claude-ai` and `chatgpt-com` remain registered but surface
   `NOT IMPLEMENTED YET`.** These two stay in the `adapters` record (so
   `readAdapterState` and friends don't throw "adapter not found" for legacy
   bookmark slots), but their `start` (at minimum) throws or returns a clear
   `NOT IMPLEMENTED YET` message rather than a generic bookmark failure. They
   are *not* in `VALID_ASSIGN_ADAPTERS`, so `-a claude-ai` is rejected at
   assign time per AC 1.

6. **Stale task frontmatter is migrated.** The task `*.md` files in
   `harness/tasks/` that carry a phantom `adapter:` value (`agent-claude`,
   `agent-codex`, `agent-pair-codex`, `agent-pair-claude`, `agent-duo`,
   `claude-code`) have that field rewritten to `adapter: null`. This lands as
   its own commit in the PR, separate from the code change, so the data diff
   is auditable. Verifiable: after the migration commit,
   `grep -rn "^adapter: \(agent-\|claude-code\)" harness/tasks/` returns
   nothing.

   ### AC verification reachability — `harness/tasks/` is outside the project git context

   `harness/tasks/*.md` lives in the harness state repo
   (`$LUDICS_STATE_PATH`), not in `git -C /Users/lukstafi/ludics`. The
   frontmatter-migration commit therefore lands in the **harness** repo, and
   the AC's primary evidence must be a find/grep over the harness tasks
   directory, not a commit SHA from the ludics project tree:
   - Pre-state: `grep -rln '^adapter: \(agent-\|claude-code\)' "$LUDICS_STATE_PATH/tasks/"`
     → the ~12 affected files.
   - Post-state: the same `grep` → expected empty.
   - Optional secondary evidence: the harness-side commit SHA for the
     frontmatter rewrite, only if the harness sync has run — not load-bearing.

7. **`ludics slot N reset` clears the interrupted state.** A new
   `slot <n> reset` subcommand sets the slot's `liveness` to `null` and
   `sessionStarted` to `null` for *any* adapter mode (no adapter dispatch, no
   process kill), journals the event, and emits a structured event. It
   succeeds on a slot in `liveness: interrupted` (and `escalated`) and is a
   no-op-safe call on an already-clean slot. The subcommand is documented in
   the `USAGE` help text in `src/index.ts`. Verifiable: assign a slot, mark it
   via `markSlotSetupFailed`, run `ludics slot N reset`, confirm the slot file
   shows `liveness: null` / `sessionStarted: null`; a unit test asserts the
   same.

8. **Help text reflects the canonical adapter set.** The `slot <n> assign`
   line (and `preempt`) in `src/index.ts`'s `USAGE` mentions that `-a` accepts
   `tmux`, `t3code`, or `manual`.

## Context

### Assign-time parsing and the missing validator

- **`runSlot` in `src/slots/index.ts`**, the `case "assign":` branch — parses
  `-a <adapter>` into a free `adapter` string (default `"manual"`). The only
  adapter check today is structural: orchestration flags
  (`--pair`/`--coder`/etc.) require `adapter === "t3code" || "tmux"` and the
  adapter must match `globalAdapter()`. There is no allow-list. The natural
  spot for a fast-fail validator is the top of `case "assign":`, before any
  side-effecting work — but per AC 2 the load-bearing validator belongs in
  `slotAssign` itself so programmatic callers are covered by the same funnel.
- **`slotAssign(slotNum, taskOrDesc, adapter, ...)` in `src/slots/index.ts`** —
  writes `data.mode = adapter` straight into the slot JSON. Note its existing
  `switch (adapter)` block (`case "agent-claude": case "agent-codex": case
  "manual": ...`) that picks a default `session` string; the `agent-*` cases
  there become dead once those modes are dropped and should be removed.
- **`case "preempt":` in `runSlot`** also takes `-a` and funnels into
  `slotPreempt` → `slotAssign`, so it's covered by the `slotAssign`-level
  validator.
- **Existing constant precedent** — `VALID_CLEAR_STATUSES` in
  `src/slots/index.ts` (used by `case "clear":` with an `includes` check and a
  `(use: ...)` error message) is the exact shape to mirror for
  `VALID_ASSIGN_ADAPTERS`.

### Adapter registry and the legacy modes

- **`src/adapters/index.ts`** — the `adapters: Record<string, Adapter>` maps
  `agent-claude`, `agent-codex`, `claude-ai`, `chatgpt-com`, `manual`,
  `t3code`, `tmux`. `getAdapter` throws `adapter not found: ${mode}` for
  unregistered strings. `ADAPTER_NAMES` is the registry superset (registered ≠
  assignable).
- **`src/adapters/agent-claude.ts` / `agent-codex.ts`** — thin wrappers that
  call `createAgentSessionAdapter({ command: "agent-claude" | "agent-codex",
  ... })` in **`src/adapters/agent-session.ts`**. `agent-session.ts`'s `start`
  shells out via `safeSyncOutput([cfg.command, task, "--bare"], ...)` — the
  missing-binary failure mode. All three files are deletable per AC 4.
- **`src/adapters/claude-ai.ts` / `chatgpt-com.ts`** — thin wrappers over
  `src/adapters/bookmark.ts` (`bookmarkStart` / `bookmarkReadState` / etc.).
  Per AC 5 these stay registered; the cleanest change is to make their `start`
  (and arguably `stop`) throw `NOT IMPLEMENTED YET` rather than touching
  `bookmark.ts`'s shared logic.

### Session sweeper coupling

- **`src/sessions/sweep-state.ts`** — `SweepMode = "agent-claude" |
  "agent-codex" | "t3code"` and the `SWEEP_TARGET_MODES` set. `registerKnownSessions`
  / `loadSessionSweepState` filter on this set. With the agent modes gone,
  `SweepMode` narrows to `"t3code"` (or whatever else is still swept);
  `defaultCleanupCommand`'s non-t3code branch (`[mode, "cleanup", name]`)
  becomes dead.
- **`src/sessions/sweep.ts`** — `agentPrefixes(mode)` returns `["claude-",
  "agent-claude-"]` / `["codex-", "agent-codex-"]` for the agent modes;
  `collectAttachedKeys` / `knownSessionStillPresent` branch on non-t3code
  modes. These branches become dead once `SweepMode` no longer includes them.
  `agent-session.ts` calls `registerKnownSessions` — that call site disappears
  with the file.
- Test files referencing the agent modes — `src/adapters/agent-session.test.ts`,
  `src/sessions/sweep.test.ts` (if present), `src/adapters/markdown.test.ts`,
  `src/adapters/task-launch.test.ts`, `src/dashboard.test.ts`,
  `src/mag.test.ts` — will need their agent-mode fixtures updated or removed.
  Note `src/mag.test.ts` tests `normalizeLaunchAdapter("agent-claude") ===
  "t3code"`: that's a *launch-notification* normalizer (legacy notification
  text → adapter), a different concern from the assign-time validator — decide
  per-test whether the legacy-string mapping still has a reason to exist.
  Mind bun's test-discovery drift when adding/removing `*.test.ts` files.
- **Unrelated, do not touch**: `.agent-sessions/` directory references
  (`src/adapters/peer-sync.ts`, `src/orchestration/*`, etc.) are the
  peer-sync session registry — a different mechanism from the `agent-claude`
  adapter module. Only the `agent-claude` / `agent-codex` *adapter* code is in
  scope.

### Interrupted-state recovery

- **`markSlotSetupFailed` in `src/slots/index.ts`** — sets
  `liveness = "interrupted"`, `sessionStarted = null`, drops the task status
  back to `ready`. `maybeAutoStartSlots` in `src/mag.ts` skips slots with
  `liveness === "interrupted" || "escalated"`.
- **`slotResume` in `src/slots/index.ts`** — throws `slot N has Mode=${mode} —
  resume only supports t3code and tmux` for non-orchestrated modes; this is
  the trap that strands operators with phantom adapters. The new `reset` verb
  is the documented escape hatch.
- **`setSlotLivenessOnData(data, value)` in `src/slots/index.ts`** — the
  mutator-only liveness writer; `slot reset` should use it (`setSlotLivenessOnData(data, null)`).
- The `case "reset":` branch in `runSlot` slots in next to `case "clear":` /
  `case "mode":`; `slotReset(slotNum)` mirrors the structure of
  `markSlotSetupFailed` (read slot, guard `(empty)`, mutate liveness +
  `sessionStarted`, `writeSlotJson`, `journalAppend`, `emitEvent`,
  `stateMarkDirty`) but performs no task-status flip and no adapter dispatch.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

This task has three separable but cohesive concerns; the user explicitly
scoped them into one PR. Suggested commit structure inside the PR:

1. **Adapter validation + `claude-ai`/`chatgpt-com` NOT-IMPLEMENTED** — add
   `VALID_ASSIGN_ADAPTERS` and the `slotAssign` validator (plus an optional
   early CLI check); make the two bookmark adapters' `start` throw
   `NOT IMPLEMENTED YET`. Tests in `src/slots/index.test.ts`.
2. **Remove `agent-claude`/`agent-codex`** — delete the three adapter files,
   de-register in `src/adapters/index.ts`, narrow `SweepMode` and prune the
   dead sweeper branches, clean up the `switch (adapter)` `agent-*` cases in
   `slotAssign`, fix up affected tests.
3. **`slot N reset`** — `slotReset` function + `case "reset":` in `runSlot` +
   `USAGE` help line. Test in `src/slots/index.test.ts`.
4. **Frontmatter migration** — separate commit in the **harness** repo (not
   the ludics repo): rewrite phantom `adapter:` values to `null` in the ~12
   affected `harness/tasks/*.md` files. A throwaway one-pass `sed`/script is
   fine; a committed `ludics tasks migrate-adapter-modes` subcommand is *not*
   required (user's call: "Coder's call on whether a tiny script helps
   auditability" — default to no new subcommand).

## Scope

**In scope:**
- Assign-time adapter validation (`VALID_ASSIGN_ADAPTERS` + `slotAssign` guard,
  optional CLI early-fail).
- Deleting `agent-claude` / `agent-codex` / `agent-session` adapter modules and
  all their now-dead wiring (registry, sweeper, `slotAssign` switch cases,
  affected tests).
- `claude-ai` / `chatgpt-com` `NOT IMPLEMENTED YET` surfacing.
- `ludics slot N reset` subcommand + help text.
- Harness `tasks/*.md` frontmatter migration (separate commit).

**Out of scope:**
- A Translate alias table for `agent-pair-*` → `tmux + --pair ...` (user chose
  Reject; Q3 moot).
- A committed `ludics tasks migrate-adapter-modes` subcommand (one-pass rewrite
  is enough).
- Dashboard-HTTP-path-specific test assertions beyond the shared `slotAssign`
  funnel (user: unit coverage at `slotAssign`/`runSlot` is sufficient).
- Removing `claude-ai` / `chatgpt-com` adapter modules (they stay registered).
- Changes to `normalizeLaunchAdapter`'s legacy launch-notification mapping
  unless its agent-mode cases become genuinely dead.

**Dependencies:** none blocking. Builds on the validator pattern established
by gh-ludics-411 (`status: done`).

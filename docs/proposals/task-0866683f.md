# Auto-complete test-failure containers when children resolve

## Goal

Test-failure umbrella containers ("Fix broken test suite: <proj>", filed by
`fileTestFailureEpisode`, gh-ludics-605) should close **automatically** once all
their failure-episode children resolve, so the next failure cleanly re-opens the
container and files a fresh dated child with no human step. Today the
all-children-resolved sweep routes these through
`/ludics-verify-container-completion`, which by contract only *notifies* and
never transitions — so a fixed suite's container sits `ready` with every child
resolved until the user closes it by hand. The user flagged this on 2026-06-25
after manually closing three verified-green containers (task-bb30d0be OCANNL,
task-6f65bba0 Ludics, task-3c984849 Curious-OCaml): "For tests we want the
containers marked done **automatically**, so new failures create new tasks.
Verification is for open-ended containers."

## Acceptance Criteria

- A test-failure container created by `fileTestFailureEpisode` carries a
  frontmatter flag identifying it as an auto-complete (test-suite) container.
  The flag is stamped at **all three** sites where the function currently writes
  `leaf: false` (fresh-create, terminal-revive, and non-terminal/no-active-child
  branches) — alongside the existing `addFrontmatterField(res.path, "leaf",
  "false")` calls.
- When `containerCompletionSweep` finds a **flagged** container with at least one
  child and every child in a terminal status, it transitions the container
  directly to `done` and emits a `container_auto_completed` event. It does **not**
  enqueue `verify-container-completion` for that container.
- When the sweep finds an **unflagged** `leaf: false` container in the same
  all-children-terminal state, today's behavior is unchanged: it enqueues
  `verify-container-completion` (notify-and-defer).
- A flagged container is not re-closed on every sweep. (Once `done`, it is in
  `TERMINAL_FOR_PARENT`, so the next sweep skips it — no extra debounce needed.)
- On the next failure after auto-completion, `fileTestFailureEpisode`'s revive
  branch flips the `done` container back to `ready`, re-stamps the flag, and
  files a fresh `ready` child; the sweep then sees a non-all-terminal container
  and only re-auto-completes once that new child resolves. The
  `resolve → done → revive-on-next-failure` lifecycle closes cleanly.
- A flagged container with **zero** children is never auto-completed (the
  sweep's existing `children.length === 0` guard is preserved for both paths).
- The flag is only ever set by `fileTestFailureEpisode`; no other code path
  stamps it onto genuinely open-ended `leaf: false` umbrella containers.
- The three already-`done` containers the user closed by hand
  (task-bb30d0be, task-6f65bba0, task-3c984849) need no migration: their next
  failure's revive branch stamps the flag, so they self-heal onto the
  auto-complete path.
- Tests cover the flag stamping (`src/health.test.ts`) and the sweep's
  flagged-vs-unflagged branch (`src/tasks/sync.test.ts`), including the
  no-children and revive-clears-state cases.

## Context

Two collaborating modules, both already importing everything the change needs:

- **`src/health.ts` — `fileTestFailureEpisode(projectName, failures)`**
  (~line 219). Creates/ensures the per-project container via
  `tasksCreate("Fix broken test suite: <proj>")` and promotes it with
  `addFrontmatterField(res.path, "leaf", "false")` at three sites: the
  `res.created` fresh-create branch (~223), the
  `TERMINAL_STATUSES.includes(status)` revive branch (~233), and the
  non-terminal/no-active-child branch (~242). Children are dated episodes filed
  `subtask_of` via `createEpisodeChild` + `setDependencyScalar`.
  `hasActiveChild` (~248) keys "in flight" on `CHILD_RESOLVED_STATUSES`
  (= `TERMINAL_STATUSES`). `addFrontmatterField` is already imported (line 6).

- **`src/tasks/sync.ts` — `containerCompletionSweep(taskMap)`** (~line 746),
  called from `tasksReconcileBlockedStatus`. It walks `leaf: false` parents
  (`entry.fm.leaf !== false`), skips parents already in `TERMINAL_FOR_PARENT`
  (done/abandoned/merged/stale/needs-confirmation/in-progress/deferred/
  preempt-queued/preempted), computes a child-set fingerprint, and — when every
  child is in `TERMINAL_FOR_CHILD` (= `TERMINAL_STATUSES`) — calls
  `queueRequest({ action: "verify-container-completion", task: parentId })`
  and `emitEvent({ event_type: "container_completion_queued", ... })`. `TaskMap`
  entries are `{ status, filePath, fm }` (type at line 670), so the branch has
  the container's `filePath` and current `status` in hand for a direct
  `transitionStatus(entry.filePath, entry.status, "done")`. `transitionStatus`,
  `addFrontmatterField`, and `emitEvent` are all already imported in `sync.ts`.

- **Sentinel/debounce** helpers (`containerCompletionDebounced` /
  `markContainerCompletionQueued` / `clearContainerCompletionSentinel` /
  `read|writeContainerCompletionFingerprint`, backed by
  `mag/container-completion-checked/<parentId>.epoch` + `.children`) already
  reset the sentinel whenever the fingerprint differs, covering the
  revive → fresh-child case for free.

- **`verify-container-completion`** is by contract notify-only — its handler and
  the delivery-time guard (`mag.ts` ~615) re-check `containerChildrenAllTerminal`
  but never transition the container. That contract is unchanged; this proposal
  just stops routing *test-suite* containers to it.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

1. **Flag name: `container_kind: "test-suite"`** (string enum). Recommended over
   a bare `auto_complete: true` boolean purely for forward extensibility — only
   `fileTestFailureEpisode` creates `leaf: false` containers today, so a boolean
   would also suffice. The sweep reads it the same way `entry.fm.leaf !== false`
   is read (`parseTaskFrontmatter` passes arbitrary frontmatter through, so
   `entry.fm.container_kind === "test-suite"`).

2. In `fileTestFailureEpisode`, add the flag stamp alongside each of the three
   existing `addFrontmatterField(res.path, "leaf", "false")` calls. Missing the
   revive-branch stamp would leave revived containers unflagged and back on the
   notify path, so all three are required.

3. In `containerCompletionSweep`, at the all-terminal point (after the
   `if (!allTerminal) continue;` check, ~line 790), branch on the flag:
   - **flagged** (`entry.fm.container_kind === "test-suite"`):
     `transitionStatus(entry.filePath, entry.status, "done")` and
     `emitEvent({ event_type: "container_auto_completed", source: "sync",
     scope: "task", task: parentId, message: "<n> child(ren) all terminal — auto-completed" })`.
     Do **not** call `queueRequest`/`markContainerCompletionQueued`/
     `writeContainerCompletionFingerprint` for this path. Pass the entry's
     current status as the `expectedFrom` arg; `transitionStatus` no-ops if the
     status isn't the expected `from`, which is fine (container may legitimately
     be `ready`/`blocked`).
   - **unflagged**: keep the existing
     `queueRequest("verify-container-completion") + markContainerCompletionQueued
     + writeContainerCompletionFingerprint + container_completion_queued` block
     verbatim.

   Re-fire suppression for the auto-complete path falls out for free: once the
   container is `done` it is in `TERMINAL_FOR_PARENT`, so the next sweep
   `continue`s past it; the auto-complete branch needs no own debounce.

## Scope

In scope: the flag stamp in `fileTestFailureEpisode`, the flagged-vs-unflagged
branch in `containerCompletionSweep`, the `container_auto_completed` event, and
tests. Out of scope: changing the `verify-container-completion` skill itself (its
notify-only contract stays for genuinely open-ended containers), any backfill
migration of the three already-`done` containers (they self-heal on next
failure), and generalizing the flag to other auto-filers (none exist today). No
new imports are needed in either file. No dependencies on other tasks.

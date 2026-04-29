# Auto-recover from orphan worktree directories in addWorktree and deferred cleanup

## Goal

Close the recurring "orphan worktree directory" failure mode where
`<repo>-<task>(-s<slot>)/` exists on disk but git no longer knows it as a
registered worktree, blocking the next `slot start` with
`fatal: refusing to reuse non-worktree path: ...`. Recovery today is manual:
move `.peer-sync` / `.claude` / `.ludics-orchestration.json` aside, `rmdir` the
empty parent, `git worktree add ...`, move scaffolding back. Automate that path
in `addWorktree`, and harden the deferred-cleanup loop so the inverse case
(unregistered-but-extant directory left behind by `removeWorktreeByPath`)
doesn't reappear later.

The bug was first surfaced in `task-ab90fcb7`'s retrospective and
independently observed by Mag during slot 1 start on 2026-04-28. This proposal
pairs the source-side fix with the cleanup-side hardening so the loop is
closed in a single PR.

## Acceptance Criteria

- `addWorktree(projectDir, path, branch, base)` in
  `src/orchestration/worktrees.ts`, when `existsSync(path)` is true and
  `worktreeExists(projectDir, path)` is false, inspects the directory contents
  and:
  - **If contents are a subset of the recovery allow-list** (`.peer-sync`,
    `.claude`, `.ludics-orchestration.json`, `node_modules`, plus an optional
    `.DS_Store` which is silently `rm`'d): moves the orchestration entries to
    a sibling temporary directory, removes the now-empty path, runs
    `git worktree add ...`, then moves the orchestration entries back into
    place. The slot start proceeds normally.
  - **Otherwise** (any unrecognized entry, e.g. user files or build output):
    throws a clearer error message that names the orphan path and the offending
    entries, and tells the operator that manual recovery is needed. The
    existing `refusing to reuse non-worktree path: ${path}` text is replaced
    by something like
    `orphan worktree-directory detected at ${path} with non-orchestration content (${list}); manual recovery needed`.
- `processDeferredCleanups()` in `src/orchestration/deferred-cleanup.ts`,
  after each `removeWorktreeByPath(entry.projectDir, path)` call: if the
  directory still exists and is a subset of the same recovery allow-list (so
  the `removeIfRegistered` no-op'd because git doesn't know it but scaffolding
  still sits there), remove the orchestration entries directly and `rmdir` the
  parent — bringing the directory to a state where future `slot start` does
  not need the `addWorktree` recovery path. Failure of this best-effort fallback
  logs to `console.error` and is not fatal (does not push the entry back into
  `remaining`).
- The recovery allow-list is defined once and shared by both call sites
  (e.g. a small constant alongside `GIT_EXCLUDE_ENTRIES` in `worktrees.ts`).
  `.DS_Store` is treated as silently-removable noise but is NOT part of the
  allow-list itself — it never causes recovery to *succeed* on its own; it
  just doesn't *block* recovery.
- A unit test in `src/orchestration/worktrees.test.ts` constructs an orphan
  layout (a real git repo plus a sibling directory containing only allow-list
  entries) and asserts that `addWorktree` (or, by extension, `createWorktrees`)
  recovers cleanly: the directory is registered as a worktree afterwards, and
  the orchestration files are still in place. A second test asserts that an
  orphan directory containing an unrecognized entry causes the throw with the
  new message and leaves the directory untouched.
- A unit test in `src/orchestration/deferred-cleanup.test.ts` exercises the
  hardening path: simulates the "directory exists with allow-list contents but
  no git registration" state and asserts that `processDeferredCleanups` removes
  the directory, rather than silently no-op'ing.
- Both halves of the loop are covered by `bun test` and the change passes
  `bun run build` and `bun run lint`.

## Context

**`addWorktree` today** (`src/orchestration/worktrees.ts:206`):

```ts
function addWorktree(projectDir: string, path: string, branch: string, base: string): void {
  removeIfRegistered(projectDir, path);
  if (existsSync(path)) {
    throw new Error(`refusing to reuse non-worktree path: ${path}`);
  }
  // ... git show-ref + git worktree add ...
}
```

The throw is the exact failure point operators hit. `removeIfRegistered`
silently no-ops if the path is not in `git worktree list --porcelain`, which
is the orphan condition: registration was pruned (manually or by git's
internal `prune` heuristics), but the directory and its scaffolding remain.

**The known scaffolding entries** are already enumerated in
`GIT_EXCLUDE_ENTRIES` (same file, just above). The recovery allow-list is a
narrower subset: only those entries the orchestrator itself writes into a
worktree root before agents start touching files. That's `.peer-sync`,
`.claude`, `.ludics-orchestration.json`, and the `node_modules` symlink.
`.agents`, `.agent-sessions`, and `_build_review*` are *not* on the recovery
list — `.agents` and `_build_review*` indicate agent work-product, and
`.agent-sessions` is a sibling-of-`projectDir` symlink target, not a worktree
entry.

**Why the orphan happens at all.** The Tentative Design in
`tasks/task-d2a16a60.md` traced this through:

- `git worktree prune` runs implicitly during normal `git worktree add` /
  `git fetch` and can drop the registration if the directory briefly
  disappears or git's heuristics decide the admin record is stale.
- The deferred-cleanup path (`processDeferredCleanups` →
  `removeWorktreeByPath` → `removeIfRegistered` → `git worktree remove --force`)
  silently no-ops if the worktree is already unregistered, leaving the
  directory contents in place.
- macOS partial-removal: `git worktree remove --force` may fail to wipe a
  `.peer-sync/<file>` held open by a still-running agent process, and
  `safeSyncOutput`-wrapped git commands swallow non-fatal exit codes.

The `addWorktree` recovery handles the *next* slot start; the
`processDeferredCleanups` hardening prevents the same orphan from being
re-seeded by the same code path on every cleanup cycle.

**Where the cleanup-side hardening goes.** In `processDeferredCleanups`
(`src/orchestration/deferred-cleanup.ts`), the worktree-removal block iterates
`entry.worktreePaths` and calls `removeWorktreeByPath(entry.projectDir, path)`.
The new fallback runs immediately after each such call: if `existsSync(path)`
is still true and the contents match the allow-list, manually remove them and
`rmdir`. `removeWorktreeByPath` itself stays unchanged — it has its own naming
guard and is called from other sites we don't want to touch.

**Constraints on the recovery move.** The orchestration entries must be moved
*off* the path before `git worktree add` runs (git refuses to add into a
non-empty directory). Use a sibling temp dir (e.g. `${path}.orphan-recover`)
created next to the parent worktree dir, so the move is intra-filesystem
(`renameSync`-eligible). After `git worktree add` succeeds, move the entries
back. If anything fails mid-recovery, surface a clear error — do not silently
leave the operator with half-moved scaffolding.

**Symlink handling.** `node_modules` is a symlink in normal flow (created by
`createWorktrees`). `renameSync` on a symlink moves the link itself, not the
target — that's the desired behavior. `.peer-sync` may also be a symlink in
duo mode; the same property holds.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

1. **Add the recovery allow-list constant** alongside `GIT_EXCLUDE_ENTRIES`
   in `src/orchestration/worktrees.ts`:

   ```ts
   /** Entries the orchestrator may write into a worktree root before any
    *  agent commits. Used by the orphan-recovery path in addWorktree and the
    *  cleanup-hardening path in processDeferredCleanups. */
   const ORPHAN_RECOVERY_ALLOWLIST = [".peer-sync", ".claude", ".ludics-orchestration.json", "node_modules"] as const;
   ```

2. **Add a small helper** (also in `worktrees.ts`) that classifies a directory:

   ```ts
   /** Returns "recoverable" with the entries to preserve when the dir contents
    *  are a subset of the allow-list (after silently dropping `.DS_Store`),
    *  "unrecognized" with the offending entries otherwise. */
   function classifyOrphanDir(path: string): { kind: "recoverable"; preserve: string[] } | { kind: "unrecognized"; offending: string[] };
   ```

3. **Inline recovery in `addWorktree`**, replacing the existing throw:

   ```ts
   if (existsSync(path)) {
     const c = classifyOrphanDir(path);
     if (c.kind === "unrecognized") {
       throw new Error(`orphan worktree-directory detected at ${path} with non-orchestration content (${c.offending.join(", ")}); manual recovery needed`);
     }
     // Move preserved entries aside, rmdir, git worktree add, move back.
     recoverOrphan(path, c.preserve, () => {
       const branchExists = ...; // existing show-ref check, hoisted into the recover callback
       // existing git worktree add invocation
     });
     return;
   }
   ```

   Keep the recovery helper local to `worktrees.ts` (no new module).

4. **Hardening in `processDeferredCleanups`**: after each
   `removeWorktreeByPath(entry.projectDir, path)`, add a best-effort block
   that calls `classifyOrphanDir(path)` and, if `recoverable`, removes the
   allow-list entries plus the parent. Wrap in try/catch, log on failure, do
   not flip `failed = true` (this is best-effort defense-in-depth, not an
   operation the entry depends on).

5. **Tests**:
   - Add `src/orchestration/worktrees.test.ts` cases that build a real git
     repo (using the existing `run`/`mkdirSync` helpers in the file), seed an
     orphan directory at the expected path with allow-list contents, then
     call `addWorktree`/`createWorktrees` and assert recovery. Mirror with an
     unrecognized-content case asserting the new error.
   - Add a `src/orchestration/deferred-cleanup.test.ts` case that builds the
     orphan state (no git registration) and asserts the directory is gone
     after `processDeferredCleanups`.

6. **Build & verify**: `bun run build && bun test && bun run lint`.

## Scope

**In scope.**

- `src/orchestration/worktrees.ts`: allow-list constant, `classifyOrphanDir`
  helper, recovery branch inside `addWorktree`, error message rewrite.
- `src/orchestration/deferred-cleanup.ts`: best-effort fallback after
  `removeWorktreeByPath` in `processDeferredCleanups`.
- New tests in `worktrees.test.ts` and `deferred-cleanup.test.ts`.

**Out of scope.**

- Refactoring `addWorktree` into a separate `recoverOrphanWorktree(path)`
  pre-step at the top of `createWorktrees` (rejected during elaboration —
  inline keeps fewer moving parts).
- Tolerating any unrecognized entries beyond `.DS_Store` (rejected during
  elaboration — conservative scope).
- Changes to `removeWorktreeByPath` itself, or to the orchestration naming
  guard. The hardening sits *around* `removeWorktreeByPath` in the cleanup
  loop, not inside it.
- Changes to `slotStart`, `slotResume`, or the adapters' start paths beyond
  what `addWorktree` already provides indirectly.
- Live-session safety beyond what the existing flow guarantees: this proposal
  recovers from *stale* orphans, not from concurrent in-flight orchestrations
  (the deferred-cleanup delay window already handles that case).

**Dependencies.** None hard. `task-ab90fcb7` is the ancestor incident
(merged); this task is the systemic fix.

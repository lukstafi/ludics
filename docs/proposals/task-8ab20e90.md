# Consolidate peer-sync dir resolution: extract shared resolvePeerSyncDir helper

## Goal

The `.peer-sync` directory name and resolution logic are duplicated across
multiple TypeScript files and the shell stop hook. This creates a maintenance
burden and risks drift between resolution strategies. Consolidating into a
shared helper and constant eliminates duplication and makes the resolution
order authoritative in one place.

## Acceptance Criteria

- A single `resolvePeerSyncDir` helper exists in `src/orchestration/peer-sync.ts`
  that encapsulates resolution: CLI arg (validated) > `LUDICS_PEER_SYNC_DIR` env
  var (validated) > `null`.
- A `PEER_SYNC_DIRNAME` constant (`".peer-sync"`) is exported from
  `src/orchestration/peer-sync.ts`.
- `orchOnStop()` in `src/orchestration/index.ts` calls the shared helper instead
  of inline resolution logic (lines 127-134).
- `src/adapters/agent-session.ts` uses `PEER_SYNC_DIRNAME` instead of hardcoded
  `".peer-sync"` strings (lines 196, 277).
- `src/adapters/base.ts` `resolveProjectDir()` uses `PEER_SYNC_DIRNAME` instead
  of hardcoded `".peer-sync"` strings (lines 201, 202, 206).
- `src/orchestration/worktrees.ts` uses `PEER_SYNC_DIRNAME` instead of hardcoded
  `".peer-sync"` in `GIT_EXCLUDE_ENTRIES` (line 38), `createWorktrees` (line 130),
  and `symlinkPeerSync` (line 186).
- The shell stop hook (`templates/hooks/ludics-on-stop.sh`) has a comment
  documenting that its resolution order mirrors the TypeScript helper.
- Existing tests pass; no behavioral changes.

## Context

**Current duplication sites:**

1. **`src/orchestration/peer-sync.ts`** — Already the home for peer-sync
   utilities (`initPeerSync`, `writePeerSync`, `readAgentStatus`, etc.) but does
   not yet export the dirname constant or a resolution helper.

2. **`src/orchestration/index.ts:127-134`** — `orchOnStop()` resolves the
   peer-sync dir inline with 2-tier fallback: CLI arg (validated by checking for
   `phase` file) > `LUDICS_PEER_SYNC_DIR` env var (validated same way) > give up.
   Uses `readFileIfExists` from a local import pattern (not from peer-sync.ts).

3. **`src/orchestration/worktrees.ts`** — Three occurrences of `".peer-sync"`:
   - Line 38: `GIT_EXCLUDE_ENTRIES` array
   - Line 130: `join(rootWorktree, ".peer-sync")` in `createWorktrees()`
   - Line 186: `join(worktreePath, ".peer-sync")` in `symlinkPeerSync()`

4. **`src/adapters/agent-session.ts`** — Two occurrences:
   - Line 196: `join(sessionInfo.workdir, ".peer-sync", cfg.statusFileName)`
   - Line 277: same pattern in `lastActivity()`

5. **`src/adapters/base.ts:194-208`** — `resolveProjectDir()` has three
   occurrences of `".peer-sync"` in `existsSync` checks.

6. **`templates/hooks/ludics-on-stop.sh`** — Shell script with a 3-tier fallback
   (env var > marker file > deprecated directory walk-up). Cannot share TypeScript
   code, but should document alignment.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

1. Add to `src/orchestration/peer-sync.ts`:
   - `export const PEER_SYNC_DIRNAME = ".peer-sync";`
   - `export function resolvePeerSyncDir(opts: { cliArg?: string }): string | null`
     implementing: CLI arg (has `phase` file) > `LUDICS_PEER_SYNC_DIR` env var
     (has `phase` file) > `null`. Validation uses `readFileIfExists` or equivalent.

2. Update all consumer files to import `PEER_SYNC_DIRNAME` and/or
   `resolvePeerSyncDir` from `peer-sync.ts`, replacing inline logic and
   hardcoded strings.

3. Add a comment block to `ludics-on-stop.sh` documenting the canonical
   resolution order and noting it mirrors the TypeScript helper.

4. Verify existing tests pass unchanged.

## Scope

**In scope:**
- Extracting `PEER_SYNC_DIRNAME` constant and `resolvePeerSyncDir` helper
- Updating all TypeScript consumers to use the shared exports
- Documenting alignment in the shell hook
- Unit test for the new `resolvePeerSyncDir` helper

**Out of scope:**
- Changing the shell hook's actual resolution logic (it can't import TypeScript)
- Changing resolution behavior or priority order
- Refactoring the marker-file walk-up logic (that lives only in the shell hook)

**Dependencies:** Relates to task-41f81ece (env-var fallback for `orchOnStop`).

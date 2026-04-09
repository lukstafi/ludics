# Unify findProjectConfigByName into config.ts and thread config through keepalive helpers

## Goal

Eliminate duplicated project-lookup logic by moving `findProjectConfigByName` from `mag.ts` to `config.ts` as a shared helper, and reduce redundant `loadConfigSync()` calls in the keepalive hot path by threading a pre-loaded config through `getSortedReadyCandidates`, `maybeFillEmptySlots`, and `maybeQueueProposals`.

## Acceptance Criteria

- `findProjectConfigByName` is exported from `config.ts`, accepting a project name and optional config, returning `ProjectConfig | null`
- `mag.ts` imports and uses the shared helper; its local copy is deleted
- `getSortedReadyCandidates(config?: LudicsFullConfig)` accepts an optional config parameter (falls back to `loadConfigSync()` when omitted for backward compatibility)
- `maybeFillEmptySlots(config?: LudicsFullConfig)` and `maybeQueueProposals(config?: LudicsFullConfig)` accept and forward config
- `magStart()` keepalive block loads config once and passes it to both `maybeQueueProposals` and `maybeFillEmptySlots`
- No breaking changes: all functions retain their no-argument signatures via defaults
- All existing tests pass without modification (pure refactoring, no behavior changes)

## Context

Source: retrospective of `task-323c2d02`, filed as `task-7f3b9c6c`.

**Problem 1 -- Duplicate lookup logic:**
`findProjectConfigByName` at `mag.ts:2231` matches projects by name or repo-tail, duplicating the name/repo-tail branch of `findProjectConfig` at `config.ts:281-283`. Three call sites in mag.ts use it (lines 1003, 2316, and indirectly through `getSortedReadyCandidates`).

**Problem 2 -- Redundant config reads:**
In the `magStart` keepalive loop (lines 2758, 2770), `maybeQueueProposals()` and `maybeFillEmptySlots()` each call `getSortedReadyCandidates()`, which calls `loadConfigSync()` independently. This results in two redundant YAML file reads per keepalive cycle.

## Approach

### Step 1: Extract `findProjectConfigByName` to config.ts

Add to `config.ts` (after `findProjectConfig`):

```typescript
export function findProjectConfigByName(
  projectName: string,
  config?: LudicsFullConfig,
): ProjectConfig | null {
  if (!projectName) return null;
  const cfg = config ?? loadConfigSync();
  const key = projectName.toLowerCase();
  return (cfg.projects ?? []).find((p) => {
    const repoTail = (p.repo.split("/").pop() ?? "").toLowerCase();
    return p.name.toLowerCase() === key || repoTail === key;
  }) ?? null;
}
```

Return type is `ProjectConfig | null` (stronger than the current local version which returns a partial type). This is safe since all call sites only access `.requirements`.

### Step 2: Update mag.ts imports and delete local copy

- Add `findProjectConfigByName` to the import from `./config.js`
- Delete the local `findProjectConfigByName` function (lines 2231-2238)
- Update the call site at line 1003 (already passes `cfg`, now passes it as the second arg)
- Update the call site at line 2316 (same pattern)

### Step 3: Thread config through the call chain

1. `getSortedReadyCandidates(config?: LudicsFullConfig)` -- use parameter if provided, else `loadConfigSync()`
2. `maybeQueueProposals(config?: LudicsFullConfig)` -- forward to `getSortedReadyCandidates(config)`
3. `maybeFillEmptySlots(config?: LudicsFullConfig)` -- forward to `getSortedReadyCandidates(config)`
4. In `magStart` keepalive block (around lines 2758-2770):
   ```typescript
   const cfg = loadConfigSync();
   maybeQueueProposals(cfg);
   // ... other calls in between ...
   maybeFillEmptySlots(cfg);
   ```

All parameters are optional with `loadConfigSync()` fallback, so no callers outside the keepalive path need changes.

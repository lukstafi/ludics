# Proposal: Deduplicate config loading in adapters — share config at call sites

**Task:** task-5b08394c
**Date:** 2026-04-13 (revised)

## Goal

Eliminate redundant `loadConfigSync()` calls in `tmux-adapter.ts` and `t3code.ts` by sharing the already-loaded config object at the relevant call sites, rather than extracting a new helper function.

## Acceptance Criteria

1. The IIFE block in `tmux-adapter.ts` (line ~468) no longer calls `loadConfigSync()` — it uses a config object already available in the enclosing scope.
2. The IIFE block in `t3code.ts` (line ~892) follows the same pattern.
3. No new helper function is introduced — the existing `findProjectConfig(projectDir, cfg)` call is inlined with the shared config.
4. No redundant `loadConfigSync()` calls remain in either adapter's start/launch path.
5. `bun run build` succeeds, all tests pass.

## Context

### Current code (both adapters, identical pattern)

```typescript
upstreamRepo: (() => {
  const cfg = loadConfigSync();
  return findProjectConfig(projectDir, cfg)?.upstream_repo || undefined;
})(),
```

This appears in:
- `src/adapters/tmux-adapter.ts` line ~468 (inside `start()`)
- `src/adapters/t3code.ts` line ~892 (inside `startOrchestrated()`)

Both functions already call `loadConfigSync()` earlier in their scope. The IIFE creates a redundant second load just to look up one field.

## Approach

1. In `tmux-adapter.ts` `start()`: hoist the config load or reuse the existing one. Replace the IIFE with:
   ```typescript
   upstreamRepo: findProjectConfig(projectDir, config)?.upstream_repo || undefined,
   ```
   where `config` is the already-loaded config from earlier in the function.

2. In `t3code.ts` `startOrchestrated()`: same pattern — reuse the config already loaded in scope.

3. If no config variable is in scope at the exact call site, move the `loadConfigSync()` call earlier in the function and store it in a `const config`, then reference it in both the existing usage and the `upstream_repo` lookup.

4. Run `bun run build` and `bun test` to verify.

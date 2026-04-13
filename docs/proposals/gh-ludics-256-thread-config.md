# Proposal: Thread config through adapter helpers to eliminate redundant loadConfigSync calls

**Task:** gh-ludics-256
**Date:** 2026-04-13

## Goal

Eliminate the remaining redundant `loadConfigSync()` calls in the adapter start paths. The keepalive path in `mag.ts` already loads config once and threads it — the remaining work is in the adapters.

## Acceptance Criteria

1. `loadConfigOrchestration()` in both `tmux-adapter.ts` and `t3code.ts` accepts an optional `config?` parameter instead of calling `loadConfigSync()` internally.
2. The `upstreamRepo` IIFE in both adapters is replaced with a direct `findProjectConfig(projectDir, config)?.upstream_repo || undefined` call using config already in scope.
3. No new `loadConfigSync()` calls are introduced.
4. `bun run build` succeeds, all tests pass.

## Context

### Keepalive path — already done

The keepalive block (mag.ts:2655) already loads config once into `keepaliveCfg` and passes it to `maybeQueueProposals` and `maybeFillEmptySlots`. The other keepalive helpers (`maybeAutoStartSlots`, `maybeUnstickAssignedSlots`, `maybeClearDoneSlots`) don't use config at all — no changes needed there.

### Adapter paths — remaining work

Both adapters have two redundant loads each:

**`loadConfigOrchestration()`** (tmux-adapter.ts:146, t3code.ts:637):
Small helper that reads `config.mag.orchestration`. Calls `loadConfigSync()` internally. The callers typically already have or could have config in scope.

**`upstreamRepo` IIFE** (tmux-adapter.ts:470, t3code.ts:894):
```typescript
upstreamRepo: (() => {
  const cfg = loadConfigSync();
  return findProjectConfig(projectDir, cfg)?.upstream_repo || undefined;
})(),
```
Identical pattern in both files. The enclosing function can receive config as a parameter.

Note: this overlaps with task-5b08394c which focuses specifically on the `upstreamRepo` IIFE deduplication. This task covers both that pattern and `loadConfigOrchestration()`.

## Approach

1. **`loadConfigOrchestration(config?)`**: Add optional `config?: LudicsFullConfig` parameter to `loadConfigOrchestration()` in both adapters, with `config ?? loadConfigSync()` fallback.

2. **`upstreamRepo` IIFE**: Replace with inline `findProjectConfig(projectDir, config)?.upstream_repo || undefined` where config is passed from the caller. If config isn't available in the enclosing scope, add it as a parameter to the enclosing start/launch function.

3. **Caller threading**: In the functions that call `loadConfigOrchestration()` and build the slot config object, load config once at the top and pass it through.

### Files to modify

- `src/adapters/tmux-adapter.ts` — `loadConfigOrchestration()` signature, `upstreamRepo` IIFE, caller threading
- `src/adapters/t3code.ts` — same pattern

# Proposal: Deduplicate config loading in adapters — extract resolveUpstreamRepo

**Task:** task-5b08394c
**Date:** 2026-04-09

## Goal

Extract a shared `resolveUpstreamRepo` helper in `config.ts` to eliminate identical IIFE blocks in `tmux-adapter.ts` and `t3code.ts` that redundantly call `loadConfigSync()` just to look up the `upstream_repo` field.

## Acceptance Criteria

1. A new exported function `resolveUpstreamRepo(projectDir: string, config?: LudicsFullConfig): string | undefined` exists in `src/config.ts`.
2. The IIFE block in `tmux-adapter.ts` (lines 468-471) is replaced with a call to `resolveUpstreamRepo(projectDir, cfg)`, where `cfg` is the already-loaded config available in scope (from `loadConfigSync()` call earlier in `start()`).
3. The IIFE block in `t3code.ts` (lines 892-895) is replaced with the same pattern.
4. No redundant `loadConfigSync()` calls are introduced; each adapter reuses config already loaded in the enclosing function scope.
5. Existing behavior is preserved — `upstreamRepo` field on `OrchestrationState` resolves to the same value as before.
6. `bun run build` succeeds with no type errors.

## Context

### Current code (both adapters, identical pattern)

```typescript
upstreamRepo: (() => {
  const cfg = loadConfigSync();
  return findProjectConfig(projectDir, cfg)?.upstream_repo || undefined;
})(),
```

This appears in:
- `/Users/lukstafi/ludics/src/adapters/tmux-adapter.ts` line 468 (inside `start()`)
- `/Users/lukstafi/ludics/src/adapters/t3code.ts` line 892 (inside `startOrchestrated()`)

### Field name status

The task file references `staging_repo` but the codebase has already been renamed to `upstream_repo` (in both `ProjectConfig` interface and adapter usage). The helper should use the current `upstream_repo` name.

### Related helpers in config.ts

- `findProjectConfig(projectDir, config?)` — already accepts optional config
- `resolveProjectPath(projectName)` — similar resolution pattern
- `resolveProposalsPath(projectDir, configuredPath?)` — same structural pattern

## Approach

1. Add `resolveUpstreamRepo` to `src/config.ts` after `findProjectConfig` (around line 286):
   ```typescript
   export function resolveUpstreamRepo(
     projectDir: string,
     config?: LudicsFullConfig,
   ): string | undefined {
     const cfg = config ?? loadConfigSync();
     return findProjectConfig(projectDir, cfg)?.upstream_repo || undefined;
   }
   ```

2. In `tmux-adapter.ts` `start()`: replace the IIFE with `resolveUpstreamRepo(projectDir)`. The function already has `loadConfigSync()` calls in scope via `loadConfigOrchestration()`, but the full config object is not directly available as a variable. The simplest correct change is to call `resolveUpstreamRepo(projectDir)` without passing config — the helper will load it once internally. Alternatively, hoist a `const cfg = loadConfigSync()` earlier in `start()` and pass it through.

3. In `t3code.ts` `startOrchestrated()`: same replacement pattern.

4. Add import of `resolveUpstreamRepo` in both adapter files (it already imports from `../config.ts`).

5. Run `bun run build` to verify.

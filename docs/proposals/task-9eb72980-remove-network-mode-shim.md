# Proposal: Remove network.mode transport compat shim from cluster.ts

**Task**: task-9eb72980
**Date**: 2026-04-09

## Goal

Remove the dead `network.mode` -> transport compatibility shim from `clusterConfig()` in `src/cluster.ts`. All active harness configs now specify `cluster.transport` (formerly `federation.transport`) directly, making this legacy fallback unreachable dead code.

## Acceptance Criteria

- [ ] The `network.mode` compat shim block (lines 52-58 of `src/cluster.ts`) is removed
- [ ] The `effectiveTransport` variable is eliminated; the `transport` const is returned directly
- [ ] `clusterConfig()` returns `transport: "local"` (default) when no `cluster.transport` is set, even if `network.mode` is present
- [ ] All existing tests pass without modification (the test file has already been cleaned of `network.mode` assertions)
- [ ] No other code paths are affected (the `network.nodes` compat shim and `networkMode()` in `network.ts` remain untouched)

## Context

The compat shim was introduced during the migration from `network.mode` + `network.nodes` config to the `federation` (now `cluster`) config section. It derived the transport value from `network.mode` when `federation.transport` was not explicitly set. Since all active configs have been migrated:

- **Code location**: `src/cluster.ts` lines 52-58 in `clusterConfig()`
- **What it does**: When `transport` is `"local"` (default) and machines exist, checks `raw.network.mode` and uses it as transport if it's not `"localhost"`
- **Why it's dead**: All harness configs now set `cluster.transport` explicitly
- **Related but out of scope**: `network.nodes` compat shim (lines above), `networkMode()` in `network.ts`, `network.mode` docs in config template

The file was renamed from `federation.ts` to `cluster.ts` as part of task-decd52ed. The test file (`cluster.test.ts`) no longer contains any `network.mode`-related assertions.

## Approach

1. In `src/cluster.ts` `clusterConfig()`, delete lines 52-58 (the `effectiveTransport` block)
2. Change line 61 from `transport: effectiveTransport` to `transport`
3. Run `bun test` to confirm all tests pass
4. Net change: ~7 lines deleted, 1 line simplified

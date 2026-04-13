# Proposal: Remove legacy network.mode fallback from networkMode()

**Task:** gh-ludics-258
**Date:** 2026-04-13

## Goal

Remove the `network.mode` fallback from `networkMode()` so it reads only `cluster.transport`. Clean up the legacy `network` config type.

## Acceptance Criteria

1. `networkMode()` reads only `cluster.transport` from config, no `network.mode` fallback.
2. The `network.mode` field is removed from the `LudicsFullConfig` type (keep `network.hostname` if still referenced).
3. `hostnameFromConfig()` is updated if it references `network` — or removed if unused.
4. `bun run build` succeeds, all tests pass.

## Context

`networkMode()` (network.ts:9-21) currently:
1. Parses raw YAML to read `cluster.transport` (or `federation.transport`)
2. If not found or "local", falls back to `loadConfigSync().network?.mode ?? "localhost"`

After task-9eb72980 removed the `clusterConfig()` compat shim, this is the last consumer of `network.mode`. All active configs use `cluster.transport`.

The `network` type in config.ts:79 is `{ mode?: string; hostname?: string; nodes?: unknown[] }`.

`hostnameFromConfig()` (network.ts:23-26) also reads `config.network?.hostname` — check if any caller still uses this or if hostname comes from elsewhere now.

## Approach

1. **Simplify `networkMode()`**: Use `loadConfigSync()` to read `cluster.transport` instead of raw YAML parsing. Return `config.cluster?.transport ?? "localhost"`. Remove the raw YAML block and the `network.mode` fallback.

2. **Check `hostnameFromConfig()`**: If still used, keep `network.hostname` in the type. If not, remove the function and clean up `network` from the config type entirely.

3. **Clean up config type**: Remove `mode` from `network` type (at minimum). If `hostname` and `nodes` are also unused, remove the entire `network` field.

### Files to modify

- `src/network.ts` — `networkMode()` (simplify), `hostnameFromConfig()` (check/remove)
- `src/config.ts` — `LudicsFullConfig.network` type (remove `mode`, possibly more)

# Proposal: Dashboard API should share validation constants with core modules

**Task:** gh-ludics-257
**Date:** 2026-04-13

## Goal

Export validation constants from core modules and import them in `dashboard-server.ts` instead of hardcoding.

## Acceptance Criteria

1. `VALID_CLEAR_STATUSES` exported from `src/slots/index.ts` and used in `dashboard-server.ts`.
2. `ADAPTER_NAMES` (or the `adapters` keys) exported from `src/adapters/index.ts` and used for mode validation in `dashboard-server.ts`.
3. `PRIORITY_INCREASE` and `PRIORITY_DECREASE` maps defined once in a shared location and imported by `dashboard-server.ts`.
4. No hardcoded adapter names or clear statuses remain in `dashboard-server.ts`.
5. `bun run build` succeeds, all tests pass.

## Context

Three sets of duplicated/hardcoded constants:

1. **Clear statuses** — `["ready", "in-progress", "done", "abandoned"]` defined inline in `slots/index.ts:1316` (not exported). Dashboard doesn't reference it.

2. **Adapter modes** — Dashboard hardcodes `["manual", "tmux", "t3code"]` (line 193), but `adapters/index.ts:15-23` has 7 adapters. New adapters won't work via dashboard.

3. **Priority maps** — `PRIORITY_DECREASE` and `PRIORITY_INCREASE` defined inline in `dashboard-server.ts:254,290`. No shared source.

## Approach

### 1. Export VALID_CLEAR_STATUSES (slots/index.ts:1316)

Move from local const to module-level export:
```typescript
export const VALID_CLEAR_STATUSES = ["ready", "in-progress", "done", "abandoned"] as const;
```

### 2. Export ADAPTER_NAMES (adapters/index.ts)

```typescript
export const ADAPTER_NAMES = Object.keys(adapters);
```

### 3. Move priority maps to shared location

Add to `src/tasks/priorities.ts` (new file) or `src/tasks/index.ts`:
```typescript
export const PRIORITY_INCREASE: Record<string, string> = { C: "B", B: "A", A: "S" };
export const PRIORITY_DECREASE: Record<string, string> = { S: "A", A: "B", B: "C" };
```

### 4. Import in dashboard-server.ts

Replace all three hardcoded sets with imports from the shared sources.

### Files to modify

- `src/slots/index.ts` — export `VALID_CLEAR_STATUSES`
- `src/adapters/index.ts` — export `ADAPTER_NAMES`
- `src/tasks/index.ts` (or new `priorities.ts`) — export priority maps
- `src/dashboard-server.ts` — import and use shared constants

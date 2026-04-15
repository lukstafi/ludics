# Proposal: Sort Deferred Launch Tile by Created Date

**Task:** task-002bddd8 — Improve the order on dashboard tile Deferred Launch: sort chronologically

## Goal

The Deferred Launch tile on the dashboard currently displays tasks in filesystem `readdirSync()` order (alphabetical by filename), which has no meaningful chronological relationship. Users want to see the most recently created deferred tasks at the top so they can quickly act on new proposals awaiting approval.

## Acceptance Criteria

1. The Deferred Launch tile displays tasks sorted by `created` date descending (newest first).
2. Tasks with a missing or null `created` date appear at the end of the list.
3. The sort mechanism is generic: `FilteredTaskTileConfig` supports an optional `sort` comparator that any filtered tile can use.
4. No changes to `dashboard.js` (client-side) are required; sorting is done server-side before writing `deferred-launch.json`.
5. Existing tiles (needs-confirmation, unanswered-questions) are unaffected.

## Context

- **`src/dashboard.ts:377-380`** -- `FilteredTaskTileConfig` interface: currently has only `filter` and `extraFields`.
- **`src/dashboard.ts:529-538`** -- `generateFilteredTaskList()`: filters then maps to JSON. No sorting step exists.
- **`src/dashboard.ts:551-557`** -- `deferredLaunchConfig`: defines the deferred tile filter and extra fields.
- **`src/dashboard.ts:350-375`** -- `DashboardTask` interface: `created` is `string | null` (YYYY-MM-DD format).
- **`src/dashboard.ts:1049`** -- Write site for `deferred-launch.json`.

## Approach

Three small changes, all in `src/dashboard.ts`:

### 1. Extend `FilteredTaskTileConfig` (line 377-380)

Add an optional `sort` comparator:

```typescript
interface FilteredTaskTileConfig {
  filter: (task: DashboardTask) => boolean;
  extraFields: (task: DashboardTask) => Record<string, unknown>;
  sort?: (a: DashboardTask, b: DashboardTask) => number;
}
```

### 2. Apply sort in `generateFilteredTaskList` (line 529-538)

Insert a conditional `.sort()` between `.filter()` and `.map()`:

```typescript
function generateFilteredTaskList(tasks: DashboardTask[], config: FilteredTaskTileConfig): Record<string, unknown>[] {
  const filtered = tasks.filter(config.filter);
  if (config.sort) filtered.sort(config.sort);
  return filtered.map((task) => ({
    id: task.id,
    title: task.title,
    project: task.project,
    priority: task.priority,
    ...config.extraFields(task),
  }));
}
```

### 3. Add sort to `deferredLaunchConfig` (line 551-557)

Sort by `created` descending, null values last:

```typescript
const deferredLaunchConfig: FilteredTaskTileConfig = {
  filter: (task) => task.status === "deferred",
  extraFields: (task) => ({
    hasProposal: task.hasProposal,
    proposalPath: task.proposalPath,
  }),
  sort: (a, b) => (b.created ?? "").localeCompare(a.created ?? ""),
};
```

This uses `localeCompare` on YYYY-MM-DD strings, which produces correct chronological ordering. Tasks with null `created` get compared as `""`, sorting them after any dated task.

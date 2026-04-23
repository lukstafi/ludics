# Add `created` to deferred-launch tile and apply newest-first sort to needs-confirmation tile

## Goal

Follow-up wiring from the `task-002bddd8` (Deferred Launch sort) retrospective. The generic `sort?` hook on `FilteredTaskTileConfig` is already in place, so two small dashboard config tweaks remain:

1. Expose `created` on deferred-launch JSON items so the date is present for UI rendering and JSON-inspection debugging (parity with the `needs-confirmation` tile, which already exposes `created`).
2. Apply the same newest-first comparator to the `needs-confirmation` tile so its items also render in the most-recently-created-first order that users now expect after task-002bddd8.

## Acceptance Criteria

- `dashboard/data/deferred-launch.json` items include a `created` field (value may be a `YYYY-MM-DD` string or `null`).
- `dashboard/data/needs-confirmation.json` items are ordered newest-first by `created`, with `null`/missing `created` sorted last — matching the deferred-launch tile's ordering semantics.
- Deferred-launch ordering and its existing test continue to pass unchanged.
- Tests in `src/dashboard.test.ts` cover both behaviors:
  - The existing `describe("deferred-launch sorting")` block (or an added assertion) verifies that `created` appears on output items.
  - A new `describe("needs-confirmation sorting")` block mirrors the deferred-launch test, covering at least three dated items plus one with `created: null`, asserting the same newest-first null-last order.
- `bun run build` passes and `ludics init --no-triggers` regenerates the JSON artifacts without error.

## Context

All changes are in `src/dashboard.ts` (lukstafi/ludics). Relevant code pointers by symbol:

- **`FilteredTaskTileConfig`** interface — already has `sort?: (a, b) => number`; no type change needed.
- **`generateFilteredTaskList`** — already applies `config.sort` when present; no change needed.
- **`needsConfirmationConfig`** — currently:
  ```ts
  const needsConfirmationConfig: FilteredTaskTileConfig = {
    filter: (task) => task.status === "needs-confirmation",
    extraFields: (task) => ({ created: task.created, relatesTo: task.dependencies.relates_to }),
  };
  ```
  `created` is already in `extraFields`; the tile just needs a `sort`.
- **`deferredLaunchConfig`** — currently:
  ```ts
  const deferredLaunchConfig: FilteredTaskTileConfig = {
    filter: (task) => task.status === "deferred",
    extraFields: (task) => ({ hasProposal: task.hasProposal, proposalPath: task.proposalPath }),
    sort: (a, b) => (b.created ?? "").localeCompare(a.created ?? ""),
  };
  ```
  `sort` already exists; `extraFields` just needs `created: task.created` added.
- **Tests** — `src/dashboard.test.ts` has `describe("deferred-launch sorting")` around lines 336–367 that writes four deferred tasks (three dated, one with `created: null`) and asserts ID order. The needs-confirmation test should mirror this structure, writing tasks with `status: needs-confirmation` and asserting the same kind of order against `dashboard/data/needs-confirmation.json`.

The empty-string fallback in the comparator (`(b.created ?? "").localeCompare(a.created ?? "")`) sorts `null` last because `""` sorts after any `YYYY-MM-DD` in `localeCompare`. Since `created` is always `YYYY-MM-DD` when present, lexicographic order coincides with chronological.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

Extract the comparator to a shared module-local helper and reference it from both configs:

```ts
const byCreatedDescNullLast = (a: DashboardTask, b: DashboardTask): number =>
  (b.created ?? "").localeCompare(a.created ?? "");
```

Then:

- Replace the inline sort in `deferredLaunchConfig` with `sort: byCreatedDescNullLast`.
- Add `sort: byCreatedDescNullLast` to `needsConfirmationConfig`.
- Add `created: task.created` into `deferredLaunchConfig.extraFields`.

Inlining the comparator at both call sites is an acceptable alternative if the implementer prefers to minimize diff surface; the helper is preferred for one-place-to-change maintenance.

For tests:

- In the existing deferred-launch test, add one assertion after the ID-order check: `expect(items.find((it) => it.id === "task-newest")).toHaveProperty("created", "2026-04-15");` (or equivalent on any dated item).
- Add a new `describe("needs-confirmation sorting")` block modeled on the deferred-launch one: write four tasks with `status: needs-confirmation` (three dated, one `null`), invoke `dashboardGenerate`, read `dashboard/data/needs-confirmation.json`, and assert the same newest-first null-last ID order.

After implementation, run `bun run build; ludics init --no-triggers` once locally so the committed dashboard JSON artifacts reflect the new sort (if the repo commits generated data — otherwise skip).

## Scope

**In scope:**
- The two `src/dashboard.ts` edits above.
- Test additions in `src/dashboard.test.ts`.
- Regenerating dashboard JSON artifacts per the build sequence.

**Out of scope:**
- Any UI rendering changes in `templates/dashboard/dashboard.js`. Displaying a "proposed on …" label on deferred items is a plausible downstream follow-up but is explicitly not part of this task — the goal here is to make the field available in JSON.
- Changes to `unansweredQuestionsConfig` or other filtered tiles.
- Generalizing `byCreatedDescNullLast` into a shared utility module; keeping it module-local in `dashboard.ts` is fine.

**Dependencies:**
- Relates to `task-002bddd8` (already merged — provided the `sort?` hook this task uses). No blocking dependencies.

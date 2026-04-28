# Normalize taskId to undefined in makeAdapterContext

## Goal

Eliminate the scattered `taskId && taskId !== "null"` guard pattern by handling
both empty and the `"null"` string sentinel at the single ingestion point in
`makeAdapterContext()`. Follow-up from PR #78 (t3code thread naming)
retrospective: `AdapterContext.taskId` is currently typed as `string` and
populated as `data.task ?? ""`, but slot data also carries the string `"null"`
(from legacy slots.md migration), so every consumer has to re-check. Centralize
the normalization, then simplify consumers.

## Acceptance Criteria

- `makeAdapterContext()` returns `taskId: undefined` for missing/empty values
  and for the string `"null"` (so consumers never see either form).
- `AdapterContext.taskId` is typed as `string | undefined` (or `taskId?: string`)
  in `src/adapters/types.ts`, used consistently by all adapters.
- Existing `ctx.taskId && ctx.taskId !== "null"` guards in adapter call sites
  collapse to a plain truthiness check (`if (ctx.taskId)`) or a `??`/`||`
  fallback.
- The `slotSessionName(slot, role, taskId, fallback)` helper in
  `src/adapters/base.ts` no longer needs the `taskId !== "null"` check; its
  callers either pass an already-normalized value or it relies on a single
  `taskId` truthiness test.
- Other call sites that still receive raw slot-data strings (e.g.
  `dashboard-server.ts`, `sessions/sweep.ts:providerCleanupName`) are reviewed
  — either rerouted through the normalized context where appropriate, or left
  with a single comment justifying the local check.
- Existing tests pass, including the test at
  `src/slots/index.test.ts:522` whose comment ("converts to `\"\"`") is updated
  to reflect the new `undefined` semantic.

## Context

**Single ingestion point.** `makeAdapterContext(slotNum, data)` lives at
`src/slots/index.ts` (around the `export function makeAdapterContext`
declaration). Today it does `taskId: data.task ?? ""`. `data.task` is
`string | null` per `SlotData` in `src/slots/types.ts`, but legacy migration
(`src/slots/migration.ts:nullIfEmpty`) and JSON serialization
(`src/slots/json.ts:slotDataToMarkdown` and the `n(v) => v ?? "null"` helper)
also propagate the string `"null"` through callers that read raw slot fields
rather than `SlotData`. The normalization point should reject both `""` and
`"null"`.

**Scattered guards** (the targets of this consolidation):

- `src/adapters/base.ts` — `slotSessionName`: `taskId && taskId !== "null" ? taskId : ...`
- `src/adapters/t3code.ts` — `startOrchestratedThreads`: `const taskId = ctx.taskId && ctx.taskId !== "null" ? ctx.taskId : undefined;`
- `src/adapters/tmux-adapter.ts` — orchestration start path: same pattern
- `src/adapters/agent-session.ts` — `readLaunchFeature` (`if (!ctx.taskId || ctx.taskId === "null") return null;`) and the `knownName` builder
  (`(ctx.taskId && ctx.taskId !== "null" ? ctx.taskId : "")`)
- `src/sessions/sweep.ts` — `providerCleanupName(taskId, session)`: receives raw slot fields, not `ctx`
- `src/dashboard-server.ts` — uses `slotData.task` directly: `if (taskId && taskId !== "null" && TASK_ID_RE.test(taskId))`

The first four read `ctx.taskId` and become trivial after the normalization.
The last two read raw `data.task` / `taskId` arguments — they may keep a local
guard, or be migrated to a shared normalizer (`normalizeTaskId(raw): string | undefined`)
exposed from `src/slots/json.ts` or `src/slots/index.ts`.

**Type definition.** `src/adapters/types.ts` defines
`interface AdapterContext { ... taskId: string; ... }`. Widening to
`taskId?: string` lets the type system enforce that consumers handle the
absent case.

**Tests.** `src/slots/index.test.ts` exercises `makeAdapterContext` directly
(several `const ctx = makeAdapterContext(1, data)` call sites). One test
explicitly asserts the current `""` semantic via comment; the new behavior is
`undefined`. Tests that pass `"null"` to `slotAssign` (e.g.
`src/slots/index.test.ts:575`) should keep working — `slotAssign("null")`
remains the way to clear the task slot, but downstream `ctx.taskId` will be
`undefined` rather than `"null"`.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

1. Add a tiny `normalizeTaskId(raw: string | null | undefined): string | undefined`
   helper near `makeAdapterContext` (or in `src/slots/json.ts` next to
   `SlotData`) that returns `undefined` when the input is `null`, `undefined`,
   `""`, or the string `"null"` (case-insensitive matches with the existing
   `nullIfEmpty` and `readRawEffortField` patterns).
2. Update `makeAdapterContext` to use it, and widen
   `AdapterContext.taskId` to `string | undefined` (`taskId?: string`).
3. Walk the guard sites listed in **Context** and simplify each to plain
   truthiness or `??`/`||` fallback.
4. Decide for `dashboard-server.ts` and `sessions/sweep.ts` whether to call
   the new helper or keep a local check — prefer reuse if the helper is
   exported.
5. Update the misleading test comment at `src/slots/index.test.ts:522`.
6. Run `bun test` and `bun run build` to confirm.

## Scope

**In scope.** All consumers of `AdapterContext.taskId` that currently carry
the `taskId !== "null"` guard, plus the underlying type definition. The
companion non-`ctx` call sites (`dashboard-server.ts`, `sweep.ts`) are in
scope to the extent they share the sentinel concern.

**Out of scope.** The persistence layer — `slotDataToMarkdown` continues to
emit `"null"` for the markdown legacy view, and `slotAssign("null", ...)`
continues to mean "clear task". Renaming `data.task` → `data.taskId` is also
out of scope; only the adapter-context view changes.

**Dependencies.** None — self-contained refactor within `src/slots/` and
`src/adapters/`.

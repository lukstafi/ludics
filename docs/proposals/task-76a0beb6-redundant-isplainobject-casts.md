# Remove redundant `as Record<string, unknown>` casts at isPlainObject call sites

## Goal

`isPlainObject` in `src/json.ts` is a user-defined type guard
(`v is Record<string, unknown>`). After a guard like
`if (!isPlainObject(parsed)) return;` or `if (isPlainObject(parsed)) { ... }`,
the value is already narrowed to `Record<string, unknown>`. Several call sites
still perform a follow-up `as Record<string, unknown>` cast (often to a new
local binding) that is a no-op. These redundant casts should be removed for
clarity and to match the existing uncast pattern already used in
`readJsonFile` and a few other places.

This is a pure-cleanup, no-behavior-change task. Follow-up from the
retrospective of task-15c3100e (which introduced `isPlainObject`).

## Acceptance Criteria

- All redundant `as Record<string, unknown>` casts immediately following
  an `isPlainObject(...)` guard on the same value are removed (see Context
  for the concrete list of sites).
- Each affected call site keeps equivalent behavior — property probes and
  downstream operations on the narrowed value still compile and run the
  same.
- `bun run typecheck`, `bun run lint`, `bun run build`, and `bun test`
  all pass.
- Non-redundant `as ...` forms listed under "Out of scope" below are
  left untouched.

## Context

`src/json.ts` defines the guard:

```ts
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
```

TypeScript narrows `v` to `Record<string, unknown>` in the true branch
(or in code that runs only after the false branch returns/continues),
so casting afterwards adds no information.

### Sites to change

Each site below is `if (!isPlainObject(X)) { ... }` (or the positive-branch
equivalent) followed by a no-op `as Record<string, unknown>` cast that
should be dropped. Line numbers drift; use the surrounding code snippets
to locate them.

1. **`src/events.ts`** — inside `eventsList` parse loop:

   ```ts
   if (!isPlainObject(parsed)) continue;
   const rec = parsed as Record<string, unknown>;  // redundant
   if (typeof rec.ts !== "string") continue;
   ```

   Drop the `rec` binding and use `parsed` directly in the `typeof` probes
   (a few lines later the code already re-casts `parsed as LudicsEvent` so
   `rec` adds no value).

2. **`src/notify.ts`** — inside `loadSessionConclusionState`:

   ```ts
   if (!isPlainObject(parsed)) return {};
   const obj = parsed as Record<string, unknown>;  // redundant
   for (const [k, v] of Object.entries(obj)) { ... }
   ```

   Drop the cast: either `const obj = parsed;` or inline
   `Object.entries(parsed)`.

3. **`src/dashboard.ts`** — PR-merge event derivation from
   `events.jsonl`:

   ```ts
   if (!isPlainObject(parsed)) continue;
   const event = parsed as Record<string, unknown>;  // redundant
   if (event.event_type === "pr_merged" && event.task) { ... }
   ```

4. **`src/dashboard.ts`** — retrospective JSON read for `prUrl`:

   ```ts
   if (!isPlainObject(parsed)) continue;
   const data = parsed as Record<string, unknown>;  // redundant
   if (data.prUrl && typeof data.prUrl === "string") { ... }
   ```

5. **`src/sessions/sweep-state.ts`** — `loadSessionSweepState`, outer
   branch:

   ```ts
   if (!isPlainObject(parsedUnknown)) {
     return { version: 1, sessions: {} };
   }
   const parsed = parsedUnknown as Record<string, unknown>;  // redundant
   ```

   Prefer the smaller diff: drop the cast and keep a one-line
   `const parsed = parsedUnknown;` rename, or rename the outer binding
   directly to `parsed` and drop the extra line — whichever is cleaner.

6. **`src/sessions/sweep-state.ts`** — same function, inner loop (second
   instance of the same pattern):

   ```ts
   if (!isPlainObject(record)) continue;
   const recordData = record as Record<string, unknown>;  // redundant
   ```

7. **`src/config.ts`** — `parseYamlFile`:

   ```ts
   if (!isPlainObject(parsed)) return {};
   return parsed as Record<string, unknown>;  // redundant → return parsed;
   ```

8. **`src/queue.ts`** — `queueList`:

   ```ts
   if (!isPlainObject(parsed)) {
     return { raw: line };
   }
   return parsed as Record<string, unknown>;  // redundant → return parsed;
   ```

### Out of scope (do NOT touch)

- `src/slots/json.ts` `return parsed as unknown as SlotData;` — this
  bridges `Record<string, unknown>` to a specific domain interface via
  `unknown`; it is not a no-op.
- Other `as Record<string, unknown>` occurrences in `src/mag.ts` and
  `src/config.ts` that are **not** preceded by an `isPlainObject` guard
  — they cast fields loaded from untyped config or nested `unknown`
  values (e.g., `config.mag as Record<string, unknown> | undefined`,
  `mag?.autonomy_level as Record<string, unknown> | undefined`,
  `validateConfigKeys(userVal as Record<string, unknown>, ...)`). Those
  are genuine casts and out of scope.
- `src/sessions/sweep-state.ts` line ~91
  `const parsedSessions = parsed.sessions as Record<string, unknown>;`
  — this casts a nested `unknown` field after a `typeof === "object"`
  check, not after `isPlainObject`. Out of scope.
- `src/queue.ts` lines ~225–229 — casts inside `recent-results`
  construction are not guarded by `isPlainObject` in the same way. Out
  of scope.
- Any `as unknown as T` forms — distinct from `as Record<string,
  unknown>` and should not be touched.

### Lint note

`@typescript-eslint/no-unnecessary-type-assertion` is currently `off`
in `eslint.config.js`, so these casts are not currently producing lint
errors. If it were enabled, the eight sites above would become
violations; the cleanup is still worthwhile on readability grounds
alone.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

For each site:

1. Remove the `as Record<string, unknown>` cast.
2. If the cast was assigning to a new local (`rec`, `obj`, `event`,
   `data`, `recordData`, inner `parsed`), either:
   - replace the assignment with a plain reference
     (`const rec = parsed;`), or
   - drop the new binding entirely and use the guarded name directly
     in the subsequent expressions (preferred when it shortens the
     function without hurting readability).
3. For the two `return parsed as Record<string, unknown>;` cases in
   `config.ts` and `queue.ts`, just drop the cast: `return parsed;`.

Then run the verification commands:

```bash
bun run typecheck
bun run lint
bun run build
bun test
```

Expected diff size: ~7–8 redundant casts removed across ~6 files, with
possibly a handful of trivial renames. No test changes required.

## Scope

**In scope:** The eight listed call sites across `src/events.ts`,
`src/notify.ts`, `src/dashboard.ts` (×2), `src/sessions/sweep-state.ts`
(×2), `src/config.ts`, `src/queue.ts`.

**Out of scope:** All sites listed under "Out of scope" above; turning
on `@typescript-eslint/no-unnecessary-type-assertion` (separate
concern); any behavior changes.

**Dependencies:** Relates to completed task-15c3100e (which introduced
`isPlainObject`); no blocking dependencies.

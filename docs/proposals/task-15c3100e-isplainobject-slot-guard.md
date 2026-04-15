# Extract isPlainObject guard utility and add shape validation to readSlotJson

## Goal

Reduce duplication of a correctness-critical guard pattern and close the last
medium-risk JSON shape validation gap. The pattern
`!v || typeof v !== "object" || Array.isArray(v)` appears 12 times across 8
source files. Extracting it into a single `isPlainObject` utility eliminates the
risk of copy-paste divergence and makes the intent self-documenting. Separately,
`readSlotJson` still performs a bare `JSON.parse(raw) as SlotData` without
verifying the parsed value is an object, meaning corrupt slot files containing
valid JSON primitives (`null`, `42`, `"string"`) silently produce bogus
`SlotData`. Adding a shape guard closes this gap.

Ref: gh-ludics-227 retrospective items (1) and (2).

## Acceptance Criteria

1. A new exported function `isPlainObject(v: unknown): v is Record<string, unknown>`
   exists in `src/json.ts` that returns `true` iff `v` is a non-null, non-array
   object.
2. All 12 inline guard instances are replaced with calls to `isPlainObject`:
   - `src/json.ts:10` (readJsonFile)
   - `src/queue.ts:21` (parseJsonRecord)
   - `src/queue.ts:132` (queueList)
   - `src/config.ts:124` (parseYamlFile)
   - `src/events.ts:107` (event parsing loop)
   - `src/notify.ts:354` (loadSessionConclusionState)
   - `src/sessions/sweep-state.ts:83` (top-level sweep state)
   - `src/sessions/sweep-state.ts:94` (per-record loop)
   - `src/dashboard.ts:925` (events JSONL parsing)
   - `src/dashboard.ts:942` (retrospective JSON parsing)
   - `src/mag.ts:400` (loadStartupAlertState)
   - `src/mag.ts:586` (readFeedbackDigestQueueState)
3. `readSlotJson` in `src/slots/json.ts` validates that the parsed value is a
   plain object before returning it. A non-object parsed value throws with the
   existing `corrupt slot JSON: <path>` error prefix.
4. Files that did not previously import from `src/json.ts` gain only the
   `isPlainObject` import: `config.ts`, `events.ts`, `notify.ts`,
   `sessions/sweep-state.ts`, `dashboard.ts`, `mag.ts`, `queue.ts`,
   `slots/json.ts`.
5. All existing tests pass without modification (`bun test`).
6. No new runtime dependencies.

## Context

### Part 1: The duplicated pattern

The guard pattern `!v || typeof v !== "object" || Array.isArray(v)` is the
standard runtime check for "is this a plain JS object?" It guards against null
(which has `typeof "object"`), primitives, and arrays. The 12 call sites use
slight variable name variations (`parsed`, `parsedUnknown`, `record`) but the
logic is identical. After gh-ludics-227 added many of these guards, the
duplication became a maintenance concern.

The proposed utility:
```ts
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
```

Note: `!!v` is equivalent to `v != null` for the relevant cases (filters out
`null` and `undefined`). The TypeScript type narrowing (`v is Record<string, unknown>`)
lets callers drop explicit casts in some cases.

### Part 2: readSlotJson shape gap

Current code at `src/slots/json.ts:41-42`:
```ts
const raw = readFileSync(file, "utf-8");
try {
  return JSON.parse(raw) as SlotData;
```

This catches JSON syntax errors but not wrong-shape JSON. The fix:
```ts
const parsed: unknown = JSON.parse(raw);
if (!isPlainObject(parsed)) {
  throw new Error(`corrupt slot JSON: ${file}: parsed value is not an object`);
}
return parsed as SlotData;
```

`readSlotJson` is called from: `src/slots/index.ts`, `src/slots/index.test.ts`,
`src/dashboard-server.ts`, `src/mag.ts`, `src/cluster-http.ts`.

### Edge cases

- `config.ts` uses `YAML.parse` not `JSON.parse`, but the guard pattern is
  identical and `isPlainObject` applies equally.
- `sweep-state.ts:94` has an inner loop guard on individual records -- both the
  outer (line 83) and inner (line 94) guards should use `isPlainObject`. The
  deeper domain-specific validation (version check, sessions shape) stays inline.
- `queue.ts` `parseJsonRecord` (lines 18-26) wraps JSON.parse + the guard. After
  refactoring it becomes a thin wrapper; no functional change needed.

### Related task

`task-b1e8641b` (harden recentResults) touches `src/queue.ts` `recentResults()` --
a different function. No site overlap. That task can benefit from importing
`isPlainObject` once this task lands first.

## Approach

1. **Define `isPlainObject`** in `src/json.ts` and export it.
2. **Replace all 12 instances** mechanically: for each site, import
   `isPlainObject` (if not already available) and replace the inline expression
   with `!isPlainObject(v)` (negated, since all sites test for the non-object
   case). Preserve the exact control flow (return null, return {}, continue,
   throw) at each site.
3. **Add shape guard to `readSlotJson`**: import `isPlainObject` from
   `../json.ts`, split `JSON.parse(raw) as SlotData` into parse + guard + return.
4. **Run `bun test`** to confirm no regressions.
5. **Single commit** with all changes.

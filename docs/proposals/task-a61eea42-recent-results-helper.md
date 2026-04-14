# Extract recentResults helper to deduplicate results-reading

## Goal

Three call sites independently read `mag/results/*.json`, filter, sort, and slice the files. This duplicates logic and creates subtle inconsistencies (one site sorts by filename, the others by mtime). A shared `recentResults(limit)` helper in `queue.ts` -- alongside the existing `writeResult` and private `resultsDir()` -- eliminates this duplication.

Related: follow-up from task-3432c95a retrospective.

## Acceptance Criteria

1. A `recentResults(limit)` function is exported from `src/queue.ts` that returns the most recent result files sorted by mtime descending, each parsed as JSON.
2. All three existing call sites (`src/mag.ts` `magLogs`, `src/dashboard.ts` `buildMagStatus`, `src/dashboard-server.ts` `/api/queue` endpoint) use the new helper instead of inline directory-reading logic.
3. The mag.ts call site switches from filename-alpha sort to mtime sort (aligning with the other two sites).
4. Existing behavior is preserved at each call site: mag.ts prints recent results when Mag is not running, dashboard.ts extracts last-activity timestamp, dashboard-server.ts returns stripped JSON array.
5. Error handling per result file (parse failures) is handled inside the helper, not at each call site.

## Context

### Current call sites

**`src/mag.ts` ~line 3020** (`magLogs` fallback when Mag is not running):
```typescript
const resultsDir = join(harnessDir(), "mag", "results");
if (existsSync(resultsDir)) {
  const files = readdirSync(resultsDir)
    .filter((f: string) => f.endsWith(".json"))
    .map((f: string) => join(resultsDir, f))
    .sort()
    .reverse()
    .slice(0, 5);
```
Sorts by filename (alphabetical descending), reads raw content, prints it.

**`src/dashboard.ts` ~line 752** (`buildMagStatus`):
```typescript
const resultsDir = join(harness, "mag", "results");
if (existsSync(resultsDir)) {
  const files = readdirSync(resultsDir)
    .filter((f: string) => f.endsWith(".json"))
    .map((f: string) => join(resultsDir, f));
  if (files.length > 0) {
    files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
```
Sorts by mtime, reads only the first file, extracts `.timestamp`.

**`src/dashboard-server.ts` ~line 453** (`/api/queue` endpoint):
```typescript
const rDir = join(harnessDir(), "mag", "results");
// ...
const files = readdirSync(rDir)
  .filter((f: string) => f.endsWith(".json"))
  .map((f: string) => join(rDir, f))
  .sort((a: string, b: string) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  .slice(0, 20);
```
Sorts by mtime, takes top 20, parses JSON, strips `.output` field.

### Helper location

`src/queue.ts` already owns the write side (`writeResult`) and the private `resultsDir()` function. The read helper belongs here.

## Approach

*Suggested approach -- agents may deviate if they find a better path.*

Add to `src/queue.ts`:

```typescript
export function recentResults(limit: number = 20): { file: string; data: Record<string, unknown>; mtimeMs: number }[] {
```

The helper reads the results directory, filters `.json` files, sorts by `statSync(f).mtimeMs` descending, slices to `limit`, and parses each file with try/catch (returning `{ error: "parse error" }` on failure). The `resultsDir()` function stays private -- `recentResults` calls it internally.

Each call site then simplifies:
- `mag.ts`: `recentResults(5).forEach(r => ...)` to print formatted JSON
- `dashboard.ts`: `recentResults(1)` to extract timestamp from the first entry
- `dashboard-server.ts`: `recentResults(20).map(...)` to strip `.output`

## Scope

**In scope:** The `recentResults` helper and refactoring the three call sites to use it.

**Out of scope:** The second `resultsDir` usage in `mag.ts` (~line 3173, the `magRequest` polling loop that waits for a specific result file by request ID) -- that is a different pattern (polling for a known file, not listing recent results).

**Dependencies:** None.

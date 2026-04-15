# Harden recentResults against statSync race and non-object JSON

## Goal

`recentResults()` in `src/queue.ts` has two latent robustness issues:

1. **statSync race**: Between `readdirSync` returning filenames and `statSync` reading each file's mtime, a file can be deleted (e.g., by a concurrent cleanup). The unguarded `statSync` call throws `ENOENT` and crashes the entire function, losing all results -- not just the deleted one.

2. **Non-object JSON passthrough**: `JSON.parse("null")`, `JSON.parse("42")`, and `JSON.parse('"str"')` all succeed without throwing, so the existing try/catch does not catch them. The return value is cast to `Record<string, unknown>` but is not actually an object, which can crash downstream callers that access `.timestamp`, `.id`, or spread the value.

Both fixes are internal to `recentResults()` -- no caller changes are needed.

## Acceptance Criteria

1. If a `.json` file in the results directory is deleted between `readdirSync` and `statSync`, `recentResults()` silently skips that file and returns the remaining results (no throw, no crash).
2. If a result file contains valid JSON that is not a plain object (e.g., `null`, `42`, `"hello"`, `[1,2,3]`), `recentResults()` returns an entry with `data` set to `{ error: "non-object result", raw: <typeof value> }` instead of passing the non-object through.
3. Plain-object JSON files continue to be returned as before (no behavior change for normal results).
4. Malformed JSON (parse errors) continues to return `{ error: "parse error" }` as before.
5. Two new test cases are added to `src/queue.test.ts` in the existing `describe("recentResults", ...)` block:
   - A test that creates a result file, deletes it before calling `recentResults`, and verifies the function returns without throwing.
   - A test that writes files containing `null`, `42`, and `[1,2]` as JSON content, and verifies each returns `data.error === "non-object result"`.

## Context

### Current implementation (`src/queue.ts` lines 195-213)

```typescript
export function recentResults(limit: number = 20): { file: string; data: Record<string, unknown>; mtimeMs: number }[] {
  const dir = resultsDir();
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f: string) => f.endsWith(".json"))
    .map((f: string) => {
      const full = join(dir, f);
      return { file: full, mtimeMs: statSync(full).mtimeMs };  // <-- Issue 1: unguarded statSync
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit);
  return files.map(({ file, mtimeMs }) => {
    try {
      return { file, data: JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>, mtimeMs };  // <-- Issue 2: cast without guard
    } catch {
      return { file, data: { error: "parse error" } as Record<string, unknown>, mtimeMs };
    }
  });
}
```

### Callers (no changes needed)

- `dashboard.ts:754` -- accesses `recentRes[0]!.data.timestamp` inside try/catch. Already resilient.
- `dashboard-server.ts:467` -- spreads `{ ...r.data }` and deletes `.output`. Fails gracefully at route-handler level.
- `mag.ts:3043` -- calls `JSON.stringify(r.data, null, 2)`. Works on any value but prints "null" for non-objects.

### Related

Follow-up from task-a61eea42 retrospective. The `parseJsonRecord()` helper at the top of `queue.ts` (lines 18-26) already implements the exact shape guard needed for Issue 2 -- the same pattern should be reused.

## Approach

### Issue 1 fix

Wrap the `statSync` call in a per-file try/catch, returning `null` on error, then filter out nulls:

```typescript
.map((f: string) => {
  const full = join(dir, f);
  try {
    return { file: full, mtimeMs: statSync(full).mtimeMs };
  } catch {
    return null;
  }
})
.filter((x): x is { file: string; mtimeMs: number } => x !== null)
```

### Issue 2 fix

After `JSON.parse`, add an object shape guard (matching the pattern from `parseJsonRecord()`):

```typescript
const parsed = JSON.parse(readFileSync(file, "utf-8"));
const data = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
  ? (parsed as Record<string, unknown>)
  : ({ error: "non-object result", raw: typeof parsed } as Record<string, unknown>);
return { file, data, mtimeMs };
```

### Tests

Add to the existing `describe("recentResults", ...)` block in `src/queue.test.ts`:

1. **statSync race test**: Create two result files, delete one via `unlinkSync` immediately before calling `recentResults()`, assert function returns exactly 1 result without throwing.

2. **Non-object JSON test**: Write three files containing `"null"`, `"42"`, and `"[1,2]"` respectively. Call `recentResults()`, assert all three entries have `data.error === "non-object result"` with the appropriate `raw` type string.

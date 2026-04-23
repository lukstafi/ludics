# Deduplicate JSON shape guard in `recentResults`

## Goal

`src/queue.ts` already has a `parseJsonRecord()` helper that parses a string,
rejects non-object shapes (null, arrays, primitives), and returns either a
`Record<string, unknown>` or `null`. The per-file mapping inside `recentResults()`
duplicates the same `parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)`
check inline. Collapse the duplication by calling `parseJsonRecord` in
`recentResults`, and unify the two currently-distinct error sentinels
(`{ error: "parse error" }` and `{ error: "non-object result", raw: typeof parsed }`)
into a single sentinel — no production caller branches on the distinction
(`magLogs()` in `src/mag.ts` only `JSON.stringify`s the data for display).

Follow-up to `task-b1e8641b` (originally filed as a retrospective suggestion
from the coder's refactor analysis).

## Acceptance Criteria

- `recentResults()` in `src/queue.ts` no longer re-implements the
  `typeof === "object" && !Array.isArray(...)` shape check. The shape check
  lives only in `parseJsonRecord` / `isPlainObject`.
- Per-file failures (unreadable file, invalid JSON, wrong-shape JSON) still
  yield a placeholder `{ error: ... }` record instead of aborting the whole
  listing — behaviour on the happy path and on each failure mode is preserved
  at the level that `magLogs()` observes (a `data` object that stringifies to
  something sensible).
- The `readFileSync` call remains inside a `try/catch` (or is otherwise
  guarded) so a file deleted between `statSync` and `readFileSync` does not
  abort the whole result — `parseJsonRecord` only catches `JSON.parse`
  errors, not `fs` errors. The existing race-hardening test
  (`survives statSync race when file is deleted...`) remains green in spirit
  for the read-time race as well.
- Tests in `src/queue.test.ts` that assert on the old sentinel strings
  (`"parse error"`, `"non-object result"`, and the `raw: typeof parsed`
  detail) are updated to match the new unified sentinel. In particular:
  - `handles malformed JSON gracefully` (line ~261)
  - `returns error entry for non-object JSON (null, number, array)` (line ~298)
- No other callers of `recentResults` are affected; `magLogs()` in
  `src/mag.ts` continues to display results via `JSON.stringify` without any
  change.
- Typecheck (`bun run build`) and tests (`bun test src/queue.test.ts`) pass.

## Context

### Files

- `src/queue.ts`
  - `parseJsonRecord(text)` — module-private helper, uses
    `isPlainObject` from `src/json.ts`. Returns `Record<string, unknown> | null`.
  - `recentResults(limit)` — reads each `*.json` in `mag/results/`, sorts by
    mtime, maps to `{ file, data, mtimeMs }`. The per-file `files.map(...)`
    body currently contains the inline duplicate.
- `src/mag.ts`
  - `magLogs(lines)` is the sole call site. It calls `recentResults(5)` and
    renders each entry via `JSON.stringify(r.data, ...)`. It does not branch
    on sentinel shape.
- `src/json.ts`
  - Hosts `isPlainObject`, the canonical shape test.
- `src/queue.test.ts`
  - Tests around lines 261 and 298 assert on the exact legacy sentinel
    strings.

### Distinctive snippet (the code being replaced)

```ts
return files.map(({ file, mtimeMs }) => {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    const data = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : ({ error: "non-object result", raw: typeof parsed } as Record<string, unknown>);
    return { file, data, mtimeMs };
  } catch {
    return { file, data: { error: "parse error" } as Record<string, unknown>, mtimeMs };
  }
});
```

## Approach

*Suggested approach — agents may deviate if they find a better path.*

Inside the `files.map` body of `recentResults`, collapse both the parse and
shape-check paths through `parseJsonRecord`, while keeping a `try/catch`
around the `readFileSync` call so `fs` errors remain isolated per file:

```ts
return files.map(({ file, mtimeMs }) => {
  try {
    const parsed = parseJsonRecord(readFileSync(file, "utf-8"));
    const data = parsed ?? ({ error: "invalid result JSON" } as Record<string, unknown>);
    return { file, data, mtimeMs };
  } catch {
    return { file, data: { error: "read error" } as Record<string, unknown>, mtimeMs };
  }
});
```

Two sentinels — `"invalid result JSON"` for parse/shape failures and
`"read error"` for filesystem failures — are fine; they distinguish
categories a human reading `magLogs` output might reasonably want to
tell apart. A single sentinel string is also acceptable if the
implementer prefers; the only hard requirement is that the inline shape
check is gone. The exact sentinel strings chosen become the test
expectations.

Update `src/queue.test.ts`:

- `handles malformed JSON gracefully` — expect the read-time/parse
  sentinel (e.g. `"invalid result JSON"` with the approach above; the
  JSON is syntactically invalid, so `parseJsonRecord` returns null and
  the catch does not fire).
- `returns error entry for non-object JSON (null, number, array)` — all
  three cases collapse to the same parse/shape sentinel; drop the
  `raw: typeof parsed` assertions (that detail is no longer preserved).

Do not re-run `JSON.parse` to re-introduce a distinction between
"threw" and "wrong shape" — that defeats the refactor.

## Scope

**In scope:**
- `src/queue.ts`: the `recentResults` per-file mapping (~4–7 lines changed).
- `src/queue.test.ts`: two tests updated to match the new sentinel(s).

**Out of scope:**
- Any change to `parseJsonRecord`, `isPlainObject`, or `magLogs`.
- Exporting `parseJsonRecord` or moving it to `src/json.ts` — canonical
  helper and duplicate already share `queue.ts`.
- Any other sentinel-unification or JSON-shape-check site elsewhere in
  the codebase.

**Dependencies:**
- Relates to `task-b1e8641b` (the hardening of `recentResults` that
  introduced the inline guard being deduplicated here).
- Relates to `task-a61eea42` (which extracted `recentResults` into
  `queue.ts`, co-locating it with `parseJsonRecord`).

# Validate parsed JSON shape, not just JSON.parse success

## Goal

Multiple JSON parse sites across the ludics codebase cast parsed data to
TypeScript types without runtime shape validation. When files contain
syntactically valid JSON of the wrong shape (primitives, arrays, null, missing
fields), the code silently continues with bad data, causing hard-to-diagnose
downstream failures. This change adds lightweight runtime shape guards at key
parse boundaries.

Ref: https://github.com/lukstafi/ludics/issues/227

## Acceptance Criteria

1. The duplicate `readJsonFile<T>` implementations in `src/orchestration/util.ts`
   and `src/t3code/server.ts` are consolidated into a single shared utility.
2. All medium-risk JSON parse sites identified in the task elaboration validate
   that the parsed value is a non-null, non-array object before use:
   - `src/orchestration/util.ts` `readJsonFile` (used for OrchestrationState)
   - `src/t3code/server.ts` `readJsonFile` (used for T3CodeServerRecord, T3CodeSlotState)
   - `src/dashboard.ts` event JSONL parsing and retrospective parsing
   - `src/events.ts` direct casts to `LudicsEvent`
3. The consolidated `readJsonFile` returns `null` (same as parse-failure) when
   the parsed value is not a plain object, preventing silent type mismatches.
4. Existing tests continue to pass; no new runtime dependencies (no Zod/typebox).
5. The existing `parseJsonRecord()` pattern from `src/queue.ts` is the model --
   ad-hoc `typeof`/`Array.isArray` guards, not a schema library.

## Context

**Existing safe pattern** -- `src/queue.ts:18`:
```ts
function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch { return null; }
}
```

**Duplicate `readJsonFile<T>` implementations:**
- `src/orchestration/util.ts:27` -- used by orchestration state, shared across
  `src/orchestration/state.ts` (reads OrchestrationState) and other orchestration modules.
- `src/t3code/server.ts:385` -- private copy, identical logic, used for
  T3CodeServerRecord/T3CodeSlotState reads.

Both cast directly: `JSON.parse(...) as T` with no shape guard.

**Medium-risk cast sites in dashboard/events:**
- `src/dashboard.ts:720` -- JSONL event lines pushed as `unknown` (no record guard)
- `src/dashboard.ts:926` -- `JSON.parse(line) as Record<string, unknown>` (at least typed as Record)
- `src/dashboard.ts:762`, `:805`, `:941` -- file reads cast to Record or specific shapes
- `src/events.ts:106` -- `JSON.parse(line) as LudicsEvent` (no guard on required fields `ts`, `epoch`, `event_type`, `source`, `scope`)

**Already safe modules** (have guards): queue.ts, health.ts, mag.ts, config.ts, retrospective.ts.

**~70+ total JSON.parse sites** -- many are in tests or already guarded. The
medium-risk production sites above are the targets.

## Approach

*Suggested approach -- agents may deviate if they find a better path.*

1. Add object-shape guard to `readJsonFile` in `src/orchestration/util.ts`:
   check that parsed result is a non-null, non-array object before returning.
   Return `null` otherwise (same semantics as parse failure).

2. Remove the duplicate `readJsonFile` from `src/t3code/server.ts` and import
   from `src/orchestration/util.ts` (or move the utility to a more neutral
   shared location if the import feels architecturally wrong).

3. In `src/events.ts` `queryEvents()`, add a record guard before the
   `as LudicsEvent` cast -- skip lines that parse to non-objects (matching the
   existing try/catch pattern).

4. In `src/dashboard.ts` JSONL parsing loops, add the same record guard before
   pushing to result arrays.

## Scope

**In scope:**
- Consolidating duplicate `readJsonFile` implementations
- Adding object-shape guards to the medium-risk parse sites listed above
- Minimal field-presence checks for `LudicsEvent` (the five required fields)

**Out of scope:**
- Deep/recursive shape validation of complex types (OrchestrationState fields, etc.)
- Adding schema validation libraries (Zod, typebox, etc.)
- Refactoring the ~70+ parse sites that are already safe or low-risk
- Changing return types or error-handling contracts of existing public APIs

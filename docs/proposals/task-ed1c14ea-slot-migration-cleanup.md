# Proposal: Post-migration cleanup -- remove dead slot-markdown helpers and add round-trip fidelity test

**Task:** task-ed1c14ea
**Project:** ludics
**Date:** 2026-04-09

## Goal

Remove dead code left over from the slots.md-to-per-slot-JSON migration and add a round-trip fidelity test for `slotDataToMarkdown` to prevent field omissions in future changes.

## Acceptance Criteria

1. `extractSections`, `replaceSections`, and the `SlotSections` interface are removed from `src/state.ts`. No callers remain.
2. `slotsFilePath` is removed as an export from `src/config.ts`. The migration code in `src/slots/index.ts` inlines the path computation instead. The unused import of `slotsFilePath` in `src/cluster-http.ts` is removed.
3. `templates/harness/slots.md` (tombstone file) is deleted.
4. A new test in `src/slots/index.test.ts` (or a dedicated `src/slots/json.test.ts`) verifies round-trip fidelity: a fully-populated `SlotData` is serialized via `slotDataToMarkdown`, and every key from the `SlotData` type appears as a labeled field in the output. The test also covers the null-value case.
5. The project builds cleanly (`bun run build`) and all tests pass (`bun test`).

## Context

- `extractSections` and `replaceSections` (lines ~192-255 in `src/state.ts`) parsed `**Terminals:**`/`**Runtime:**`/`**Git:**` sections from the old monolithic slots.md. Zero callers outside `state.ts`.
- `slotsFilePath` (line 309 in `src/config.ts`) is imported in `src/cluster-http.ts` (line 8) but never called there. Its only real caller is `ensureSlotsDir` in `src/slots/index.ts` (line 51) for one-time migration detection.
- `templates/harness/slots.md` contains only tombstone text. No code references it.
- `slotDataToMarkdown` in `src/slots/json.ts` (lines 68-89) serializes all 13 `SlotData` fields. The `Liveness` field was nearly omitted during migration -- a round-trip test would have caught it.
- `SlotData` interface (`src/slots/types.ts`) has 13 fields: `slot`, `process`, `task`, `mode`, `session`, `path`, `started`, `adapterArgs`, `machine`, `sessionStarted`, `liveness`, `terminals`, `runtime`, `git`.

## Approach

### Item 1: Remove dead helpers from `src/state.ts`

Delete the `SlotSections` interface, `extractSections`, and `replaceSections` functions. Grep to confirm no remaining references, then remove.

### Item 2: Remove `slotsFilePath` from `src/config.ts`

- In `src/slots/index.ts` line 51, replace `slotsFilePath()` call with `join(harnessDir(), "slots.md")` (the `join` import and `harnessDir` are already available).
- Remove `slotsFilePath` from the import in `src/cluster-http.ts` line 8.
- Remove the `slotsFilePath` function from `src/config.ts`.

### Item 3: Delete tombstone

`rm templates/harness/slots.md`.

### Item 4: Round-trip fidelity test

Add a test (in `src/slots/json.test.ts` or appended to `index.test.ts`) that:
1. Constructs a `SlotData` with every field set to a non-null, non-empty sentinel value.
2. Calls `slotDataToMarkdown(data)`.
3. For each key in `SlotData`, asserts the markdown output contains the corresponding label and value. The mapping from camelCase keys to markdown labels is explicit (e.g., `adapterArgs` -> `**Adapter Args:**`, `sessionStarted` -> `**Session Started:**`).
4. Tests the null case: construct a `SlotData` with all nullable fields as `null`, serialize, verify `"null"` appears for each.

# Proposal: Split slots.md into per-slot JSON files to reduce contention

**Task**: task-e19c470b
**Date**: 2026-04-07

## Goal

Replace the single monolithic `slots.md` file with per-slot JSON files (`slots/slot-1.json` … `slots/slot-N.json`). This eliminates file-level write contention between concurrent federation HTTP requests, removes the markdown regex parse/rewrite cycle, and makes single-slot updates truly atomic.

## Acceptance Criteria

- A new `src/slots/json.ts` module exports `slotJsonDir`, `slotJsonPath`, `readSlotJson`, `writeSlotJson`, `readAllSlotJson`, and `emptySlotData`.
- `writeSlotJson` performs an atomic write (write temp file + `renameSync`) so that concurrent readers never see a partial file.
- `src/config.ts` exports `slotJsonDir(harness?)` alongside the existing `slotsFilePath` (kept for migration).
- `src/slots/index.ts` reads and writes slot state exclusively via `readSlotJson`/`writeSlotJson`; no more `parseSlotBlocks`, `getField`, `setField`, or `writeSlotFile` calls survive.
- `workerSlotsOverride` changes from a Markdown string to `Map<number, SlotData>` (or `null`).
- `src/federation-http.ts`:
  - `handleGetSlots()` returns a JSON response (`{ slots: SlotData[] }`) on a new `/api/federation/slots/json` endpoint; the old markdown endpoint is kept but serializes from JSON for backward compat during rollout.
  - `handlePostSlotUpdate()` reads/writes a single `slots/slot-N.json` file rather than the whole `slots.md`.
  - `federationGetSlots()` client fetches from the new JSON endpoint.
  - `federationPostSlotUpdate()` payload is unchanged (slot + section fields).
- `mag.ts:processSlotIntents()` populates `workerSlotsOverride` from the JSON endpoint response.
- All consumers in `mag.ts`, `dashboard.ts`, `flow.ts`, `notify.ts`, `sessions/sweep.ts`, `tasks/sync.ts`, `sessions/index.ts`, `dashboard-server.ts` use `readAllSlotJson` and access fields as plain JSON properties (`slot.task`, `slot.mode`, etc.) — no markdown parsing remains.
- `src/slots/paths.ts` replaces its private `parseSlotBlocks`/`extractField` with `readAllSlotJson` + direct field access; the "Phase 2" comment is removed.
- `src/slots/markdown.ts` is either deleted or reduced to only `mergeAdapterState` (refactored to accept/return `SlotData`) and `addNoteToSlotData`; all parse/write functions are gone.
- `src/slots/types.ts` `SlotBlock.raw` field is removed; `SlotBlock` is renamed or replaced by `SlotData`.
- `src/init.ts` creates the `slots/` directory with `slot-1.json` … `slot-N.json` instead of copying `slots.md`.
- Tests (`src/slots/index.test.ts`, `src/tasks/sync.test.ts`, `src/federation-http.test.ts`) use JSON helpers; no test writes `slots.md` directly.
- Existing harnesses with a `slots.md` but no `slots/` directory are migrated automatically on first access (one-time migration in `ensureSlotsDir()`).
- `bun run build` passes with no TypeScript errors after the migration.

## Context

### Problem

`slots.md` is a single file read-modify-write by every slot operation. In a federated setup, multiple worker nodes POST to `/api/federation/slot-update` concurrently; the controller handler reads the entire file, patches one block, and rewrites — a classic read-modify-write race. Additionally:

- The markdown format requires iterating lines with regex to extract and update individual fields (`getField`, `setField` in `src/slots/markdown.ts`).
- `writeSlotFile` in `markdown.ts` (line 107) serializes all 6 blocks into one string and calls `writeFileSync` — the entire file is rewritten for any single-slot change.
- `src/slots/paths.ts` has its own duplicate `parseSlotBlocks` (line 12) with the comment "full slots.md parser comes in Phase 2" — indicating the design always anticipated this migration.

### Key call sites verified

| File | Relevant lines | Action |
|------|----------------|--------|
| `src/config.ts:301-303` | `slotsFilePath()` | Add `slotJsonDir()` alongside |
| `src/slots/markdown.ts` | All exports | Replace / delete |
| `src/slots/types.ts:1-17` | `SlotBlock` with `.raw` | Rename to `SlotData`, drop `.raw` |
| `src/slots/index.ts:29-88` | `workerSlotsOverride`, `loadBlocks`, `writeSlotFileOrHttp` | Full rewrite |
| `src/slots/paths.ts:12-34` | Private `parseSlotBlocks` | Delete, use JSON reader |
| `src/federation-http.ts:499-505` | `handleGetSlots` | Add JSON endpoint |
| `src/federation-http.ts:632-...` | `handlePostSlotUpdate` | Patch single file |
| `src/federation-http.ts:266-268` | `federationGetSlots` | Fetch JSON |
| `src/mag.ts:2587-2641` | `processSlotIntents`, `setWorkerSlotsOverride` | Use `Map<number, SlotData>` |
| `src/dashboard.ts:201`, `~836` | `generateSlots`, `discoverTtydUrls` | Use `readAllSlotJson` |
| `src/flow.ts:118`, `345` | `readSlottedTaskIds`, `flowContext` | Direct JSON field access |
| `src/notify.ts:193`, `209` | `taskSlotPath`, `taskSlotNumber` | Use `readAllSlotJson` |
| `src/sessions/sweep.ts:58` | `collectAttachedKeys` | Use `readAllSlotJson` |
| `src/tasks/sync.ts:865` | `maybeTriggerPreempt` | Use `readAllSlotJson` |
| `src/sessions/index.ts` | feeds `slotsFilePath` → `extractSlotPaths` | Change to JSON |
| `src/dashboard-server.ts:266` | regex over raw slots content | Use `readAllSlotJson` |
| `src/init.ts:277` | copies `templates/harness/slots.md` | Generate JSON files instead |

### JSON schema

```json
{
  "slot": 1,
  "process": "(empty)",
  "task": null,
  "mode": null,
  "session": null,
  "path": null,
  "started": null,
  "adapterArgs": null,
  "machine": null,
  "sessionStarted": null,
  "liveness": null,
  "terminals": "",
  "runtime": "",
  "git": ""
}
```

All fields that were `"null"` string sentinels become JSON `null`. Multi-line adapter sections (`terminals`, `runtime`, `git`) remain strings (the adapter output format is preserved as-is within the field value).

## Approach

### Phase 1 — New JSON layer (`src/slots/json.ts`, new file)

```ts
export interface SlotData {
  slot: number;
  process: string;
  task: string | null;
  mode: string | null;
  session: string | null;
  path: string | null;
  started: string | null;
  adapterArgs: string | null;
  machine: string | null;
  sessionStarted: string | null;
  liveness: string | null;
  terminals: string;
  runtime: string;
  git: string;
}

export function slotJsonDir(harness?: string): string
export function slotJsonPath(slot: number, harness?: string): string
export function emptySlotData(slot: number): SlotData
export function readSlotJson(slot: number, harness?: string): SlotData  // returns emptySlotData if absent
export function writeSlotJson(slot: number, data: SlotData, harness?: string): void  // atomic rename
export function readAllSlotJson(count: number, harness?: string): Map<number, SlotData>
```

`writeSlotJson` writes to `slot-N.json.tmp` then `renameSync` to `slot-N.json` — OS-level atomic on POSIX filesystems.

### Phase 2 — `src/config.ts`

Add `slotJsonDir(harness?)` exporting `join(h, "slots")`. Keep `slotsFilePath` to allow one-time migration detection.

### Phase 3 — `src/slots/index.ts` rewrite

- `ensureSlotsFile` → `ensureSlotsDir`: creates `slots/` directory, writes `emptySlotData` for any missing slot files. If `slots.md` exists but `slots/` does not, parse and migrate each slot block to JSON (one-time migration).
- `loadBlocks` → removed; callers use `readAllSlotJson` or `readSlotJson` directly.
- `workerSlotsOverride: string | null` → `workerSlotsOverride: Map<number, SlotData> | null`.
- `writeSlotFileOrHttp`: in worker context, POST unchanged (sections dict); in controller context, call `writeSlotJson(slotNum, updatedData)`.
- All mutation functions (`slotAssign`, `slotClear`, etc.) read `readSlotJson(slot)`, mutate plain object, call `writeSlotJson(slot, data)`.

### Phase 4 — `src/slots/markdown.ts` refactor

- Delete: `parseSlotBlocks`, `getField`, `getProcess`, `getTask`, `getMode`, `getSession`, `getPath`, `getStarted`, `getAdapterArgs`, `getSessionStarted`, `getMachine`, `getLiveness`, `setField`, `emptyBlock`, `writeSlotFile`.
- Refactor: `mergeAdapterState(data: SlotData, adapterOutput: string): SlotData` — same parsing logic for `terminals`/`runtime`/`git` sections from adapter text, but reads/writes `SlotData` fields instead of a block string.
- Refactor: `addNoteToSlotData(data: SlotData, note: string): SlotData` — appends `- note\n` to `data.runtime`.

### Phase 5 — Federation HTTP (`src/federation-http.ts`)

- Add `/api/federation/slots/json` GET → returns `{ slots: SlotData[] }`.
- Keep `/api/federation/slots` GET for old-worker compat: serialize JSON data back to markdown on-the-fly (use a thin `slotDataToMarkdown` helper, ~10 lines).
- `handlePostSlotUpdate(body)`: `readSlotJson(slot)` → patch fields → `writeSlotJson(slot, data)`. No more whole-file rewrite.
- `federationGetSlots()` client: fetch from `/api/federation/slots/json`; return `Map<number, SlotData>`.
- `federationPostSlotUpdate`: payload unchanged.

### Phase 6 — `src/mag.ts` and all consumers

Replace `readFileSync(slotsFilePath()) + parseSlotBlocks` with `readAllSlotJson(slotsCount())`. Replace `getTask(block)` etc. with `slot.task` etc. The `workerSlotsOverride` in `processSlotIntents` changes from a Markdown string to a `Map<number, SlotData>`.

### Phase 7 — `src/slots/paths.ts`

Replace private `parseSlotBlocks`/`extractField`/`extractGitPaths` with `readAllSlotJson` and direct field access. `git` field already stores the multi-line git section — parse `Working directory:` lines from `slot.git`. Remove the "Phase 2" comment.

### Phase 8 — `src/init.ts` and templates

`init.ts:277` currently copies `templates/harness/slots.md`. Change to: `mkdirSync(join(harnessDir, "slots"), { recursive: true })` + write `emptySlotData(i)` for `i` in `1..slotsCount`. Remove `templates/harness/slots.md` (or leave as tombstone).

### Phase 9 — Tests

Update `src/slots/index.test.ts`, `src/tasks/sync.test.ts`, `src/federation-http.test.ts`: replace all `writeFileSync(join(harness, "slots.md"), ...)` setup with `writeSlotJson` calls per slot. Update assertions to use `readSlotJson` / `readAllSlotJson`.

### Rollout notes

- The one-time migration in `ensureSlotsDir` is idempotent: if `slots/` already exists, it is a no-op. This means existing harnesses auto-migrate on next `ludics` invocation.
- Federation protocol: the old markdown endpoint is preserved until all worker nodes are updated. Because ludics is single-repo, a coordinated PR merge covers all nodes.
- Git tracking: `slots/` directory is added to the harness repo automatically since the whole harness dir is tracked. `slots.md` can be git-removed or left as a zero-byte tombstone.

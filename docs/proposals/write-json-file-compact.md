# Add `writeJsonFileCompact` helper and migrate ad-hoc JSON writers

## Goal

Follow-up from gh-ludics-303 retrospective (coder's `suggestRefactorSummary`
item 3): ship `writeJsonFileCompact(path, value)` alongside the existing
`writeJsonFile` in `src/json.ts` so callers pick pretty-vs-compact explicitly
rather than using `atomicWriteFileSync(path, JSON.stringify(...) + "\n")`
ad-hoc. Migrate the seven call sites currently bypassing the named helpers
(four compact, three pretty) to the canonical helpers, eliminating the
"three-shape" anomaly the retrospective flagged.

## Acceptance Criteria

- `src/json.ts` exports `writeJsonFileCompact(path: string, value: unknown): void`
  that writes `JSON.stringify(value) + "\n"` via `atomicWriteFileSync`.
- All four compact-with-newline writer sites use `writeJsonFileCompact`
  (byte-identical to the current output):
  - `saveSubscriberState` in `src/notify.ts`
  - `setPendingFollowupRevise` in `src/notify.ts`
  - `writeResult` in `src/queue.ts`
  - `recordIntent` in `src/cluster-http.ts`
- The three pretty-without-newline writer sites use `writeJsonFile` (gains one
  trailing newline byte per file; invisible to downstream `JSON.parse`
  consumers):
  - `writeRetrospective` in `src/retrospective.ts`
  - `saveTestHealthState` in `src/health.ts`
  - tmux-slot state writer in `src/adapters/tmux-adapter.ts`
- Byte-exactness assertions in `src/health.test.ts` and
  `src/retrospective.test.ts` are updated to expect
  `JSON.stringify(..., null, 2) + "\n"` (see Context below). No other
  byte-exactness assertions are affected.
- `src/json.test.ts` gains a `describe("writeJsonFileCompact", ...)` block
  mirroring the existing `writeJsonFile` block: exact compact-with-newline
  output, round-trip through `readJsonFile`, no `.tmp` leftover,
  parent-directory auto-creation.
- `bun test` passes (all existing tests plus the new compact test block).
- `bun run build && ludics init --no-triggers` continues to succeed (standard
  Ludics post-change sequence).

## Context

### `src/json.ts` helpers

- `atomicWriteFileSync(path, content)` — temp-file + rename; auto-creates
  parent directory via `mkdirSync(dirname(path), { recursive: true })`;
  retries once on `ENOENT`.
- `writeJsonFile(path, value)` — `atomicWriteFileSync(path, JSON.stringify(value, null, 2) + "\n")`.
- Existing test block `describe("writeJsonFile", ...)` in `src/json.test.ts`
  covers byte-exact output and `readJsonFile` round-trip.

### Compact-with-newline writer sites (4, byte-identical migration)

Each of these currently emits `atomicWriteFileSync(file, JSON.stringify(x) + "\n")`
with no indentation and a single trailing `\n`:

- `saveSubscriberState` in `src/notify.ts`
- `setPendingFollowupRevise` in `src/notify.ts`
- `writeResult` in `src/queue.ts`
- `recordIntent` in `src/cluster-http.ts`

All four files already import from `./json.ts` (notify.ts and cluster-http.ts
import `atomicWriteFileSync` and `writeJsonFile`; queue.ts imports
`atomicWriteFileSync` and `isPlainObject`). The migration adds
`writeJsonFileCompact` to each import list.

No tests (`notify.test.ts`, `queue.test.ts`, `cluster-http.test.ts`) assert
byte-exact output on these files — they parse + compare, so the byte-identical
migration is trivially safe.

### Pretty-without-newline writer sites (3, gains `\n` byte)

Each currently emits `atomicWriteFileSync(path, JSON.stringify(x, null, 2))`
— pretty-printed, **no trailing newline**:

- `writeRetrospective` in `src/retrospective.ts`
- `saveTestHealthState` in `src/health.ts`
- tmux-slot state writer in `src/adapters/tmux-adapter.ts`
  (imports `atomicWriteFileSync` from `../json.ts`)

Migrating to `writeJsonFile` adds one trailing `\n` byte per file. Downstream
consumers (`/ludics-process-suggestions` for retrospectives,
`/ludics-health-check` for health state, dashboard + runner for tmux-slot
state) all go through `JSON.parse`, so the newline is invisible.

### Byte-exactness test assertions (proposal-phase verification)

Grep of `src/**/*.test.ts` for `toBe(JSON.stringify(...))` against the three
pretty-without-newline output paths found two assertions that must be updated
(both explicitly comment "Byte-exactness: no added trailing newline" — they
exist precisely to pin the current ad-hoc shape):

- `src/health.test.ts:196`:
  `expect(readFileSync(path, "utf-8")).toBe(JSON.stringify(state, null, 2));`
- `src/retrospective.test.ts:192`:
  `expect(readFileSync(file, "utf-8")).toBe(JSON.stringify(data, null, 2));`

Both become `... + "\n"` after migration. `src/adapters/tmux-adapter.test.ts`
has no byte-exactness assertion on `tmux-slot-*.json` output (only
`existsSync` checks), so no adapter-test update is needed.

### Scope boundary: sibling task-29bea074

This task does not touch the 8 deferred atomic-write sites tracked by
task-29bea074; once this helper lands, task-29bea074 may reuse
`writeJsonFileCompact` for any of its sites that have compact shape. The
`blocks: [task-29bea074]` dependency in the frontmatter continues to hold.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

1. Add to `src/json.ts` immediately after `writeJsonFile`:

   ```ts
   export function writeJsonFileCompact(path: string, value: unknown): void {
     atomicWriteFileSync(path, JSON.stringify(value) + "\n");
   }
   ```

2. Add a `describe("writeJsonFileCompact", ...)` block in `src/json.test.ts`
   mirroring the existing `writeJsonFile` block: (a) exact compact-with-newline
   output, (b) `readJsonFile` round-trip, (c) no `.tmp` sibling, (d) auto-creates
   missing parent directory.

3. For each of the 4 compact sites, swap
   `atomicWriteFileSync(file, JSON.stringify(x) + "\n")` →
   `writeJsonFileCompact(file, x)`. Add `writeJsonFileCompact` to the existing
   `./json.ts` import.

4. For each of the 3 pretty-without-newline sites, swap
   `atomicWriteFileSync(path, JSON.stringify(x, null, 2))` →
   `writeJsonFile(path, x)`. Add `writeJsonFile` to the import where missing
   (retrospective.ts and health.ts currently import only `atomicWriteFileSync`;
   tmux-adapter.ts imports only `atomicWriteFileSync`). The now-unused
   `atomicWriteFileSync` import can be dropped from files that no longer
   reference it.

5. Update the two byte-exactness test assertions to expect the
   `+ "\n"` form:
   - `src/health.test.ts:196` and
   - `src/retrospective.test.ts:192`.

6. Run `bun test` and then `bun run build && ludics init --no-triggers`.

## Scope

**In scope:**
- `writeJsonFileCompact` helper in `src/json.ts`
- Unit test block in `src/json.test.ts`
- 4 compact-site migrations (byte-identical)
- 3 pretty-site migrations (add trailing newline byte)
- Updates to 2 byte-exactness test assertions in `src/health.test.ts` and
  `src/retrospective.test.ts`
- Removing now-unused `atomicWriteFileSync` imports where the migration is the
  only remaining reference

**Out of scope:**
- Sibling task-29bea074 deferred atomic-write sites (the `blocks` relation is
  preserved; that task picks up the helper once this lands).
- Revisiting byte-exactness assertions on the 4 compact files — the
  byte-identical migration keeps them passing unchanged.
- Any broader refactor of `atomicWriteFileSync` itself.

**Dependencies:**
- `blocks: [task-29bea074]` — confirmed to still hold after this proposal.
- `relates_to: [gh-ludics-303]` — retrospective origin.

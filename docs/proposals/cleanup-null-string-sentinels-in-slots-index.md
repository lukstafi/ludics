# Clean up persistence-layer `"null"` string sentinels in `src/slots/index.ts`

## Goal

Eliminate the four remaining `"null"` JS-literal write sites in
`src/slots/index.ts` so `grep -rn 'taskId.*"null"' src/` and
`grep -rn '"null"' src/slots/index.ts` no longer surface persistence-layer
hits during review. With reader-side normalization centralized
(`normalizeOptionalString`, `parseTaskFrontmatterLineFallback`,
`readRawEffortField`), the writers are the last reason to keep the legacy
sentinel branch alive in this file.

Follow-up cleanup from the retrospective of `task-ab90fcb7`. Sibling
workflow-meta task: `gh-ludics-428` (review-time grep disambiguation rules
in orchestration skills/docs). The two are independent and may ship in
either order.

## Acceptance Criteria

- The writer signatures `taskUpdateFrontmatter` and
  `taskUpdateFrontmatterFields` (in `src/slots/index.ts`) and
  `updateFrontmatterField` and `addFrontmatterField` (in
  `src/tasks/markdown.ts`) accept `string | null` for the value parameter.
  Whenever the value is `null` or the empty string `""`, the writer emits
  the canonical YAML null token — i.e. the on-disk line is exactly
  `<field>: null`. For non-empty string values, behavior is unchanged.
- All four `"null"` write sites in `src/slots/index.ts` are updated to pass
  `null` (no quotes) instead of the string `"null"`:
  1. `taskUpdateForSlotClear()` — the `slotClear` body, just after
     `transitionStatus(file, expectedFrom, finalStatus)` succeeds. Was
     `taskUpdateFrontmatter(taskId, "slot", "null")`; becomes
     `taskUpdateFrontmatter(taskId, "slot", null)`.
  2. `slotAssign()` reassign path's prior-task cleanup, inside the
     `oldData.task && oldData.task !== taskId` branch. Was
     `updateFrontmatterField(oldTaskFile, "slot", "null")`; becomes
     `updateFrontmatterField(oldTaskFile, "slot", null)`.
  3. `taskCompleteDirectly()` — the no-slot completion path, just after
     the `in-progress|deferred → done` transition. Was
     `taskUpdateFrontmatter(taskId, "slot", "null")`; becomes
     `taskUpdateFrontmatter(taskId, "slot", null)`.
- The `slotAssign` journal-formatting line (currently
  `\`Slot ${slotNum} assigned: ${processDesc} (task=${taskId ?? "null"}, adapter=${adapter})\``)
  drops the parenthetical task field when `taskId` is absent. The new
  format is equivalent to
  `\`Slot ${slotNum} assigned: ${processDesc}${taskId ? \` (task=${taskId})\` : ""} (adapter=${adapter})\``.
  When `taskId` is set the format is unchanged from today (still
  `Slot N assigned: <proc> (task=<id>) (adapter=<adp>)`).
- After the change, `grep -n '"null"' src/slots/index.ts` no longer matches
  any frontmatter-write site or the slot-assign journal line. Matches
  inside `slotPreemptStash`/`slotPreemptUnstash` (~lines 676–731) remain
  untouched (out of scope — different concern; see Scope).
- `src/slots/index.test.ts` continues to pass with no assertion changes.
  In particular, the `expect(persisted).toContain("slot: null")` assertions
  (~lines 212, 632, 678, 1734) continue to hold, because writers still emit
  `slot: null` on disk.
- `bun run lint`, `bun run typecheck`, `bun run build`, and `bun test` are
  all clean.

## Context

### The four write sites (function/symbol pointers — line numbers drift)

In `src/slots/index.ts`:

1. `taskUpdateForSlotClear()` — the `slotClear` body. After
   `transitionStatus(file, expectedFrom, finalStatus)` returns truthy,
   the function calls
   `taskUpdateFrontmatter(taskId, "slot", "null")` to clear the `slot:`
   frontmatter field on the task being cleared.

2. `slotAssign()` reassign path — inside the
   `if (oldData.task && oldData.task !== taskId)` branch (the cleanup of
   the previous task that is being displaced from this slot), the function
   calls
   `updateFrontmatterField(oldTaskFile, "slot", "null")` (note: this site
   uses `updateFrontmatterField` from `src/tasks/markdown.ts` directly,
   not the local `taskUpdateFrontmatter` wrapper, because it has a file
   path rather than a task id).

3. `taskCompleteDirectly()` — the no-slot completion path. After
   `transitionStatus(file, ["in-progress", "deferred"], "done")` returns
   truthy, the function calls
   `taskUpdateFrontmatter(taskId, "slot", "null")`.

4. `slotAssign()` journal-formatting line, emitted just before
   `emitEvent({ event_type: "slot_assign", ... })` near the end of the
   function:

   ```ts
   journalAppend("slot", `Slot ${slotNum} assigned: ${processDesc} (task=${taskId ?? "null"}, adapter=${adapter})`);
   ```

   This is a free-form human-readable journal entry, not a structured
   write. The structured `events.jsonl` log on the next line already
   handles task absence via `task: taskId ?? undefined`.

### Writer functions touched

In `src/slots/index.ts`:

- `taskUpdateFrontmatterFields(taskId, updates: Record<string, string>)` —
  the underlying batch-write helper. Splices `${field}: ${updates[field]}`
  literally into the frontmatter. The `updates` value type widens to
  `Record<string, string | null>`; the splice line normalizes
  `null` and `""` to the literal token `null` (yielding on-disk
  `<field>: null`). Non-empty strings are emitted verbatim.
- `taskUpdateFrontmatter(taskId, field, value)` — single-field convenience
  wrapper around the above. Value type widens identically.

In `src/tasks/markdown.ts`:

- `updateFrontmatterField(filePath, field, value)` — single-field writer
  used directly by `slotAssign`'s reassign cleanup. Value type widens to
  `string | null`; same `null | ""` → `null` normalization.
- `addFrontmatterField(filePath, field, value)` — currently a one-line
  alias for `updateFrontmatterField`. Signature widens identically so
  callers that already pass strings keep type-checking.

### Read-side compatibility (no migration needed)

The on-disk shape stays exactly `slot: null` (unquoted YAML null), which
all readers already accept:

- `normalizeOptionalString()` in `src/tasks/markdown.ts` returns undefined
  for JS `null`, undefined, `""`, and the case-insensitive string
  `"null"`.
- `parseTaskFrontmatterLineFallback()` skips fields whose value parses to
  `"null"`.
- The full YAML parse path turns the unquoted `null` token into JS `null`,
  which downstream code handles uniformly.

So the cleanup is forward-only — no other reader, no other writer, no
external script needs to change.

### Sites explicitly NOT in scope (different concerns)

The following matches in `src/slots/index.ts` for `"null"` are
deliberately preserved:

- `slotPreemptStash` (~lines 676–682) writes `previousTask: data.task ?? "null"`
  and similar `previousMode/Session/Path/Started/AdapterArgs` entries to a
  preempt-stash JSON. `slotPreemptUnstash` (~lines 717–731) reads them back
  and uses `=== "null"` comparisons to restore the displaced slot. This is
  an **internal in-memory sentinel** for the preempt feature, paired
  symmetrically inside the same module — no review-time confusion risk.
  Out of scope per the `task-ab90fcb7` proposal.
- The CLI surface `slotAssign(slotNum, "null", adapter)` (where the second
  positional arg is the *taskId* and the literal string `"null"` means
  "clear taskId") is the documented sentinel surface for the slot CLI,
  preserved by the `task-ab90fcb7` proposal. Out of scope.
- `slotDataToMarkdown()` and any legacy `slots.md` writers that emit
  human-readable `**Task:** null` lines are explicitly out of scope per
  the `task-ab90fcb7` proposal.
- The local helper at `src/slots/index.ts:190` (`if (!raw || raw.toLowerCase() === "null") return null;`)
  is a *reader* normalization, not a writer — out of scope.

### Test file

`src/slots/index.test.ts` has multiple `toContain("slot: null")`
assertions (~lines 212, 632, 678, 1734) that pin the on-disk byte shape.
Because Option A keeps that shape unchanged, no test edits are required.
There is also a `slotAssign(1, "null", "t3code")` call (~line 575) that
exercises the CLI sentinel surface — that surface is out of scope and the
call stays as-is.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

### 1. Widen the writer signatures

In `src/tasks/markdown.ts`, change `updateFrontmatterField` to accept
`string | null` and normalize the value once at the splice point:

```ts
export function updateFrontmatterField(
  filePath: string,
  field: string,
  value: string | null,
): void {
  // ... existing bounds/lookup logic unchanged ...
  const normalized = (value === null || value === "") ? "null" : value;
  // wherever the function currently writes `${field}: ${value}`,
  // write `${field}: ${normalized}` instead (both at the in-place
  // replace site and the upsert/insert site).
}
```

`addFrontmatterField` is a one-line alias and inherits the new signature
automatically.

In `src/slots/index.ts`, change `taskUpdateFrontmatterFields` to accept
`Record<string, string | null>`, and normalize identically at the splice
line:

```ts
function taskUpdateFrontmatterFields(
  taskId: string,
  updates: Record<string, string | null>,
): void {
  // ... existing scan loop unchanged, except the splice line:
  const raw = updates[field]!;
  const normalized = (raw === null || raw === "") ? "null" : raw;
  output.push(`${field}: ${normalized}`);
  // ...
}

function taskUpdateFrontmatter(
  taskId: string,
  field: string,
  value: string | null,
): void {
  taskUpdateFrontmatterFields(taskId, { [field]: value });
}
```

Note: the `for (const field of remaining)` loop currently uses
`updates[field]` without `!`; preserve whatever style is in place, but
ensure TypeScript's narrowing handles `string | null` cleanly (the
`Record<string, string | null>` value is always defined for keys in
`remaining`, so `updates[field]!` or destructuring is fine).

### 2. Update the four call sites

```diff
-  taskUpdateFrontmatter(taskId, "slot", "null");                 // taskUpdateForSlotClear
+  taskUpdateFrontmatter(taskId, "slot", null);

-      updateFrontmatterField(oldTaskFile, "slot", "null");        // slotAssign reassign cleanup
+      updateFrontmatterField(oldTaskFile, "slot", null);

-  taskUpdateFrontmatter(taskId, "slot", "null");                 // taskCompleteDirectly
+  taskUpdateFrontmatter(taskId, "slot", null);
```

### 3. Drop the journal-line parenthetical when taskId is absent

```diff
-  journalAppend("slot", `Slot ${slotNum} assigned: ${processDesc} (task=${taskId ?? "null"}, adapter=${adapter})`);
+  journalAppend(
+    "slot",
+    `Slot ${slotNum} assigned: ${processDesc}${taskId ? ` (task=${taskId})` : ""} (adapter=${adapter})`,
+  );
```

When `taskId` is set the human-readable line is unchanged; when absent,
the parenthetical disappears entirely (chosen over a placeholder like
`task=none` per the elaboration's resolved Q2).

### 4. Verify

Run from `~/ludics`:

- `bun run lint` — must exit 0.
- `bun run typecheck` — must exit 0 (the signature widening is the only
  type-system-relevant change; existing callers all pass `string`, which
  remains assignable).
- `bun run build`.
- `bun test` — all `toContain("slot: null")` assertions in
  `src/slots/index.test.ts` should still pass; the
  `slotAssign(1, "null", "t3code")` call exercises the CLI taskId
  sentinel surface (out of scope) and continues to work.
- `grep -n '"null"' src/slots/index.ts` — confirm only the
  preempt-stash/unstash matches (~lines 676–731) and the local reader
  helper at ~line 190 remain. The four target sites should be gone.

## Scope

**In scope:**

- Signature widening of `updateFrontmatterField`, `addFrontmatterField`
  in `src/tasks/markdown.ts`.
- Signature widening of `taskUpdateFrontmatterFields`,
  `taskUpdateFrontmatter` in `src/slots/index.ts`.
- Writer-side normalization: both `null` and `""` collapse to the
  canonical YAML null token `null` on disk.
- Updating the four call sites enumerated in the Acceptance Criteria.
- Verification (lint/typecheck/build/test).

**Out of scope** (preserved by the `task-ab90fcb7` proposal):

- The `slotAssign(taskId="null")` CLI sentinel surface — the documented
  way to "clear taskId" on the slot CLI.
- `slotDataToMarkdown()` and any legacy `slots.md` human-readable writers.
- The `slotPreemptStash` / `slotPreemptUnstash` in-memory `"null"`
  sentinels (`src/slots/index.ts` ~lines 676–731).
- The local reader-normalization helper at `src/slots/index.ts:190`
  (`raw.toLowerCase() === "null"`).
- Reader-side cleanup — already centralized in `normalizeOptionalString`
  and `parseTaskFrontmatterLineFallback`; nothing more to do there.

**Dependencies:** none. Independent of `gh-ludics-428` (which adds
review-time disambiguation rules to the orchestration skills/docs).

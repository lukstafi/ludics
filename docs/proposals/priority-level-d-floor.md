# Add priority level D as the new floor; C remains default

## Goal

Make "postpone" actually demote C-priority tasks. Today the dashboard
"postpone" button is a silent no-op on C: `PRIORITY_DECREASE["C"]` is
`undefined`, so the frontmatter rewrite is skipped, while the slot-clear
half of postpone still runs and `maybeFillEmptySlots` immediately re-picks
the task. C is the most-populated tier (≈159 tasks at C across the
harness), so this bug blocks the primary tool users reach for when they
want to push work further down the queue.

Introduce a new priority level **D** below C. C stays the default at
creation time. Postpone from C now demotes to D. D is terminal — postpone
on D remains a no-op, which is acceptable.

No GitHub issue; user request from 2026-04-22.

## Acceptance Criteria

- `PRIORITY_INCREASE` maps `D → C`, `PRIORITY_DECREASE` maps `C → D`, and
  `priorityValue("D") === 4` (with existing S=0, A=1, B=2, C=3
  preserved).
- The dashboard "postpone" action on a C-priority task writes
  `priority: D` to the task's frontmatter. The dashboard "promote" action
  on a D-priority task writes `priority: C`.
- Focus-project boost applies to D (D → C on focus projects), mirroring
  the existing C → B boost. Implemented by replacing the hand-coded
  switch in `effectivePriority` / `effectivePriorityValue` with a table
  lookup (`PRIORITY_INCREASE[p] ?? p`) so future ladder changes only
  touch `markdown.ts`.
- The create-task API accepts `priority: "D"` as a valid value (regex
  widened to `/^[A-DS]$/`). The task-creator UI (`task-creator.html`
  radio buttons) is **not** widened — D is reached only via
  demote/postpone, by design.
- The `adoptSessions` sort in `src/mag.ts` handles D correctly. The
  inline `pv` arrow is replaced with an import of `priorityValue` from
  `./tasks/markdown.ts`, eliminating the duplicated ladder definition.
- The dashboard renders a D-priority badge with a styled color across
  all three themes (default, dark, high-contrast). The chosen color is
  a paler gray than C — visually distinct-enough to read, but clearly
  "less prominent" than C.
- The tooltip/comment at `dashboard.js:531` is updated from
  `C→B→A→S` to `D→C→B→A→S`.
- `src/tasks/priority-value.test.ts` covers D: exact value `4`,
  `C < D < unknown` ordering, and the chained `S < A < B < C < D`
  assertion.
- Running `bun test` passes. `bun run build` succeeds with no new type
  errors.

## Context

### Priority ladder (primary edit site)

`src/tasks/markdown.ts` defines the ladder at the top of the file:

```ts
export const PRIORITY_INCREASE: Record<string, string> = { C: "B", B: "A", A: "S" };
export const PRIORITY_DECREASE: Record<string, string> = { S: "A", A: "B", B: "C" };

export function priorityValue(p: string): number {
  switch (p) {
    case "S": return 0;
    case "A": return 1;
    case "B": return 2;
    case "C": return 3;
    default: return 9;
  }
}
```

All three need D entries.

### Focus-project boost

`effectivePriority` and `effectivePriorityValue` in `src/config.ts`
currently hand-code the boost ladder. The cleaner implementation uses
the `PRIORITY_INCREASE` table directly:

```ts
export function effectivePriority(priority: string, project: string): string {
  if (!priorityProjectSet().has(project.toLowerCase())) return priority;
  return PRIORITY_INCREASE[priority] ?? priority;
}
```

`effectivePriorityValue` should still delegate to `effectivePriority`
then `priorityValue` (imported from `./tasks/markdown.ts`).

### Dashboard API — create-task regex

`src/dashboard-server.ts` validates the priority field of the
create-task endpoint with `/^[A-CS]$/`. Widen to `/^[A-DS]$/`. The
promote/postpone handlers in the same file already use
`PRIORITY_INCREASE[...] ?? currentPriority` /
`PRIORITY_DECREASE[...] ?? currentPriority`, so they pick up D
automatically once the tables are updated.

### `mag.ts` inline mirror

`src/mag.ts` contains a second copy of the priority ladder:

```ts
const pv = (p: string) => p === "A" ? 1 : p === "B" ? 2 : p === "C" ? 3 : 9;
return pv(a.priority) - pv(b.priority);
```

(Inside the `adoptSessions` sort.) Replace the `const pv = ...` with
`import { priorityValue } from "./tasks/markdown.ts"` at the top of the
file (if not already imported; `mag.ts` already imports from `./config.ts`
adjacent modules, so this is a trivial add) and use `priorityValue`
directly.

### Dashboard CSS

`templates/dashboard/style.css` declares four `--priority-*` variables
and four `.priority-{A,B,C,S}` rules per theme. The three themes are:

- Default (light): lines ~31–34 for vars, ~1011–1029 for rules.
- Dark: lines ~80–83.
- High-contrast: lines ~118–121.
- There is a fourth theme block at ~2382 (media-query based).

`dashboard.js` renders badges with the dynamic class name
`priority-${priority}`, so a missing `.priority-D` rule produces an
unstyled badge. Each theme needs:

- A `--priority-d` CSS variable, one shade paler than `--priority-c`.
  Specifically: default `#c4bfbb` (paler than `#6b6560`), dark `#d6d3d1`
  (paler than `#a8a29e`), high-contrast `#909090` (paler than `#606060`).
  Exact hex values are a suggestion — agents may tune them so long as
  the result is clearly paler/less prominent than C in each theme.
- A `.priority-D { background-color: var(--priority-d); }` rule.

### Tooltip

`templates/dashboard/dashboard.js` line ~531:
```js
// Promote a ready queue task's priority one level (C→B→A→S)
```
Update to `D→C→B→A→S`.

### Unit test

`src/tasks/priority-value.test.ts` — add test cases for D:

```ts
test("priorityValue('D') === 4", () => {
  expect(priorityValue("D")).toBe(4);
});

test("orders S < A < B < C < D", () => {
  expect(priorityValue("C")).toBeLessThan(priorityValue("D"));
  expect(priorityValue("D")).toBeLessThan(priorityValue("X"));
});
```

### Surfaces that need NO change (verified)

- `src/flow.ts` — `flowBlocked` lex-sort uses `localeCompare` with `"Z"`
  sentinel. D sorts between C and Z naturally. `flowCritical`
  hard-filters to `priority === "A"`, correctly excluding D.
- `src/dashboard.ts` sort comparators — route through
  `effectivePriorityValue` / `priorityValue`; pick up D for free.
- `templates/dashboard/tasks.html` — renders `P${priority}` textContent
  with no class-based styling; D renders as "PD" naturally.
- `templates/dashboard/task-creator.html` — radio buttons stay C/B/A by
  design (D is demote-only). Add a brief code comment noting this is
  deliberate.
- `src/tasks/index.ts` default priority "C" for CLI creation and
  retrospective follow-ups — unchanged.
- `src/tasks/markdown.ts` gh-issue label-priority inference — never
  produces D (D is only reached via explicit demote). Add a one-line
  comment making the invariant explicit.
- `parseTaskFrontmatter` accepts arbitrary string priorities already;
  no validation barrier.
- `skills/ludics-briefing.md` and `templates/mag/memory/workflows.md` —
  prose about "high-priority" tasks, not ladder enumerations.

### Non-goals (explicitly out of scope)

- Fixing the "postpone-still-reassigns-via-slot-clear" behavior.
  Accepted as a quirk.
- Fixing `maybeFillEmptySlots` orphan-proposal leapfrog (separate
  concern from gh-ocannl-404).
- A level below D (E, frozen, iced).
- Making D reachable from the task-creator UI.
- Changing the default priority at creation time (stays C).

## Approach

*Suggested approach — agents may deviate if they find a better path.*

Straightforward mechanical change, fully mapped. Seven edits:

1. `src/tasks/markdown.ts` — extend `PRIORITY_INCREASE`,
   `PRIORITY_DECREASE`, and `priorityValue`.
2. `src/config.ts` — replace hand-coded switch in `effectivePriority`
   with `PRIORITY_INCREASE[priority] ?? priority`;
   `effectivePriorityValue` delegates through `priorityValue`.
3. `src/dashboard-server.ts` — widen create-task regex to `/^[A-DS]$/`.
4. `src/mag.ts` — import `priorityValue` from `./tasks/markdown.ts`,
   drop inline `pv` arrow in `adoptSessions`.
5. `templates/dashboard/style.css` — add `--priority-d` var to each
   theme block (including the media-query one at ~2382) and a
   `.priority-D` rule.
6. `templates/dashboard/dashboard.js` — update tooltip comment at
   ~531 from `C→B→A→S` to `D→C→B→A→S`.
7. `src/tasks/priority-value.test.ts` — add D test cases.

Add a short comment in `task-creator.html` and in the gh-issue
priority-inference block noting the deliberate omissions.

Verify with `bun test` and `bun run build`. No migration is needed —
there are zero existing D tasks harness-wide.

## Scope

**In**: items 1–7 above, plus the two explanatory code comments.

**Out**: all items in the Non-goals section.

**Dependencies**: none. No blocker tasks.

**Follow-up tasks worth filing separately** (not part of this work):

- `flowBlocked` lex-sort latent bug: `"S".localeCompare(...)` mis-orders
  S as "last" because `S > C` lexically. Today this misorders correctly
  for the sentinel case but not once priorities are mixed. Worth a
  dedicated task.
- The deeper "postpone still re-picks via `maybeFillEmptySlots`" issue,
  which D only papers over for C tasks (still no-op on D itself).

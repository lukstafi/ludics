# Proposal: Extract taskLink / proposalLink helpers to centralize URL encoding

**Task**: task-e577b9be
**Date**: 2026-04-23

## Goal

Replace the nine repeated `"/task.html?task=${encodeURIComponent(...)}"` and
`"/proposal.html?task=${encodeURIComponent(...)}"` expressions scattered across
server-side TypeScript and client-side dashboard scripts with two small helpers
— `taskLink(id)` and `proposalLink(id)` — so the URL shape and encoding choice
live in exactly one place per side. Eliminates the class of regression (a new
call site reaching for `escapeHtml` or omitting encoding) captured by the
`task-c5937037` retrospective and already partly fenced by existing tests.

## Acceptance Criteria

1. **TS helpers exist and are exported** from `src/dashboard.ts`:
   - `export function taskLink(id: string): string` — returns `/task.html?task=<encoded id>`.
   - `export function proposalLink(id: string): string` — returns `/proposal.html?task=<encoded id>`.
   - Both use `encodeURIComponent` and include the leading `/` (absolute form).
2. **JS helpers exist** as top-level functions in
   `templates/dashboard/dashboard.js`:
   - `function taskLink(id)` and `function proposalLink(id)` — same shape and
     absolute-path convention as the TS side.
   - Available at top-level so existing call sites inside handlers can invoke
     them without plumbing.
3. **All server-side call sites migrated** to the helpers:
   - `generateSlots()` — `slotProposalLink` (line ~265).
   - `generateTasksTree()` — `taskFileLink` and `proposalLink` (lines ~648, ~649).
   - `generateRecentlyCompleted()` — `proposalLink` (line ~970).
   - `src/notify.ts` `proposalViewUrl` — uses `proposalLink(taskId)` (prefixed
     with `dashboardBaseUrl`).
4. **All client-side call sites migrated** to the helpers, switching from
   relative (`task.html?...`) to absolute (`/task.html?...`) form:
   - `dashboard.js` `fetchNeedsConfirmation()` href.
   - `dashboard.js` `fetchUnansweredQuestions()` href.
   - `dashboard.js` `fetchDeferredLaunch()` ternary — both branches.
   - `templates/dashboard/task.html` inline script — the `View Proposal` link.
   - `templates/dashboard/retrospective.html` inline script — the `Proposal`
     link in the retro links bar.
5. **Round-trip test on the TS side** (`src/dashboard.test.ts`):
   For every id in the delimiter suite
   `["plain", "task&x", "task#x", "task?x", "task+x", "task with space"]`,
   assert `new URL(taskLink(id), "http://x/").searchParams.get("task") === id`
   and the same for `proposalLink(id)`.
6. **Round-trip test on the JS side** (`templates/dashboard/task.test.ts`):
   Same delimiter suite, but evaluated against the helper functions defined in
   `dashboard.js`. Because `dashboard.js` has no exports, the test may
   evaluate the relevant helper source via `new Function(...)` (see existing
   file's regex assertions), or the helpers can be moved into a small module
   the test can `import` — either is acceptable as long as round-trip passes
   for the full id suite against both `taskLink` and `proposalLink`.
7. **Existing regression guards updated, not weakened**:
   - `src/dashboard.test.ts` "tasks-tree link renders task.html" describe
     block — the assertion `expect(link).toBe("/task.html?task=task-abc123")`
     still passes (helper output is byte-for-byte the same for the plain id).
     For the URL-encoded id case (`task-with space`), the expected encoding
     remains `task-with%20space`.
   - `templates/dashboard/task.test.ts` "dashboard.js task links" describe
     block — the four literal-substring assertions are replaced with
     equivalent helper-based checks: each call site now reads
     `taskLink(task.id)` or `proposalLink(task.id)`, and the "never
     `escapeHtml`" regression guard (`not.toMatch(/task\.html\?task=\$\{escapeHtml/)`)
     stays in place.
   - The "no raw task-files/ links remain" guard stays untouched.
8. **Build + lint clean**: `bun run build` and `bun test` pass. Follow harness
   memory's recommended post-change sequence: `bun run build; ludics init
   --no-triggers` so the dashboard output reflects the refactor.

## Context

### Current state — call sites inventory

Symbol names; line numbers from 2026-04-23 for orientation only.

**Server-side (`src/dashboard.ts`)** — all absolute, all use `encodeURIComponent`:

```
slotProposalLink    in generateSlots()            ~line 265
taskFileLink        in generateTasksTree()        ~line 648
proposalLink        in generateTasksTree()        ~line 649
proposalLink        in generateRecentlyCompleted() ~line 970
```

**Server-side (`src/notify.ts`)** — uses `encodeURIComponent`, has a
`dashboardBaseUrl` prefix:

```
proposalViewUrl     in sendProposalNotification() ~line 508
```

**Client-side (`templates/dashboard/dashboard.js`)** — currently relative, all
use `encodeURIComponent` (the mixed `escapeHtml` vs `encodeURIComponent`
inconsistency was fixed in PR #333; this task locks in the correct pattern):

```
needs-confirm-link  in fetchNeedsConfirmation()   ~line 601
unanswered-q-link   in fetchUnansweredQuestions() ~line 622
viewLink ternary    in fetchDeferredLaunch()      ~lines 637–638
```

**Client-side inline scripts** — currently relative:

```
View Proposal link  in task.html renderLinks()      ~line 126
Proposal link       in retrospective.html          ~line 115
```

### Scripts that do not share a module system

- `dashboard.js`, `nav.js`, `markdown.js` each define their own `escapeHtml`
  and run as classic `<script>` files (no `import/export`).
- `task.html` and `retrospective.html` include `nav.js` and `markdown.js`
  but *not* `dashboard.js`. This is why the helper cannot live only in
  `dashboard.js` if we want `task.html` and `retrospective.html` to use it —
  see *Approach* for placement.

### Existing regression guards (must keep passing)

- `src/dashboard.test.ts` — `describe("tasks-tree link renders task.html")`:
  asserts `link === "/task.html?task=task-abc123"` and the space-id case
  encodes as `task-with%20space`.
- `templates/dashboard/task.test.ts` — `describe("dashboard.js task links")`:
  four `toContain` assertions for href substrings + the "never `escapeHtml`"
  regex guard + the "no `task-files/` links" regex guard.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

### 1. TS side — one exported pair in `src/dashboard.ts`

```typescript
export function taskLink(id: string): string {
  return `/task.html?task=${encodeURIComponent(id)}`;
}

export function proposalLink(id: string): string {
  return `/proposal.html?task=${encodeURIComponent(id)}`;
}
```

Placement: near the top of the file (below imports and the existing
`dashboardDataDir` / `readSlotIntentForDashboard` utility helpers, above
`generateSlots`). Keeps the helpers discoverable to readers and reusable by
other modules (`notify.ts` imports them).

`notify.ts` usage becomes:

```typescript
import { proposalLink } from "./dashboard.ts";
// ...
const proposalViewUrl = `${dashboardBaseUrl}${proposalLink(taskId)}`;
```

### 2. JS side — shared placement

Two reasonable placements; pick the one that keeps the round-trip test
tractable:

**Option A (preferred): new small module `templates/dashboard/links.js`.**
Top-level function declarations `taskLink(id)` and `proposalLink(id)`. Include
via `<script src="links.js"></script>` from `dashboard.js`'s host page
(`index.html`), `task.html`, and `retrospective.html`. Test via the same
`readFileSync` + `new Function(source + "; return { taskLink, proposalLink }")`
pattern that already exists for `task.test.ts` — keeps tests pure and avoids
bundler changes.

**Option B: inline duplicates in `dashboard.js`, `task.html`, and
`retrospective.html`.** Simpler wiring (no new file, no new `<script>` tag);
the test file in `templates/dashboard/` evaluates the helper source extracted
from `dashboard.js` and asserts the inline copies in `task.html` /
`retrospective.html` match via string search. Accepts one kind of duplication
to avoid another.

Option A is cleaner long-term; Option B is smaller. Either is fine as long as
the acceptance criteria tests pass.

### 3. Migration order

1. Add helpers (TS + JS side) with tests in place but call sites untouched —
   tests for helpers pass in isolation.
2. Migrate server-side call sites; rerun `bun test` — existing
   `dashboard.test.ts` assertions still pass because helper output is byte-
   identical.
3. Migrate client-side call sites; update `task.test.ts` regression guards to
   match the new inline text (e.g., `toContain("taskLink(task.id)")` instead
   of `toContain("task.html?task=${encodeURIComponent(task.id)}")`), keeping
   the never-`escapeHtml` and no-`task-files/` guards untouched.
4. Migrate `notify.ts` — its existing tests (`src/notify.test.ts`) should
   continue to pass; if any assertion checks the literal URL, update it to
   match the helper output.
5. Run `bun run build; ludics init --no-triggers` and spot-check the
   dashboard renders the expected links.

### 4. Round-trip test pattern

Shared between both sides. Example (TS):

```typescript
describe("taskLink / proposalLink round-trip", () => {
  const ids = ["plain", "task&x", "task#x", "task?x", "task+x", "task with space"];
  for (const id of ids) {
    test(`taskLink(${JSON.stringify(id)}) round-trips`, () => {
      const href = taskLink(id);
      const url = new URL(href, "http://x/");
      expect(url.searchParams.get("task")).toBe(id);
      expect(url.pathname).toBe("/task.html");
    });
    test(`proposalLink(${JSON.stringify(id)}) round-trips`, () => {
      const href = proposalLink(id);
      const url = new URL(href, "http://x/");
      expect(url.searchParams.get("task")).toBe(id);
      expect(url.pathname).toBe("/proposal.html");
    });
  }
});
```

Same shape on the JS side, with the helpers loaded via whichever mechanism
Option A or B chose.

## Scope

**In scope**:

- Two helpers on each side (TS export, JS top-level or `links.js` module).
- Nine migrated call sites: four in `src/dashboard.ts`, one in `src/notify.ts`,
  three in `templates/dashboard/dashboard.js`, one in
  `templates/dashboard/task.html`, one in `templates/dashboard/retrospective.html`.
- New round-trip tests on both sides for the delimiter suite.
- Updates to the existing four `task.test.ts` literal-substring assertions so
  they track the refactor (not deletions; equivalent helper-based checks).
- Cross-side consistency: client call sites switch to absolute `/task.html?...`
  form.

**Out of scope**:

- Broader URL-encoding audit beyond `task.html` and `proposal.html` patterns.
- Helpers for `retrospective.html?task=...`, `task-files/…`, or other URL
  patterns (no duplication currently; fold in when a second site appears).
- Other template files (`briefing.html`, `health.html`, `mag.html`,
  `ntfy.html`) — they don't currently emit `task.html?...` or
  `proposal.html?...` links.
- Any change to `escapeHtml`, `markdown.js`, or `nav.js`.

**Dependencies**: none. Related to `task-c5937037` (retrospective origin) and
`task-ba243220` (bundled patterns-doc additions); neither blocks this.

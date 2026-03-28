# Proposal: Dashboard PR #71 followups

**Task**: task-ce15fb2a
**Effort**: small

## Overview

Three follow-up improvements from the PR #71 coder reflection: (1) consolidate
redundant per-task file reads in `dashboard.ts`, (2) add effort badges to
ready queue tiles, (3) color-code effort badges by size across both slots and
ready queue.

## Current state

In `src/dashboard.ts`, `generateSlots()` (lines 222--227) calls four separate
functions per occupied slot, each of which independently opens, reads, and
YAML-parses the same task file:

- `lookupTaskContent(taskId)` -- reads file, strips frontmatter, returns body
- `lookupTaskEffort(taskId)` -- reads file, parses YAML, returns `effort`
- `lookupTaskHasProposal(taskId)` -- reads file, parses YAML, returns boolean
- `lookupTaskGithubUrl(taskId)` -- reads file, parses YAML, returns `url`

That is 4 file reads + 3 YAML parses per slot per refresh cycle.

The `ReadyTask` interface (line 268) lacks `effort` and `milestone` fields,
even though `generateReady()` already includes `milestone` in the output
objects. The ready queue rendering in `dashboard.js` (`renderReadyQueue`,
line 207) does not display effort.

Effort badges in slot tiles use a single neutral color
(`background-color: var(--bg-secondary)`), with no visual distinction between
small, medium, and large effort.

## Plan

### 1. Consolidate task-file lookups

Replace the four lookup functions with a single `lookupTaskMetadata(taskId)`:

```ts
interface TaskMetadata {
  content: string | null;    // markdown body (frontmatter stripped)
  githubUrl: string | null;
  effort: string | null;
  hasProposal: boolean;
}

function lookupTaskMetadata(taskId: string): TaskMetadata {
  const tasksDir = join(harnessDir(), "tasks");
  const taskFile = join(tasksDir, taskId + ".md");
  if (!existsSync(taskFile)) {
    return { content: null, githubUrl: null, effort: null, hasProposal: false };
  }
  const raw = readFileSync(taskFile, "utf-8");
  const body = raw.replace(/^---\n[\s\S]*?\n---\n*/, "").trim() || null;
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    return { content: body, githubUrl: null, effort: null, hasProposal: false };
  }
  const data = (YAML.parse(fmMatch[1]!) ?? {}) as Record<string, unknown>;
  const url = data.url;
  const githubUrl = (url && typeof url === "string" && url.trim() !== "" &&
    url.trim().toLowerCase() !== "null") ? url.trim() : null;
  const effort = data.effort;
  const effortStr = (effort && typeof effort === "string" && effort.trim() !== "" &&
    effort.trim().toLowerCase() !== "null") ? effort.trim() : null;
  return {
    content: body,
    githubUrl,
    effort: effortStr,
    hasProposal: hasNonNullProposal(data.proposal),
  };
}
```

Update `generateSlots()` to call `lookupTaskMetadata()` once per slot and
destructure the result. Delete the four individual `lookupTask*` functions.

### 2. Add effort to ReadyTask and ready queue rendering

Update the `ReadyTask` interface to include the missing fields:

```ts
interface ReadyTask {
  id: string;
  title: string;
  priority: string;
  project: string;
  context: string;
  deadline: string | null;
  milestone: string | null;   // already emitted, just missing from interface
  effort: string | null;      // new
}
```

In `generateReady()`, add `effort` to the mapped output. The `DashboardTask`
already has all frontmatter fields available (via `readDashboardTasks`), but
`effort` is not currently in `DashboardTask` either. Add an `effort` field to
`DashboardTask` populated from `data.effort`, then flow it through to
`ReadyTask`.

In `dashboard.js` `renderReadyQueue()`, add an effort badge after the title:

```js
const effortBadge = task.effort
    ? `<span class="effort" data-effort="${escapeHtml(task.effort)}">${escapeHtml(task.effort)}</span>`
    : '';
// Insert into the <li> template
```

### 3. Color-coded effort badges via CSS attribute selectors

Add `data-effort` attributes to effort badges in both slot rendering
(`renderSlots` in dashboard.js, line 127) and ready queue rendering. Then add
CSS rules using attribute selectors:

```css
.effort[data-effort="small"] {
    background-color: #166534;  /* green-800 */
    color: #bbf7d0;            /* green-200 */
}
.effort[data-effort="medium"] {
    background-color: #92400e;  /* amber-800 */
    color: #fde68a;            /* amber-200 */
}
.effort[data-effort="large"] {
    background-color: #991b1b;  /* red-800 */
    color: #fecaca;            /* red-200 */
}
```

In `dashboard.js`, update the slot effort badge (line 127) to include
`data-effort`:

```js
if (slot.effort) meta.push(`<span class="effort" data-effort="${escapeHtml(slot.effort)}">${escapeHtml(slot.effort)}</span>`);
```

## Files to change

| File | Changes |
|------|---------|
| `src/dashboard.ts` | Replace 4 lookup functions with `lookupTaskMetadata()`. Add `effort` to `ReadyTask` and `DashboardTask` interfaces. Add `milestone` to `ReadyTask` interface. Update `generateSlots()` call site. Update `generateReady()` to include `effort`. |
| `templates/dashboard/dashboard.js` | Add `data-effort` to slot effort badge. Add effort badge to ready queue items. |
| `templates/dashboard/style.css` | Add color-coded `.effort[data-effort=...]` rules. |

## Risks and edge cases

- The `lookupTaskMetadata` consolidation is a pure refactor with identical
  behavior; risk is low.
- Tasks without an `effort` field will simply show no badge (null handling
  already in place).
- The `milestone` field addition to `ReadyTask` is a type-correctness fix;
  the runtime data already includes it.
- CSS attribute selectors are well-supported in all modern browsers.

## Ambiguities

- None identified. The three items are clearly scoped and the implementation
  paths are straightforward.

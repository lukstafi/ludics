# Mag dashboard: promote and edit/cancel buttons on pending queue items

**Task:** task-cf3ef9f1
**Date:** 2026-04-24

## Goal

In the Mag tab of the dashboard, the Pending Requests section currently
renders queued items as read-only rows. The user wants two per-row affordances
so they can reorder the queue and recycle/cancel pending requests without
hand-editing `mag/queue.jsonl`:

1. **Promote to top** — move a pending request past every other pending item,
   preserving the relative order of the rest.
2. **Edit / cancel** — dequeue a pending request and append whatever free-form
   content it carried into the composer textarea, so the user can edit and
   resubmit (or simply leave it removed). The hydration is the *edit* half of
   the affordance; the dequeue is the *cancel* half — exposed as one button.

Both actions operate on `mag/queue.jsonl` and must cooperate with the stop
hook's atomic pop via the existing `withQueueLock` in `src/queue.ts` (never
truncate the file directly — see harness feedback
`feedback_never_clear_queue.md`).

## Acceptance Criteria

1. **Two buttons per pending row** in the Mag tab's queue list:
   - `↑` — "Move to top" (promote).
   - `✎✖` — "Edit / cancel" (dequeue + hydrate composer).
   Buttons are a single combined affordance per role; do NOT split edit and
   cancel into two buttons. Icons are Unicode glyphs, matching the existing
   `✓` / `✕` pattern used elsewhere in the dashboard.

2. **Promote** moves the targeted item to index 0 of `queue.jsonl`, preserving
   the relative order of the other pending items. If the item is already at
   index 0 it is a no-op (no error). If the id is no longer in the queue
   (popped mid-click), the server returns a not-found response and the client
   re-fetches — no UI error toast required, the next poll converges.

3. **Edit / cancel** removes the targeted item from `queue.jsonl` and
   returns its content to the client. The client appends the content to the
   `#queue-message` textarea, using a separator (a blank line between prior
   content and the appended text) *only when* both the existing textarea
   content and the appended content are non-empty. If the pending item has no
   `content` field (e.g. `elaborate`, `draft-proposal`, `preempt`, other
   non-message actions) the textarea is not modified. The textarea is focused
   after hydration. A subsequent Send on an empty textarea is a no-op (the
   existing `sendMessage` path already handles empty input).

4. **Raw / unparseable queue lines** (items that come back from `queueList()`
   with `{ raw: string }` instead of a structured record) render without the
   two action buttons — there is no `id` to target. These lines still render
   as they do today (malformed marker + truncated content).

5. **Concurrency**: promote and cancel are implemented as new library
   functions in `src/queue.ts`, each wrapping its read-modify-write in
   `withQueueLock`. They race-safely against the stop hook's
   `queuePopExpected` — no new lock, no direct file writes outside the helpers.

6. **HTTP API**: two new endpoints on the dashboard server, following the
   shape of `/api/task-promote`, `/api/task-confirm`, `/api/task-dismiss`:
   - `POST /api/queue-promote?id=<req-id>` → JSON body with a `status` field
     whose value is one of `"promoted"`, `"already-head"`, `"not-found"`.
   - `POST /api/queue-cancel?id=<req-id>` → on success, JSON with
     `{ status: "cancelled", content: string | null, action: string, task?: string }`.
     On miss, `{ status: "not-found" }`.
   Both handlers bump `lastGenerated = 0` so the dashboard data pipeline
   refreshes on the next tick, mirroring the other mutation endpoints.
   Invalid / missing `id` → HTTP 400 with a short message. Unexpected
   exceptions → HTTP 500 with the error string. Successful responses are HTTP
   200 with `Content-Type: application/json`.

7. **CLI parity** (optional but preferred for handler uniformity): add
   `ludics mag queue promote <id>` and `ludics mag queue cancel <id>`
   subcommands to the existing `case "queue"` switch in `src/mag.ts`, shelling
   through to the same library functions. On `cancelled`, print the removed
   JSON line to stdout so a shell user can inspect or re-feed the queue; on
   `not-found` set `process.exitCode = 1`.

8. **Regression tests**:
   - `src/queue.test.ts` — add unit tests for `queuePromoteToTop` covering:
     already-head no-op, promote from middle, promote from tail, not-found
     (id not in queue), empty queue. Verify post-conditions by reading
     `queue.jsonl` back through `queueList()` and asserting order.
   - `src/queue.test.ts` — add unit tests for `queueCancel` covering:
     removes targeted item, returns its parsed request record and raw line,
     not-found for unknown id, empty queue. Verify post-condition by reading
     back via `queueList()`.
   - `src/dashboard.test.ts` — add integration tests for
     `/api/queue-promote` and `/api/queue-cancel` mirroring the existing
     `/api/task-confirm` / `/api/task-dismiss` patterns: start the server,
     seed a queue, hit the endpoint, assert response JSON and that
     `queueList()` reflects the change.

9. **Build and test**: `bun run build` succeeds; `bun test` passes with the
   new tests; after code changes, `ludics init --no-triggers` regenerates
   the bundled dashboard assets.

## Context

### Queue data path

`src/queue.ts` is the single choke-point for `mag/queue.jsonl`
reads and writes. Every mutation runs inside `withQueueLock(fn)` — a
directory-based advisory lock with stale-lock recovery via `LOCK_STALE_MS`
(pid-liveness check plus a mtime fallback). The helpers already atomically
support enqueue (`queueRequest`), head-reinsert (`queueReinsertHead`),
destructive head pop (`queuePopOne`, `queuePopExpected`), and full drain
(`queuePopAll`). A non-destructive listing (`queueList`) powers the existing
`GET /api/queue`.

Every request record carries a unique `id` of the form
`req-<epoch>-<pid*1e6+counter>` generated by `nextRequestId()`. That is the
natural handle for promote/cancel.

`parseQueueLines` and the private `readQueueLines`/`writeQueueLines` helpers
(which use `atomicWriteFileSync`) are the existing building blocks for the
new helpers.

### Stop-hook cooperation

`src/mag.ts` — the `mag queue-pop` entry point and `queuePopSkill()` both
call `queuePopExpected()`, which is locked. Because promote and cancel will
share the same `withQueueLock`, they are race-free with respect to the pop
path: the only observable race is chronological — a pop can beat a click to
the server, in which case promote/cancel sees `not-found`. The client's
5 s poll reconverges the UI.

### Dashboard-server mutation pattern

`src/dashboard-server.ts` already implements three per-row task actions with
a consistent shape (find them by searching for the literals
`"/api/task-promote"`, `"/api/task-confirm"`, `"/api/task-dismiss"`):

```ts
if (pathname === "/api/task-confirm") {
  const taskParam = url.searchParams.get("task");
  if (!taskParam || !TASK_ID_RE.test(taskParam)) {
    return new Response("Bad Request: invalid task id", { status: 400 });
  }
  try {
    // … validate, mutate, bump lastGenerated = 0 …
    return new Response(JSON.stringify({ status: "ready" }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(String(e), { status: 500 });
  }
}
```

The queue endpoints should follow the same shape with an `id` param in place
of `task`, and a simple regex or length guard for the `req-<digits>-<digits>`
shape (reusing a small `QUEUE_ID_RE` constant is fine).

### Mag tab UI

`templates/dashboard/mag.html` is the entire Mag tab — single-file HTML plus
inline script, no framework. The queue list is rendered by `renderQueue(pending,
results)`. Each pending item currently becomes one `<div class="mag-queue-item">`
built from `item.action`, `item.task`, `item.content`, `item.timestamp`. The
composer is `<textarea id="queue-message">` + `<button id="queue-send">` driven
by `sendMessage()`. Styling lives in `templates/dashboard/style.css` under the
`.mag-queue-*` class family (a short block near the bottom: `.mag-queue-item`,
`.mag-queue-item .action`, `.mag-queue-item .timestamp`).

### CLI switch

`src/mag.ts` has a `case "queue":` branch that currently handles `mag queue`
(show) and `mag queue pop one|all`. Adding `promote <id>` and `cancel <id>`
subcommands here slots in without structural change.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

### 1. Extend `src/queue.ts`

Add two exported functions, both locked:

```ts
export type QueuePromoteResult = "promoted" | "already-head" | "not-found";

export function queuePromoteToTop(id: string): QueuePromoteResult {
  return withQueueLock(() => {
    const lines = readQueueLines();
    const idx = lines.findIndex(line => {
      const rec = parseJsonRecord(line);
      return rec !== null && rec.id === id;
    });
    if (idx < 0) return "not-found";
    if (idx === 0) return "already-head";
    const [promoted] = lines.splice(idx, 1);
    writeQueueLines([promoted!, ...lines]);
    return "promoted";
  });
}

export type QueueCancelResult =
  | { status: "cancelled"; line: string; request: Record<string, unknown> }
  | { status: "not-found" };

export function queueCancel(id: string): QueueCancelResult {
  return withQueueLock(() => {
    const lines = readQueueLines();
    const idx = lines.findIndex(line => {
      const rec = parseJsonRecord(line);
      return rec !== null && rec.id === id;
    });
    if (idx < 0) return { status: "not-found" };
    const [removed] = lines.splice(idx, 1);
    const request = parseJsonRecord(removed!)!;
    writeQueueLines(lines);
    return { status: "cancelled", line: removed!, request };
  });
}
```

Both helpers emit an `emitEvent` with `event_type: "queue_mutate"` (or reuse
the existing `"queue_pop"` type if that's a closer fit — the author should
pick what matches the existing telemetry shape) so the journal records the
action.

### 2. Wire CLI subcommands in `src/mag.ts`

Inside `case "queue":`, extend the `sub2` handling:

```ts
} else if (sub2 === "promote") {
  const id = args[2];
  if (!id) throw new Error("id required (usage: mag queue promote <id>)");
  const { queuePromoteToTop } = await import("./queue.ts");
  const result = queuePromoteToTop(id);
  if (result === "not-found") { process.exitCode = 1; }
  console.log(result);
} else if (sub2 === "cancel") {
  const id = args[2];
  if (!id) throw new Error("id required (usage: mag queue cancel <id>)");
  const { queueCancel } = await import("./queue.ts");
  const result = queueCancel(id);
  if (result.status === "not-found") { process.exitCode = 1; console.log("not-found"); }
  else { console.log(result.line); }
}
```

Update the unknown-subcommand error message to list the new choices.

### 3. Add endpoints to `src/dashboard-server.ts`

Place next to the existing `/api/queue` handlers. Define a
`QUEUE_ID_RE = /^req-\d+-\d+$/` at the same scope as `TASK_ID_RE`.

```ts
if (pathname === "/api/queue-promote" && req.method === "POST") {
  const idParam = url.searchParams.get("id");
  if (!idParam || !QUEUE_ID_RE.test(idParam)) {
    return new Response("Bad Request: invalid queue id", { status: 400 });
  }
  try {
    const { queuePromoteToTop } = await import("./queue.ts");
    const status = queuePromoteToTop(idParam);
    lastGenerated = 0;
    return new Response(JSON.stringify({ status }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(String(e), { status: 500 });
  }
}

if (pathname === "/api/queue-cancel" && req.method === "POST") {
  const idParam = url.searchParams.get("id");
  if (!idParam || !QUEUE_ID_RE.test(idParam)) {
    return new Response("Bad Request: invalid queue id", { status: 400 });
  }
  try {
    const { queueCancel } = await import("./queue.ts");
    const result = queueCancel(idParam);
    lastGenerated = 0;
    if (result.status === "not-found") {
      return new Response(JSON.stringify({ status: "not-found" }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    const request = result.request;
    const content = typeof request.content === "string" ? request.content : null;
    const action = typeof request.action === "string" ? request.action : "unknown";
    const task = typeof request.task === "string" ? request.task : undefined;
    const body: Record<string, unknown> = { status: "cancelled", content, action };
    if (task !== undefined) body.task = task;
    return new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(String(e), { status: 500 });
  }
}
```

### 4. UI in `templates/dashboard/mag.html`

In `renderQueue`, change the pending-item rendering to include two buttons
with `data-queue-id` attributes, hidden for `raw` entries:

```js
if (item.raw) {
  html += `<div class="mag-queue-item"><span class="action">[malformed]</span> ${escapeHtml(String(item.raw).slice(0, 80))}</div>`;
  continue;
}
const id = item.id ? escapeHtml(String(item.id)) : '';
// …
const actions = id
  ? `<div class="mag-queue-actions">
       <button type="button" class="mag-queue-action promote" title="Move to top" data-queue-id="${id}" onclick="promoteQueueItem('${id}')">↑</button>
       <button type="button" class="mag-queue-action edit-cancel" title="Edit / cancel" data-queue-id="${id}" onclick="editCancelQueueItem('${id}')">✎✖</button>
     </div>`
  : '';
html += `<div class="mag-queue-item"><span class="action">[${action}]</span>${task}${content}${ts}${actions}</div>`;
```

Handlers:

```js
async function promoteQueueItem(id) {
  try {
    await fetch('/api/queue-promote?id=' + encodeURIComponent(id), { method: 'POST' });
  } catch {}
  fetchQueue();
}

async function editCancelQueueItem(id) {
  try {
    const r = await fetch('/api/queue-cancel?id=' + encodeURIComponent(id), { method: 'POST' });
    if (r.ok) {
      const body = await r.json();
      if (body.status === 'cancelled' && body.content) {
        const ta = document.getElementById('queue-message');
        if (ta) {
          const existing = ta.value;
          const sep = existing && existing.trim() ? '\n\n' : '';
          ta.value = existing + sep + body.content;
          ta.focus();
        }
      }
    }
  } catch {}
  fetchQueue();
}
```

Add a small block of CSS to `style.css` next to the existing `.mag-queue-item`
block for button layout (`.mag-queue-actions { display: inline-flex; gap: 4px; margin-left: 6px; }`
and a compact `.mag-queue-action` style). The exact styling is at the
implementer's discretion as long as the buttons are clearly clickable and
don't overflow the row.

### 5. Tests

Add to `src/queue.test.ts` following the existing `describe("queuePopOne", …)`
style:

```ts
describe("queuePromoteToTop", () => {
  test("promotes middle item to head", async () => { /* … */ });
  test("already-head is a no-op", async () => { /* … */ });
  test("not-found for unknown id", async () => { /* … */ });
  test("empty queue returns not-found", async () => { /* … */ });
});

describe("queueCancel", () => {
  test("removes targeted item and returns its record", async () => { /* … */ });
  test("not-found for unknown id", async () => { /* … */ });
});
```

Add integration tests in `src/dashboard.test.ts` using the same server-boot
pattern as the existing tests (spin up the dashboard, seed a queue via
`queueRequest`, hit the endpoints, assert JSON and queue state).

## Scope

**In scope:**
- New library helpers `queuePromoteToTop` and `queueCancel` in `src/queue.ts`.
- New endpoints `/api/queue-promote` and `/api/queue-cancel` in
  `src/dashboard-server.ts`.
- UI buttons, handlers, and minor CSS in `templates/dashboard/mag.html`
  (and `style.css`).
- Optional `ludics mag queue promote <id>` / `ludics mag queue cancel <id>`
  subcommands in `src/mag.ts`.
- Unit tests for the new helpers; integration tests for the new endpoints.

**Out of scope:**
- Reordering pending items to arbitrary positions (only promote-to-top).
- Per-action-type branching for the cancel button (uniform dequeue + content
  hydration only).
- Confirm dialogs, undo, or draft preservation for the composer overwrite UX
  (user resolved: silently append).
- Any reshape of the pop path or the lock. Stop-hook / `queuePopExpected`
  behaviour is unchanged.
- Adding an `id` field to historical queue entries that lack one — existing
  records without `id` were all popped long ago; current writes always include
  it (see `nextRequestId`). If a pre-existing record somehow lacks `id`, the
  UI simply won't render buttons for it (same as `raw`).

**Dependencies:** none. Builds on existing queue infrastructure shipped by
`task-3432c95a-mag-dashboard-queue.md`.

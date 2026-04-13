# Proposal: Add request queue side panel to Mag dashboard (rename terminal.html → mag.html)

**Task:** task-3432c95a
**Date:** 2026-04-13

## Goal

Add a queue side panel to the Mag terminal page showing pending/processed queue messages, with ability to send new messages. Rename `terminal.html` → `mag.html`.

## Acceptance Criteria

1. `terminal.html` renamed to `mag.html`; all 9 template files and `nav.js` updated.
2. Side panel shows queue items from `mag/queue.jsonl` with action, task, timestamp. Auto-refreshes via polling.
3. Text area + Send button allows enqueuing a new message.
4. New API endpoints: `GET /api/queue` (list items) and `POST /api/queue` (enqueue).
5. `bun run build` succeeds, all tests pass.

## Context

### Current state

`terminal.html` is a simple page: header nav + an iframe pointing to ttyd (URL from `data/mag.json`). No queue visibility. Served as a static file — no dedicated route in `dashboard-server.ts`.

### Queue infrastructure

`src/queue.ts` has `queueRequest()` (append), `queuePop()` (destructive read), `queuePending()` (boolean), `queueShow()` (CLI print). No non-destructive list function exported. Private `readQueueLines()` at line 73 reads all lines.

### References to update (rename)

9 template files with hardcoded `terminal.html` in nav links, plus `nav.js:5`. Also `terminal.html` itself (self-link).

## Approach

### 1. Rename terminal.html → mag.html

- Rename `templates/dashboard/terminal.html` → `mag.html`
- Update references in all template files: `index.html`, `health.html`, `terminals.html`, `retrospective.html`, `briefing.html`, `tasks.html`, `ntfy.html`, `proposal.html`, and `mag.html` itself
- Update `nav.js:5` href

### 2. Add queue side panel to mag.html

Layout: flexbox row — terminal iframe (flex: 1) + queue panel (fixed width ~350px, right side).

Queue panel has two sections:
- **Queue list** (top, scrollable): pending items with action, task ID, timestamp. Poll `GET /api/queue` every 5s.
- **Send form** (bottom, fixed): text area + Send button. POST to `/api/queue`.

### 3. Export queueList() from queue.ts

```typescript
export function queueList(): QueueRequest[] {
  return readQueueLines()
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as QueueRequest);
}
```

### 4. Add API endpoints in dashboard-server.ts

```typescript
// GET /api/queue — list pending items
// Returns JSON array of queue items

// POST /api/queue — enqueue a message
// Body: { action: string, task?: string }
// Calls queueRequest() and returns the created item
```

Add near the existing `/api/queue-hold` endpoint (line 410).

### 5. Also show recent results

Read `mag/results/*.json` (last 10 by mtime) to show completed items alongside pending ones, giving a full picture of queue activity.

### Files to modify

- `templates/dashboard/terminal.html` → `mag.html` (rename + add side panel)
- `templates/dashboard/*.html` (8 files) — update nav links
- `templates/dashboard/nav.js` — update href
- `src/queue.ts` — export `queueList()`
- `src/dashboard-server.ts` — add `/api/queue` GET and POST endpoints

# Proposal: Remove Terminals tab, link to t3code Web client

**Task:** gh-ludics-40
**Date:** 2026-03-11
**Status:** draft

## Summary

Replace the dashboard's Terminals tab (which embeds ttyd iframes in a 3x2 grid) with a nav-bar link that opens the t3code Web client in a new browser tab. The t3code server URL is resolved dynamically via a new `data/t3code.json` endpoint. Slot tiles on the main Dashboard page already link to per-thread t3code URLs through the existing `slot.terminals` mechanism — no change needed there.

## Motivation

The Terminals tab was built for the agent-duo era (ttyd iframes). With the migration to t3code, terminals are accessed via the t3code Web client at `{webUrl}/{threadId}`. Embedding t3code in iframes is not practical — it is a full web app. A direct link is the correct UX. This also makes gh-ludics-23 Bug 3 (missing terminal sessions) moot.

## Changes

### 1. New data endpoint: `data/t3code.json`

**File:** `src/dashboard.ts` (lines 396-488)

Add a `generateT3code()` function that reads the t3code server record and returns the web URL. Wire it into `dashboardGenerate()`.

```typescript
// After the existing imports, add:
import { readServerRecord } from "./t3code/server.ts";

// New generator (add after generateBriefing around line 459):
function generateT3code(): Record<string, unknown> {
  const record = readServerRecord();
  if (!record) {
    return { available: false, webUrl: null };
  }
  return { available: true, webUrl: record.webUrl };
}
```

In `dashboardGenerate()` (line 463), add after the briefing.json write (line 486):

```typescript
writeFileSync(join(dataDir, "t3code.json"), JSON.stringify(generateT3code(), null, 2));
console.error("  t3code.json");
```

### 2. Replace "Terminals" nav link with "t3code" external link

**Files to modify (nav bar appears in all four):**

| File | Nav bar location |
|------|-----------------|
| `templates/dashboard/index.html` | Line 14 |
| `templates/dashboard/tasks.html` | Line 187 |
| `templates/dashboard/briefing.html` | Line 155 |
| `templates/dashboard/terminals.html` | Will be deleted |

In each surviving file, replace:
```html
<a href="terminals.html">Terminals</a>
```
with:
```html
<a href="#" id="t3code-link" target="_blank">t3code</a>
```

Add a shared JS snippet at the end of each page's `<script>` block (or in `dashboard.js` for `index.html`):

```javascript
// Resolve t3code link
(async function() {
  try {
    const resp = await fetch('data/t3code.json');
    if (!resp.ok) return;
    const data = await resp.json();
    const link = document.getElementById('t3code-link');
    if (link && data.available && data.webUrl) {
      link.href = data.webUrl;
      link.title = 't3code Web client';
    } else if (link) {
      link.style.opacity = '0.4';
      link.style.pointerEvents = 'none';
      link.title = 't3code server not running';
    }
  } catch { /* ignore */ }
})();
```

Note: The `getUrl()` helper in `network.ts` already handles Tailscale hostnames transparently. However, the t3code server record stores `webUrl` with the host it was started on (`127.0.0.1`). For Tailnet access, the `generateT3code()` function should replace the host with `networkHostname()`:

```typescript
import { networkHostname } from "./network.ts";

function generateT3code(): Record<string, unknown> {
  const record = readServerRecord();
  if (!record) {
    return { available: false, webUrl: null };
  }
  // Replace host with network-aware hostname for Tailnet support
  const hostname = networkHostname();
  const webUrl = `http://${hostname}:${record.port}`;
  return { available: true, webUrl };
}
```

### 3. Delete `terminals.html`

**File:** `templates/dashboard/terminals.html` (entire file, 437 lines)

Delete the file. The `dashboardInstall()` function uses `copyDir()` which copies all files from the template directory, so removing the source file is sufficient. Users who have already installed the dashboard will retain a stale `terminals.html` in their harness — this is harmless since no page links to it anymore.

### 4. Update `dashboard.js` — add t3code link resolver

**File:** `templates/dashboard/dashboard.js` (line ~53, inside `fetchAllData`)

Add `fetchT3codeLink()` to the `Promise.all` array (line 41-46):

```javascript
async function fetchAllData() {
    try {
        await Promise.all([
            fetchSlots(),
            fetchReadyQueue(),
            fetchNotifications(),
            fetchMagStatus(),
            fetchT3codeLink()   // <-- add
        ]);
        ...
    }
}
```

And add the fetch function:

```javascript
async function fetchT3codeLink() {
    try {
        const response = await fetch(CONFIG.dataPath + 't3code.json');
        if (!response.ok) return;
        const data = await response.json();
        const link = document.getElementById('t3code-link');
        if (!link) return;
        if (data.available && data.webUrl) {
            link.href = data.webUrl;
            link.title = 't3code Web client';
            link.style.opacity = '';
            link.style.pointerEvents = '';
        } else {
            link.style.opacity = '0.4';
            link.style.pointerEvents = 'none';
            link.title = 't3code server not running';
        }
    } catch { /* ignore */ }
}
```

For `tasks.html` and `briefing.html`, the inline `<script>` blocks do not call a shared `fetchAllData()`. Append the same self-invoking function shown in Change 2 to each inline script.

### 5. No changes needed to slot terminal links

The t3code adapter (`src/adapters/t3code.ts`, line 710) already writes `Web: {webUrl}/{threadId}` entries to the Terminals section of `slots.md`. These flow into `slots.json` via `generateSlots()` (lines 54-66) and are rendered as clickable links by `dashboard.js` (lines 117-124). No changes needed here.

### 6. No changes needed to `dashboard-server.ts`

The server serves static files. The new `data/t3code.json` will be served automatically once generated. No routing changes required.

## Files Modified (summary)

| File | Action |
|------|--------|
| `src/dashboard.ts` | Add `generateT3code()`, wire into `dashboardGenerate()` |
| `templates/dashboard/index.html` | Replace Terminals nav link with t3code link |
| `templates/dashboard/dashboard.js` | Add `fetchT3codeLink()` |
| `templates/dashboard/tasks.html` | Replace Terminals nav link, add t3code link JS |
| `templates/dashboard/briefing.html` | Replace Terminals nav link, add t3code link JS |
| `templates/dashboard/terminals.html` | **Delete** |

## Test Plan

1. **Unit: `generateT3code()` with no server record** -- returns `{ available: false, webUrl: null }`.
2. **Unit: `generateT3code()` with server record** -- returns correct `webUrl` with network-aware hostname.
3. **Manual: `ludics dashboard generate`** -- verify `data/t3code.json` is created alongside other JSON files.
4. **Manual: `ludics dashboard serve`** -- open dashboard:
   - Verify "t3code" link appears in nav bar on all three pages (index, tasks, briefing).
   - Verify "Terminals" link is gone from nav bar.
   - When t3code server is running: link opens t3code Web client in new tab.
   - When t3code server is not running: link is grayed out / non-clickable.
5. **Manual: slot tiles** -- verify slot terminal links (Web) still work and point to `{webUrl}/{threadId}`.
6. **Manual: `ludics dashboard install`** -- verify `terminals.html` is not copied to the dashboard directory.
7. **Regression: briefing and tasks pages** -- verify they still load and function correctly.

## Risk Assessment

- **Low risk.** This is a UI-only change to the dashboard templates plus one small data generator addition. No changes to slot management, task management, or adapter logic.
- **Stale `terminals.html` in existing installs.** Users who installed before this change will have a leftover `terminals.html`. It will still be accessible by direct URL but no page links to it. Acceptable — `ludics dashboard install` will not copy it on next reinstall.
- **t3code server not running.** The link gracefully degrades (grayed out, non-clickable). No errors thrown.
- **Tailnet hostname resolution.** Uses the existing `networkHostname()` infrastructure which already handles localhost/tailscale modes. No new hostname logic needed.

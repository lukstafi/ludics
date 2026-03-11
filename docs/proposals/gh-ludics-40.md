# Proposal: Remove Terminals tab, link to t3code Web client

**Task:** gh-ludics-40
**Date:** 2026-03-11
**Status:** draft

## Summary

Replace the dashboard's Terminals tab (which embeds ttyd iframes in a 3x2 grid) with a nav-bar link that navigates to the t3code Web client in the same browser tab. The t3code server URL is resolved dynamically via a new `data/t3code.json` endpoint, using the shared `networkHostname()` from `src/network.ts` so that both the dashboard and t3code use the same network address. The default network mode is migrated from `localhost` to `tailscale`, making Tailnet the default access method. All stale terminal-related code (terminals.html, ttyd references in dashboard.ts, mag-terminal element in index.html) is cleaned up.

In planned followup work, the t3code fork will be modified to add links back to the dashboard, enabling bidirectional navigation.

## Motivation

The Terminals tab was built for the agent-duo era (ttyd iframes). With the migration to t3code, terminals are accessed via the t3code Web client at `{webUrl}/{threadId}`. Embedding t3code in iframes is not practical — it is a full web app. A direct same-tab navigation link is the correct UX. This also makes gh-ludics-23 Bug 3 (missing terminal sessions) moot.

The dashboard and t3code should share the same network hostname so that links work consistently regardless of whether the user is accessing from localhost or over Tailnet. The `networkHostname()` function in `src/network.ts` is the single source of truth for this.

## Changes

### 1. Tailnet default migration

**File:** `src/network.ts` (line 7)

Change the default network mode from `"localhost"` to `"tailscale"`:

```typescript
// Before:
return config.network?.mode ?? "localhost";

// After:
return config.network?.mode ?? "tailscale";
```

This means machines with Tailscale installed will default to using the Tailnet hostname for all URLs (dashboard, t3code, mag terminal). Users who want localhost behavior can explicitly set `network.mode: localhost` in their `config.yaml`. The fallback chain in `networkHostname()` (line 44-53) already handles the case where Tailscale is unavailable — it falls back to the config hostname, then to `"localhost"`.

No changes to `config.yaml` are needed — the config file does not currently set `network.mode`, so it will pick up the new default.

### 2. New data endpoint: `data/t3code.json`

**File:** `src/dashboard.ts`

Add a `generateT3code()` function that reads the t3code server record and returns the web URL, using `networkHostname()` to ensure the URL uses the shared network address:

```typescript
import { readServerRecord } from "./t3code/server.ts";
import { networkHostname } from "./network.ts";

function generateT3code(): Record<string, unknown> {
  const record = readServerRecord();
  if (!record) {
    return { available: false, webUrl: null };
  }
  // Use shared networkHostname() so dashboard and t3code use the same address
  const hostname = networkHostname();
  const webUrl = `http://${hostname}:${record.port}`;
  return { available: true, webUrl };
}
```

Wire it into `dashboardGenerate()` after the briefing.json write:

```typescript
writeFileSync(join(dataDir, "t3code.json"), JSON.stringify(generateT3code(), null, 2));
console.error("  t3code.json");
```

Note: `getUrl` is already imported from `./network.ts` — add `networkHostname` to that import. Or use `getUrl(record.port)` directly, since it already calls `networkHostname()` internally:

```typescript
function generateT3code(): Record<string, unknown> {
  const record = readServerRecord();
  if (!record) {
    return { available: false, webUrl: null };
  }
  return { available: true, webUrl: getUrl(record.port) };
}
```

This approach is cleaner — it reuses `getUrl()` which already calls `networkHostname()`.

### 3. Replace "Terminals" nav link with "t3code" same-tab link

**Files to modify (nav bar appears in all three surviving files):**

| File | Nav bar location |
|------|-----------------|
| `templates/dashboard/index.html` | Line 14 |
| `templates/dashboard/tasks.html` | Line 187 |
| `templates/dashboard/briefing.html` | Line 155 |

In each file, replace:
```html
<a href="terminals.html">Terminals</a>
```
with:
```html
<a href="#" id="t3code-link">t3code</a>
```

No `target="_blank"` — clicking the link navigates away from the dashboard in the same tab. In followup work, the t3code fork will add a link back to the dashboard.

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

### 4. Delete `terminals.html`

**File:** `templates/dashboard/terminals.html` (entire file, ~437 lines)

Delete the file. The `dashboardInstall()` function uses `copyDir()` to copy all files from the template directory, so removing the source file is sufficient.

### 5. Stale code cleanup

The following terminal-related dead code should be removed when the Terminals tab is deleted:

#### 5a. Remove ttyd/mag-terminal references from `src/dashboard.ts`

In `generateMag()` (lines 413-415, 441), remove the ttyd terminal URL generation:

```typescript
// REMOVE these lines from generateMag():
const magPort = String((config.mag as Record<string, unknown> | undefined)?.ttyd_port ?? "7679");
const terminal = getUrl(magPort);

// And remove from the return object:
terminal: terminal || null,
```

The `mag.terminal` field was used to link to the ttyd terminal for the Mag session. With t3code replacing ttyd, this is dead code. The Mag session is now accessed via the t3code Web client like any other thread.

#### 5b. Remove `mag-terminal` link from `templates/dashboard/index.html`

Line 117 in `index.html`:
```html
<!-- REMOVE this line: -->
<a href="#" id="mag-terminal">Open terminal</a>
```

#### 5c. Remove `mag-terminal` handling from `templates/dashboard/dashboard.js`

Lines 219, 236-238 in `dashboard.js`:
```javascript
// REMOVE these lines from renderMagStatus():
const terminalLink = document.getElementById('mag-terminal');

if (terminalLink && mag.terminal) {
    terminalLink.href = mag.terminal;
    terminalLink.style.display = 'inline';
}
```

#### 5d. Rename terminal links in slot tiles (optional, not stale)

The slot-level `terminals` field in `renderSlots()` (dashboard.js lines 117-124) is **not stale** — it renders per-slot t3code Web URLs written by the t3code adapter. These links remain useful and should be kept. However, the comment `// Build terminal links` could be updated to `// Build session links` to reflect the t3code era.

### 6. Shared hostname between dashboard and t3code

The `networkHostname()` function in `src/network.ts` is already the single source of truth for determining the hostname. This proposal ensures both the dashboard server and the t3code link use it consistently:

- **Dashboard server** (`src/dashboard-server.ts`): Already uses `getUrl()` or should use `networkHostname()` for the address it reports. No change needed if it already binds to `0.0.0.0`.
- **t3code link in dashboard**: The new `generateT3code()` uses `getUrl(record.port)` which calls `networkHostname()` internally. This ensures the t3code URL uses the same hostname as the dashboard.
- **Slot terminal links**: The t3code adapter writes URLs using the host the server was started on. If the t3code server start logic also uses `networkHostname()`, these will be consistent. Verify in `src/t3code/server.ts` that the server record's `webUrl` uses `networkHostname()` or `getUrl()`.

The key point is: **one function (`networkHostname()`) determines the hostname for all services**. With the Tailnet default migration (Change 1), this means both dashboard and t3code links will use the Tailnet hostname by default.

### 7. Update `dashboard.js` — add t3code link resolver

**File:** `templates/dashboard/dashboard.js`

Add `fetchT3codeLink()` to the `Promise.all` array:

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

For `tasks.html` and `briefing.html`, append the same self-invoking function shown in Change 3 to each inline script.

### 8. No changes needed to slot terminal links

The t3code adapter already writes `Web: {webUrl}/{threadId}` entries to the Terminals section of `slots.md`. These flow into `slots.json` and are rendered by `dashboard.js`. No changes needed here.

## Files Modified (summary)

| File | Action |
|------|--------|
| `src/network.ts` | Change default mode from `"localhost"` to `"tailscale"` |
| `src/dashboard.ts` | Add `generateT3code()`, remove ttyd `terminal` from `generateMag()` |
| `templates/dashboard/index.html` | Replace Terminals nav link with t3code, remove `mag-terminal` link |
| `templates/dashboard/dashboard.js` | Add `fetchT3codeLink()`, remove `mag-terminal` handling |
| `templates/dashboard/tasks.html` | Replace Terminals nav link, add t3code link JS |
| `templates/dashboard/briefing.html` | Replace Terminals nav link, add t3code link JS |
| `templates/dashboard/terminals.html` | **Delete** |

## Test Plan

1. **Unit: `generateT3code()` with no server record** -- returns `{ available: false, webUrl: null }`.
2. **Unit: `generateT3code()` with server record** -- returns correct `webUrl` using `networkHostname()`.
3. **Unit: `networkMode()` default** -- returns `"tailscale"` when no config is set.
4. **Unit: `networkHostname()` fallback** -- returns `"localhost"` when Tailscale is not available and no config hostname is set.
5. **Manual: `ludics dashboard generate`** -- verify `data/t3code.json` is created; verify `data/mag.json` no longer contains `terminal` field.
6. **Manual: `ludics dashboard serve`** -- open dashboard:
   - Verify "t3code" link appears in nav bar on all three pages (index, tasks, briefing).
   - Verify "Terminals" link is gone from nav bar.
   - Verify "Open terminal" link is gone from Mag status section.
   - When t3code server is running: link navigates to t3code Web client in the same tab.
   - When t3code server is not running: link is grayed out / non-clickable.
7. **Manual: Tailnet access** -- access dashboard from a different machine on the Tailnet; verify t3code link uses the Tailnet hostname.
8. **Manual: slot tiles** -- verify slot terminal links (Web) still work and point to `{webUrl}/{threadId}`.
9. **Manual: `ludics dashboard install`** -- verify `terminals.html` is not copied.
10. **Manual: explicit localhost mode** -- set `network.mode: localhost` in config.yaml; verify everything uses `localhost`.
11. **Regression: briefing and tasks pages** -- verify they still load and function correctly.

## Risk Assessment

- **Low risk overall.** UI-only changes to dashboard templates plus one data generator, one default change.
- **Tailnet default migration.** This is the most impactful change — all URLs will default to Tailnet hostnames. Mitigated by the existing fallback chain in `networkHostname()`: if Tailscale is not installed or not connected, it falls back to config hostname, then to `"localhost"`. Users on machines without Tailscale will see no behavior change.
- **Stale `terminals.html` in existing installs.** Users who installed before this change will have a leftover file. Harmless — no page links to it.
- **t3code server not running.** The link gracefully degrades (grayed out, non-clickable).
- **Shared hostname consistency.** Using `getUrl()` / `networkHostname()` everywhere ensures the dashboard and t3code links always use the same hostname. The t3code adapter's server record should also be verified to use the same function.
- **No return navigation (yet).** Clicking t3code navigates away; browser back button is the only return. Followup on the t3code fork will add dashboard links.

# Proposal: Dashboard scroll preservation and quick links fix

**Task:** gh-ludics-23
**Date:** 2026-03-11
**Status:** draft

## Summary

This proposal addresses two of the three bugs listed in gh-ludics-23. Bug 3 (terminals missing sessions) is **moot** because gh-ludics-40 (slot 1) is removing the Terminals tab entirely and replacing it with t3code links. This proposal covers:

- **Bug 1:** Scrolling panes on the main dashboard tab reset every 10 seconds
- **Bug 2:** Quick Links section uses `runCommand()` which just shows an alert

## Verified Code Locations

### Bug 1: Scroll reset

| File | Line(s) | What |
|------|---------|------|
| `templates/dashboard/dashboard.js` | 28 | `setInterval(fetchAllData, CONFIG.refreshInterval)` — 10s refresh |
| `templates/dashboard/dashboard.js` | 70-127 | `renderSlots()` — rebuilds all slot tile DOM via `innerHTML` |
| `templates/dashboard/dashboard.js` | 115 | `detailsDiv.innerHTML = html` — destroys scroll position |
| `templates/dashboard/dashboard.js` | 124 | `linksDiv.innerHTML = links` — same pattern |
| `templates/dashboard/dashboard.js` | 143-164 | `renderReadyQueue()` — replaces `list.innerHTML` |
| `templates/dashboard/dashboard.js` | 180-200 | `renderNotifications()` — replaces `list.innerHTML` |
| `templates/dashboard/style.css` | 243 | `.task-content` has `overflow-y: auto` (scrollable) |
| `templates/dashboard/style.css` | 381 | `.panel ul` has `overflow-y: auto` (sidebar lists scrollable) |

### Bug 2: Quick links

| File | Line(s) | What |
|------|---------|------|
| `templates/dashboard/index.html` | 124-129 | Quick Links `<ul>` with `onclick="runCommand(...)"` calls |
| `templates/dashboard/dashboard.js` | 261-263 | `runCommand()` — just does `alert()` |
| `templates/dashboard/tasks.html` | — | No URL filter/search-param support exists |

## Implementation Approach

### Bug 1: Preserve scroll position during DOM updates

**Strategy:** Add a helper function `updateHTML(element, newHTML)` that:
1. Compares the new HTML string against the current `innerHTML` (normalized).
2. If content is unchanged, skips the update entirely (most common case during idle periods).
3. If content has changed, captures `scrollTop` of all `.task-content` elements and the element itself before updating, sets `innerHTML`, then restores `scrollTop` values.

**Specific changes in `templates/dashboard/dashboard.js`:**

1. Add helper at the top of the file:

```js
function updateHTML(element, newHTML) {
    if (element.innerHTML === newHTML) return; // no change, skip
    // Save scroll positions of scrollable children
    const scrollState = [];
    element.querySelectorAll('.task-content').forEach((el, i) => {
        scrollState.push({ selector: i, scrollTop: el.scrollTop });
    });
    const parentScroll = element.scrollTop;
    // Update
    element.innerHTML = newHTML;
    // Restore scroll positions
    element.querySelectorAll('.task-content').forEach((el, i) => {
        if (scrollState[i]) el.scrollTop = scrollState[i].scrollTop;
    });
    element.scrollTop = parentScroll;
}
```

2. In `renderSlots()` (line 115), replace `detailsDiv.innerHTML = html` with `updateHTML(detailsDiv, html)`.

3. In `renderSlots()` (line 124), replace `linksDiv.innerHTML = links` with `updateHTML(linksDiv, links)`.

4. In `renderSlots()` (lines 87-88), for the empty case, replace direct `innerHTML = ''` with `updateHTML(detailsDiv, '')` and `updateHTML(linksDiv, '')`.

5. In `renderReadyQueue()` (line 148 and 163), replace `list.innerHTML = ...` with `updateHTML(list, ...)`.

6. In `renderNotifications()` (line 185 and 199), replace `list.innerHTML = ...` with `updateHTML(list, ...)`.

**Note:** The `innerHTML` string comparison is a simple and effective diff for this dashboard — the HTML is small and deterministic (no random IDs or timestamps embedded in the markup itself, since timestamps are formatted from the same ISO strings each cycle). The `tasks.html` page already uses a more sophisticated approach (tracking `openNodeKeys` to preserve expansion state) but does not preserve scroll, so it has the same class of bug — however that page is out of scope for this issue.

### Bug 2: Make quick links functional

**Strategy:** Replace `runCommand()` alert calls with direct navigation links. Since `tasks.html` has no URL filter support, the links should navigate to existing pages or scroll to on-page sections.

**Specific changes in `templates/dashboard/index.html` (lines 124-129):**

Replace the Quick Links `<ul>` content with:

```html
<li><a href="tasks.html">All Tasks</a></li>
<li><a href="#" onclick="document.getElementById('ready-list').scrollIntoView({behavior:'smooth'}); return false;">Flow Ready</a></li>
<li><a href="briefing.html">Briefing</a></li>
<li><a href="terminals.html">Terminals</a></li>
```

Changes:
- "All Tasks" becomes a direct link to `tasks.html` (no onclick).
- "Flow Ready" scrolls to the Ready Queue panel on the current page.
- "Flow Blocked" and "Flow Critical" are **removed** — there is no filtered view for these and no backend endpoint to generate one. They are misleading as non-functional links.
- "Briefing" and "Terminals" are added as quick-access links (they exist in the nav bar but having them in Quick Links is convenient).
- The `runCommand()` function in `dashboard.js` (lines 261-263) is **deleted** since nothing calls it anymore.

**Note on nav bar overlap with gh-ludics-24:** gh-ludics-24 (slot 3) is adding a proposal viewer page which will add a nav link. The Quick Links changes here do not conflict — they only modify the Quick Links `<ul>` in the sidebar, not the `<header>` nav bar. If the Terminals nav link is being removed by gh-ludics-40, the Quick Links entry for Terminals should also be omitted; coordinate at merge time.

## Test Plan

- [ ] Open dashboard with active slots that have long `.task-content`. Scroll down in a task content pane. Wait >10 seconds. Verify scroll position is preserved.
- [ ] Open dashboard with enough notifications/ready-queue items to overflow. Scroll the sidebar lists. Wait >10 seconds. Verify scroll position is preserved.
- [ ] Modify a slot assignment (e.g., `ludics slot assign`). Verify the dashboard reflects the change on the next refresh cycle without requiring a manual page reload.
- [ ] Click "All Tasks" in Quick Links. Verify it navigates to `tasks.html`.
- [ ] Click "Flow Ready" in Quick Links. Verify it scrolls smoothly to the Ready Queue panel.
- [ ] Verify no JavaScript console errors on page load or during refresh cycles.
- [ ] Verify the "Briefing" and "Terminals" quick links navigate correctly.

## Risk Assessment

**Low risk.** Both changes are isolated to frontend template files (`dashboard.js` and `index.html`). No backend changes required. No data format changes.

- **Scroll preservation:** The `innerHTML` string comparison is O(n) on the HTML string length, but the dashboard HTML is small (<10KB per slot tile). If this becomes a concern, a hash-based comparison could be substituted.
- **Quick links:** Removing "Flow Blocked" and "Flow Critical" reduces functionality, but these links never worked — they only showed an alert. If filtered task views are desired in the future, they should be implemented as a proper feature in `tasks.html` with URL parameter support.
- **Merge conflict with gh-ludics-40:** If the Terminals tab is removed before this lands, the "Terminals" quick link should be dropped. The nav bar `<a href="terminals.html">Terminals</a>` will presumably be removed by gh-ludics-40 — this proposal does not touch the nav bar.
- **Merge conflict with gh-ludics-24:** Minimal. gh-ludics-24 adds a nav bar entry; this proposal only changes the sidebar Quick Links section and `dashboard.js`.

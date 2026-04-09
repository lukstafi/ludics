# Dashboard fetch-render split: documenting comment for cross-dependent panels

## Goal

Add a documenting comment block to `fetchAllData()` in `dashboard.js` that codifies the fetch-render split convention. The comment explains when inline rendering is safe (independent panels) versus when fetch must be separated from render (cross-dependent panels), and flags `fetchMagStatus` as the highest-risk function for future cross-dependency.

## Acceptance Criteria

- A comment block is added inside or immediately above `fetchAllData()` in `templates/dashboard/dashboard.js`
- The comment states the principle: when a panel's rendering depends on data from another concurrent fetch, the fetch function must return data only, with rendering deferred until after `Promise.all` resolves
- The comment notes that independent panels (e.g., `fetchReadyQueue`, `fetchNotifications`) safely render inline because they have no cross-dependencies
- The comment explicitly calls out `fetchSlots` as the current example of the split pattern (depends on `window.__globalAdapter` set by `fetchAdapter`)
- The comment flags `fetchMagStatus` as highest-risk for future cross-dependency because it mutates global `queueHeld` state and calls `updateQueueHoldUI()` inline
- No functional code changes -- documentation only

## Context

The `fetchAllData()` function (line 41 of `templates/dashboard/dashboard.js`) runs all fetch functions concurrently via `Promise.all` (lines 43-55), then calls `renderSlots(slots)` after all promises resolve (line 56).

This pattern was introduced to fix a race condition: `renderSlots` reads `window.__globalAdapter` (set by `fetchAdapter` at line 84), so rendering slots inline within `fetchSlots` would race against `fetchAdapter`. The fix split `fetchSlots` to return data only, with `renderSlots` called post-`Promise.all`.

However, most other fetch functions still render inline within their bodies:
- `fetchReadyQueue()` (line 236) -- calls `renderReadyQueue()` inline
- `fetchNotifications()` (line 282) -- calls `renderNotifications()` inline
- `fetchMagStatus()` (line 323) -- calls `renderMagStatus()` inline, also mutates global `queueHeld` and calls `updateQueueHoldUI()`
- `fetchT3codeLink()` (line 425) -- manipulates DOM directly
- `fetchAndRenderTaskList()` (line 545) -- combined by design

This inline pattern is currently correct because none of these panels depend on data from other concurrent fetches. The comment should prevent future regressions by making the convention explicit.

## Approach

*Suggested approach -- agents may deviate if they find a better path.*

Add a JSDoc-style comment block immediately before or at the top of `fetchAllData()` body, approximately:

```javascript
// Fetch all dashboard data
//
// CONVENTION: fetch-render split for cross-dependent panels
//
// All fetch functions run concurrently in Promise.all. Most fetch functions
// render their panels inline -- this is safe when the panel has no
// cross-dependencies on data from other concurrent fetches.
//
// When a panel DOES depend on another fetch's result (e.g., renderSlots needs
// window.__globalAdapter set by fetchAdapter), the fetch function must return
// data only, and rendering must happen after Promise.all resolves.
//
// Current split: fetchSlots returns data; renderSlots called post-Promise.all.
// Highest risk for future split: fetchMagStatus mutates global queueHeld state
// and calls updateQueueHoldUI() inline -- if any future panel reads queueHeld,
// this will need the same fetch/render separation.
```

The exact wording can be adjusted, but it must cover the three key points from the acceptance criteria: the principle, the current example, and the risk flag.

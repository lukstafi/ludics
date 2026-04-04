# Dashboard: adapter label as toggle button (tmux/t3code <-> manual)

## Goal

Restore the ability to toggle a slot between its automated adapter (tmux or t3code) and manual mode directly from the dashboard. The adapter label on each slot card should be a clickable button. When the current mode is `tmux` or `t3code`, clicking switches to `manual`. When the current mode is `manual`, clicking switches to the global default adapter (read from `adapter.json`).

## Acceptance Criteria

1. The mode toggle button renders for **all non-empty slots that have a mode**, regardless of whether a session is active (remove the `!slot.sessionStarted` guard that was previously in place).
2. When a slot's mode is `manual`, clicking the toggle switches it to the global default adapter as reported by `adapter.json` (not hardcoded to `tmux`).
3. The dashboard JS fetches `adapter.json` on each refresh cycle and uses its `adapter` field to determine the "other mode" when the current mode is `manual`.
4. A `.mode-toggle-btn.mode-tmux` CSS rule exists, styled consistently with the existing `.mode-t3code` and `.mode-manual` rules.
5. No backend changes needed -- the existing `/api/slot-mode` endpoint and `slotSetMode()` already accept all three modes (`manual`, `tmux`, `t3code`) and handle active-session logic.
6. All existing tests pass.

## Context

### Current state

The mode toggle button already exists (from task-11e95b74):

- **`templates/dashboard/dashboard.js` line 152-156**: Renders a `<button class="mode-toggle-btn">` when `slot.mode` is truthy. Currently computes `otherMode` as: `slot.mode === 'manual' ? 'tmux' : 'manual'` -- this is hardcoded to `tmux` and doesn't use the global adapter setting.

- **`templates/dashboard/dashboard.js` line 687-705**: `toggleSlotMode(slotNum, mode)` calls `GET /api/slot-mode?slot=N&mode=MODE` and refreshes on success.

- **`src/dashboard-server.ts` lines 181-203**: Backend endpoint already validates mode is one of `manual`, `tmux`, `t3code` -- no changes needed here.

- **`src/slots/index.ts` lines 522-564**: `slotSetMode()` allows switching to `manual` even during active sessions. Switching FROM manual to automated is blocked during active sessions (sensible guard). No changes needed.

- **`templates/dashboard/style.css` lines 331-359**: CSS rules for `.mode-toggle-btn`, `.mode-t3code`, and `.mode-manual` exist. Missing: `.mode-tmux` rule.

### Data source for global adapter

- **`src/dashboard.ts` lines 799-815**: `generateAdapter()` writes `adapter.json` with an `adapter` field set to `"tmux"` or `"t3code"` based on `globalAdapter()` from config.
- The dashboard does **not** currently fetch `adapter.json`. It needs to start doing so, storing the global adapter name for use in the toggle logic.

## Approach

*Suggested approach -- agents may deviate if they find a better path.*

1. **Add `adapter.json` fetch** to `fetchAllData()` in `dashboard.js`. Store the result in a module-level variable (e.g., `window.__globalAdapter`). Add a `fetchAdapter()` function similar to `fetchMeta()` that reads `adapter.json` from `CONFIG.dataPath`.

2. **Update toggle `otherMode` logic** (line 155): Change from `slot.mode === 'manual' ? 'tmux' : 'manual'` to `slot.mode === 'manual' ? (window.__globalAdapter || 'tmux') : 'manual'`.

3. **Add `.mode-toggle-btn.mode-tmux` CSS rule** in `style.css` after the existing `.mode-t3code` rule. Use `var(--accent)` or another distinct color (tmux is a different adapter from t3code, so a different color aids visual distinction).

4. **No backend changes** -- the endpoint and `slotSetMode()` already handle all three modes correctly.

## Scope

**In scope:**
- Dashboard JS: fetch `adapter.json`, update toggle `otherMode` computation
- Dashboard CSS: add `.mode-tmux` style rule
- Verifying existing tests still pass

**Out of scope:**
- Backend changes to `slotSetMode()` or `/api/slot-mode` (already correct)
- Session teardown behavior (handled by task-7d0021cd / already in `slotSetMode`)
- Slot start/resume on mode switch (user confirmed: toggling mode does not auto-start)

**Dependencies:**
- `task-7d0021cd` (relates_to) handles the backend safe-teardown plumbing. The toggle UI works regardless -- `slotSetMode()` already handles switching to manual during active sessions.

# Proposal: Dashboard Deferred Launch Tile with Approve/Abandon Buttons

## Goal

Add a "Deferred Launch" dashboard tile that surfaces tasks where `auto-start-evaluate` returned `defer-to-user`. The tile provides **Approve** (enable auto-start) and **Abandon** buttons, making deferred tasks visible and actionable without relying on ntfy.sh notifications alone.

## Acceptance Criteria

- [ ] `auto-start-evaluate` CLI handler sets `deferred_launch: true` in task frontmatter when decision is `defer-to-user`; clears it when decision is `auto-start`
- [ ] New "Deferred Launch" tile on the dashboard, positioned between Unanswered Questions and Recent Notifications
- [ ] Tile lists tasks with `deferred_launch: true` that are not completed/abandoned
- [ ] Each row shows: priority badge, task title (linked to proposal or task file), Approve button, Abandon button
- [ ] **Approve** button: clears `deferred_launch`, sets `approved: true` in frontmatter -- does NOT immediately launch; the keepalive's `maybeAutoStartSlots()` picks it up when a slot is available
- [ ] `evaluateAutoStartDecisionPure` returns `auto-start` (not `defer-to-user`) for tasks with `approved: true`, preventing re-deferral
- [ ] **Abandon** button: sets `status: abandoned`, clears `deferred_launch` -- no confirmation dialog
- [ ] Existing ntfy notification buttons use approve/enable semantics: "Launch task" label changes to "Approve task", and the handler clears `deferred_launch` + sets `approved: true` instead of calling `launchSessionFromNotification`
- [ ] Empty state shows "No tasks awaiting approval"
- [ ] Tile uses the `FilteredTaskTileConfig` / `fetchAndRenderTaskList` shared pattern

## Context

### Code Pointers

| File | Location | Relevance |
|------|----------|-----------|
| `src/mag.ts` | L3069-3081 | `auto-start-evaluate` CLI handler -- where `deferred_launch` flag must be set |
| `src/mag.ts` | L888-908 | `evaluateAutoStartDecisionPure()` -- needs `approved` parameter to skip deferral |
| `src/mag.ts` | L912-957 | `launchSessionFromNotification()` -- currently used by ntfy Launch button, will be replaced by approve semantics |
| `src/mag.ts` | L1105-1131 | `processQueueItem` message handlers for "Launch task" / "Abandon task" -- ntfy button handling |
| `src/mag.ts` | L1862-1906 | `maybeAutoStartSlots()` -- keepalive auto-start that will pick up approved tasks |
| `src/dashboard.ts` | L331-356 | `DashboardTask` interface -- add `deferredLaunch` field |
| `src/dashboard.ts` | L396-450 | `readDashboardTasks()` -- read `deferred_launch` from YAML |
| `src/dashboard.ts` | L503-523 | `FilteredTaskTileConfig`, existing configs -- add `deferredLaunchConfig` |
| `src/dashboard.ts` | L952-1003 | `dashboardGenerate()` -- add `deferred-launch.json` output |
| `src/dashboard-server.ts` | L331-384 | `/api/task-confirm`, `/api/task-dismiss` -- model for new endpoints |
| `src/notify.ts` | L114-118 | `proposalActions()` -- ntfy button labels ("Launch task" -> "Approve task") |
| `templates/dashboard/index.html` | L116-122 | After Unanswered Questions -- insert new section |
| `templates/dashboard/dashboard.js` | L43-54 | `fetchAllData()` -- register new fetch |
| `templates/dashboard/dashboard.js` | L538-600 | `fetchAndRenderTaskList`, `fetchNeedsConfirmation` -- pattern to follow |
| `templates/dashboard/dashboard.js` | L602-638 | `confirmTask`, `dismissTask` -- pattern for action handlers |

## Approach

### 1. Backend: `deferred_launch` flag in `auto-start-evaluate` (src/mag.ts)

In the `auto-start-evaluate` CLI case (L3069-3081), after `evaluateAutoStartDecisionPure` returns:

- If `result.decision === "defer-to-user"`: resolve the task file and call `updateFrontmatterField(taskFile, "deferred_launch", "true")`.
- If `result.decision === "auto-start"`: resolve the task file and call `updateFrontmatterField(taskFile, "deferred_launch", "null")` to clear any prior deferral.

Import `updateFrontmatterField` from `./tasks/markdown.ts` (already used in dashboard-server.ts).

### 2. Backend: `approved` support in auto-start evaluation (src/mag.ts)

Modify `evaluateAutoStartDecisionPure` to accept a new parameter `approved: boolean`. When `approved` is true, return `auto-start` regardless of confidence/autonomy (the user has explicitly approved). Update the CLI handler to read `approved` from the task frontmatter and pass it.

### 3. Backend: `DashboardTask` and data generation (src/dashboard.ts)

- Add `deferredLaunch: boolean` to the `DashboardTask` interface (L331).
- In `readDashboardTasks()` (L442), read `data.deferred_launch` same as `hasQuestions`.
- Add `deferredLaunchConfig`:
  ```ts
  const deferredLaunchConfig: FilteredTaskTileConfig = {
    filter: (task) => task.deferredLaunch && !task.isCompleted && task.status !== "abandoned",
    extraFields: (task) => ({
      hasProposal: task.hasProposal,
      proposalPath: task.proposalPath,
    }),
  };
  ```
- In `dashboardGenerate()` (L972), add:
  ```ts
  writeFileSync(join(dataDir, "deferred-launch.json"),
    JSON.stringify(generateFilteredTaskList(tasks, deferredLaunchConfig), null, 2));
  ```

### 4. Backend: API endpoints (src/dashboard-server.ts)

Add two new endpoints following the `task-confirm` / `task-dismiss` pattern:

**`/api/deferred-approve`** (`?task=<id>`):
- Validate task ID, resolve task file
- Verify task has `deferred_launch: true` (return 409 otherwise)
- Call `updateFrontmatterField(taskFile, "deferred_launch", "null")` to clear the flag
- Call `addFrontmatterField(taskFile, "approved", "true")` to set approval
- Set `lastGenerated = 0` to trigger dashboard regeneration
- Return `{ status: "approved" }`

**`/api/deferred-abandon`** (`?task=<id>`):
- Validate task ID, resolve task file
- Verify task has `deferred_launch: true` (return 409 otherwise)
- Call `updateFrontmatterField(taskFile, "status", "abandoned")`
- Call `updateFrontmatterField(taskFile, "deferred_launch", "null")`
- If task is assigned to a slot, call `slotClear(slotNum, "abandoned")` via shelling out
- Set `lastGenerated = 0`
- Return `{ status: "abandoned" }`

### 5. Frontend: HTML (templates/dashboard/index.html)

Insert between Unanswered Questions and Recent Notifications (~L122):
```html
<!-- Deferred Launch -->
<section class="deferred-launch panel">
    <h2>Deferred Launch</h2>
    <ul id="deferred-launch-list">
        <li class="loading">Loading...</li>
    </ul>
</section>
```

### 6. Frontend: JS (templates/dashboard/dashboard.js)

**`fetchDeferredLaunch()`** using `fetchAndRenderTaskList`:
```js
function fetchDeferredLaunch() {
    return fetchAndRenderTaskList({
        jsonFile: 'deferred-launch.json',
        listId: 'deferred-launch-list',
        emptyText: 'No tasks awaiting approval',
        renderItem(task) {
            const priority = task.priority || '-';
            const priorityClass = `priority-${priority}`;
            const viewLink = task.hasProposal
                ? `proposal.html?task=${encodeURIComponent(task.id)}`
                : `task-files/${encodeURIComponent(task.id)}.md`;
            return `
            <li class="deferred-launch-item">
                <span class="priority ${priorityClass}">${escapeHtml(priority)}</span>
                <a class="task-title" href="${viewLink}" target="_blank">${escapeHtml(task.title || task.id)}</a>
                <span class="deferred-actions">
                    <button class="approve-btn" onclick="approveDeferred('${escapeHtml(task.id)}')" title="Approve: enable auto-start">Approve</button>
                    <button class="abandon-btn" onclick="abandonDeferred('${escapeHtml(task.id)}')" title="Abandon task">Abandon</button>
                </span>
            </li>`;
        },
    });
}
```

**Action handlers** following `confirmTask`/`dismissTask` pattern:
```js
async function approveDeferred(taskId) {
    const btn = event.target;
    btn.disabled = true;
    btn.textContent = '...';
    try {
        const response = await fetch(`/api/deferred-approve?task=${encodeURIComponent(taskId)}`);
        if (response.ok) { fetchAllData(); }
        else { btn.textContent = 'Approve'; setTimeout(() => { btn.disabled = false; }, 2000); }
    } catch { btn.textContent = 'Approve'; setTimeout(() => { btn.disabled = false; }, 2000); }
}

async function abandonDeferred(taskId) {
    const btn = event.target;
    btn.disabled = true;
    btn.textContent = '...';
    try {
        const response = await fetch(`/api/deferred-abandon?task=${encodeURIComponent(taskId)}`);
        if (response.ok) { fetchAllData(); }
        else { btn.textContent = 'Abandon'; setTimeout(() => { btn.disabled = false; }, 2000); }
    } catch { btn.textContent = 'Abandon'; setTimeout(() => { btn.disabled = false; }, 2000); }
}
```

Register `fetchDeferredLaunch()` in the `Promise.all` array in `fetchAllData()` (L43).

### 7. Frontend: CSS (templates/dashboard/style.css)

Add styles for `.deferred-launch-item`, `.approve-btn`, `.abandon-btn` following existing `.needs-confirm-item`, `.confirm-btn`, `.dismiss-btn` patterns.

### 8. Ntfy notification semantics update (src/notify.ts, src/mag.ts)

**`src/notify.ts` L114-118** -- Change `proposalActions()`:
- `"launch"` label -> `"approve"`, body `"Approve task ${taskId}"` (was `"Launch task ${taskId}"`)

**`src/mag.ts` L1105-1120** -- Update `processQueueItem` message handlers:
- Add handler for `"Approve task <id>"`: reads task file, clears `deferred_launch`, sets `approved: true`. Does NOT call `launchSessionFromNotification`.
- Keep backward-compat handler for `"Launch task <id>"` that does the same approve semantics (old buttons still in the wild).

### 9. Test updates (src/mag.test.ts, src/notify.test.ts)

- Update `evaluateAutoStartDecisionPure` tests to cover the new `approved` parameter
- Update ntfy action tests to expect "Approve task" instead of "Launch task"
- Add test: approved=true bypasses defer-to-user

### Edge Cases

- **Task already approved via ntfy before dashboard loads**: The flag is cleared, task disappears from tile -- correct behavior.
- **Re-evaluation after code changes**: `auto-start-evaluate` re-sets `deferred_launch` only if `approved` is not set. Once approved, the task stays approved.
- **Stale `deferred_launch` on completed tasks**: The filter excludes completed/abandoned tasks.
- **Slot clearing via abandon**: The dashboard endpoint should attempt slot clearing if the task is assigned, but gracefully handle the case where it's not assigned to any slot.

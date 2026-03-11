# Proposal: Dashboard proposal viewer and notification view button

**Task:** gh-ludics-24
**Date:** 2026-03-11
**Status:** draft

## Summary

Add a rendered proposal viewer page (`proposal.html`) to the dashboard, link to it from slot tiles and the tasks tree, and add a "view" action button to proposal notifications instead of attaching raw files. This replaces the current raw-markdown experience with a styled HTML view consistent with `briefing.html`.

## Verified Code Locations

All line numbers verified against current source as of 2026-03-11.

| Component | File | Key lines / symbols |
|---|---|---|
| Proposal file route | `src/dashboard-server.ts` | Lines 161-178: `/proposal-files/` handler |
| resolveProposalFile() | `src/dashboard-server.ts` | Lines 83-112 |
| parseTaskFrontmatter() | `src/dashboard-server.ts` | Lines 38-51 |
| SlotJson interface | `src/dashboard.ts` | Lines 18-30 |
| generateSlots() | `src/dashboard.ts` | Lines 42-95 |
| lookupTaskContent() | `src/dashboard.ts` | Lines 32-40 |
| DashboardTask interface | `src/dashboard.ts` | Lines 108-126 |
| TasksTreeNode interface | `src/dashboard.ts` | Lines 128-139 |
| hasNonNullProposal() | `src/dashboard.ts` | Lines 148-155 |
| readDashboardTasks() | `src/dashboard.ts` | Lines 166-208 |
| buildTaskNode() | `src/dashboard.ts` | Lines 277-333 (proposalLink at line 316) |
| renderSlots() | `templates/dashboard/dashboard.js` | Lines 70-127 |
| markdownToHtml() in dashboard.js | `templates/dashboard/dashboard.js` | Lines 295-374 |
| markdownToHtml() in briefing.html | `templates/dashboard/briefing.html` | Lines 231-352 |
| Tasks page renderNode() | `templates/dashboard/tasks.html` | Lines 268-339 (proposalLink at line 299) |
| Slot tile HTML | `templates/dashboard/index.html` | Lines 27-86 (.slot-links div) |
| .slot-links CSS | `templates/dashboard/style.css` | Lines 333-347 |
| notifyProposal() | `src/notify.ts` | Lines 858-965 |
| buildProposalNotificationActions() | `src/notify.ts` | Lines 109-134 |
| NTFY_MAX_ACTIONS | `src/notify.ts` | Line 66 (value: 3) |
| getUrl() | `src/network.ts` | Line 58 |
| networkHostname() | `src/network.ts` | Lines 39-56 |
| Nav bar (index.html) | `templates/dashboard/index.html` | Lines 11-17 |
| Nav bar (briefing.html) | `templates/dashboard/briefing.html` | Lines 152-158 |
| Nav bar (tasks.html) | `templates/dashboard/tasks.html` | Lines 183-189 |

## Implementation Approach

### Step 1: Create `proposal.html` viewer page

Create `templates/dashboard/proposal.html`, modeled on `briefing.html`. The page:
- Has the standard nav bar header (matching other pages)
- Reads `?task={taskId}` query parameter from the URL
- Fetches `/proposal-files/{taskId}.md` from the dashboard server
- Renders markdown to HTML using the same `markdownToHtml()` function (copied from `briefing.html`)
- Displays a "not found" placeholder when the proposal does not exist
- Shows the task ID in the page title and a header above the rendered content

```html
<!-- Key structure (abbreviated) -->
<main class="briefing-container">
    <div class="briefing-header">
        <h2 id="proposal-title">Proposal</h2>
        <span class="briefing-date" id="proposal-task-id"></span>
    </div>
    <div class="briefing-content" id="proposal-content">
        <div class="briefing-placeholder">
            <span class="text">Loading proposal...</span>
        </div>
    </div>
</main>

<script>
    const params = new URLSearchParams(window.location.search);
    const taskId = params.get('task');
    if (taskId) {
        fetch(`/proposal-files/${encodeURIComponent(taskId)}.md`)
            .then(r => { if (!r.ok) throw new Error('Not found'); return r.text(); })
            .then(md => {
                document.getElementById('proposal-content').innerHTML = markdownToHtml(md);
                document.getElementById('proposal-task-id').textContent = taskId;
                document.title = `Proposal: ${taskId}`;
            })
            .catch(() => { /* show not-found placeholder */ });
    }
    // markdownToHtml(), inlineFormat(), escapeHtml(), parseTableRow() — same as briefing.html
</script>
```

The page reuses the `.briefing-content` and `.briefing-container` CSS classes from `briefing.html` (inlined `<style>` block, same pattern as briefing). No new CSS file needed.

### Step 2: Add `hasProposal` and `proposalLink` to SlotJson

In `src/dashboard.ts`:

**2a. Extend `SlotJson` interface** (line 18) with two new fields:

```typescript
interface SlotJson {
  // ... existing fields ...
  hasProposal: boolean;
  proposalLink: string | null;
}
```

**2b. In `generateSlots()`** (around lines 73-91), after determining `taskId`, look up whether the task has a proposal by reading the task file frontmatter:

```typescript
// After: const taskContent = taskId && taskId !== "null" ? lookupTaskContent(taskId) : null;
let hasProposal = false;
if (taskId && taskId !== "null") {
  const taskFile = join(harnessDir(), "tasks", taskId + ".md");
  if (existsSync(taskFile)) {
    const content = readFileSync(taskFile, "utf-8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const data = YAML.parse(fmMatch[1]!) as Record<string, unknown>;
      hasProposal = hasNonNullProposal(data.proposal);
    }
  }
}

result.push({
  // ... existing fields ...
  hasProposal,
  proposalLink: hasProposal && taskId ? `/proposal.html?task=${encodeURIComponent(taskId)}` : null,
});
```

Note: The task file is already read by `lookupTaskContent()`, so for efficiency, refactor `lookupTaskContent()` to return both the body and whether a proposal exists, avoiding a double read. Alternatively, since `generateSlots()` runs at most once per TTL period (default 5s), the extra read is acceptable.

### Step 3: Add proposal link to slot tiles on main page

In `templates/dashboard/dashboard.js`, inside `renderSlots()` (lines 117-124), after building terminal links, add a proposal link:

```javascript
// After the terminal links loop (line 124):
if (slot.proposalLink) {
    links += `<a href="${slot.proposalLink}" target="_blank">proposal</a>`;
}
linksDiv.innerHTML = links;
```

### Step 4: Update Tasks page proposal links to use rendered viewer

In `src/dashboard.ts`, line 316, change:

```typescript
// FROM:
const proposalLink = task.proposalPath ? `/proposal-files/${encodeURIComponent(task.id)}.md` : null;
// TO:
const proposalLink = task.proposalPath ? `/proposal.html?task=${encodeURIComponent(task.id)}` : null;
```

This changes the Tasks page links from raw markdown to the rendered proposal viewer. The raw markdown endpoint `/proposal-files/` remains available for programmatic access.

### Step 5: Add "view" action button to proposal notifications

In `src/notify.ts`, modify `notifyProposal()` (line 858):

**5a.** Import `getUrl` (already imported in dashboard.ts but not in notify.ts) and `loadConfigSync`:

```typescript
import { getUrl } from "./network.ts";
```

Check: `getUrl` may already be imported. Verify at top of file.

**5b.** After computing `slotSuffix` (line 867), compute the dashboard URL:

```typescript
const config = loadConfigSync();
const dashboardPort = config.dashboard?.port ?? 7678;
const dashboardBaseUrl = getUrl(dashboardPort);
const proposalViewUrl = `${dashboardBaseUrl}/proposal.html?task=${encodeURIComponent(taskId)}`;
```

**5c.** In `buildProposalNotificationActions()` (line 109), add a "view" action as the first entry. The ntfy.sh "view" action type opens a URL in the browser:

```typescript
export function buildProposalNotificationActions(
  taskId: string,
  project: string,
  inTopic: string,
  headers: Record<string, string>,
  proposalViewUrl?: string,   // NEW parameter
): NtfyAction[] {
  const actions: NtfyAction[] = [];

  // "view" action opens URL in browser — always first
  if (proposalViewUrl) {
    actions.push({
      action: "view",
      label: "View proposal",
      url: proposalViewUrl,
    });
  }

  const action = (label: string, body: string): NtfyAction => ({
    action: "http",
    label,
    url: `https://ntfy.sh/${inTopic}`,
    method: "POST",
    headers,
    body,
  });

  actions.push(
    action("agent-duo", `Launch agent-duo for ${taskId} in project ${project}`),
    action("pair-claude", `Launch agent-pair-claude for ${taskId} in project ${project}`),
    action("pair-codex", `Launch agent-pair-codex for ${taskId} in project ${project}`),
    action("t3code", `Launch t3code for ${taskId} in project ${project}`),
    action("agent-claude", `Launch agent-claude for ${taskId} in project ${project}`),
    action("agent-codex", `Launch agent-codex for ${taskId} in project ${project}`),
    action("revise", `Revise proposal for ${taskId}`),
    action("abandon", `Abandon task ${taskId}`),
  );
  return actions;
}
```

**5d.** Update the call site in `notifyProposal()` (line 899) to pass the URL:

```typescript
const actions = inTopic
  ? buildProposalNotificationActions(taskId, project, inTopic, headers, proposalViewUrl)
  : [];
```

### Step 6: Simplify notification body when dashboard URL is available

In `notifyProposal()`, when the dashboard is reachable (i.e., `networkMode() !== "localhost"` or always, since localhost is also valid for local use), include the view URL in the message body as a fallback for clients that don't support ntfy actions:

```typescript
const viewLine = `View: ${proposalViewUrl}`;
const inlineMessage = proposalInlineMessage(summary, proposalText, attachmentName);
// Prepend view link to the inline message
const enrichedMessage = `${viewLine}\n\n${inlineMessage}`;
```

Keep the file attachment as-is for the primary notification (ntfy supports both attachment + actions). The "view" action button is additive, not replacing the attachment.

### Step 7 (Optional): Extract shared markdown renderer

The `markdownToHtml()` function is duplicated in `briefing.html`, `dashboard.js`, and will be duplicated again in `proposal.html`. To reduce this:

- Create `templates/dashboard/markdown.js` with the shared functions: `markdownToHtml()`, `inlineFormat()`, `escapeHtml()`, `parseTableRow()`
- Update `briefing.html`, `dashboard.js`, and `proposal.html` to use `<script src="markdown.js"></script>` instead of inline definitions

This is optional cleanup. It can be done in this PR or deferred.

## Nav Bar Considerations

The `proposal.html` page does NOT need a nav bar entry. It is accessed via:
1. Direct URL with query parameter: `/proposal.html?task={taskId}`
2. Proposal links in slot tiles on the main page
3. Proposal links in the tasks tree
4. "View" action button in ntfy notifications

This avoids any nav bar conflict with gh-ludics-40 (which is changing the "Terminals" link to "t3code"). If a nav bar entry is desired in the future, it would need coordination with gh-ludics-40.

However, the `proposal.html` page itself MUST include the nav bar for consistency (linking back to Dashboard, Tasks, Briefing). This nav bar will need to be updated if gh-ludics-40 lands first (or vice versa). The merge conflict is trivial (one line change in the nav bar).

## Test Plan

1. **Manual: proposal viewer page**
   - Create a task with a `proposal:` field pointing to an existing markdown file
   - Navigate to `/proposal.html?task={taskId}` in browser
   - Verify markdown renders correctly with headings, code blocks, lists, tables, links
   - Verify "not found" placeholder when task ID is invalid or has no proposal
   - Verify the page has correct nav bar links and styling consistent with briefing.html

2. **Manual: slot tiles show proposal links**
   - Assign a task with a proposal to a slot
   - Run `ludics dashboard generate` and open the dashboard
   - Verify the slot tile shows a "proposal" link in the `.slot-links` area
   - Verify clicking it opens `proposal.html?task={taskId}`
   - Verify empty slots and slots without proposals do not show the link

3. **Manual: tasks page links**
   - Navigate to Tasks page
   - Find a task with a proposal
   - Verify the "proposal" link points to `/proposal.html?task={taskId}` (not `/proposal-files/`)
   - Verify clicking opens the rendered viewer

4. **Manual: notification "view" button**
   - Trigger a proposal notification via `ludics notify proposal` or by completing a proposal workflow
   - Verify the ntfy notification has a "View proposal" action button
   - Verify tapping/clicking it opens the rendered proposal in the browser
   - Verify the existing action buttons (agent-duo, revise, abandon) still appear

5. **Manual: raw endpoint still works**
   - Verify `/proposal-files/{taskId}.md` still serves raw markdown (needed by programmatic consumers)

## Risk Assessment

| Risk | Severity | Mitigation |
|---|---|---|
| Nav bar merge conflict with gh-ludics-40 | Low | proposal.html nav bar is a copy; conflict is trivial one-line resolution. No nav bar entry added for proposals. |
| `markdownToHtml()` duplication | Low | Third copy of the function. Optional Step 7 extracts to shared file. |
| Dashboard not reachable when notification fires | Low | "view" action is additive; file attachment and inline text remain as fallback. |
| `NTFY_MAX_ACTIONS=3` overflow | Low | "view" action is type "view" (not "http"), which occupies one of the 3 action slots. The action chunking logic already handles overflow by sending follow-up messages. With "view" as first action, the first notification carries: view + agent-duo + pair-claude. Remaining actions go to follow-up. |
| Stale `proposal.html` in existing installs | None | `ludics dashboard install` uses `copyDir()` which copies all template files. New installs get the file automatically. |

## Files Modified

| File | Change |
|---|---|
| `templates/dashboard/proposal.html` | **New file** — proposal viewer page |
| `src/dashboard.ts` | Extend `SlotJson` with `hasProposal`/`proposalLink`; update `generateSlots()`; change `proposalLink` in `buildTaskNode()` |
| `templates/dashboard/dashboard.js` | Add proposal link to `renderSlots()` |
| `src/notify.ts` | Add `proposalViewUrl` param to `buildProposalNotificationActions()`, add "view" action, compute dashboard URL in `notifyProposal()` |

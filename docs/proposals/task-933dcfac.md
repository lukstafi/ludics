# Proposal: Dashboard contextual links for slot tiles

## Summary

Add PR, proposal, GitHub issue, and t3code thread links to dashboard slot tiles. Currently slot tiles only show terminal links. This enriches them with contextual navigation.

## Changes

### 1. Extend SlotJson interface (`src/dashboard.ts`)

Add optional fields:
- `prUrl: string | null` — PR URL from orchestration state
- `githubUrl: string | null` — GitHub issue URL from task frontmatter `url:`
- `proposalPath: string | null` — proposal file path from task frontmatter `proposal:`

### 2. Enrich `generateSlots()` (`src/dashboard.ts`)

- Load task metadata via `readDashboardTasks()` at the start
- For each slot with a task: look up the task, extract `url`, `proposal` fields
- For PR URLs: read orchestration state if available (`agentStates[name].prUrl`)
- Detect t3code thread URLs from the existing terminals entries
- Populate new SlotJson fields

### 3. Update `renderSlots()` (`templates/dashboard/dashboard.js`)

Replace terminal-only link section with comprehensive link builder:
1. GitHub issue link (label: "Issue")
2. Proposal link (label: "Proposal", links to `/proposal.html?task=ID`)
3. PR link (label: "PR")
4. t3code thread links (label: "t3code")
5. Other terminal links (existing ttyd/tmux)

Labels are short and compact. Existing `.slot-links` CSS is reused.

### Files to modify

- `src/dashboard.ts` — SlotJson interface + `generateSlots()`
- `templates/dashboard/dashboard.js` — `renderSlots()` link generation

### Testing

- `ludics dashboard generate` produces enriched `slots.json`
- Dashboard shows clickable Issue/Proposal/PR/t3code links on slot tiles
- Empty slots or tasks without URLs show no broken links

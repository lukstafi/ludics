# Proposal: Dashboard Unanswered Questions tile

**Task**: task-ed2be1ba
**Project**: ludics

## Goal

Surface tasks with `has_questions: true` on the dashboard so the user can see at a glance which tasks are blocked waiting for their input, without needing to grep task files or rely on notification nags.

## Acceptance Criteria

1. A new "Unanswered Questions" tile appears in the dashboard sidebar, directly below the "Needs Confirmation" tile.
2. The tile lists all non-completed tasks that have `has_questions: true` in their frontmatter.
3. Each item shows: priority badge + task title as a clickable link to the task file (via `task-files/<id>.md`).
4. When no tasks have unanswered questions, the tile displays "No unanswered questions".
5. The tile data refreshes on the same 10-second interval as all other tiles.
6. The tile styling matches existing sidebar panels (same `.panel` class, same font sizes, same priority badge colors).

## Context

Tasks with `has_questions: true` are blocked on user input. The Mag nags hourly about them, but there is no persistent visual indicator on the dashboard. This means the user might miss blocked tasks when glancing at the dashboard. The Needs Confirmation tile already demonstrates the exact pattern needed -- this is a simpler variant (no action buttons required, since the user answers questions by editing the task file directly).

## Approach

Follow the Needs Confirmation tile pattern across four files:

**Backend (`src/dashboard.ts`)**:
- Add `hasQuestions: boolean` field to the `DashboardTask` interface (after `hasRetrospective`).
- Populate it in `readDashboardTasks()` as `hasQuestions: !!data.has_questions`.
- Define `UnansweredQuestionsTask` interface (id, title, project, priority).
- Add `generateUnansweredQuestions(tasks)` function that filters for `task.hasQuestions && !task.isCompleted` and maps to the interface fields.
- In `dashboardGenerate()`, write `unanswered-questions.json` after `needs-confirmation.json`.

**HTML (`templates/dashboard/index.html`)**:
- Add a `<section class="unanswered-questions panel">` with `<ul id="unanswered-questions-list">` directly after the Needs Confirmation `</section>` (line 114).

**JavaScript (`templates/dashboard/dashboard.js`)**:
- Add `fetchUnansweredQuestions()` that fetches `data/unanswered-questions.json`.
- Add `renderUnansweredQuestions(tasks)` that renders items as priority badge + task link (same markup as Needs Confirmation items but without confirm/dismiss buttons).
- Register `fetchUnansweredQuestions()` in the `Promise.all` array inside `fetchAllData()`.

**CSS (`templates/dashboard/style.css`)**:
- Reuse the existing `.needs-confirm-item` and `.needs-confirm-link` classes, or define equivalent `.unanswered-q-item` / `.unanswered-q-link` classes with the same styles. No new visual design needed.

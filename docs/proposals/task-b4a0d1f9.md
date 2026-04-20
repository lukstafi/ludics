# Remove dead CSS class rules from style.css after content.css extraction

## Goal

Remove ~92 lines of dead CSS from `templates/dashboard/style.css` that are vestiges of the pre-extraction class names (`.briefing-container`, `.briefing-content`, `.health-container`, `.health-content`, `.briefing-placeholder`, `.health-placeholder`). These rules were superseded by `content.css` (which defines `.content-container`, `.rendered-content`, `.content-placeholder`) during task-c603d177 but intentionally left behind because `style.css` was out-of-scope for that task.

## Acceptance Criteria

- The day-theme table-row override targeting `.briefing-content` / `.health-content` (lines 1270-1274) is removed
- The "Backward compat aliases" block is removed: `.briefing-container`, `.briefing-header`, `.briefing-date` (lines 1876-1878), `.briefing-content` and all descendant rules (lines 1880-1904), `.briefing-placeholder` / `.health-placeholder` combined rules (lines 1906-1935), `.health-container` (line 1938), `.health-content` and all descendant rules (lines 1948-1971)
- The comment on line 1875 ("Backward compat aliases...") is removed
- `.health-section-title` (lines 1940-1946) is preserved -- it is still referenced by `health.html`
- `.doctor-section`, `.doctor-meta`, `.doctor-section pre` (lines 1973-1998) are preserved -- they are live
- No functional regression: all dashboard pages render correctly after the change (verified by confirming no HTML/JS references to the removed class names exist)

## Context

- `templates/dashboard/style.css` -- the file to edit (2396 lines currently)
- `templates/dashboard/content.css` -- the replacement rules already in production
- HTML consumers: `briefing.html`, `health.html`, `proposal.html`, `retrospective.html` -- all use new class names (`.content-container`, `.rendered-content`, `.content-placeholder`)
- The only reference to `briefing-content` in HTML is as an element ID (`id="briefing-content"` in `briefing.html` line 34), not a CSS class
- `.health-section-title` is used in `health.html` lines 39 and 47

Two deletion regions:
1. Lines 1270-1274 (day theme override for old classes)
2. Lines 1875-1938, 1948-1971 (backward compat block, excluding `.health-section-title` at 1940-1946)

Net reduction: ~92 lines.

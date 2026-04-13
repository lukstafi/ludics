# Extract shared dashboard tab CSS into content.css partial

## Goal

Four dashboard pages (`briefing.html`, `health.html`, `proposal.html`, `retrospective.html`) each contain near-identical inline CSS for rendering markdown content panels -- heading typography, paragraph spacing, list styles, inline code, pre/code blocks, and table formatting. This duplication (~60-80 lines repeated across files) makes style changes error-prone and increases maintenance burden. Extract the shared rules into a single `content.css` file linked by each page.

Follows up from the gh-ludics-152 retrospective suggestion.

## Acceptance Criteria

- A new `templates/dashboard/content.css` file contains the shared content-rendering rules (headings, paragraphs, lists, strong, code, pre, tables, striped rows) under a unified class name (e.g., `.rendered-content`).
- The same file contains shared container and placeholder rules (`.content-container`, `.content-placeholder`) currently duplicated as `.briefing-container`/`.health-container` and `.briefing-placeholder`/`.health-placeholder`.
- All four HTML files (`briefing.html`, `health.html`, `proposal.html`, `retrospective.html`) link `content.css` and use the shared class names instead of page-specific duplicates.
- Each HTML file's inline `<style>` block retains only truly page-specific CSS (e.g., `.doctor-section` in health, `.retro-meta`/`.phase-timeline`/`.turn-*` in retrospective, `.proposal-task-id` in proposal).
- The dashboard pages render identically before and after the change (visual regression: manual spot-check is sufficient).

## Context

### Current architecture

- All pages link `style.css` (global layout, nav, footer, color variables).
- Page-specific CSS lives in inline `<style>` blocks in each HTML file. There are no CSS partials or `@import` directives today.

### Duplicated rule sets

The following CSS selectors are duplicated across all four files with identical property values (only the class prefix differs: `.briefing-content` vs `.health-content`):

| Selector pattern | Properties |
|---|---|
| `.X-content` | bg, border-radius, border, padding, line-height |
| `.X-content h1/h2/h3` | font-size, font-weight, margin, color, border-bottom |
| `.X-content p` | margin, color |
| `.X-content ul/ol, li` | margin, padding, color |
| `.X-content strong` | color, font-weight |
| `.X-content code` | bg, padding, border-radius, font-size |
| `.X-content pre` | bg, padding, border-radius, overflow, margin |
| `.X-content pre code` | transparent bg, no padding |
| `.X-content table/th/td` | width, collapse, padding, border, font-size |
| `.X-content tr:nth-child(even) td` | striped row bg |

Container/placeholder rules (`.X-container`, `.X-placeholder`, `.X-placeholder .icon/.text/.hint`) are also duplicated across briefing, health, proposal, and retrospective with only minor differences (`min-height: 300px` vs `200px` for placeholder).

### Key files

- `templates/dashboard/briefing.html` -- lines 10-147 (inline CSS)
- `templates/dashboard/health.html` -- lines 9-167 (inline CSS)
- `templates/dashboard/proposal.html` -- lines 9-153 (inline CSS)
- `templates/dashboard/retrospective.html` -- lines 9-47 (inline CSS, compressed format)
- `templates/dashboard/style.css` -- global styles (not modified)

### Class rename needed

- `briefing.html`, `proposal.html`, `retrospective.html` use `.briefing-content` / `.briefing-container` / `.briefing-placeholder`
- `health.html` uses `.health-content` / `.health-container` / `.health-placeholder`
- HTML markup class attributes must be updated to match the new shared class names

### Minor divergence

- `briefing-placeholder` uses `min-height: 300px`; `health-placeholder` uses `min-height: 200px`. The shared partial should pick a default (300px matches 3 of 4 pages), with health overriding locally if the smaller height is preferred.

## Approach

*Suggested approach -- agents may deviate if they find a better path.*

1. Create `templates/dashboard/content.css` with the shared rules using `.rendered-content` (content panel), `.content-container` (page wrapper), and `.content-placeholder` (empty state).
2. In each of the 4 HTML files, add `<link rel="stylesheet" href="content.css">` after the `style.css` link.
3. Remove the duplicated rules from each file's inline `<style>` block; keep only page-specific rules.
4. Update HTML class names in markup: `.briefing-content` / `.health-content` to `.rendered-content`, `.briefing-container` / `.health-container` to `.content-container`, `.briefing-placeholder` / `.health-placeholder` to `.content-placeholder`.
5. For health.html's smaller placeholder height, add a one-line override in the remaining inline styles.

## Scope

**In scope:** The four dashboard HTML template files and the new `content.css` file.

**Out of scope:** `style.css` (global styles, unchanged), JavaScript files, data pipeline, any non-dashboard templates. No functional behavior changes -- this is a pure CSS refactor.

**Dependencies:** None. This task is independent and can be merged on its own.

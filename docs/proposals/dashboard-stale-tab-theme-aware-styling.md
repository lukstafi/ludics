# Theme-aware styling for Dashboard "Stale" tab

## Goal

The Dashboard's **Stale** panel is barely readable on the **OLED** theme and
entirely unreadable on **Night**. Its task-title links don't recolor with the
active theme, and they lean on **blue** — which the user perceives as low
luminosity, so blue-on-dark has poor effective contrast.

Root cause (confirmed during elaboration): the Stale panel renders each task
title as `<a class="task-title stale-link">`, but `templates/dashboard/style.css`
has **no `.stale-link` rule** (nor `.stale-item` / `.stale-actions`). With no
`color` override, the anchor falls back to the **browser-default link color
(blue)**, which is theme-invariant and low-luminance. This is a *missing rule*,
not a hardcoded blue literal — there are no blue hex literals in `style.css`,
and the file header even notes "Night (warm, no blue)".

A second defect lives in the same panel: the priority badge
(`<span class="priority …">`) only gets its **chip geometry** (box size, border
radius, centering) from the selector `.ready-queue .priority`, which is scoped to
the Ready Queue. In every other panel the badge renders as a bare inline letter
rather than a centered chip.

The durable user constraint (from memory): **do not rely on blue for legibility
on dark themes.** Use theme-aware tokens with real luminance contrast; reserve
blue (in fact, never blue here — the palette is warm) for non-load-bearing
accents only.

## Acceptance Criteria

- [ ] The Stale panel's task-title links resolve to a **theme token**, not the
  UA-default link color. Verifiable by evidence: `templates/dashboard/style.css`
  contains a `.stale-link` rule whose base `color` is `var(--text-primary)`
  (the load-bearing title color), and `grep` for the UA-default fallback (an
  absent `.stale-link` rule) no longer applies — i.e. `grep -n '\.stale-link'
  templates/dashboard/style.css` returns at least the base rule and its
  `:hover`.
- [ ] The load-bearing title color is **never blue** on any theme. Because it is
  `var(--text-primary)`, which is defined as `#e8e6e3` (`:root` / Night),
  `#1c1917` (`[data-theme="day"]`, dark), and `#ffffff` (`[data-theme="oled"]`),
  the title is legible (high-contrast, non-blue) on all three themes. Verifiable
  by inspecting that the `.stale-link` base color references `--text-primary` and
  not a blue literal or the default anchor color.
- [ ] The Stale link's **hover** mirrors the sibling links: `color:
  var(--accent)` + `text-decoration: underline`. `--accent` is a warm
  red/orange in all three themes (`#e85d4a` / `#c9362c` / `#ff4040`) — never
  blue — so the hover affordance is also theme-aware and non-blue. Verifiable by
  the presence of a `.stale-link:hover` rule with those two declarations.
- [ ] The Stale priority badge renders as a **proper centered chip** (fixed
  box, border-radius, centering), the same as the Ready Queue badge. Verifiable
  by evidence: the chip geometry block (`display: inline-flex; … width; height;
  border-radius; justify-content/align-items: center`) is no longer scoped to
  `.ready-queue .priority` but applies to the `.priority` badge wherever it is
  rendered, so the Stale item's `<span class="priority …">` receives it.
- [ ] **No regression to other `.priority` consumers.** The `.priority` badge is
  rendered in five panels — Ready Queue, Needs Confirmation, Unanswered
  Questions, Deferred Launch, and Stale (see *Context*). Generalizing the chip
  geometry must leave the Ready Queue badge visually unchanged (it already had
  the geometry) and must not break the four panels that previously rendered a
  bare letter (they gain the chip, which is the intended consistent treatment).
  Verifiable by confirming the geometry declarations are unchanged in value and
  only the *selector* is broadened, plus the build/install sequence below
  completes without error.
- [ ] No backend or JS change is required for the title fix (CSS-only). The
  markup in `templates/dashboard/dashboard.js` (`fetchStale` → `renderItem`) and
  the backend `staleConfig` in `src/dashboard.ts` already emit the correct
  classes and fields; they stay untouched.

## Context

### How things work now

- **Stale markup** — `templates/dashboard/dashboard.js`, `fetchStale()` →
  `renderItem`: emits
  ```
  <li class="stale-item">
    <span class="priority priority-${P}">${P}</span>
    <a class="task-title stale-link" href="…" target="_blank">${title}</a>
    <span class="stale-actions"> …Revive / Abandon buttons… </span>
  </li>
  ```
  The markup is correct; the CSS for `stale-link`, `stale-item`, and
  `stale-actions` is simply missing.

- **The precedent to copy** — sibling filtered-task panels render the same
  `task-title` anchor but each ships a dedicated link rule pinned to a theme
  token, in `templates/dashboard/style.css`:
  - `.needs-confirm-link { color: var(--text-primary); text-decoration: none; … }`
    + `.needs-confirm-link:hover { color: var(--accent); text-decoration: underline; }`
  - `.unanswered-q-link` / `:hover` — identical shape.
  - `.deferred-task-title { color: var(--text-primary); … }` (a `<span>`).
  These recolor correctly because `--text-primary` and `--accent` are redefined
  per theme. The Stale link lacks the equivalent rule.

- **Theme system** — `templates/dashboard/style.css` defines custom properties
  in three blocks: `:root {…}` (Night, default — "warm tones, no blue"),
  `[data-theme="day"] {…}`, `[data-theme="oled"] {…}`. Relevant tokens:
  `--text-primary` (`#e8e6e3` / `#1c1917` / `#ffffff`), `--accent`
  (`#e85d4a` / `#c9362c` / `#ff4040`). **There is no `[data-theme="night"]`
  block** — `nav.js`'s `setTheme('night')` sets `dataset.theme = "night"`,
  which matches no specific block, so the `:root` defaults apply. `:root` *is*
  Night; rely on `:root`/inherited tokens for it, not a Night-specific block.

- **Priority badge — current scope** — `.ready-queue .priority` (in
  `style.css`) supplies the chip geometry: `display: inline-flex; align-items:
  center; justify-content: center; width: 20px; height: 20px; border-radius:
  var(--radius-sm); font-family/size/weight; flex-shrink: 0`. The per-letter
  background colors (`.priority-A/B/C/S/D`) are **unscoped**, so the Stale badge
  gets its color but not its box. The badge `<span class="priority …">` is
  emitted by **five** renderers in `dashboard.js`:
  `renderReadyQueue`, `fetchNeedsConfirmation`, `fetchUnansweredQuestions`,
  `fetchDeferredLaunch`, and `fetchStale`. Only Ready Queue currently receives
  the chip geometry; the other four render a bare inline letter today.

- **Backend** — `src/dashboard.ts`, `staleConfig`
  (`filter: task.status === "stale"`) writes `stale.json` via
  `generateFilteredTaskList`, emitting the same fields as the other panels. No
  backend change is expected.

- **Build artifact** — `templates/dashboard/` is the source; the build copies
  templates into the served output. After editing, run the build/install
  sequence (see *Approach*) so the edit lands where `ludics dashboard serve`
  serves from.

## Approach

*Suggested approach — agents may deviate if they find a better path.* The
approach was iterated on with the user (resolved questions, 2026-06-24) and is
straightforward; it is CSS-only.

**1. Add the missing Stale rules** to `templates/dashboard/style.css`, placed
alongside the existing `.needs-confirm-link` / `.unanswered-q-link` /
`.deferred-*` blocks, mirroring their shape verbatim:

- `.stale-item` — flex row layout consistent with `.needs-confirm-item` /
  `.unanswered-q-item` (`display: flex; align-items: center; gap; padding`).
- `.stale-link` — `color: var(--text-primary); text-decoration: none;
  font-size: 0.82rem;` (the load-bearing, theme-aware, non-blue title color).
- `.stale-link:hover` — `color: var(--accent); text-decoration: underline;`.
- `.stale-actions` — `margin-left: auto; display: flex; gap;` to push the
  Revive/Abandon buttons to the right, mirroring `.confirm-actions` /
  `.deferred-actions`.

**2. Generalize the priority-badge chip geometry (broad approach, per resolved
Q1).** Broaden the geometry selector so the chip box/centering applies wherever
the `.priority` badge is rendered, not only inside `.ready-queue`. Move the
geometry declarations from `.ready-queue .priority` onto a selector that covers
all five panels (e.g. the unscoped `.priority`, or a grouped selector listing
all five item classes). Keep the geometry **values unchanged** — only broaden
the selector — so the Ready Queue badge is visually identical and the other four
panels gain the same chip.

- *Audit (required by Q1):* the five `.priority` consumers are Ready Queue,
  Needs Confirmation, Unanswered Questions, Deferred Launch, and Stale. Confirm
  the broadened selector affects only these badge spans (the `.priority-*` color
  classes are already global and unaffected) and that the `.ready-queue li`
  flex layout still composes correctly with the now-globally-styled chip. The
  intended outcome for the previously-bare panels (chip instead of letter) is a
  consistent improvement, not a regression.

**3. Build & verify** (CLAUDE.md "Ludics build sequence"):
```bash
bun run build
ludics init --no-triggers
```
Then `ludics dashboard serve` to view if desired. No JS or backend edits.

## Scope

**In scope:**
- Add `.stale-link` (+ `:hover`), `.stale-item`, `.stale-actions` CSS rules.
- Generalize the priority-badge chip geometry off `.ready-queue .priority` so it
  applies to all `.priority` badges (broad approach), with an audit of the five
  consumers to confirm no regression.

**Out of scope:**
- Any JS or backend change (`dashboard.js`, `src/dashboard.ts`) — the markup and
  emitted fields are already correct.
- Broadening to other dashboard surfaces — the user scoped this to the Stale
  tab; the priority-badge generalization is the one in-scope closely-related
  instance, explicitly approved.
- Introducing a `[data-theme="night"]` block — Night intentionally inherits
  `:root`.

**Dependencies:** none.

# Migrate hand-crafted dashboard Markdown renderer to `marked`

## Goal

Replace the bespoke ~160-line line-loop Markdown renderer at
`templates/dashboard/markdown.js` with the established `marked` library.
The hand-rolled renderer doesn't handle nested lists, soft-breaks,
`\*` / `\_` escapes, autolinks, images, blockquotes, language-tagged
fenced code blocks, or GFM task-list checkboxes — every feature gap is a
maintenance burden, and real content already exercises some of them
(task files in `~/self-improve/harness/tasks/` use task-list checkboxes
that today render as literal `- [ ]` text). Migrating to `marked`
silently fixes those gaps and removes the line-loop code we maintain.

Source: harness `tasks/task-61aee08e.md`. All five elaboration questions
were resolved on 2026-04-29 (vendor as ESM file, `marked` over
`markdown-it`, no DOMPurify, accept loss of `target="_blank"`,
browser-only consumer).

## Acceptance Criteria

- A vendored ESM build of `marked` lives at
  `templates/dashboard/vendor/marked.esm.js` with its MIT license header
  preserved at the top of the file. A sibling
  `templates/dashboard/vendor/README.md` records: package name, version,
  upstream URL, license, and the `dashboardInstall` install path so a
  future maintainer knows how to bump it.
- `templates/dashboard/markdown.js` no longer contains the line-loop
  renderer (`markdownToHtml`, `parseTableRow`, `inlineFormat`,
  `escapeHtml` browser DOM-roundtrip helpers). It is rewritten as a thin
  wrapper that imports `marked` from `./vendor/marked.esm.js`, exposes
  `window.markdownToHtml = (md) => marked.parse(md ?? "", { gfm: true })`,
  and (because some `dashboard.js` code paths still call `escapeHtml`
  directly — confirm via grep) preserves a `window.escapeHtml` shim that
  performs the same DOM `textContent` round-trip the current file does,
  unless no remaining caller exists.
- All eight HTML pages that load `markdown.js` are updated to load it as
  an ES module: `<script type="module" src="markdown.js"></script>`.
  The full list (verified on HEAD `be78a23`):
  - `templates/dashboard/index.html` (line 173)
  - `templates/dashboard/briefing.html` (line 46)
  - `templates/dashboard/proposal.html` (line 49)
  - `templates/dashboard/task.html` (line 51)
  - `templates/dashboard/retrospective.html` (line 49)
  - `templates/dashboard/health.html` (line 58)
  - `templates/dashboard/task-creator.html` (line 105)
  - `templates/dashboard/task-creator.html` already lists it; verify
    no other reference is missed via
    `grep -rln 'markdown\.js' templates/`.
  Line numbers above are HEAD snapshots — the worker uses the grep result,
  not pinned numbers, when editing.
- The seven existing call sites continue to work unchanged (each assigns
  `markdownToHtml(...)` output to `innerHTML`):
  - `templates/dashboard/proposal.html` ~ proposal body
  - `templates/dashboard/task.html` ~ task body
  - `templates/dashboard/briefing.html` ~ briefing content
  - `templates/dashboard/retrospective.html` ~ turn messages
  - `templates/dashboard/health.html` ~ health report content
  - `templates/dashboard/task-creator.html` ~ live preview
  - `templates/dashboard/dashboard.js` ~ slot-pane task-content
- A new behavioral test file (e.g.
  `templates/dashboard/markdown.test.ts`) imports `marked` directly and
  asserts the rendered HTML for a representative fixture set. Coverage
  required:
  - Basic paragraph and inline emphasis (`**bold**`, `*italic*`,
    backtick `code`).
  - Link with default attributes (no `target="_blank"` — confirms the
    accepted behavior change from the elaboration's Q4).
  - Fenced code with a language tag (`` ```ts ... ``` `` produces a
    `<pre><code class="language-ts">` shape).
  - GFM pipe table (header + body rows).
  - GFM task-list checkbox (`- [ ] todo` and `- [x] done` produce
    `<input type="checkbox" disabled>` markup — silent upgrade over
    today's literal-text behavior).
  - Nested unordered list (one level of indentation).
  - HTML escaping in source: feeding `<script>alert(1)</script>` in MD
    produces an output where `<script>` is rendered as escaped text, not
    an actual `<script>` element. This pins the no-DOMPurify decision
    (Q3).
  - Empty / nullish input: `markdownToHtml(null)` and
    `markdownToHtml(undefined)` return `""`. (Today's renderer's
    early-guard behavior must be preserved by the wrapper — see
    Approach.)
- `marked` is added as a regular dependency in `package.json`
  (`"marked": "^18.0.2"` at time of writing — worker uses `bun add
  marked` to pin the actual current latest). The CLI never imports
  `marked` directly (verify with
  `grep -rln "from .marked" src/`), so it is not pulled into the
  Bun-compiled binary. The dependency exists only so the new test can
  `import { marked } from "marked"`.
- `bun run typecheck && bun run lint && bun run build && bun test` all
  pass.
- The existing assertion in `templates/dashboard/task.test.ts:165`
  (`expect(template).toContain("markdownToHtml(body)")`) continues to
  pass — preserved naturally because the wrapper still exposes
  `markdownToHtml` as a global.
- Manual smoke verification: with the dashboard running, render a real
  task with task-list checkboxes (e.g., one of the elaboration target
  tasks), a proposal with a GFM table (e.g.,
  `docs/proposals/agent-duo-migration.md`), and a briefing with mixed
  formatting. Visual parity is sufficient — bytes will differ.
- The line-loop renderer is deleted in the same PR (no dead-code keep).

## Context

### How rendering works today

`templates/dashboard/markdown.js` is a single hand-rolled file. It
exports two globals attached to `window` in the browser:

- `markdownToHtml(md)` — line-loop parser handling fenced code (no
  language tag), three heading levels, `---` rules, `-` / `*` unordered
  lists, `\d+\.` ordered lists, GFM-style pipe tables, blank-line
  paragraph splits, and inline format (code → bold → italic → link, in
  that order). Links are emitted with `target="_blank"`. No nested
  lists, no soft-breaks, no escapes for `\*` / `\_`, no autolinks, no
  images, no blockquotes, no task-list checkboxes, no language-tagged
  code blocks.
- `escapeHtml(str)` — uses DOM `textContent` round-trip. Browser-only;
  cannot run under Bun without a DOM shim.

### Serving and install model

- `templates/dashboard/` is statically served by `dashboard-server.ts`
  via the trailing generic file branch (the same branch that already
  serves `markdown.js`).
- `dashboardInstall` in `src/dashboard.ts` does a recursive `copyDir`
  from `templates/dashboard/` to
  `~/self-improve/harness/dashboard/`. Anything dropped under
  `templates/dashboard/vendor/` is installed and served automatically
  with no server-side change.
- The CLI ships as a Bun-compiled binary
  (`bun build --compile src/index.ts`). Runtime declared
  dependencies (`yaml`) bundle into the binary. None reach the browser
  — that is why the browser-side library has to be vendored.

### Call sites

Eight HTML pages reference `markdown.js`; seven of them invoke
`markdownToHtml(...)` and assign the result to `innerHTML`. The eighth,
`templates/dashboard/index.html`, includes the script for shared use by
its partial fragments. Full list confirmed by
`grep -rln 'markdown\.js\|markdownToHtml' templates/`:

```
templates/dashboard/index.html
templates/dashboard/briefing.html
templates/dashboard/proposal.html
templates/dashboard/task.html
templates/dashboard/retrospective.html
templates/dashboard/health.html
templates/dashboard/task-creator.html
templates/dashboard/dashboard.js
templates/dashboard/markdown.js
templates/dashboard/task.test.ts
```

### Tests today

- `templates/dashboard/task.test.ts` asserts the literal string
  `"markdownToHtml(body)"` appears in `task.html`. It does not exercise
  the renderer's behavior. Other dashboard tests
  (`dashboard.test.ts`, etc.) do not touch the renderer.
- No behavioral test of `markdown.js` exists — the file uses `document`
  and the codebase forbids `mock.module(` (lint
  `lint:no-mock-module`), so adding a Bun-runnable behavioral test
  requires importing the library directly rather than testing the
  installed wrapper.

### GFM features in real content

Worker should re-confirm before writing the test fixture set, but the
elaboration found:

- Task-list checkboxes used in many task files (e.g., `gh-agent-duo-11`
  and similar in `~/self-improve/harness/tasks/`).
- GFM pipe tables used in proposals (e.g.,
  `docs/proposals/agent-duo-migration.md`).
- No syntax highlighting today: `grep -rn 'highlight\|prism\|hljs'
  templates/dashboard/` returns only an unrelated CSS class for tree
  nodes. Fenced code blocks render as `<pre><code>...</code></pre>`
  with no language class even when ` ```ts ` is written. `marked` will
  start emitting `language-X` classes — harmless without a highlighter,
  and a follow-up task can pick Prism vs hljs later.

### License compatibility

`marked` is MIT (verified at https://github.com/markedjs/marked).
Ludics' `LICENSE` is MIT. Vendoring `marked.esm.js` requires preserving
its MIT header at the top of the vendored file.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

The structural shape was iterated on with the user during elaboration
(Q1, Q2, Q4) and is therefore documented here.

### 1. Vendor `marked.esm.js`

```bash
cd ~/ludics
mkdir -p templates/dashboard/vendor
# Pick the latest stable `marked` (~18.0.x at writing — worker re-checks
# `npm view marked version` and pins).
curl -L \
  -o templates/dashboard/vendor/marked.esm.js \
  "https://cdn.jsdelivr.net/npm/marked@<VERSION>/lib/marked.esm.js"
```

The exact upstream URL above is illustrative; check
https://www.npmjs.com/package/marked for the current ESM bundle path
(`lib/marked.esm.js` has been the stable name across recent majors).
Confirm the file starts with the MIT license header, then write
`templates/dashboard/vendor/README.md`:

```markdown
# Vendored browser libraries

Files in this directory are statically served to the dashboard at
http://localhost:7678/ and copied verbatim by `dashboardInstall` in
`src/dashboard.ts`.

## marked.esm.js

- **Package**: marked
- **Version**: <pin to the version you downloaded>
- **License**: MIT (header preserved at top of file)
- **Upstream**: https://github.com/markedjs/marked
- **Source URL**:
  https://cdn.jsdelivr.net/npm/marked@<VERSION>/lib/marked.esm.js

To bump: re-download from the same URL with the new version, update the
version number above, and re-run `bun test
templates/dashboard/markdown.test.ts` to confirm output parity on the
fixture set.
```

### 2. Rewrite `templates/dashboard/markdown.js` as a thin wrapper

The full new contents (sketch):

```javascript
// markdown.js -- Markdown-to-HTML for dashboard pages.
// Wraps the vendored `marked` library; preserves the `markdownToHtml`
// global so existing call sites in proposal.html, task.html,
// briefing.html, retrospective.html, health.html, task-creator.html,
// and dashboard.js need no change beyond switching the <script> tag to
// type="module".

import { marked } from "./vendor/marked.esm.js";

window.markdownToHtml = (md) => marked.parse(md ?? "", { gfm: true });

// Preserve escapeHtml as a global only if any call site still uses it.
// Confirm via `grep -rn 'escapeHtml' templates/dashboard/` before
// deleting.
window.escapeHtml = (str) => {
    if (!str) return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
};
```

Two things worth noting:

- `gfm: true` is the default in `marked` v5+, but pass it explicitly so
  intent is visible to a future reader.
- The `md ?? ""` guard is load-bearing: today's renderer returns `""`
  for `null` / `undefined`; `marked.parse(undefined)` throws.

### 3. Switch `<script>` tags to `type="module"`

For each of the eight HTML files in the call-sites list, change

```html
<script src="markdown.js"></script>
```

to

```html
<script type="module" src="markdown.js"></script>
```

ESM imports require module scripts; ludics targets modern browsers, so
this is a one-line change per page. No CSP header is set today by
`dashboard-server.ts`, so no `nonce` plumbing is needed. (If a CSP is
added later, no inline glue means we don't need a nonce.)

### 4. Add `marked` as a dev/regular dependency for the test

```bash
cd ~/ludics
bun add marked
```

This adds `"marked": "^<version>"` to `package.json` `dependencies`. The
CLI never imports `marked` (verify), so the Bun-compiled binary is
unaffected. Choosing a regular dep (over devDependency) keeps the
import resolution unambiguous in Bun's test runner without requiring
`--with-dev` flags.

The test file then imports directly:

```typescript
// templates/dashboard/markdown.test.ts
import { describe, expect, test } from "bun:test";
import { marked } from "marked";

const render = (md: string | null | undefined) =>
    marked.parse(md ?? "", { gfm: true });

describe("dashboard Markdown rendering (via marked, gfm)", () => {
    test("nullish input renders as empty string", () => {
        expect(render(null)).toBe("");
        expect(render(undefined)).toBe("");
        expect(render("")).toBe("");
    });

    test("inline emphasis and code", () => {
        const out = render("**bold** *italic* `code`");
        expect(out).toContain("<strong>bold</strong>");
        expect(out).toContain("<em>italic</em>");
        expect(out).toContain("<code>code</code>");
    });

    test("link has no target=\"_blank\" by default", () => {
        const out = render("[hello](https://example.com)");
        expect(out).toContain('href="https://example.com"');
        expect(out).not.toContain('target="_blank"');
    });

    test("fenced code block with language tag", () => {
        const out = render("```ts\nconst x = 1;\n```");
        expect(out).toContain('class="language-ts"');
    });

    test("GFM pipe table", () => {
        const out = render(
            "| a | b |\n| - | - |\n| 1 | 2 |\n",
        );
        expect(out).toContain("<table>");
        expect(out).toContain("<th>a</th>");
        expect(out).toContain("<td>1</td>");
    });

    test("GFM task-list checkbox", () => {
        const out = render("- [ ] todo\n- [x] done\n");
        expect(out).toContain('type="checkbox"');
        expect(out).toMatch(/disabled/);
    });

    test("nested unordered list", () => {
        const out = render("- outer\n  - inner\n");
        // Inner <ul> is nested inside the outer <li>.
        expect(out).toMatch(/<li>[\s\S]*<ul>[\s\S]*inner/);
    });

    test("escapes HTML in source (no DOMPurify needed)", () => {
        const out = render("<script>alert(1)</script>");
        expect(out).toContain("&lt;script&gt;");
        expect(out).not.toContain("<script>alert");
    });
});
```

The test imports `marked` from the npm package, not from the vendored
file. This is a deliberate choice: testing the npm package validates
the exact same library code (same source, same version) without needing
to dynamic-import an ESM file from disk in Bun's test environment.
Worker should pin the `marked` version in `package.json` to the same
version vendored under `templates/dashboard/vendor/` and add a comment
in `vendor/README.md` reminding the next bumper to keep both in sync.

The alternative — dynamic-importing
`templates/dashboard/vendor/marked.esm.js` directly from the test — is
less ergonomic in Bun (`import()` of a relative file path works, but
the file is a browser-targeted ESM build that may rely on global
identifiers). Stick with the dependency-based approach.

### 5. Delete the line-loop renderer

After steps 1–4 are working, remove the
`function markdownToHtml(...)`, `function parseTableRow(...)`,
`function inlineFormat(...)`, and the original `function
escapeHtml(...)` from `markdown.js`. The wrapper from step 2 is the
file's full new contents.

### 6. Verify

```bash
cd ~/ludics
bun run typecheck
bun run lint
bun run build
bun test
```

Then start the dashboard locally and manually render:

- a real task with task-list checkboxes,
- `docs/proposals/agent-duo-migration.md` (has a GFM table),
- a recent briefing.

Confirm visual parity (bytes will differ; layout should be at least as
good as today, with the silent upgrades for nested lists and task-list
checkboxes).

## Scope

**In scope:**

- Vendor `marked` ESM as `templates/dashboard/vendor/marked.esm.js`
  with MIT header preserved.
- `templates/dashboard/vendor/README.md` documenting source/version.
- Rewrite `templates/dashboard/markdown.js` to a thin wrapper around
  `marked`.
- Update the eight HTML files that load `markdown.js` to use
  `type="module"`.
- Add `marked` as a `package.json` dependency for test use only.
- Add `templates/dashboard/markdown.test.ts` covering the fixture set
  listed in Acceptance Criteria.
- Delete the line-loop renderer functions in the same PR.

**Out of scope** (per task body and elaboration Q3, Q4):

- Adding new Markdown features (footnotes, math, mermaid, syntax
  highlighting). Those land as separate tasks once the migration is in.
- DOMPurify or any post-pass sanitizer. `marked`'s default HTML-in-
  source escaping matches the current posture (Q3 resolution).
- Preserving `target="_blank"` on links. Accepted change per Q4 — user
  uses middle-click / cmd-click for new tab.
- Server-side AST manipulation (heading extraction, ToC, etc.).
- Re-styling the dashboard. Preserve current CSS hooks; let `marked`
  use its default class names.
- Non-browser MD rendering paths. Q5 confirmed there are none today.
- Switching to `markdown-it`. Q2 confirmed `marked` is the right
  default; no plugin needs day-one.

**Dependencies:** none. Self-contained.

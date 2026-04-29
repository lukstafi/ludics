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
`markdown-it`, ~~no DOMPurify~~ → **DOMPurify post-pass added** on
post-elaboration review (Q3's premise that `marked` escapes raw HTML
by default was wrong; `marked` passes raw HTML through per CommonMark
and the `sanitize` option was removed in v5; without a sanitizer the
dashboard's XSS posture would weaken vs today's hand-rolled
`escapeHtml` pre-pass), accept loss of `target="_blank"`, browser-only
consumer).

## Acceptance Criteria

- A vendored ESM build of `marked` lives at
  `templates/dashboard/vendor/marked.esm.js` with its MIT license header
  preserved at the top of the file. A vendored ESM build of DOMPurify
  lives at `templates/dashboard/vendor/purify.es.js` with its
  Apache-2.0 / MPL-2.0 license header preserved (added by post-elaboration
  review — see updated Q3 below). A sibling
  `templates/dashboard/vendor/README.md` records: package name, version,
  upstream URL, license, and the `dashboardInstall` install path for
  both bundles so a future maintainer knows how to bump them.
- `templates/dashboard/markdown.js` no longer contains the line-loop
  renderer (`markdownToHtml`, `parseTableRow`, `inlineFormat`,
  `escapeHtml` browser DOM-roundtrip helpers). It is rewritten as a thin
  wrapper that imports `marked` from `./vendor/marked.esm.js` and
  `DOMPurify` from `./vendor/purify.es.js`, then exposes
  `window.markdownToHtml = (md) => DOMPurify.sanitize(marked.parse(md ?? "", { gfm: true }), { FORBID_TAGS: ["style"], FORBID_ATTR: ["style"] })`.
  The DOMPurify config closes the inline-style spoofing vector: while
  `<style>` tags are stripped by DOMPurify default, the `style="..."`
  attribute is *not*, which would let untrusted MD apply
  `position:fixed;…` overlays or `display:none` to hide controls.
  `FORBID_ATTR: ["style"]` strips the attribute while leaving the host
  tag intact (so `<div style="…">x</div>` becomes `<div>x</div>`,
  preserving the Option B benign-HTML contract for everything except
  the styling vector). The wrapper also (because some `dashboard.js`
  code paths still call `escapeHtml` directly — confirm via grep)
  preserves a `window.escapeHtml` shim that performs the same DOM
  `textContent` round-trip the current file does, unless no remaining
  caller exists.
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
  - Sanitisation of dangerous HTML in source (replaces the original
    "escape to text" fixture — see updated Q3 below): feeding
    `<script>alert(1)</script>` in MD produces output that contains
    no `<script>` tag and no `alert(1)` payload (DOMPurify default
    config strips it). Feeding `[click](javascript:alert(1))` produces
    an `<a>` whose `href` is missing or non-`javascript:`. Feeding
    `<img src="x" onerror="alert(1)">` produces output containing no
    `onerror` attribute and no `alert(1)` payload.
  - Benign HTML in source (Option B contract): feeding `<b>hello</b>`
    in MD produces output containing `<b>hello</b>` as HTML, NOT
    escaped text. This is a deliberate behaviour change vs the
    hand-rolled renderer's escapeHtml-pre-pass posture, accepted
    because (a) the hand-rolled renderer's text-rendering of benign
    HTML was an incidental side effect of `escapeHtml`, not a
    designed contract; (b) standard Markdown / GFM allows benign
    inline HTML; (c) DOMPurify's default policy + the `FORBID_ATTR:
    ["style"]` tightening keep the dashboard safe against `<script>`,
    event-handler attributes, dangerous URL schemes, AND inline-CSS
    spoofing.
  - Inline-style spoofing guard: feeding
    `<div style="position:fixed;...">spoof</div>` produces output
    where the `style` attribute is removed (`<div>spoof</div>`).
    Feeding `<style>.x { display: none }</style>` produces output
    that contains no `<style>` tag.
  - Vendor↔npm sync: `templates/dashboard/vendor/marked.esm.js` is
    byte-identical to `node_modules/marked/lib/marked.esm.js`, and
    `templates/dashboard/vendor/purify.es.js` is byte-identical to
    `node_modules/dompurify/dist/purify.es.mjs`. A regression test
    asserts both pairs match so a `bun install` that bumps a parser
    version without re-vendoring fails CI loudly.
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

## purify.es.js

- **Package**: dompurify
- **Version**: <pin to the dompurify version installed transitively
  via isomorphic-dompurify>
- **License**: Apache-2.0 OR MPL-2.0 (header preserved at top of file)
- **Upstream**: https://github.com/cure53/DOMPurify
- **Source URL**:
  https://cdn.jsdelivr.net/npm/dompurify@<VERSION>/dist/purify.es.mjs

To bump: re-download from the same URLs with the new versions, update
the version numbers above, and re-run `bun test
templates/dashboard/markdown.test.ts` to confirm output parity on the
fixture set.
```

### 2. Rewrite `templates/dashboard/markdown.js` as a thin wrapper

The full new contents (sketch):

```javascript
// markdown.js -- Markdown-to-HTML for dashboard pages.
// Pipes vendored marked through vendored DOMPurify so dangerous HTML
// in MD source cannot reach innerHTML. Exposes window.markdownToHtml
// and window.escapeHtml so existing call sites in dashboard.js and
// the page templates need no API change beyond loading this file as
// an ES module.

import { marked } from "./vendor/marked.esm.js";
import DOMPurify from "./vendor/purify.es.js";

const PURIFY_CONFIG = { FORBID_TAGS: ["style"], FORBID_ATTR: ["style"] };

window.markdownToHtml = (md) =>
    DOMPurify.sanitize(marked.parse(md ?? "", { gfm: true }), PURIFY_CONFIG);

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

Four things worth noting:

- `gfm: true` is the default in `marked` v5+, but pass it explicitly so
  intent is visible to a future reader.
- The `md ?? ""` guard is load-bearing: today's renderer returns `""`
  for `null` / `undefined`; `marked.parse(undefined)` throws.
- The DOMPurify post-pass restores the dashboard's HTML-in-source
  XSS posture relative to today (which the bare `marked.parse(...)`
  would weaken — see updated Q3 below).
- `FORBID_ATTR: ["style"]` closes the inline-style spoofing vector
  (DOMPurify default strips `<style>` tags but leaves `style="…"`
  attributes untouched, which would let untrusted MD apply
  `position:fixed;…` overlays or hide controls via `display:none`).
  `FORBID_TAGS: ["style"]` is belt-and-braces (already default).

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

### 4. Add `marked` and `isomorphic-dompurify` as regular deps for the test

```bash
cd ~/ludics
bun add marked isomorphic-dompurify
```

This adds both to `package.json` `dependencies`. The CLI never imports
either (verify with `grep -rln 'from "marked"\|from "isomorphic-dompurify"' src/`),
so the Bun-compiled binary is unaffected. Choosing regular deps (over
devDependencies) keeps import resolution unambiguous in Bun's test
runner without requiring `--with-dev` flags. `isomorphic-dompurify` is
preferred over raw `dompurify` for the test side because DOMPurify
needs a DOM and `isomorphic-dompurify` provides a JSDOM shim
automatically when run under Node/Bun.

The test file then imports directly:

```typescript
// templates/dashboard/markdown.test.ts
import { describe, expect, test } from "bun:test";
import { marked } from "marked";
import DOMPurify from "isomorphic-dompurify";

// Mirrors the wrapper in templates/dashboard/markdown.js: marked(GFM)
// followed by DOMPurify.sanitize with the inline-style guard.
const PURIFY_CONFIG = { FORBID_TAGS: ["style"], FORBID_ATTR: ["style"] };
const render = (md: string | null | undefined) =>
    DOMPurify.sanitize(
        marked.parse(md ?? "", { gfm: true }) as string,
        PURIFY_CONFIG,
    );

describe("dashboard Markdown rendering (marked + DOMPurify, gfm)", () => {
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

    test("raw <script> in source is sanitised away", () => {
        const out = render("<script>alert(1)</script>");
        expect(out).not.toMatch(/<script[\s>]/i);
        expect(out).not.toContain("alert(1)");
    });

    test("javascript: URLs in links are stripped from href", () => {
        const out = render("[click](javascript:alert(1))");
        expect(out).not.toMatch(/href=["']?javascript:/i);
    });

    test("event-handler attributes are stripped", () => {
        const out = render('<img src="x" onerror="alert(1)">');
        expect(out).not.toContain("onerror");
        expect(out).not.toContain("alert(1)");
    });

    // Behaviour change vs the hand-rolled renderer's escapeHtml-pre-pass
    // posture (Option B contract): benign raw HTML in source survives.
    test("benign raw HTML in source is preserved as HTML", () => {
        const out = render("<b>hello</b>");
        expect(out).toContain("<b>hello</b>");
        expect(out).not.toContain("&lt;b&gt;");
    });
});
```

The test imports `marked` and `isomorphic-dompurify` from npm, not
from the vendored files. This is a deliberate choice: testing the npm
packages validates the exact same library code (same source, same
version) without needing to dynamic-import browser-targeted ESM files
from disk in Bun's test environment. Worker should pin the `marked`
and `dompurify` versions installed by `bun add` to the same versions
vendored under `templates/dashboard/vendor/` and add a "To bump"
section in `vendor/README.md` reminding the next maintainer to keep
both in sync.

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

**Out of scope** (per task body and elaboration Q4; Q3's
"no DOMPurify" answer was overridden post-elaboration — see updated
opening summary and Approach section):

- Adding new Markdown features (footnotes, math, mermaid, syntax
  highlighting). Those land as separate tasks once the migration is in.
- Tightening the DOMPurify config beyond the
  `FORBID_TAGS: ["style"]` / `FORBID_ATTR: ["style"]` set added in
  this PR (custom `ALLOWED_TAGS` / `ALLOWED_ATTR` allow-lists,
  link-target hardening, etc.). The current config preserves
  XSS-safety + closes the inline-style spoofing vector flagged by
  PR-#436 review while keeping the Option B benign-HTML upgrade;
  further tightening is a future task if a real need surfaces.
- Preserving `target="_blank"` on links. Accepted change per Q4 — user
  uses middle-click / cmd-click for new tab.
- Server-side AST manipulation (heading extraction, ToC, etc.).
- Re-styling the dashboard. Preserve current CSS hooks; let `marked`
  use its default class names.
- Non-browser MD rendering paths. Q5 confirmed there are none today.
- Switching to `markdown-it`. Q2 confirmed `marked` is the right
  default; no plugin needs day-one.

**Dependencies:** none. Self-contained.

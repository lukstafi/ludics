import { describe, expect, test } from "bun:test";
import { marked } from "marked";
import DOMPurify from "isomorphic-dompurify";

// Mirrors the wrapper in templates/dashboard/markdown.js: marked(GFM)
// followed by DOMPurify.sanitize. Imports the npm copies so the
// fixture runs under Bun; the browser uses the vendored copies under
// templates/dashboard/vendor/, which vendor/README.md keeps version-
// aligned.
const render = (md: string | null | undefined) =>
    DOMPurify.sanitize(
        marked.parse(md ?? "", { gfm: true }) as string,
    );

describe("dashboard Markdown rendering (marked + DOMPurify, gfm)", () => {
    test("nullish/empty input renders as empty string", () => {
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

    test('link has no target="_blank" by default', () => {
        const out = render("[hello](https://example.com)");
        expect(out).toContain('href="https://example.com"');
        expect(out).not.toContain('target="_blank"');
    });

    test("fenced code with language tag emits language-X class", () => {
        const out = render("```ts\nconst x = 1;\n```");
        expect(out).toContain('class="language-ts"');
    });

    test("GFM pipe table renders <table>/<th>/<td>", () => {
        const out = render("| a | b |\n| - | - |\n| 1 | 2 |\n");
        expect(out).toContain("<table>");
        expect(out).toContain("<th>a</th>");
        expect(out).toContain("<td>1</td>");
    });

    test("GFM task-list checkboxes render disabled inputs", () => {
        const out = render("- [ ] todo\n- [x] done\n");
        expect(out).toContain('type="checkbox"');
        expect(out).toMatch(/disabled/);
    });

    test("nested unordered list nests <ul> inside <li>", () => {
        const out = render("- outer\n  - inner\n");
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

    // Behaviour change vs the hand-rolled renderer, which rendered
    // benign raw HTML as escaped text. Under marked + DOMPurify default
    // config, benign HTML round-trips as HTML; only dangerous content
    // is stripped. Pinned here so a future tightening doesn't silently
    // re-introduce the old text-rendering.
    test("benign raw HTML in source is preserved as HTML (Option B contract)", () => {
        const out = render("<b>hello</b>");
        expect(out).toContain("<b>hello</b>");
        expect(out).not.toContain("&lt;b&gt;");
    });
});

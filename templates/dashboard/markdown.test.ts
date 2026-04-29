import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { marked } from "marked";
import DOMPurify from "isomorphic-dompurify";

// Mirrors the wrapper in templates/dashboard/markdown.js: marked(GFM)
// followed by DOMPurify.sanitize with the inline-style guard. Imports
// the npm copies so the fixture runs under Bun; the browser uses the
// vendored copies under templates/dashboard/vendor/, which the
// vendor-sync test below pins byte-identical so CI fails if the two
// drift.
const PURIFY_CONFIG = { FORBID_TAGS: ["style"], FORBID_ATTR: ["style"] };
const render = (md: string | null | undefined) =>
    DOMPurify.sanitize(
        marked.parse(md ?? "", { gfm: true }) as string,
        PURIFY_CONFIG,
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
    // benign raw HTML as escaped text. Under marked + DOMPurify
    // (style-attr stripped), benign HTML round-trips as HTML; only
    // dangerous content + style-bearing markup is stripped. Pinned
    // here so a future tightening doesn't silently re-introduce the
    // old text-rendering.
    test("benign raw HTML in source is preserved as HTML (Option B contract)", () => {
        const out = render("<b>hello</b>");
        expect(out).toContain("<b>hello</b>");
        expect(out).not.toContain("&lt;b&gt;");
    });

    test("inline style attribute is stripped (UI-spoofing guard)", () => {
        // A position:fixed / display:none style on user-controlled
        // markup could hide dashboard controls or overlay the page.
        // The wrapper's PURIFY_CONFIG.FORBID_ATTR=["style"] closes
        // that vector while leaving the host tag in place.
        const out = render(
            '<div style="position:fixed;top:0;left:0;width:100%;height:100%;background:red">spoof</div>',
        );
        expect(out).not.toMatch(/\sstyle\s*=/i);
        expect(out).toContain("<div>spoof</div>");
    });

    test("<style> tag is stripped from source", () => {
        const out = render(
            "<style>.task-content { display: none }</style>",
        );
        expect(out).not.toMatch(/<style[\s>]/i);
        expect(out).not.toContain("display: none");
    });
});

// Vendor-sync regression — keeps the npm-installed packages this test
// imports byte-aligned with the ESM bundles served to the browser.
// Without this test, a `bun install` that bumps marked or dompurify
// would silently change the runtime behaviour while CI still validates
// against an in-sync fixture set. The `vendor/README.md` "To bump"
// rule says re-run `cp node_modules/.../*.{esm.js,es.mjs}
// templates/dashboard/vendor/`; this test fails loud if that step is
// skipped.
describe("vendored bundles match npm copies byte-for-byte", () => {
    const repoRoot = resolve(import.meta.dir, "..", "..");
    const pairs: Array<{ npm: string; vendored: string }> = [
        {
            npm: resolve(repoRoot, "node_modules/marked/lib/marked.esm.js"),
            vendored: resolve(repoRoot, "templates/dashboard/vendor/marked.esm.js"),
        },
        {
            npm: resolve(repoRoot, "node_modules/dompurify/dist/purify.es.mjs"),
            vendored: resolve(repoRoot, "templates/dashboard/vendor/purify.es.js"),
        },
    ];
    for (const { npm, vendored } of pairs) {
        test(`vendored ${vendored.split("/").pop()} matches ${npm.split("/").pop()}`, () => {
            expect(readFileSync(vendored)).toEqual(readFileSync(npm));
        });
    }
});

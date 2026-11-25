"""Part 2 of the scripts/check-prompts.sh CLI conformance suite: links, shell/verdict reads,
suite map, brief template, and this checkout (#1336).

Split from test_checkprompts_cli.py so both halves shard across separate Ubuntu CI runners with
headroom under LUDICS_TEST_WATCHDOG. Run with
``scripts/py -m unittest ludics.tests.test_checkprompts_cli_checks``.
"""

import functools
import os
import re
import shutil
import unittest
from collections.abc import Callable

from ludics.tests.checkprompts_cli_harness import (
    BASH,
    CP,
    NO_NAMES,
    NO_SYMLINKS,
    SRC,
    WINDOWS,
    WORKER,
    Case,
    FixtureMissed,
    append,
    clean,
    copy_prompts,
    drift_tree,
    fixture_tree,
    fresh,
    nul_edit,
    read,
    rewrite,
    row_after_beta,
    run,
    setUpModule,
    skill,
    slots,
    slots_tree,
    src_lines,
    tearDownModule,
    write,
)

__all__ = ["setUpModule", "tearDownModule"]

# --- relative links and anchors ------------------------------------------------------------------
# ludics-lite#260 cut the wave prompt and its references into sections addressed by anchor, and
# every one of those links was verified by hand, once; this is what re-verifies them. Two trees, for
# the two things there are to pin. A scratch one for the READING -- what counts as a link, which
# directory a path is read from, what a heading slugs to -- where each probe is one defect against
# the well-formed control. Then the REAL prompts, copied, for the claim that today's links resolve
# and that a moved heading or a renamed file is caught.

NOTES = "alpha/references/notes.md"
NOTES_MD = """\
# Notes

## Close-out

The first one.

## Supervision, recovery and evidence

Punctuation to drop, blanks to hyphenate.

## Close-out

The second one, which GitHub numbers.

## Notes-1

An explicit suffix, standing where a repeat would want to land.

## Notes

A third collision, which has to step over the explicit one.

"""


def links_tree(root: str) -> None:
    """A passing layout, plus a reference file for the prompts to link into."""
    fresh(root)
    # An em dash, the non-ASCII punctuation this prose is written with and GitHub drops, written as
    # its UTF-8 bytes.
    write(os.path.join(root, NOTES), NOTES_MD.encode() + b"## Close \xe2\x80\x94 out\n\nPunctuation GitHub drops.\n\n")
    write(os.path.join(root, "alpha/references/a_(b).md"), "A parenthesized filename.\n")


def links_body(root: str, rel: str, *lines: str) -> None:
    """Appends Markdown lines to a file in the scratch tree."""
    append(os.path.join(root, rel), "".join(f"{x}\n" for x in lines))


def links_nonascii(root: str, rel: str) -> None:
    """Appends a heading carrying a letter GitHub keeps, whose anchor this check will not guess at."""
    append(os.path.join(root, rel), b"\n## Caf\xc3\xa9\n\nA letter GitHub keeps.\n")


def links_unspellable(root: str, rel: str) -> None:
    """Appends a heading GitHub slugs by its RENDERED text (`foo`), which is not its source. On the
    END of a file on purpose -- it suppresses the numbering after it -- so probes about ordinary
    headings add it only when they mean to."""
    append(os.path.join(root, rel), "\n## [Foo](https://example.invalid)\n\nInline link syntax.\n")


GONE = "resolves to no file: alpha/references/gone.md"
UNSPELLABLE = "will not spell an anchor for"


def no_slug(anchor: str) -> str:
    return f"GitHub slug is '{anchor}'"


class LinksTest(Case):
    def setUp(self) -> None:
        super().setUp()
        links_tree(self.root)

    def heading_case(self, label: str, rc: int, want: str, *, heading: str | bytes, link: str) -> None:
        """A fresh links tree with ``heading`` appended to the notes and ``link`` to the skill."""
        links_tree(self.root)
        append(f"{self.root}/{NOTES}", heading)
        links_body(self.root, "alpha/SKILL.md", link)
        self.expect(label, rc, want)

    def link_case(self, label: str, rc: int, want: str, *lines: str) -> None:
        """A fresh links tree with ``lines`` appended to the skill."""
        links_tree(self.root)
        links_body(self.root, "alpha/SKILL.md", *lines)
        self.expect(label, rc, want)

    def test_resolving_and_broken(self) -> None:
        self.link_case(
            "a resolving link, with an anchor and without",
            0,
            "(2 checked)",
            "See [one section](references/notes.md#close-out) and [all of it](references/notes.md).",
        )
        self.link_case(
            "a link to a file that is not there",
            1,
            "alpha/SKILL.md: link to references/gone.md resolves to no file: alpha/references/gone.md",
            "See [what moved](references/gone.md).",
        )
        self.link_case(
            "an anchor no heading slugs to",
            1,
            "link to references/notes.md#launch names no heading: alpha/references/notes.md has none whose GitHub slug is 'launch'",
            "See [what was retitled](references/notes.md#launch).",
        )

    # The slug is GitHub's: blanks become hyphens, a hyphen already there stays, and the punctuation
    # between them goes; a repeated heading takes GitHub's numbering; the anchor is compared as TEXT
    # and in full.
    def test_slugs(self) -> None:
        cases = (
            ("punctuation is dropped and blanks become hyphens", 0, "(1 checked)", "supervision-recovery-and-evidence"),
            (
                "...while a hyphen in the heading is kept, not dropped with the punctuation",
                1,
                no_slug("closeout"),
                "closeout",
            ),
            ("a repeated heading takes GitHub's -1 suffix", 0, "(1 checked)", "close-out-1"),
            ("...and only as many of them as the file writes", 1, no_slug("close-out-2"), "close-out-2"),
            ("an anchor that is a prefix of a slug is not that slug", 1, no_slug("close"), "close"),
            ("a '.' in an anchor is that character, not a wildcard", 1, no_slug("close.out"), "close.out"),
            # GitHub numbers a repeat by taking the next FREE name, so an explicit `## Notes-1`
            # standing between two `## Notes` pushes the second repeat to `notes-2` (round 1, P2).
            ("a repeat steps over a heading that already holds its suffix", 0, "(1 checked)", "notes-2"),
            ("...and that heading keeps its own name", 0, "(1 checked)", "notes-1"),
            ("...and no further name is handed out", 1, no_slug("notes-3"), "notes-3"),
            # Beyond ASCII the slug is knowable for General Punctuation, which GitHub drops.
            ("the punctuation GitHub drops is dropped here too", 0, "(1 checked)", "close--out"),
        )
        for label, rc, want, anchor in cases:
            with self.subTest(label):
                self.link_case(label, rc, want, f"See [it](references/notes.md#{anchor}).")

    # ...and is not knowable for a byte that may be a letter GitHub keeps: the heading contributes
    # no slug and the link is refused with the reason (round 1, P2).
    def test_a_letter_past_ascii(self) -> None:
        links_nonascii(self.root, NOTES)
        links_body(self.root, "alpha/SKILL.md", "See [the ASCII residue](references/notes.md#caf).")
        self.expect(
            "a heading carrying a letter past ASCII spells no anchor, so its residue answers for none", 1, UNSPELLABLE
        )

    # A path is read from the LINKING file's directory. Both directions: the root-relative spelling
    # of a target that resolves is a different file, and `..` climbs out of a reference directory.
    def test_paths(self) -> None:
        R = self.root
        self.link_case(
            "a path is read from the linking file's directory, not from the root",
            1,
            "resolves to no file: alpha/alpha/references/notes.md",
            "See [the root-relative spelling](alpha/references/notes.md).",
        )
        links_tree(R)
        links_body(R, NOTES, "Back to [the prompt](../SKILL.md).")
        self.expect("a reference file is a linking file too, and '..' climbs from it", 0, "(1 checked)")
        # A path that climbed out of the checkout is refused on the PATH, and never probed on the
        # filesystem: the probe plants exactly that file beside the tree, which under a filesystem
        # test would make the link read as resolving.
        links_tree(R)
        write(f"{self.base}/outside.md", "Outside the checkout.\n")
        links_body(R, NOTES, "Out of [the checkout](../../../outside.md).")
        self.expect(
            "a path that climbs past the root is refused, even where that file exists",
            1,
            "resolves outside the checkout: ../outside.md",
        )

    # Every file the scan reads links in is one, not just the skill prompts.
    def test_linking_files(self) -> None:
        R = self.root
        for label, rel, target in (
            ("README.md is a linking file", "README.md", "missing.md"),
            ("...and routines/README.md", "routines/README.md", "routines/missing.md"),
            ("...and a routine prompt", "routines/nightly/SKILL.md", "routines/nightly/missing.md"),
        ):
            with self.subTest(label):
                links_tree(R)
                links_body(R, rel, "See [nothing](missing.md).")
                self.expect(label, 1, f"FAIL: {rel}: link to missing.md resolves to no file: {target}")
        # A routine keeps its reference files under `routines/<name>/references/`, and the second
        # hop out of one was where a missing target passed (round 5, P2).
        links_tree(R)
        write(f"{R}/routines/nightly/references/guide.md", "# Guide\n\nSee [the second hop](gone.md).\n")
        self.expect(
            "a routine reference file is a linking file too",
            1,
            "routines/nightly/references/guide.md: link to gone.md resolves to no file",
        )
        # A reference file whose name begins with a dot is a reference file (round 12, P2).
        links_tree(R)
        write(f"{R}/alpha/references/.guide.md", "# Guide\n\nSee [the second hop](gone.md).\n")
        self.expect(
            "a dotted reference file is a linking file too",
            1,
            "alpha/references/.guide.md: link to gone.md resolves to no file",
        )

    # What falls outside the one shape this reads is NOT CHECKED rather than guessed at. Each target
    # names something that is not there, so a probe that passes is a probe reporting the gap it is
    # meant to report -- and each gap reports nothing rather than reporting wrongly.
    def test_outside_the_shape(self) -> None:
        shapes = (
            ("an http(s) URL", "[released](https://example.invalid/missing.md)"),
            ("another URI scheme", "[write in](mailto:nobody@example.invalid)"),
            ("a link carrying a title", '[titled](references/gone.md "Not read")'),
            ("a site-absolute path", "[absolute](/references/gone.md)"),
            ("a same-file anchor, which names no file", "[here](#close-out)"),
            ("a target that is not Markdown", "[the licence](LICENSE)"),
        )
        for label, link in shapes:
            with self.subTest(label):
                self.link_case(f"outside the shape, so not read: {label}", 0, "0 failed", f"See {link}.")
        self.link_case(
            "outside the shape, so not read: a link split across two lines",
            0,
            "0 failed",
            "See [a target on the next line](",
            "references/gone.md).",
        )
        # The target must be SPELLED as a path in this checkout: a percent escape is a reading this
        # scan does not do (round 2, P2). The DECODED file is planted, so neither a literal probe
        # nor a decoding one could pass here by accident.
        links_tree(self.root)
        write(f"{self.root}/alpha/references/my notes.md", "A name needing an escape.\n")
        links_body(self.root, "alpha/SKILL.md", "See [an escaped name](references/my%20notes.md).")
        self.expect("outside the shape, so not read: a percent-escaped destination", 0, "0 failed")
        self.link_case(
            "outside the shape, so not read: a destination in angle brackets",
            0,
            "0 failed",
            "See [an angle-bracket destination](<references/gone.md>).",
        )

    # There is no fenced-code scope, which is the reading's one gap that cuts both ways -- pinned
    # from both sides, so it is a decision on record rather than a hole nobody meant.
    def test_no_fence_scope(self) -> None:
        R = self.root
        links_body(R, NOTES, "```sh", "# Improvised heading", "```")
        links_body(R, "alpha/SKILL.md", "See [a comment in a fence](references/notes.md#improvised-heading).")
        self.expect("a '#' comment inside a fence reads as a heading", 0, "(1 checked)")
        self.link_case(
            "...and a link inside a fence is read like any other",
            1,
            "link to references/gone.md resolves to no file",
            "```",
            "See [an example](references/gone.md).",
            "```",
        )
        # The same on one line, which is the form documentation actually reaches for.
        self.link_case(
            "...and one quoted between backticks is read as the link it spells",
            1,
            "link to references/gone.md resolves to no file",
            "The shape read is `[label](references/gone.md)`, quoted here in prose.",
        )
        # A heading inside an HTML comment contributes an anchor, as one inside a fence does: that
        # can ACCEPT a link GitHub would not resolve, and refuses none (round 4, P2, rebutted).
        self.heading_case(
            "a heading inside an HTML comment contributes an anchor, as one inside a fence does",
            0,
            "(1 checked)",
            heading="\n<!--\n## Hidden\n-->\n",
            link="See [a heading inside a comment](references/notes.md#hidden).",
        )

    # A Markdown destination may carry balanced parentheses, so the target ends at the paren that
    # closes the link and not at the first one (round 1, P2).
    def test_parentheses(self) -> None:
        self.link_case(
            "a destination carrying balanced parentheses is read whole",
            0,
            "(1 checked)",
            "See [a parenthesized name](references/a_(b).md).",
        )
        self.link_case(
            "...so a missing one is reported, not skipped",
            1,
            "resolves to no file: alpha/references/a_(c).md",
            "See [a parenthesized name](references/a_(c).md).",
        )
        self.link_case(
            "...while an aside after a link is not part of its target",
            0,
            "(1 checked)",
            "Prose [linking](references/notes.md) and then (an aside in parentheses).",
        )

    # A false `](` -- the token written in prose, or a bracket pair that opens no link -- does not
    # abandon or swallow the rest of the LINE (rounds 2 and 3, P2).
    def test_false_candidates(self) -> None:
        cases = (
            (
                "a false ]( does not abandon the link after it",
                "The token ]( is documented; see [the guide](references/gone.md).",
            ),
            (
                "...nor does a destination whose parens never close",
                "[Mismatched](references/notes.md and then [a real one](references/gone.md).",
            ),
            (
                "a rejected candidate does not swallow the link nested inside it",
                "Token ]( prose [the guide](references/gone.md).)",
            ),
            (
                "...and neither does a title, which is rejected for a different reason",
                'A [titled one](references/notes.md "T") then [a real one](references/gone.md).',
            ),
            (
                "...while the labelled one on the same line is still read",
                "The token ](references/gone.md) is documented; [and here](references/gone.md) it is.",
            ),
            ("...while the one that does close at it opens a link", "A [note] then [a real one](references/gone.md)."),
            (
                "...while two backslashes escape each other and leave a real opener",
                "Prose with \\\\[note](references/gone.md), where the backslash is the escaped one.",
            ),
        )
        for label, line in cases:
            with self.subTest(label):
                self.link_case(label, 1, GONE, line)
        # A `+` is one of the path characters the shape admits.
        self.link_case(
            "a '+' is a path character, so its target is read",
            1,
            "resolves to no file: alpha/references/c++.md",
            "See [a plus in the name](references/c++.md).",
        )
        # A link opens with a LABEL: the label is the bracket THIS `]` closes, read with backslash
        # parity, so a token, a bracket already closed or an escaped bracket opens nothing.
        not_links = (
            (
                "a target with no opening label is not a link, so its file is not required",
                "The token ](references/gone.md) is documented, and is not a link.",
            ),
            (
                "a bracket already closed is not this link's label",
                "A [note] then ](references/gone.md) as a token, not a link.",
            ),
            (
                "an escaped bracket opens no label",
                "Prose with \\[note](references/gone.md) escaped, which renders as text.",
            ),
            (
                "an escaped closing bracket closes no label",
                "Prose [with an escaped closer\\](references/gone.md) renders as text.",
            ),
        )
        for label, line in not_links:
            with self.subTest(label):
                self.link_case(label, 0, "0 failed", line)

    # GitHub slugs a heading by its RENDERED text; this reads the source. Where the two differ the
    # heading spells no anchor at all (round 2 onwards, P2) -- tested narrowly, so the far commoner
    # literal readings, where both sides agree, keep working.
    def test_rendered_versus_source(self) -> None:
        R = self.root
        links_unspellable(R, NOTES)
        links_body(R, "alpha/SKILL.md", "See [the source reading](references/notes.md#foohttpsexampleinvalid).")
        self.expect("a heading carrying inline link syntax accepts no anchor from its source", 1, UNSPELLABLE)
        links_tree(R)
        links_unspellable(R, NOTES)
        links_body(R, "alpha/SKILL.md", "See [the rendered reading](references/notes.md#foo).")
        self.expect("...and says so rather than answering for the rendered one either", 1, UNSPELLABLE)
        cases: tuple[tuple[str, int, str, str, str], ...] = (
            (
                "...while literal brackets render as their source and still slug",
                0,
                "(1 checked)",
                "## Notes [draft]\n\nLiteral brackets, which render as themselves.\n",
                "notes-draft",
            ),
            (
                "a heading carrying an HTML tag spells no anchor from its source",
                1,
                UNSPELLABLE,
                "\n## <em>Foo</em>\n\nAn HTML tag.\n",
                "emfooem",
            ),
            (
                "...and neither does one carrying a character entity",
                1,
                UNSPELLABLE,
                "\n## A &amp; B\n\nAn entity.\n",
                "a-amp-b",
            ),
            (
                "...while a bare < or & is text to both readings and still slugs",
                0,
                "(1 checked)",
                "\n## A < B and Launch & supervise\n\nLiteral, on both sides.\n",
                "a--b-and-launch--supervise",
            ),
            # Underscore emphasis: the slugger keeps `_` as a word character (round 4, P2).
            (
                "a heading carrying underscore emphasis spells no anchor from its source",
                1,
                UNSPELLABLE,
                "\n## _Foo_\n\nUnderscore emphasis.\n",
                "_foo_",
            ),
            (
                "...while an intraword underscore is text to both readings and keeps its anchor",
                0,
                "(1 checked)",
                "\n## FLEET_BOX_CORRECTNESS_SLOTS\n\nIntraword, so literal on both sides.\n",
                "fleet_box_correctness_slots",
            ),
            # A code span's CONTENT is literal text: padding stripped as CommonMark strips it, its
            # content slugged as the text it is, and the markup tests not reading into it (round 5).
            (
                "a padded code span renders without its padding",
                0,
                "(1 checked)",
                "\n## ` padded `\n\nA span whose content is padded.\n",
                "padded",
            ),
            (
                "...so the source reading, spaces and all, names no heading",
                1,
                no_slug("-padded-"),
                "\n## ` padded `\n\nA span whose content is padded.\n",
                "-padded-",
            ),
            (
                "underscores inside a code span are literal, not emphasis",
                0,
                "(1 checked)",
                "\n## `_foo_`\n\nEmphasis markers inside a span are literal.\n",
                "_foo_",
            ),
            (
                "...and so are a tag and an entity, which the markup tests must not read into",
                0,
                "(1 checked)",
                "\n## `<T>` and `&amp;`\n\nMarkup inside a span is literal too.\n",
                "t-and-amp",
            ),
            (
                "...while a backtick run with no closing match is just a backtick",
                0,
                "(1 checked)",
                "\n## unclosed `run\n\nA backtick run with no match is literal.\n",
                "unclosed-run",
            ),
            # A backslash makes the next ASCII punctuation literal, before any delimiter test
            # (round 6, P2).
            (
                "an escaped underscore is literal, so its heading keeps its anchor",
                0,
                "(1 checked)",
                "\n## \\_Foo\\_\n\nEscaped underscores, which render as themselves.\n",
                "_foo_",
            ),
            (
                "...and an escaped angle bracket opens no tag",
                0,
                "(1 checked)",
                "\n## \\<em\\> literal\n\nAn escaped angle bracket is not a tag.\n",
                "em-literal",
            ),
            (
                "...while an escaped backtick opens no span, so what it held is read as emphasis",
                1,
                UNSPELLABLE,
                "\n## \\`_foo_\\`\n\nEscaped backticks open no span, so the underscores are emphasis.\n",
                "_foo_",
            ),
            # One-sided code-span padding is preserved (round 9, P2).
            (
                "a space a code span preserves is not trimmed away after rendering",
                0,
                "(1 checked)",
                "\n## ` foo`\n\nOne-sided padding, which survives.\n",
                "-foo",
            ),
            (
                "...so the trimmed reading names no heading",
                1,
                no_slug("foo"),
                "\n## ` foo`\n\nOne-sided padding, which survives.\n",
                "foo",
            ),
            # A backslash does not escape INSIDE a code span, so the span walk and the escape
            # reading are one walk, left to right (round 10, P2).
            (
                "a backslash inside a code span escapes nothing, so what follows is not span content",
                1,
                UNSPELLABLE,
                "\n## `\\`_foo_`\n\nA backslash inside a span, which escapes nothing.\n",
                "_foo_",
            ),
            (
                "...while the one walk keeps both readings a span is owed",
                0,
                "(1 checked)",
                "\n## `_lit_` and ` padded `\n\nSpan contents, still literal.\n",
                "_lit_-and-padded",
            ),
            # A `<` is markup only once the construct CLOSES (round 10, P2).
            (
                "an incomplete HTML construct is not HTML, so its heading keeps its anchor",
                0,
                "(1 checked)",
                "\n## Use <Type\n\nAn opening bracket that closes nothing.\n",
                "use-type",
            ),
            (
                "...while a complete one still spells no anchor",
                1,
                UNSPELLABLE,
                "\n## Use <em>tags</em>\n\nA tag spelled whole.\n",
                "use-emtagsem",
            ),
            (
                "...while a bare < among them is still text on both sides",
                0,
                "(1 checked)",
                "\n## A < B still text\n\nAn opening bracket that is not markup.\n",
                "a--b-still-text",
            ),
            # The heading guard applies the same label test the link reader does (round 12, P2).
            (
                "a heading carrying a link-shaped token with no label keeps its anchor",
                0,
                "(1 checked)",
                "\n## Token ](literal)\n\nA token, not a link.\n",
                "token-literal",
            ),
            (
                "...while one carrying a real label still spells no anchor",
                1,
                UNSPELLABLE,
                "\n## [Real](https://example.invalid) link\n\nA link, which renders.\n",
                "reallinkhttpsexampleinvalid-link",
            ),
            # A comment refuses the heading only once it CLOSES (round 12, P2).
            (
                "an unclosed comment opener is text, so its heading keeps its anchor",
                0,
                "(1 checked)",
                "\n## Use <!-- literal\n\nAn opener that closes nothing.\n",
                "use----literal",
            ),
            (
                "...while a closed one still spells no anchor",
                1,
                UNSPELLABLE,
                "\n## Hidden <!-- gone --> here\n\nA comment spelled whole.\n",
                "hidden---gone----here",
            ),
            # A character reference renders as markup only when it DECODES (round 12, P2).
            (
                "a character reference HTML does not define is text, and keeps its anchor",
                0,
                "(1 checked)",
                "\n## Rock &bogus; Roll\n\nA name HTML does not define.\n",
                "rock-bogus-roll",
            ),
            (
                "...while one that decodes still spells no anchor",
                1,
                UNSPELLABLE,
                "\n## Rock &amp; Roll\n\nA name HTML defines.\n",
                "rock-amp-roll",
            ),
            (
                "...and so does a numeric one, which always decodes",
                1,
                UNSPELLABLE,
                "\n## Rock &#38; Roll\n\nA numeric reference, which always decodes.\n",
                "rock-38-roll",
            ),
            # The raw-HTML forms beyond tags and comments render as markup (round 11, P2).
            (
                "a heading that is raw HTML spells no anchor: a processing instruction",
                1,
                UNSPELLABLE,
                "\n## <?target?>\n\nRaw HTML, which renders as markup.\n",
                "target",
            ),
            (
                "a heading that is raw HTML spells no anchor: a declaration",
                1,
                UNSPELLABLE,
                "\n## <!DOCTYPE html>\n\nRaw HTML, which renders as markup.\n",
                "doctype-html",
            ),
            (
                "a heading that is raw HTML spells no anchor: a CDATA section",
                1,
                UNSPELLABLE,
                "\n## <![CDATA[x]]>\n\nRaw HTML, which renders as markup.\n",
                "cdatax",
            ),
        )
        for label, rc, want, heading, anchor in cases:
            with self.subTest(label):
                self.heading_case(label, rc, want, heading=heading, link=f"See [it](references/notes.md#{anchor}).")

    # The block structure the heading reader models: blockquotes, list items, indentation, tabs,
    # line ends and hash runs.
    def test_heading_lines(self) -> None:
        cases: tuple[tuple[str, int, str, str | bytes, str], ...] = (
            # A tab inside a heading is a control character GitHub REMOVES (round 3, P2).
            (
                "an internal tab is removed, not turned into a hyphen",
                0,
                "(1 checked)",
                "\n## Foo\tBar\n\nAn internal tab.\n",
                "foobar",
            ),
            (
                "...so the hyphenated reading names no heading",
                1,
                no_slug("foo-bar"),
                "\n## Foo\tBar\n\nAn internal tab.\n",
                "foo-bar",
            ),
            # A heading inside a blockquote is a heading; one inside a list item is refused rather
            # than guessed at (round 3, P2).
            (
                "an ATX heading inside a blockquote is a heading",
                0,
                "(1 checked)",
                "\n> ## Quoted heading\n>\n> In a blockquote.\n",
                "quoted-heading",
            ),
            (
                "...while one inside a list item is refused rather than guessed at",
                1,
                no_slug("listed-heading"),
                "\n- ## Listed heading\n\n  In a list item.\n",
                "listed-heading",
            ),
            # GFM's indentation limits travel with the blockquote strip (round 4, P2).
            (
                "four spaces before a blockquote marker is code, not a heading",
                1,
                no_slug("indented-quote"),
                "\n    > ## Indented quote\n\nFour spaces: code, not a container.\n",
                "indented-quote",
            ),
            (
                "...and so is content indented four spaces inside one",
                1,
                no_slug("indented-content"),
                "\n>     ## Indented content\n\nCode inside the quote.\n",
                "indented-content",
            ),
            (
                "...while three spaces is still a blockquote, and its heading still a heading",
                0,
                "(1 checked)",
                "\n   > ## Barely quoted\n>\n> Three spaces is still a quote.\n",
                "barely-quoted",
            ),
            # The one space a blockquote marker takes may be a tab, expanded to the next stop
            # (round 7, P2); the columns it leaves over are indentation (round 10, P2).
            (
                "a tab may stand for the space a blockquote marker takes",
                0,
                "(1 checked)",
                "\n>\t## Tabbed quote\n>\n> A tab where the space would be.\n",
                "tabbed-quote",
            ),
            (
                "the columns a tab leaves after a blockquote marker are indentation",
                1,
                no_slug("hidden-by-indentation"),
                "\n>\t  ## Hidden by indentation\n",
                "hidden-by-indentation",
            ),
            # A carriage return is the other half of a CRLF line ending, not content (round 7, P2).
            (
                "a CRLF line ending does not join the closing hashes to the heading",
                0,
                "(1 checked)",
                "\n## Closed off ##\r\n",
                "closed-off",
            ),
            (
                "...so the reading that keeps it names no heading",
                1,
                no_slug("closed-off-"),
                "\n## Closed off ##\r\n",
                "closed-off-",
            ),
            # An empty slug is still an OCCUPANT, and numbers its repeats (round 8, P2).
            ("...and stops where the file does", 1, no_slug("-2"), "\n## !!!\n\n## !!!\n", "-2"),
            # A heading may END at its hash run (round 9, P2).
            (
                "a heading that ends at its hash run is a heading, and occupies its slug",
                0,
                "(1 checked)",
                "\n#\n\n## !!!\n",
                "-1",
            ),
            # An ATX heading is one to six hashes followed by a blank or the line end.
            ("seven hashes open no heading", 1, no_slug("seven-hashes"), "\n####### Seven hashes\n", "seven-hashes"),
            ("...nor does a hash run glued to its text", 1, no_slug("tagline"), "\n#tagline\n", "tagline"),
        )
        for label, rc, want, heading, anchor in cases:
            with self.subTest(label):
                self.heading_case(label, rc, want, heading=heading, link=f"See [it](references/notes.md#{anchor}).")
        self.heading_case(
            "an empty slug numbers its repeats, which are anchors that work",
            0,
            "(2 checked)",
            heading="\n## !!!\n\n## !!!\n\n## !!!\n",
            link="See [the first repeat](references/notes.md#-1) and [the second](references/notes.md#-2).",
        )

    # A heading this check will not spell still OCCUPIES a slug on GitHub, and the numbering is
    # occupancy-based. What that costs is bounded, and the bound is the point: every slug this emits
    # is one GitHub HAS, so an anchor accepted here resolves there, and only the `-<n>` spelling goes
    # unconfirmed (round 3, P2; the suppression tried instead was taken out in round 9).
    def test_unspellable_headings_occupy_slugs(self) -> None:
        R = self.root
        foo = "\n## Foo\n\nThe heading GitHub numbers past the refused one.\n"
        links_unspellable(R, NOTES)
        append(f"{R}/{NOTES}", foo)
        links_body(R, "alpha/SKILL.md", "See [the name GitHub has](references/notes.md#foo).")
        self.expect("an anchor an unspellable heading holds on GitHub still resolves here", 0, "(1 checked)")
        links_tree(R)
        links_unspellable(R, NOTES)
        append(f"{R}/{NOTES}", foo)
        links_body(R, "alpha/SKILL.md", "See [the numbered reading](references/notes.md#foo-1).")
        self.expect(
            "...while the -<n> spelling goes unconfirmed, and the message names what did it",
            1,
            "leave a numbered repeat unconfirmed",
        )
        links_tree(R)
        links_unspellable(R, NOTES)
        links_body(R, "alpha/SKILL.md", "See [a heading standing before it](references/notes.md#close-out).")
        self.expect("...and a heading BEFORE it keeps its name, which nothing later can move", 0, "(1 checked)")
        # A heading-shaped line inside a FENCE that the slug reader will not spell must not take the
        # real headings after it down with it (round 9, P2).
        self.heading_case(
            "an unspellable heading inside a fence refuses no anchor after it",
            0,
            "(1 checked)",
            heading="\n```\n## [Example](https://example.invalid)\n```\n\n## After the fence\n",
            link="See [past a phantom heading](references/notes.md#after-the-fence).",
        )

    # A byte-order mark opens a FILE, not a line, and GFM removes it before parsing (round 6, P2).
    def test_a_byte_order_mark(self) -> None:
        write(f"{self.root}/alpha/references/marked.md", b"\xef\xbb\xbf# Marked\n\n## Close-out\n")
        links_body(self.root, "alpha/SKILL.md", "See [past a byte-order mark](references/marked.md#marked).")
        self.expect("a byte-order mark does not hide the first heading of a file", 0, "(1 checked)")

    # A case-insensitive filesystem -- the macOS default -- answers yes for a link whose spelling the
    # checkout does not have, while GitHub serves that link as a 404 (round 7, P2). On a
    # case-sensitive box the path does not exist at all, so the refusal is asserted by the half of
    # the message both share. A hidden path component is spelled as the checkout spells it too
    # (round 8, P2).
    def test_spelling_the_checkout_has(self) -> None:
        R = self.root
        self.link_case(
            "a link the checkout spells differently is refused, however the filesystem answers",
            1,
            "alpha/SKILL.md: link to references/Notes.md",
            "See [a mis-cased path](references/Notes.md).",
        )
        self.link_case(
            "...while the spelling the checkout has resolves",
            0,
            "(1 checked)",
            "See [the spelling it has](references/notes.md).",
        )
        links_tree(R)
        write(f"{R}/alpha/.refs/notes.md", "# Hidden\n\n## A section\n")
        links_body(R, "alpha/SKILL.md", "See [a hidden directory](.refs/notes.md#a-section).")
        self.expect("a hidden path component is spelled as the checkout spells it", 0, "(1 checked)")
        links_tree(R)
        write(f"{R}/alpha/.refs/notes.md", "# Hidden\n")
        links_body(R, "alpha/SKILL.md", "See [a mis-cased hidden directory](.Refs/notes.md).")
        self.expect("...and a mis-cased one is still refused", 1, "alpha/SKILL.md: link to .Refs/notes.md")

    # The lexical `..` guard stops a path SPELLING its way out of the checkout; a symbolic link walks
    # out without spelling anything. Refused on the path, at any component, before the target is
    # TOUCHED -- the probes plant a real file with a real heading at each destination, so a reader
    # that still followed the link would turn the refusal into a pass (rounds 2-4, P2).
    @unittest.skipIf(WINDOWS, NO_SYMLINKS)
    def test_symbolic_links(self) -> None:
        R, outside = self.root, f"{self.base}/outside.md"
        write(outside, "# Outside\n\n## Planted\n")
        os.symlink(outside, f"{R}/alpha/references/linked.md")
        links_body(R, "alpha/SKILL.md", "See [a link out](references/linked.md#planted).")
        self.expect(
            "a target that is a symbolic link is refused, not followed",
            1,
            "reached through a symbolic link: alpha/references/linked.md",
        )
        links_tree(R)
        write(f"{self.base}/elsewhere/notes.md", "# Outside\n")
        os.symlink(f"{self.base}/elsewhere", f"{R}/alpha/linked")
        links_body(R, "alpha/SKILL.md", "See [a link out of a parent](linked/notes.md).")
        self.expect(
            "...and so is one reached through a symlinked parent",
            1,
            "reached through a symbolic link: alpha/linked/notes.md",
        )
        links_tree(R)
        os.symlink(outside, f"{R}/alpha/references/linked.md")
        links_body(R, "alpha/SKILL.md", "See [an anchored link out](references/linked.md#planted).")
        self.expect(
            "an anchored symlinked target is refused before its headings are read",
            1,
            "reached through a symbolic link: alpha/references/linked.md",
        )
        links_tree(R)
        links_body(R, NOTES, "See [an anchored climb out](../../../outside.md#planted).")
        self.expect(
            "...and so is an anchored target that climbs past the root",
            1,
            "resolves outside the checkout: ../outside.md",
        )
        # The guard on the READING side: a prompt file that is a symlink out of the checkout is
        # reported rather than read, or skipped in silence (round 4, P2).
        links_tree(R)
        write(outside, "# Outside\n\nSee [a host link](gone.md).\n")
        os.symlink(outside, f"{R}/alpha/references/extra.md")
        self.expect(
            "a linking file reached through a symbolic link is not read",
            1,
            "alpha/references/extra.md: is reached through a symbolic link",
        )

    # The obligation comes from a link, as the fixtures' comes from a fixture.
    def test_no_link_no_obligation(self) -> None:
        fresh(self.root)
        self.lacks(
            "...and a tree carrying no such link takes no link obligation", "relative Markdown link", run(CP, self.root)
        )

    def test_annotations(self) -> None:
        # Under Actions the failure is an annotation on the LINKING file, which is the file to edit.
        links_body(self.root, "alpha/SKILL.md", "See [what moved](references/gone.md).")
        self.expect(
            "GitHub annotations name the linking file",
            1,
            "::error file=alpha/SKILL.md::link to references/gone.md",
            env={"GITHUB_ACTIONS": "true"},
        )


# The real prompts. The link probed is read OFF the wave prompt rather than restated: the anchors
# ludics-lite#260 created are exactly what moves next time the sections do.


@functools.cache
def real_link() -> str:
    for line in src_lines("issue-wave/SKILL.md"):
        found = re.findall(r"\((references/[A-Za-z0-9_.-]*\.md#[A-Za-z0-9_-]+)\)", line)
        if found:
            target = found[-1]
            if os.path.isfile(os.path.join(SRC, "issue-wave", target.split("#")[0])):
                return target
            break
    raise AssertionError("the link probes need an anchored references/....md#... link in issue-wave/SKILL.md")


def links_real(root: str) -> None:
    """The one tree that takes EVERY Markdown file, because the real link graph is its subject."""
    shutil.rmtree(root, ignore_errors=True)
    found: list[str] = []
    for top, dirs, files in os.walk(SRC):
        dirs[:] = sorted(d for d in dirs if d != ".git")
        found.extend(os.path.relpath(os.path.join(top, f), SRC) for f in files if f.endswith(".md"))
    copy_prompts(root, *sorted(found))


class LinksRealTest(Case):
    def setUp(self) -> None:
        super().setUp()
        self.target = real_link()
        self.file = self.target.split("#")[0]
        links_real(self.root)

    def test_the_real_links_resolve(self) -> None:
        self.expect("every relative link in the real prompts resolves, anchors included", 0, "anchors included")

    # The two drifts this check exists for, each made at the source: a section retitled, and the
    # file holding it renamed. Both look exactly like a working link until somebody clicks one.
    def test_a_retitled_heading(self) -> None:
        rewrite(self.root, f"issue-wave/{self.file}", pattern="^## ", repl="## Renamed ")
        self.expect(
            "a retitled heading is caught in the prompt that anchors into it",
            1,
            f"issue-wave/SKILL.md: link to {self.target} names no heading",
        )

    def test_a_renamed_file(self) -> None:
        old = f"{self.root}/issue-wave/{self.file}"
        os.rename(old, old.removesuffix(".md") + "-renamed.md")
        self.expect("a renamed reference file is caught the same way", 1, f"issue-wave/SKILL.md: link to {self.file}")


# --- the shell checker's byte and path readings ----------------------------------------------------
# The checker was a shell script until ludics-lite#403, run on macOS under the platform's own awk,
# sed and find, and its verdicts are what the port keeps. Each probe below is a reading those tools
# made that no other probe holds, found by the parity review of the port.


class ShellReadingsTest(Case):
    # A NUL ends an awk record's text: whatever follows a NUL on its line is not there to the index,
    # register, slot, link and heading readers.
    def test_a_nul_ends_a_line(self) -> None:
        R, s = self.root, slots()
        none = "FAIL: issue-wave/references/executions.md: states no mac-studio slot count"
        slots_tree(R)
        nul_edit(R, "issue-wave/references/executions.md", containing="mac-studio", where="prefix")
        self.expect("a slot count stated only after a NUL is no statement", 1, none)
        slots_tree(R)
        append(f"{R}/issue-wave/references/executions.md", f"note \0 mac-studio={s.other}\n")
        self.expect("a wrong slot count after a NUL is not read", 0, "mac-studio correctness slots agree")
        links_tree(R)
        append(f"{R}/{NOTES}", "\n## Sec\0tail\n\nCut short.\n")
        links_body(R, "alpha/SKILL.md", "See [it](references/notes.md#sec).")
        self.expect("a heading's slug stops at a NUL", 0, "(1 checked)")
        links_tree(R)
        append(f"{R}/{NOTES}", "x\0 [gone](missing.md)\n")
        links_body(R, "alpha/SKILL.md", "See [it](references/notes.md).")
        self.expect("a link after a NUL is not read", 0, "(1 checked)")
        fixture_tree(R)
        nul_edit(R, "README.md", containing="alpha/scripts/test-shell.sh", where="suffix")
        self.expect("a register line reads up to a NUL", 0, "fixture command register and required CI platforms agree")
        # A sed reading keeps the NUL, and the command substitution around it then drops it: the
        # routine names read off LOCAL_ROUTINES are the ones with the NUL taken out.
        drift_tree(R)
        rewrite(R, "scripts/sync-routines.sh", pattern='^LOCAL_ROUTINES="', repl='LOCAL_ROUTINES="\0')
        self.expect("a NUL in LOCAL_ROUTINES is dropped from the names", 0, "runs it to read its own drift")

    # A count is bash arithmetic's, which wraps at 64 bits: 2^64 + n is n, and 2^64 is zero.
    def test_counts_wrap_at_64_bits(self) -> None:
        R, s = self.root, slots()
        slots_tree(R)
        rewrite(R, WORKER, pattern=f"mac-studio={s.want}", repl=f"mac-studio={2**64 + s.want}", count=0)
        self.expect("a default past 64 bits wraps as bash arithmetic does", 0, f"count say {s.want}")
        slots_tree(R)
        rewrite(R, WORKER, pattern=f"mac-studio={s.want}", repl=f"mac-studio={2**64}", count=0)
        self.expect("a default of 2^64 is zero", 1, "SLOTS assignment states mac-studio=0; the worker requires")

    # The slot scan walked the root with `find` and cut the root back off each path with an awk `-v`
    # assignment, which is escape-processed: a backslash in the root's path matched no file, so the
    # scan found no statement at all.
    @unittest.skipIf(WINDOWS, NO_NAMES)
    def test_a_backslash_in_the_root(self) -> None:
        slots_tree(self.root)
        odd = f"{self.base}/b\\nroot"
        shutil.copytree(self.root, odd)
        self.expect(
            "a root whose path holds a backslash finds no slot statement",
            1,
            "FAIL: issue-wave/references/executions.md: states no mac-studio slot count",
            CP,
            odd,
        )

    # ...and `find` does not descend into a root that is itself a symbolic link. The default root is
    # `$HERE/..` named logically, so this checkout reached through a link is one.
    @unittest.skipIf(WINDOWS, NO_SYMLINKS)
    def test_a_root_through_a_symbolic_link(self) -> None:
        none = "FAIL: issue-wave/references/executions.md: states no mac-studio slot count"
        slots_tree(self.root)
        os.symlink(self.root, f"{self.base}/linked-root")
        self.expect("a root that is a symbolic link finds no slot statement", 1, none, CP, f"{self.base}/linked-root")
        os.symlink(SRC, f"{self.base}/checkout-link")
        self.expect(
            "this checkout through a symbolic link finds no slot statement",
            1,
            none,
            f"{self.base}/checkout-link/scripts/check-prompts.sh",
        )

    # The root is entered with `cd "$ROOT" && pwd`: the logical path when it is a directory, and the
    # physical one when it is not -- `lnk/../root` through a symbolic link lands where the kernel does.
    @unittest.skipIf(WINDOWS, NO_SYMLINKS)
    def test_dot_dot_through_a_symbolic_link(self) -> None:
        d = f"{self.base}/dotdot"
        os.makedirs(f"{d}/real/x")
        fresh(f"{d}/real/root")
        os.symlink("real/x", f"{d}/lnk")
        self.expect(
            "a '..' through a symbolic link falls back to the physical directory",
            0,
            clean(f"{d}/real/root"),
            BASH,
            "-c",
            'cd "$1" && exec "$2" lnk/../root',
            "_",
            d,
            CP,
        )
        self.expect(
            "...and so does --one",
            0,
            "1 passed, 0 failed",
            BASH,
            "-c",
            'cd "$1" && exec "$2" --one ../root/alpha',
            "_",
            f"{d}/lnk",
            CP,
        )

    # An index that is a regular file but cannot be read is there, and indexes nothing.
    @unittest.skipIf(WINDOWS or os.name == "posix" and os.geteuid() == 0, "a mode of 000 does not stop this reader")
    def test_an_unreadable_index(self) -> None:
        R = self.root
        fresh(R)
        shutil.rmtree(f"{R}/routines/nightly")
        shutil.rmtree(f"{R}/routines/weekly")
        os.chmod(f"{R}/routines/README.md", 0)
        self.addCleanup(os.chmod, f"{R}/routines/README.md", 0o644)
        self.expect(
            "an unreadable index with nothing to index is not missing",
            0,
            "ok: routines/README.md: no routines/ SKILL.md directory to index",
        )


# --- whole-line reads of bg-run.sh wait's verdict line (ludics-lite#826) -------------------------
# Each form the verdicts module's boundary lists, in each kind of file it sweeps, is refused; the
# first-word reads beside them pass, as do the four files it names as excluded and a root without
# the writer.

VERDICT_FORMS = (
    ("scripts/a.sh", 'if [ "$said" = "rc=0" ]; then', "a test = comparison"),
    ("scripts/a.sh", "[ \"$(head -n1 log)\" = 'rc=0' ] && echo ok", "a test = comparison"),
    ("scripts/a.sh", '[ "$v" != DIED ] || exit 1', "an ==/!= comparison"),
    ("scripts/a.sh", 'test "$v" = "rc=$want"', "a test = comparison"),
    ("scripts/a.sh", '[ "rc=0" = "$said" ]', "a test = comparison"),
    ("scripts/a.sh", '[ ! "rc=0" = "$said" ]', "a test = comparison"),
    ("scripts/a.sh", 'test ! "RUNNING" = "$said"', "a test = comparison"),
    ("scripts/a.sh", '[ -n "$said" -a STOPPED = "$said" ]', "a test = comparison"),
    ("scripts/a.sh", '[[ $said == "RUNNING" ]] && continue', "an ==/!= comparison"),
    ("scripts/a.sh", "[[ rc=0 == $said ]]", "an ==/!= comparison"),
    ("scripts/a.sh", "grep -x 'rc=0' out", "a grep -x match"),
    ("scripts/a.sh", 'printf "%s\\n" "$v" | grep -qxF STOPPED', "a grep -x match"),
    ("scripts/a.sh", "grep --line-regexp -e 'rc=0' out", "a grep -x match"),
    ("scripts/a.sh", "grep -q '^rc=0$' out", "an anchored grep match"),
    ("scripts/a.sh", 'case "$said" in rc=0) ok ;; esac', "a case arm"),
    ("scripts/a.sh", "  STARTING|RUNNING) again ;;", "a case arm"),
    ("scripts/a.sh", 'case "$v" in rc=*) done ;; DIED) again ;; esac', "a case arm"),
    ("scripts/a.sh", 'case "$said" in "other result"|rc=0) echo success ;; esac', "a case arm"),
    ("scripts/a.sh", "case $said in 'a b'|x\"y z\"|STOPPED) stop ;; esac", "a case arm"),
    ("alpha/SKILL.md", '    [ "$(bg-run.sh wait "$d")" = "rc=0" ] && echo passed', "a test = comparison"),
    ("alpha/references/x.md", "- `grep -x STOPPED` on the wait's output", "a grep -x match"),
    ("lib/ludics/x/y.py", '    if said == "rc=0":', "an ==/!= comparison"),
    ("lib/ludics/x/y.py", "    ok = line != 'DIED'", "an ==/!= comparison"),
    ("lib/ludics/x/y.py", '    if "rc=0"==said:', "an ==/!= comparison"),
    ("lib/ludics/x/y.py", '    ok = said=="DIED"', "an ==/!= comparison"),
    ("lib/ludics/x/y.py", '    ok="RUNNING"==said', "an ==/!= comparison"),
    ("lib/ludics/x/y.py", "    ok='rc=0'!=said", "an ==/!= comparison"),
    ("lib/ludics/x/y.py", '    if said == f"rc={want}":', "an ==/!= comparison"),
    ("scripts/a.sh", "grep 'rc=0' -x out", "a grep -x match"),
    ("scripts/a.sh", "v=$(grep rc=0 out -x)", "a grep -x match"),
    ("issue-wave/scripts/other.sh", "case $v in (DIED) x ;; esac", "a case arm"),
)

VERDICT_CONTROLS = (
    'case "$said" in rc=*) ;; *) refuse ;; esac',
    '[[ $said == rc=* ]] && done=1',
    'case "${said%% *}" in STOPPED*) stopped ;; esac',
    "grep -q '^rc=' out",
    "grep -x 'rc=0 (finished earlier' out",
    '[ "$wrc" -eq 0 ] || exit 1',
    'if said.startswith("rc="):',
    'state = "RUNNING"',
    "if len(names) == RUNNING_SHOWN:",
    "if word is Word.RUNNING or cfg.RUNNING==x:",
    "A wait prints `rc=0` and exits 0; `RUNNING` (3) means re-issue it.",
    "  3) refuse \"bg-run.sh wait: RUNNING -- live\" ;;",
)


class VerdictReadsTest(Case):
    OK = "ok: no whole-line read of bg-run.sh wait's verdict line in"

    def setUp(self) -> None:
        super().setUp()
        fresh(self.root)
        write(os.path.join(self.root, "issue-wave", "scripts", "bg-run.sh"), "#!/bin/sh\n")

    def test_a_tree_of_first_word_reads_passes(self) -> None:
        write(os.path.join(self.root, "scripts", "a.sh"), "".join(f"{line}\n" for line in VERDICT_CONTROLS))
        write(os.path.join(self.root, "lib", "ludics", "x", "y.py"), "".join(f"{line}\n" for line in VERDICT_CONTROLS))
        append(os.path.join(self.root, "alpha", "SKILL.md"), "".join(f"    {line}\n" for line in VERDICT_CONTROLS))
        self.expect("first-word reads of the verdict line pass", 0, self.OK)

    def test_each_whole_line_read_is_refused(self) -> None:
        for rel, line, form in VERDICT_FORMS:
            with self.subTest(line=line):
                fresh(self.root)
                write(os.path.join(self.root, "issue-wave", "scripts", "bg-run.sh"), "#!/bin/sh\n")
                path = os.path.join(self.root, rel)
                if os.path.exists(path):
                    append(path, f"{line}\n")
                    n = len(read(path).split("\n")) - 1
                else:
                    write(path, f"#!/bin/sh\n{line}\n")
                    n = 2
                result = self.expect(f"{line!r} is refused", 1, f"FAIL: {rel}: line {n}: {form} reads bg-run.sh wait's whole")
                self.lacks(f"{line!r}", self.OK, result)

    def test_the_excluded_files_and_only_they_are_not_read(self) -> None:
        bad = '[ "$said" = "rc=0" ]\n'
        excluded = ("issue-wave/scripts/bg-run.sh", "issue-wave/scripts/test-bg-run.sh",
                    "lib/ludics/checkprompts/verdicts.py", "lib/ludics/tests/test_checkprompts_cli_checks.py")
        for rel in excluded:
            write(os.path.join(self.root, rel), bad)
        # The tree's own suite file draws the fixture register's refusals, which are not this check's.
        result = run(CP, self.root)
        self.check("the writer, its suite, the scanner and its fixtures are not read", 1, result, self.OK)
        self.lacks("an excluded file", "reads bg-run.sh wait's whole", result)
        write(os.path.join(self.root, "issue-wave", "scripts", "test-bg-run-2.sh"), bad)
        self.expect("a name beside an excluded one is read", 1,
                    "FAIL: issue-wave/scripts/test-bg-run-2.sh: line 1: a test = comparison")

    def test_no_writer_no_obligation(self) -> None:
        os.remove(os.path.join(self.root, "issue-wave", "scripts", "bg-run.sh"))
        write(os.path.join(self.root, "scripts", "a.sh"), '[ "$said" = "rc=0" ]\n')
        result = self.expect("a root without bg-run.sh carries no obligation", 0, clean(self.root))
        self.lacks("no writer", "verdict line", result)


# --- the suite map (#718) ------------------------------------------------------------------------
# lib/ludics/README.md's map of the suites that drive each module. The scratch package has a module
# at the top, two in a subpackage and one below that, an __init__.py at each level and a tests/
# directory (neither owes a line), and the fixture register's suites; alpha/scripts/test-shell.sh
# declares the SECTIONS=( array that section arguments are read against. a.py binds names at its top
# level each way the map's parts read (#1035), and each way they do not.

SUITE_MAP_OK = "ok: lib/ludics/README.md: every one of the 4 modules names the suites that drive it"
SECTIONED = "alpha/scripts/test-shell.sh"
SECTIONS_TEXT = 'echo first\nSECTIONS=(\n  "alpha one"\n  "beta / two --x"\n)\n'
SUITE_MAP = """\
# lib/ludics

## Which suites drive each module

Prose before the map.

```
a.py
    alpha/scripts/test-shell.sh "alpha one" beta
    lib/ludics/tests/test_x.py

pkg/b.py pkg/c.py
pkg/sub/d.py
    ship-pr/scripts/test-*.sh

a.py:CONST a.py:X a.py:Y a.py:ANN
a.py:fn a.py:afn a.py:Klass
    alpha/scripts/test-shell.sh beta
```

## Checking
"""


A_PY = """\
\"\"\"A module with parts.\"\"\"
import os
CONST = 1
X = Y = 2
ANN: int = 3
A, B = 4, 5
def fn():
    pass
async def afn():
    pass
class Klass:
    def method(self):
        pass
if os.sep:
    COND = 6
for LOOP in ():
    pass
"""


def suite_map_tree(root: str, text: str = SUITE_MAP) -> None:
    fixture_tree(root)
    for rel in ("__init__.py", "a.py", "pkg/__init__.py", "pkg/b.py", "pkg/c.py", "pkg/sub/__init__.py",
                "pkg/sub/d.py", "tests/__init__.py", "tests/test_x.py", "tests/fake.py"):
        write(os.path.join(root, "lib", "ludics", rel), "")
    write(os.path.join(root, "lib", "ludics", "a.py"), A_PY)
    write(os.path.join(root, SECTIONED), SECTIONS_TEXT)
    write(os.path.join(root, "lib", "ludics", "README.md"), text)


def changed(text: str, old: str, new: str) -> str:
    if old not in text:
        raise FixtureMissed(f"'{old}' is not in the map fixture")
    return text.replace(old, new, 1)


class SuiteMapTest(Case):
    BASE = SUITE_MAP

    def test_a_mapped_package_passes(self) -> None:
        # A section argument is a substring of a section's name, quoted or bare; a glob stands for
        # the suites it matches; a group's module lines may run over several lines; a part names a
        # def, async def, class, or plain-name (chained or annotated) assignment at the top level.
        suite_map_tree(self.root, self.BASE)
        self.expect("a package whose every module has a line passes", 0, SUITE_MAP_OK)

    def test_no_package_no_obligation(self) -> None:
        fixture_tree(self.root)
        result = self.expect("a root without lib/ludics/__init__.py owes no map", 0, "0 failed")
        self.lacks("no package", "suites that drive", result)

    def test_each_defect_is_refused(self) -> None:
        R = self.root
        B = self.BASE
        cases: tuple[tuple[str, str, str], ...] = (
            ("a module named twice", changed(B, "pkg/b.py pkg/c.py", "pkg/b.py pkg/c.py a.py"),
             "names 'a.py' again (first on line"),
            ("a name that is no module", changed(B, "pkg/sub/d.py\n", "pkg/sub/d.py pkg/zz.py\n"),
             "names 'pkg/zz.py', which is no module of lib/ludics"),
            ("an __init__.py is no module", changed(B, "pkg/sub/d.py\n", "pkg/sub/d.py pkg/__init__.py\n"),
             "names 'pkg/__init__.py', which is no module"),
            ("a word that is no module path", changed(B, "a.py\n", "a.py lib/ludics/a\n"),
             "'lib/ludics/a' is not a module path relative to lib/ludics"),
            ("a part whose name is no identifier", changed(B, "a.py:Klass", "a.py:Klass a.py:1x"),
             "'a.py:1x' is not a module path relative to lib/ludics, nor a part of one"),
            ("a part with no name", changed(B, "a.py:Klass", "a.py:Klass a.py:"),
             "'a.py:' is not a module path relative to lib/ludics, nor a part of one"),
            ("a part named twice", changed(B, "a.py:Klass", "a.py:Klass a.py:CONST"),
             "names 'a.py:CONST' again (first on line"),
            ("a part of no module", changed(B, "a.py:Klass", "a.py:Klass pkg/zz.py:X"),
             "names the part 'pkg/zz.py:X' of 'pkg/zz.py', which is no module of lib/ludics"),
            ("a part of an __init__.py", changed(B, "a.py:Klass", "a.py:Klass pkg/__init__.py:X"),
             "names the part 'pkg/__init__.py:X' of 'pkg/__init__.py', which is no module"),
            ("a part bound by a tuple target", changed(B, "a.py:Klass", "a.py:Klass a.py:A"),
             "names the part 'a.py:A', but 'a.py' binds no 'A' at its top level"),
            ("a part bound by an import", changed(B, "a.py:Klass", "a.py:Klass a.py:os"),
             "names the part 'a.py:os', but 'a.py' binds no 'os' at its top level"),
            ("a part bound under an if", changed(B, "a.py:Klass", "a.py:Klass a.py:COND"),
             "names the part 'a.py:COND', but 'a.py' binds no 'COND' at its top level"),
            ("a part bound by a for", changed(B, "a.py:Klass", "a.py:Klass a.py:LOOP"),
             "names the part 'a.py:LOOP', but 'a.py' binds no 'LOOP' at its top level"),
            ("a method is no part", changed(B, "a.py:Klass", "a.py:Klass a.py:method"),
             "names the part 'a.py:method', but 'a.py' binds no 'method' at its top level"),
            ("a name bound nowhere", changed(B, "a.py:Klass", "a.py:Klass a.py:Nope"),
             "names the part 'a.py:Nope', but 'a.py' binds no 'Nope' at its top level"),
            ("a part's line does not stand for its module's",
             changed(B, 'a.py\n    alpha/scripts/test-shell.sh "alpha one" beta\n    lib/ludics/tests/test_x.py\n\n', ""),
             "module 'a.py' has no line in the map"),
            ("a part group with no suite line", changed(B, "a.py:fn a.py:afn a.py:Klass\n    alpha/scripts/test-shell.sh beta\n",
                                                        "a.py:fn a.py:afn a.py:Klass\n"),
             "a module line with no suite line under it"),
            ("a part's section that selects none", changed(B, "    alpha/scripts/test-shell.sh beta\n", "    alpha/scripts/test-shell.sh delta\n"),
             f"'delta' selects no section of {SECTIONED}"),
            ("a group with no suite line", changed(B, "pkg/b.py pkg/c.py\npkg/sub/d.py\n", "pkg/b.py pkg/c.py\n\npkg/sub/d.py\n"),
             "a module line with no suite line under it"),
            ("a group with no suite line at the end", changed(B, "    ship-pr/scripts/test-*.sh\n", ""),
             "a module line with no suite line under it"),
            ("a module line after a suite line", changed(B, "test_x.py\n\npkg/b.py", "test_x.py\npkg/b.py"),
             "a module line under suite lines"),
            ("a suite line with no module line", changed(B, "test_x.py\n\n", "test_x.py\n\n    alpha/scripts/test-python.py\n\n"),
             "a suite line with no module line above it in its group"),
            ("a suite line of two spaces", changed(B, "    lib/ludics/tests/test_x.py", "  lib/ludics/tests/test_x.py"),
             "neither a module line (no indent) nor a suite line"),
            ("a suite line of five spaces", changed(B, "    lib/ludics/tests/test_x.py", "     lib/ludics/tests/test_x.py"),
             "neither a module line (no indent) nor a suite line"),
            ("a suite line indented by a tab", changed(B, "    lib/ludics/tests/test_x.py", "\tlib/ludics/tests/test_x.py"),
             "neither a module line (no indent) nor a suite line"),
            ("a path that is no suite", changed(B, "    lib/ludics/tests/test_x.py", "    lib/ludics/tests/fake.py"),
             "'lib/ludics/tests/fake.py' is not a suite"),
            ("a test-* file that is not a suite", changed(B, "    lib/ludics/tests/test_x.py", "    alpha/scripts/test-data.json"),
             "'alpha/scripts/test-data.json' is not a suite"),
            ("a glob that matches nothing", changed(B, "ship-pr/scripts/test-*.sh", "ship-pr/scripts/test-nope-*.sh"),
             "the glob 'ship-pr/scripts/test-nope-*.sh' matches no suite"),
            ("a glob given sections", changed(B, "ship-pr/scripts/test-*.sh", "ship-pr/scripts/test-*.sh alpha"),
             "the glob 'ship-pr/scripts/test-*.sh' takes no section arguments"),
            ("a section argument that selects none", changed(B, '"alpha one" beta', '"alpha one" gamma'),
             f"'gamma' selects no section of {SECTIONED}"),
            ("an argument the suite reads as an option", changed(B, '"alpha one" beta', '"alpha one" --x'),
             f"'--x' starts with '-': {SECTIONED} reads it as an option"),
            ("sections for a suite that declares none", changed(B, "tests/test_x.py\n", "tests/test_x.py alpha\n"),
             "'lib/ludics/tests/test_x.py' declares no SECTIONS=( array"),
            ("words that do not split", changed(B, '"alpha one" beta', '"alpha one beta'),
             "its words do not split as the shell's"),
            ("no heading", changed(B, "## Which suites drive each module", "## Which suites drive the modules"),
             "no '## Which suites drive each module' line"),
            ("a fence after the next heading", changed(B, "Prose before the map.\n", "## Next\n"),
             "has no fenced block before the next heading"),
            ("an unclosed fence", changed(B, "```\n\n## Checking", "\n## Checking"),
             "the map's fence is never closed"),
        )
        for label, text, want in cases:
            with self.subTest(case=label):
                suite_map_tree(R, text)
                result = self.expect(f"{label} is refused", 1, f"FAIL: lib/ludics/README.md: {want}"
                                     if want.startswith(("no '", "module '")) else want)
                self.lacks(label, SUITE_MAP_OK, result)

    def test_every_module_owes_a_line(self) -> None:
        R = self.root
        for rel in ("pkg/e.py", "pkg/sub/deeper/f.py", "g.py"):
            with self.subTest(module=rel):
                suite_map_tree(R, self.BASE)
                write(os.path.join(R, "lib", "ludics", rel), "")
                self.expect(f"{rel} without a line is refused", 1,
                            f"FAIL: lib/ludics/README.md: module '{rel}' has no line in the map")
        # tests/ is the unit suites, not modules; __pycache__ holds no source. Neither owes a line.
        suite_map_tree(R, self.BASE)
        write(os.path.join(R, "lib", "ludics", "tests", "helper.py"), "")
        write(os.path.join(R, "lib", "ludics", "pkg", "__pycache__", "b.py"), "")
        self.expect("tests/ and __pycache__ owe no line", 0, SUITE_MAP_OK)

    def test_a_part_of_a_module_that_does_not_parse_is_refused(self) -> None:
        R = self.root
        suite_map_tree(R, changed(self.BASE, "a.py:Klass", "a.py:Klass pkg/c.py:X"))
        write(os.path.join(R, "lib", "ludics", "pkg", "c.py"), "X = 1\ndef (\n")
        result = self.expect("a part of a module that does not parse is refused", 1,
                             "names the part 'pkg/c.py:X', but 'pkg/c.py' has no top-level names: it does not parse as Python")
        self.lacks("an unparsable module", SUITE_MAP_OK, result)
        # The source is read as Python reads it: a BOM and a UTF-8 identifier are no parse error.
        suite_map_tree(R, changed(self.BASE, "a.py:Klass", "a.py:Klass pkg/c.py:X"))
        with open(os.path.join(R, "lib", "ludics", "pkg", "c.py"), "wb") as f:
            f.write(b"\xef\xbb\xbfcaf\xc3\xa9 = 1\nX = 2\n")
        self.expect("a UTF-8 module with a BOM yields its parts", 0, SUITE_MAP_OK)
        # Its own module line still stands: the module is mapped, only its parts cannot be read.
        suite_map_tree(R, self.BASE)
        write(os.path.join(R, "lib", "ludics", "pkg", "c.py"), "X = 1\ndef (\n")
        self.expect("an unparsable module named by its own line alone passes", 0, SUITE_MAP_OK)

    def test_the_readme_and_the_sections_are_read(self) -> None:
        R = self.root
        suite_map_tree(R, self.BASE)
        os.remove(os.path.join(R, "lib", "ludics", "README.md"))
        self.expect("a package with no README is refused", 1,
                    "FAIL: lib/ludics/README.md: missing: it maps the suites that drive each module")
        for label, old, new, want in (
            ("a section name that is not plain", '  "beta / two --x"', '  "$beta"', "line 4 of its SECTIONS=( array is not a plain"),
            ("an unclosed SECTIONS array", "\n)\n", "\n", "its SECTIONS=( array (line 2) is never closed"),
        ):
            with self.subTest(case=label):
                suite_map_tree(R, self.BASE)
                write(os.path.join(R, SECTIONED), changed(SECTIONS_TEXT, old, new))
                self.expect(f"{label} is refused on the suite", 1,
                            f"FAIL: {SECTIONED}: cannot read the sections of '{SECTIONED}': {want}")


# --- the brief template (ludics#1072) ------------------------------------------------------------


BRIEF_OK = "ok: the brief template (14 parts) renders, its references exist, and it holds no retired step"
BRIEF_OWN = ("who.md", "tests.md", "blocking.md", "context.md")
BRIEF_SHARED = ("where.md", "startup.md", "task.md", "requests.md", "landing.md", "checkpoint.md", "after-merge.md")
BRIEF_COMMON = """\
## Who you are

Worker of `@@WAVE@@` in `@@WT@@`, run by `@@COORDINATOR@@` on `@@MAIN@@`.

@@PROJECT@@

Read `issue-wave/references/notes.md`, *Blocking on a run*, and run
`~/.claude/skills/issue-wave/scripts/bg-run.sh wait <dir>` and `~/ludics/scripts/run-*.sh`.
"""
BRIEF_PLANNING = "## Paired planning (mode: @@MODE@@)\n\nComment on @@ISSUE@@.\n"
BRIEF_PROJECT = "## This project\n\nRead `lib/ludics/README.md`, *Which suites drive\n  each module*.\n"


BRIEF_AFTER_MERGE = (
    "## After the merge\n\n"
    "Start your final reply with the plain line `HANDBACK @@T@@`, before any heading or prose.\n"
    "Leave `@@WT@@` in place.\n"
)
BRIEF_GEMINI_WHO = (
    "## Who you are\n\n"
    "Gemini CLI worker on `@@HOST@@`.\n"
    "- Start every final message with its handoff marker on the first line.\n"
    "- Start every hand-back turn's final message with `HANDBACK @@T@@` on its first line, with nothing\n"
    "  before it -- no status summary, heading, or prose.\n"
)
BRIEF_GEMINI_WAKEUP = (
    "When `run_command` returns a managed task,\n"
    "stop calling tools and wait for agy's reactive wakeup without polling."
)


def brief_tree(root: str) -> None:
    """A passing layout with the issue-wave skill, its shipped template and the project part."""
    fresh(root)
    skill(root, "issue-wave", "name: issue-wave", "description: Waves.")
    row_after_beta(root, row="| `issue-wave` | Waves. |")
    write(os.path.join(root, "issue-wave", "references", "notes.md"), "# Notes\n\n## Blocking on a run\n")
    write(os.path.join(root, "issue-wave", "scripts", "bg-run.sh"), "")
    write(os.path.join(root, "scripts", "run-against-base.sh"), "")
    write(os.path.join(root, "lib", "ludics", "README.md"), "# lib\n\n## Which suites drive each module\n")
    write(os.path.join(root, "lib", "ludics", "fleetworker", "waveprep.py"), "")
    template = os.path.join(root, "issue-wave", "templates", "native-claude")
    write(os.path.join(template, "who.md"), BRIEF_COMMON)
    for part in BRIEF_OWN[1:]:
        write(os.path.join(template, part), f"## {part}, for `@@WORKER@@`\n")
    for part in BRIEF_SHARED:
        body = BRIEF_AFTER_MERGE if part == "after-merge.md" else f"## {part}, in `@@WT@@`\n"
        write(os.path.join(root, "issue-wave", "templates", "shared", part), body)
    for part in ("planning-paired.md", "planning-paired+critique.md"):
        write(os.path.join(root, "issue-wave", "templates", "shared", part), BRIEF_PLANNING)
    write(os.path.join(root, ".github", "wave-brief.md"), BRIEF_PROJECT)


def gemini_brief_tree(root: str) -> str:
    brief_tree(root)
    gemini = os.path.join(root, "issue-wave", "templates", "cli-gemini")
    write(os.path.join(gemini, "who.md"), BRIEF_GEMINI_WHO)
    for part in BRIEF_OWN[1:]:
        write(os.path.join(gemini, part), f"## {part} on `@@HOST@@`\n")
    for part in ("blocking.md", "tests.md"):
        append(os.path.join(gemini, part), f"\n{BRIEF_GEMINI_WAKEUP}\n")
    return gemini


class BriefTemplateTest(Case):
    T = "issue-wave/templates/native-claude/"

    def test_a_well_formed_template_passes(self) -> None:
        brief_tree(self.root)
        self.expect("the shipped template, its references and the project part pass", 0, BRIEF_OK)
        self.expect("...and nothing else fails", 0, "0 failed")

    def test_no_prep_no_obligation(self) -> None:
        brief_tree(self.root)
        shutil.rmtree(os.path.join(self.root, "issue-wave", "templates"))
        os.remove(os.path.join(self.root, "lib", "ludics", "fleetworker", "waveprep.py"))
        result = self.expect("a root without waveprep.py owes no template", 0, "0 failed")
        self.lacks("no prep", "brief template", result)

    def test_a_cli_kind_ships_its_own_parts(self) -> None:
        brief_tree(self.root)
        for part in BRIEF_OWN:
            write(os.path.join(self.root, "issue-wave", "templates", "cli-codex", part), f"## {part} on `@@HOST@@`\n")
        self.expect("a CLI kind with its four own parts passes", 0, BRIEF_OK.replace("14 parts", "18 parts"))

    def test_native_codex_uses_the_kind_rules(self) -> None:
        brief_tree(self.root)
        template = os.path.join(self.root, "issue-wave", "templates", "native-codex")
        for part in BRIEF_OWN:
            write(os.path.join(template, part), f"## {part} on `@@HOST@@`\n")
        self.expect("native Codex ships four own parts", 0, BRIEF_OK.replace("14 parts", "18 parts"))
        append(os.path.join(template, "blocking.md"), "@@UNKNOWN@@\n")
        self.expect("native Codex placeholders are checked too", 1,
                    "@@UNKNOWN@@ is not rendered (no value for UNKNOWN)")

    def test_each_defect_is_refused(self) -> None:
        R, T, S = self.root, self.T, "issue-wave/templates/shared/"
        cases: tuple[tuple[str, Callable[[], None], str], ...] = (
            ("a missing template directory", lambda: shutil.rmtree(os.path.join(R, "issue-wave", "templates")),
             "FAIL: lib/ludics/fleetworker/waveprep.py: issue-wave/templates/ is missing"),
            ("a missing planning part", lambda: os.remove(os.path.join(R, S, "planning-paired.md")),
             f"FAIL: {S}planning-paired.md: is missing, or no regular file"),
            ("a planning part restated in a kind", lambda: write(os.path.join(R, T, "planning-paired.md"), BRIEF_PLANNING),
             f"FAIL: {T}planning-paired.md: is no part wave prep reads there (it reads who.md, tests.md, blocking.md, context.md)"),
            ("a file prep never reads", lambda: write(os.path.join(R, T, "planning-pair.md"), "x\n"),
             f"FAIL: {T}planning-pair.md: is no part wave prep reads there"),
            ("the old whole common part", lambda: write(os.path.join(R, T, "common.md"), "x\n"),
             f"FAIL: {T}common.md: is no part wave prep reads there (it reads who.md, tests.md, blocking.md, context.md)"),
            ("a directory for no kind", lambda: write(os.path.join(R, "issue-wave", "templates", "native-gpt", "who.md"), ""),
             "FAIL: issue-wave/templates/native-gpt: is no template directory: native-<kind> or cli-<kind> (kinds: claude, codex, gemini),"
             " shared, review or ab"),
            ("no native-claude", lambda: os.rename(os.path.join(R, T), os.path.join(R, "issue-wave", "templates", "native-codex")),
             "FAIL: issue-wave/templates: has no native-claude/"),
            ("no shared parts", lambda: shutil.rmtree(os.path.join(R, S)),
             "FAIL: issue-wave/templates: has no shared/: the parts every transport's brief shares"),
            ("a missing shared part", lambda: os.remove(os.path.join(R, S, "landing.md")),
             f"FAIL: {S}landing.md: is missing, or no regular file"),
            ("a kind's own part among the shared", lambda: write(os.path.join(R, S, "who.md"), "x\n"),
             f"FAIL: {S}who.md: is no part wave prep reads there (it reads where.md, startup.md,"),
            ("a shared part restated in a kind", lambda: write(os.path.join(R, T, "landing.md"), "x\n"),
             f"FAIL: {T}landing.md: is no part wave prep reads there"),
            ("a kind's missing own part", lambda: os.remove(os.path.join(R, T, "blocking.md")),
             f"FAIL: {T}blocking.md: is missing, or no regular file"),
            ("half a CLI brief", lambda: write(os.path.join(R, "issue-wave", "templates", "cli-codex", "who.md"), "## Who\n"),
             "FAIL: issue-wave/templates/cli-codex/tests.md: is missing, or no regular file"),
            ("an issue name in a common part", lambda: append(os.path.join(R, T, "who.md"), "Closes @@ISSUE@@\n"),
             f"FAIL: {T}who.md: {T}who.md:9: @@ISSUE@@ is not rendered (no value for ISSUE)"),
            ("a leg name in a shared part", lambda: append(os.path.join(R, S, "requests.md"), "@@LEG_WT@@\n"),
             f"FAIL: {S}requests.md: {S}requests.md:2: @@LEG_WT@@ is not rendered"),
            ("a name no wave file supplies", lambda: append(os.path.join(R, S, "planning-paired.md"), "@@COORD@@\n"),
             f"FAIL: {S}planning-paired.md: {S}planning-paired.md:4: @@COORD@@ is not rendered"),
            ("PROJECT in the project part", lambda: append(os.path.join(R, ".github", "wave-brief.md"), "@@PROJECT@@\n"),
             "FAIL: .github/wave-brief.md: .github/wave-brief.md:5: @@PROJECT@@ is not rendered"),
            ("a reference to no file", lambda: append(os.path.join(R, T, "who.md"), "See `issue-wave/references/gone.md`.\n"),
             f"FAIL: {T}who.md: `issue-wave/references/gone.md` names no file of this tree"),
            ("a skills path to no file", lambda: append(os.path.join(R, S, "task.md"), "Run `~/.claude/skills/ship-pr/x.sh`.\n"),
             f"FAIL: {S}task.md: `~/.claude/skills/ship-pr/x.sh` names no file of this tree"),
            ("a glob that matches nothing", lambda: append(os.path.join(R, T, "who.md"), "Run `~/ludics/scripts/nope-*.sh`.\n"),
             f"FAIL: {T}who.md: `~/ludics/scripts/nope-*.sh` names no file"),
            ("a heading the file lacks", lambda: append(os.path.join(R, T, "who.md"), "`issue-wave/references/notes.md`, *Idle*\n"),
             f"FAIL: {T}who.md: `issue-wave/references/notes.md`, *Idle*: issue-wave/references/notes.md has no heading"),
            ("a heading across a line break", lambda: write(os.path.join(R, "lib", "ludics", "README.md"), "# lib\n"),
             "*Which suites drive each module*: lib/ludics/README.md has no heading with that text"),
            ("a retired step", lambda: append(os.path.join(R, S, "planning-paired+critique.md"), "Call `set_monitor` with auto_fix off.\n"),
             f"FAIL: {S}planning-paired+critique.md: line 4 holds 'set_monitor', a retired brief step (#1078"),
            ("a retired step in the project part", lambda: append(os.path.join(R, ".github", "wave-brief.md"), "**Auto-fix off on your PR**\n"),
             "FAIL: .github/wave-brief.md: line 5 holds 'Auto-fix off', a retired brief step"),
        )
        for label, damage, want in cases:
            with self.subTest(case=label):
                brief_tree(R)
                damage()
                result = self.expect(f"{label} is refused", 1, want)
                self.lacks(label, BRIEF_OK, result)

    def test_the_review_parts_are_held_to_their_own_files_and_names(self) -> None:
        R, V = self.root, "issue-wave/templates/review/"

        def review_tree() -> None:
            brief_tree(R)
            for part, text in (("checkpoint.md", "Review @@REPO@@#@@PR@@ at @@SHA8@@ of @@WAVE@@.\n"), ("clone.md", "In a clone of @@REPO@@ (@@KIND@@).\n"),
                               ("issue.md", "For @@ISSUE@@.\n"),
                               ("source.md", "From @@SOURCE@@, see `@@BRIEF@@`.\n"), ("confirm.md", "After @@REVIEWED_SHA@@.\n"),
                               ("verdict.md", "End on the verdict (@@KIND@@).\n")):
                write(os.path.join(R, V, part), text)
            write(os.path.join(R, ".github", "review-checkpoint.md"), "## This project\n\nRead `lib/ludics/README.md` at @@MAIN@@.\n")

        review_tree()
        self.expect("the review parts and the project's review part pass", 0, BRIEF_OK.replace("14 parts", "21 parts"))
        cases: tuple[tuple[str, Callable[[], None], str], ...] = (
            ("a missing review part", lambda: os.remove(os.path.join(R, V, "confirm.md")),
             f"FAIL: {V}confirm.md: is missing, or no regular file: wave review looks this shipped part up"),
            ("a file wave review never reads", lambda: write(os.path.join(R, V, "notes.md"), "x\n"),
             f"FAIL: {V}notes.md: is no part wave review reads"),
            ("an issue name in the checkpoint part", lambda: append(os.path.join(R, V, "checkpoint.md"), "@@ISSUE@@\n"),
             f"FAIL: {V}checkpoint.md: {V}checkpoint.md:2: @@ISSUE@@ is not rendered"),
            ("a brief name in the project's review part", lambda: append(os.path.join(R, ".github", "review-checkpoint.md"), "@@WT@@\n"),
             "FAIL: .github/review-checkpoint.md: .github/review-checkpoint.md:4: @@WT@@ is not rendered"),
            ("a reference to no file", lambda: append(os.path.join(R, V, "verdict.md"), "See `issue-wave/references/gone.md`.\n"),
             f"FAIL: {V}verdict.md: `issue-wave/references/gone.md` names no file of this tree"),
        )
        for label, damage, want in cases:
            with self.subTest(case=label):
                review_tree()
                damage()
                self.expect(f"{label} is refused", 1, want)

    def test_the_ab_judge_part_is_held_to_its_own_files_and_names(self) -> None:
        R, A = self.root, "issue-wave/templates/ab/"

        def ab_tree() -> None:
            brief_tree(R)
            write(os.path.join(R, A, "judge.md"), "Judge @@PAIR@@ in @@REPO@@ at @@CHECKOUT@@ from @@DIR@@.\n")

        ab_tree()
        self.expect("the ab judge part passes", 0, BRIEF_OK.replace("14 parts", "15 parts"))
        cases: tuple[tuple[str, Callable[[], None], str], ...] = (
            ("missing judge.md", lambda: os.remove(os.path.join(R, A, "judge.md")),
             f"FAIL: {A}judge.md: is missing, or no regular file: wave ab-pairs looks this shipped part up"),
            ("an extra file in templates/ab", lambda: write(os.path.join(R, A, "extra.md"), "x\n"),
             f"FAIL: {A}extra.md: is no part wave ab-pairs reads there (it reads judge.md)"),
            ("a brief placeholder in judge.md", lambda: append(os.path.join(R, A, "judge.md"), "@@WT@@\n"),
             f"FAIL: {A}judge.md: {A}judge.md:2: @@WT@@ is not rendered"),
            ("a broken reference in judge.md", lambda: append(os.path.join(R, A, "judge.md"), "See `issue-wave/references/gone.md`.\n"),
             f"FAIL: {A}judge.md: `issue-wave/references/gone.md` names no file of this tree"),
        )
        for label, damage, want in cases:
            with self.subTest(case=label):
                ab_tree()
                damage()
                self.expect(f"{label} is refused", 1, want)

    def test_required_template_sentences_are_pinned(self) -> None:
        R = self.root
        gemini = gemini_brief_tree(R)
        self.expect("cli-gemini with its pinned hand-back rule passes (including across a line wrap)",
                    0, BRIEF_OK.replace("14 parts", "18 parts"))
        write(os.path.join(gemini, "who.md"), "## Who you are\n\nGemini CLI worker on `@@HOST@@`.\n")
        self.expect("removing the pinned hand-back rule from cli-gemini/who.md is refused", 1,
                    "FAIL: issue-wave/templates/cli-gemini/who.md: missing pinned sentence"
                    " \"Start every hand-back turn's final message with `HANDBACK @@T@@` on its first line, with nothing before it\"")
        gemini_brief_tree(R)
        write(os.path.join(R, "issue-wave", "templates", "shared", "after-merge.md"), "## After the merge\n\nLeave `@@WT@@`.\n")
        self.expect("removing the pinned hand-back rule from shared/after-merge.md is refused", 1,
                    "FAIL: issue-wave/templates/shared/after-merge.md: missing pinned sentence"
                    " 'Start your final reply with the plain line `HANDBACK @@T@@`, before any heading or prose.'")

    def test_t1357_the_first_line_rule_has_its_own_pin(self) -> None:
        gemini = gemini_brief_tree(self.root)
        sentence = "Start every final message with its handoff marker on the first line."
        write(os.path.join(gemini, "who.md"), BRIEF_GEMINI_WHO.replace(f"- {sentence}\n", ""))
        self.expect("removing only the final-message first-line rule is refused", 1,
                    "FAIL: issue-wave/templates/cli-gemini/who.md: missing pinned sentence"
                    f" '{sentence}'")

    def test_t1351_each_gemini_part_pins_the_wakeup_sentence(self) -> None:
        gemini_brief_tree(self.root)
        self.expect("wrapped wakeup sentences pass", 0, BRIEF_OK.replace("14 parts", "18 parts"))
        for part in ("blocking.md", "tests.md"):
            with self.subTest(part=part):
                gemini = gemini_brief_tree(self.root)
                write(os.path.join(gemini, part), f"## {part} on `@@HOST@@`\n")
                self.expect(f"removing only the wakeup sentence from {part} is refused", 1,
                            f"FAIL: issue-wave/templates/cli-gemini/{part}: missing pinned sentence"
                            ' "When `run_command` returns a managed task, stop calling tools and wait'
                            " for agy's reactive wakeup without polling.\" (#1351")

    def test_words_of_other_shapes_are_not_read(self) -> None:
        # The boundary: only ~/.claude/skills/, ~/ludics/ and top-level-entry words are references.
        brief_tree(self.root)
        append(os.path.join(self.root, self.T, "who.md"),
               "`/usr/bin/lockf`, `../x/y.md`, `@@WT@@/z.md`, `fleetworker/`, `nowhere/a.md`, `README.md`\n")
        self.expect("words outside the reference grammar pass unread", 0, BRIEF_OK)


# --- this checkout -------------------------------------------------------------------------------


class ThisCheckoutTest(Case):
    def test_this_checkouts_prompts_pass(self) -> None:
        self.expect("this checkout's prompts pass", 0, "0 failed", CP)


if __name__ == "__main__":
    unittest.main()

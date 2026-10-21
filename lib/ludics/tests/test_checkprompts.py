"""Unit tests for ludics.checkprompts: the readers whose edge cases the review rounds were about.

The conformance suite is test_checkprompts_cli.py, which drives the command line over scratch
trees; these pin the readers one at a time, where a regression names the function that moved.
"""

import contextlib
import io
import os
import shutil
import tempfile
import unittest

from ludics.checkprompts import __main__ as entry
from ludics.checkprompts.bytes_view import awk_records, lat, records, u
from ludics.checkprompts.cleanup import invocation_options, lex
from ludics.checkprompts.frontmatter import Refused, Resolved, frontmatter, value_of, well_formed_bytes
from ludics.checkprompts.links import heading_slugs, md_links, render_spans, resolve, slug
from ludics.checkprompts.registers import fixture_command, indexed
from ludics.checkprompts.slots import (
    BadPair,
    Count,
    DigitMention,
    NoCount,
    WordMention,
    as_number,
    awk_assigned,
    code_of,
    numerals_before,
    slot_default,
    slot_mentions,
    unquote,
    word_end,
)


class BytesViewTest(unittest.TestCase):
    def test_round_trip_keeps_bytes(self) -> None:
        self.assertEqual(u(lat("café \udcff")), "café \udcff")
        self.assertEqual(len(lat("é")), 2)  # two bytes, two characters

    def test_records_are_awks(self) -> None:
        self.assertEqual(records(""), [])
        self.assertEqual(records("a\n\n"), ["a", ""])
        self.assertEqual(records("a\nb"), ["a", "b"])

    def test_awk_records_stop_at_a_nul(self) -> None:
        self.assertEqual(awk_records("ab\0cd\ngh\0\nij"), ["ab", "gh", "ij"])


class ValueGrammarTest(unittest.TestCase):
    def test_resolved(self) -> None:
        cases = {
            '"Quoted, with a # inside." # note': "Quoted, with a # inside.",
            "'It''s quoted, with: a colon'": "It's quoted, with: a colon",
            '"a \\"q\\" and \\\\"': 'a "q" and \\',
            "Text - with - dashes # trailing": "Text - with - dashes",
            "Runs checks:quickly": "Runs checks:quickly",
            "null": "",
            "~": "",
            "# only a comment": "",
            '""': "",
        }
        for raw, want in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(value_of(raw), Resolved(want))

    def test_refused(self) -> None:
        cases = {
            '"bad \\q"': "may escape only",
            "'open": "single-quoted value must close",
            "[a, b]": "indicator '['",
            "- item": "starts with '- '",
            "Runs: x": "contains ': '",
            "Ends:": "contains ': '",
            "42": "'42' does not start with a letter",
            "Yes": "'Yes' is a boolean or null",
        }
        for raw, reason in cases.items():
            with self.subTest(raw=raw):
                match value_of(raw):
                    case Refused(got):
                        self.assertIn(reason, got)
                    case other:
                        self.fail(f"{raw!r} was accepted as {other}")

    def test_frontmatter_shape(self) -> None:
        self.assertIsNone(frontmatter("---\r\nname: a\r\n---\r\n"))
        self.assertIsNone(frontmatter("---"))
        self.assertIsNone(frontmatter("---\nname: a\n"))
        self.assertEqual(frontmatter("---\nname: a\n\n\n---\nbody"), ["name: a"])
        self.assertEqual(frontmatter("---\n---\n"), [""])

    def test_bytes(self) -> None:
        self.assertTrue(well_formed_bytes(b"---\nname: a\n---\nbody \xe2\x80\xa8 here\n"))
        self.assertFalse(well_formed_bytes(b"---\nname: a\xe2\x80\xa8\n---\n"))
        self.assertFalse(well_formed_bytes(b"---\nname: \xc2\x85\n---\n"))
        self.assertFalse(well_formed_bytes(b"a\0b"))
        self.assertFalse(well_formed_bytes(b"\xff"))


class RegistersTest(unittest.TestCase):
    def test_indexed(self) -> None:
        self.assertTrue(indexed(["| `beta` | x |"], "beta"))
        self.assertTrue(indexed(["`beta` | pipeless"], "beta"))
        self.assertFalse(indexed(["| `betas` | x |"], "beta"))
        self.assertFalse(indexed(["| `v1x2` | x |"], "v1.2"))
        self.assertFalse(indexed(["The `beta` skill."], "beta"))

    def test_fixture_command(self) -> None:
        readme = ["intro", "a/test-x.sh", "## Tests", "python3 a/test-y.py", "./a/test-z.sh", "## Next"]
        self.assertFalse(fixture_command(readme, "a/test-x.sh"))
        self.assertTrue(fixture_command(readme, "a/test-y.py"))
        self.assertTrue(fixture_command(readme, "a/test-z.sh"))
        workflow = [
            "jobs:",
            "  git-bash:",
            "    runs-on: windows-latest",
            "      - run: s/test-a.sh || exit 1",
            "  other:",
            "    runs-on: windows-latest",
            "      - run: s/test-b.sh",
        ]
        self.assertTrue(fixture_command(workflow, "s/test-a.sh", "git-bash"))
        self.assertFalse(fixture_command(workflow, "s/test-b.sh", "git-bash"))
        self.assertTrue(fixture_command(workflow, "s/test-b.sh", "windows"))


class ShellWordsTest(unittest.TestCase):
    def test_word_end(self) -> None:
        line = 'X="a b" c'
        self.assertEqual(word_end(line, 2), 7)  # through the closing quote
        self.assertEqual(word_end("X=a\\ b c", 2), 6)  # an escaped blank is in the word
        self.assertEqual(word_end("X=don't stop", 2), 7)  # an unclosed quote was not quoting

    def test_code_of_keeps_length_and_heredoc_words(self) -> None:
        for line in ["a 'b' # c", "cat <<'EOF' x", 'x "<<Y"', "a\\b"]:
            self.assertEqual(len(code_of(line)), len(line))
        # A trailing backslash blanks the character after it too, as the shell checker's did.
        self.assertEqual(code_of("ab\\"), "ab  ")
        self.assertIn("<<'EOF'", code_of("cat <<'EOF' x"))
        self.assertNotIn("<<", code_of('x "<<Y"'))

    def test_unquote(self) -> None:
        self.assertEqual(unquote("\"a b\"'c'\\ d"), "a bc d")


class SlotsTest(unittest.TestCase):
    def test_default(self) -> None:
        cases: dict[str, Count | BadPair | NoCount] = {
            'SLOTS="${X-$(f || echo mac-studio=6)}"\n': Count("6"),
            "SLOTS=mac-studio=6\nSLOTS=mac-studio=7\n": Count("7"),
            "SLOTS=mac-studio=6\nSLOTS=mac-studio=7 true\n": Count("6"),
            "SLOTS=mac-studio=6\ncat <<A <<B\nx\nA\nSLOTS=mac-studio=7\nB\n": Count("6"),
            "SLOTS=mac-studio=6\nf() {\nSLOTS=mac-studio=7\n}\n": Count("6"),
            "SLOTS=mac-studio=6\nread -r x <<<\"$S\"\nSLOTS=mac-studio=7\n": Count("7"),
            'SLOTS="a=oops mac-studio=6"\n': BadPair("a=oops"),
            'SLOTS="mac-studio=oops mac-studio=6"\n': BadPair("mac-studio=oops"),
            'SLOTS="${X-}" # old mac-studio=6\n': NoCount(),
            "SLOTS=not_mac-studio=6\n": NoCount(),
        }
        for text, want in cases.items():
            with self.subTest(text=text):
                self.assertEqual(slot_default(text), want)

    def test_numerals(self) -> None:
        def before(text: str) -> str:
            return numerals_before(text, len(text) + 1)

        self.assertEqual(before(" (twenty six"), "twenty six")
        self.assertEqual(before(" one hundred and six"), "one hundred and six")
        self.assertEqual(before(" a slot and six"), "six")
        self.assertEqual(before(" have one. six"), "six")
        self.assertEqual(before(" is done"), "")

    def test_mentions(self) -> None:
        text = (
            "Run X_SLOTS=\"t=2 mac-studio=2\" now; mac-studio=7 is not it.\n"
            "(six on\nmac-studio) and [MAC-STUDIO=06]\n"
        )
        self.assertEqual(
            slot_mentions(text),
            [
                DigitMention("7", "mac-studio=7"),
                DigitMention("06", "MAC-STUDIO=06"),
                WordMention("six"),
            ],
        )
        # A comment shaped like an assignment is prose, and held.
        self.assertEqual(slot_mentions("# was: SLOTS=mac-studio=3\n"), [DigitMention("3", "mac-studio=3")])


    def test_as_number_is_bash_arithmetic(self) -> None:
        self.assertEqual(as_number("006"), "6")
        self.assertEqual(as_number("18446744073709551622"), "6")
        self.assertEqual(as_number("18446744073709551616"), "0")
        self.assertEqual(as_number("9223372036854775808"), "-9223372036854775808")
        self.assertEqual(as_number("99999999999999999999999"), "200376420520689663")
        self.assertEqual(as_number("6oops"), "6oops")

    def test_awk_assigned_is_escape_processed(self) -> None:
        self.assertEqual(awk_assigned("/a/b/"), "/a/b/")
        self.assertEqual(awk_assigned("a\\qb\\101\\\\c\\\"d\\/e"), 'aqbA\\c"d/e')
        self.assertEqual(awk_assigned("[\\n][\\t][\\777][\\89]"), "[\n][\t][\xff][I]")
        self.assertEqual(awk_assigned("a\\0b"), "a")
        self.assertEqual(awk_assigned("a\\"), "a\\")
        self.assertIsNone(awk_assigned("a\nb"))


class CleanupTest(unittest.TestCase):
    def test_lex(self) -> None:
        lexed = lex('h.sh a "b; c" --x 2>&1 --y; gh --z')
        self.assertEqual(lexed.words, ["h.sh", "a", "b; c", "--x", "2", "--y"])
        self.assertTrue(lexed.term)
        self.assertEqual(lexed.rest, " gh --z")
        self.assertTrue(lex("h.sh --a \\").cont)

    def test_invocations(self) -> None:
        prompt = "\n".join(
            [
                "Prose post-merge-cleanup.sh --nope",
                "````bash",
                "```",
                "~/x/post-merge-cleanup.sh a --base --weird --flag \\",
                "  --cont # --commented",
                "gh pr view --json x; (post-merge-cleanup.sh --second)",
                "test-post-merge-cleanup.sh --list",
                "````",
                "post-merge-cleanup.sh --outside",
            ]
        )
        self.assertEqual(
            invocation_options(prompt, "--base "), ["--base", "--flag", "--cont", "--second"]
        )


class LinksTest(unittest.TestCase):
    def test_resolve(self) -> None:
        self.assertEqual(resolve("a/references", "../SKILL.md"), "a/SKILL.md")
        self.assertEqual(resolve("a", "../../x.md"), "../x.md")
        self.assertEqual(resolve(".", "./x.md"), "x.md")

    def test_md_links(self) -> None:
        text = (
            "Token ]( prose [g](gone.md).) [t](x.md \"T\") [n](a_(b).md#h) \\[e](e.md)"
            " [u](https://x/y.md) [p](my%20n.md)\n"
        )
        got = [(link.target, link.resolved, link.anchor) for link in md_links("s/S.md", "s", text)]
        self.assertEqual(got, [("gone.md", "s/gone.md", ""), ("a_(b).md#h", "s/a_(b).md", "h")])

    def test_slug(self) -> None:
        cases: dict[str, str | None] = {
            "Supervision, recovery and evidence": "supervision-recovery-and-evidence",
            lat("Close — out"): "close--out",
            "` padded `": "padded",
            "` foo`": "-foo",
            "`_lit_` and ` padded `": "_lit_-and-padded",
            "FLEET_BOX_CORRECTNESS_SLOTS": "fleet_box_correctness_slots",
            "Foo\tBar": "foobar",
            "Use <Type": "use-type",
            "Rock &bogus; Roll": "rock-bogus-roll",
            "Token ](literal)": "token-literal",
            "_Foo_": None,
            "[Foo](https://x)": None,
            "<em>Foo</em>": None,
            "A &amp; B": None,
            "\\`_foo_\\`": None,
            lat("Café"): None,
        }
        for heading, want in cases.items():
            with self.subTest(heading=heading):
                self.assertEqual(slug(heading), want)

    def test_render_spans_is_one_walk(self) -> None:
        self.assertEqual(render_spans("`\\`_foo_`"), ("\\_foo_`", "._foo_`"))

    def test_heading_numbering(self) -> None:
        text = "## Notes\n## Notes-1\n## Notes\n## !!!\n## !!!\n> ## Quoted\n    > ## Code\n#tag\n####### seven\n"
        slugs = heading_slugs("\xef\xbb\xbf# Marked\r\n" + text)
        self.assertEqual(slugs.anchors, {"marked", "notes", "notes-1", "notes-2", "-1", "quoted"})
        self.assertFalse(slugs.unspelled)
        self.assertTrue(heading_slugs("## [F](x)\n## F\n").unspelled)


class EntryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="ludics-checkprompts."))

    def tearDown(self) -> None:
        shutil.rmtree(self.root)

    def write(self, rel: str, text: str) -> None:
        path = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)

    def run_checker(self, *argv: str) -> tuple[int, str]:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = entry.run(list(argv))
        return rc, out.getvalue()

    def test_a_well_formed_tree_passes_and_a_blank_in_a_name_is_one_directory(self) -> None:
        self.write("a b/SKILL.md", "---\nname: a b\ndescription: Spaced.\n---\n")
        self.write("README.md", "| `a b` | x |\n")
        self.write("routines/README.md", "")
        rc, out = self.run_checker(self.root)
        self.assertEqual(rc, 0, out)
        self.assertIn("ok: a b/SKILL.md: frontmatter names 'a b'", out)
        self.assertTrue(out.endswith("\ncheck-prompts: 3 passed, 0 failed\n"), out)

    def test_one_mode(self) -> None:
        self.write("task/SKILL.md", "---\nname: other\ndescription: Installed.\n---\n")
        rc, out = self.run_checker("--one", os.path.join(self.root, "task") + "/")
        self.assertEqual((rc, out.splitlines()[-1]), (0, "check-prompts: 1 passed, 0 failed"))


if __name__ == "__main__":
    unittest.main()

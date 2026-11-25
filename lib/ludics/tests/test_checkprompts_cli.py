"""The conformance suite of scripts/check-prompts.sh: its command line, run over scratch trees.

Every case runs the checker the way the skills, CI and the preflight run it -- the shell entry
point, as a subprocess, against a scratch tree -- and asserts its exit status and a substring of its
output. A well-formed layout passes, and each defect the checker exists for is refused with the
message that names it, with a passing tree as the control, since a scan that cannot fail would prove
nothing (ludics-lite#55). It ends by running the checker on this checkout, which is the same verdict
CI's prompt hygiene step reads. test_checkprompts.py pins the readers one function at a time; this
file never calls into them.

Ported from scripts/test-check-prompts.sh (ludics-lite#403), case for case: a case's label is the
shell suite's, so a failure names the probe it was there. What the port changed:
- A mutation that matches nothing RAISES (``FixtureMissed``, a failure of the case that asked for
  it), and so does one that leaves the file as it was. The shell helpers each carried that guard by
  hand, and nothing probed the guards (ludics-lite#107); here they are one mechanism, and
  ``MutationGuardTest`` probes it.
- A passing scratch tree is asserted with a verdict DERIVED from the tree (``clean``), not a typed
  "6 passed" (ludics-lite#96).
- The slot probes rewrite the count word wherever the checker reads it, the word standing before
  ``on mac-studio``, rather than a parenthesized phrase the prose happens to use (ludics-lite#263).

Part 1 of the split CLI conformance suite (core layout, frontmatter, indexes, fixture register,
slots, roster, reading list, drift guard, and cleanup options); links, shell readings, verdict
reads, suite map, brief template, and the live checkout live in test_checkprompts_cli_checks.py
so each module sits well under LUDICS_TEST_WATCHDOG (#1336).

Run it with ``scripts/py -m unittest ludics.tests.test_checkprompts_cli`` (CI's `prompts` and
macOS jobs do, and the preflight's prompt-fixtures guard); ``unittest discover`` reaches it too.
"""


import functools
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from collections.abc import Callable
from dataclasses import dataclass

from ludics.tests.checkprompts_cli_harness import (
    BASH,
    CP,
    ENV,
    FIXTURE_SUITES,
    GIT_BASH,
    LINK_TARGETS,
    MACOS_WEEKLY,
    NO_NAMES,
    SKILL_SCRIPTS,
    SRC,
    WINDOWS,
    WORKER,
    WORKFLOW_OF,
    Case,
    FixtureMissed,
    append,
    beta_row,
    clean,
    copy_prompts,
    delete_lines,
    drift,
    drift_tree,
    edit_line,
    fixture_tree,
    fresh,
    map_lines,
    nul_edit,
    read,
    rewrite,
    row_after_beta,
    run,
    scratch,
    setUpModule,
    skill,
    slots,
    slots_tree,
    src_lines,
    tearDownModule,
    write,
)

__all__ = ["setUpModule", "tearDownModule"]

class MutationGuardTest(unittest.TestCase):
    """The guard every mutation stands behind, probed (ludics-lite#107): a mutation that matched
    nothing, or changed nothing, fails the case that asked for it instead of handing it a tree the
    case then asserts a verdict over."""

    def setUp(self) -> None:
        self.root = os.path.join(tempfile.mkdtemp(dir=scratch[0]), "tree")
        fresh(self.root)

    def test_a_pattern_that_matches_nothing_raises(self) -> None:
        with self.assertRaisesRegex(FixtureMissed, "matched nothing"):
            rewrite(self.root, "README.md", pattern=r"^\| `gamma` \|", repl="x")
        with self.assertRaises(FixtureMissed):
            rewrite(self.root, "routines/README.md", pattern=r"^\| `beta` \| The second\. \|$", repl="x")

    def test_a_replacement_that_changes_nothing_raises(self) -> None:
        with self.assertRaisesRegex(FixtureMissed, "changed nothing"):
            rewrite(self.root, "README.md", pattern="beta", repl="beta")

    def test_the_line_helpers_raise_too(self) -> None:
        with self.assertRaises(FixtureMissed):
            edit_line(self.root, "README.md", at=1, pattern="nothing here", repl="x")
        with self.assertRaises(FixtureMissed):
            delete_lines(self.root, "README.md", pattern="^nothing here$")
        with self.assertRaises(FixtureMissed):
            nul_edit(self.root, "README.md", containing="nothing here", where="prefix")

    def test_the_readme_helpers_raise_when_the_beta_row_is_gone(self) -> None:
        rewrite(self.root, "README.md", pattern="`beta`", repl="`gamma`")
        with self.assertRaises(FixtureMissed):
            row_after_beta(self.root, row="| `x` | y |")
        with self.assertRaises(FixtureMissed):
            beta_row(self.root, row="| `x` | y |")

    def test_a_raised_guard_fails_the_case(self) -> None:
        # Run apart from this suite's own result, so the deliberate trip is counted only here.
        root = self.root

        class Probe(unittest.TestCase):
            def test_probe(self) -> None:
                rewrite(root, "README.md", pattern="^nothing here$", repl="x")

        result = unittest.TestResult()
        Probe("test_probe").run(result)
        self.assertEqual((len(result.failures), len(result.errors)), (1, 0))


# --- the command line --------------------------------------------------------------------------


class CommandLineTest(Case):
    def test_a_well_formed_tree_passes(self) -> None:
        fresh(self.root)
        self.expect("a well-formed tree passes", 0, clean(self.root))

    def test_a_missing_root_is_refused(self) -> None:
        self.expect(
            "a missing root is refused, not passed", 2, "no such directory", CP, os.path.join(self.base, "nowhere")
        )

    def test_a_root_with_no_prompt(self) -> None:
        # A root carrying no prompt at all is a verdict, not a pass over nothing.
        empty = os.path.join(self.base, "empty")
        os.makedirs(empty)
        self.expect(
            "a root with no prompt at all is refused, not passed",
            1,
            f"FAIL: .: no */SKILL.md or routines/*/SKILL.md under {empty}",
            CP,
            empty,
        )

    def test_help_and_unknown_options(self) -> None:
        self.expect(
            "--help prints the usage and succeeds", 0, "usage: check-prompts.sh [root] | --one <dir>", CP, "--help"
        )
        self.expect("an unknown option is a usage error", 2, "check-prompts: unknown option: --bogus", CP, "--bogus")

    # Single-directory mode shares the grammar but has no repository layout requirements.
    def test_one(self) -> None:
        fresh(self.root)
        R = self.root
        self.expect("one prompt needs no README", 0, "1 passed, 0 failed", CP, "--one", f"{R}/alpha")
        os.rename(f"{R}/alpha", f"{R}/installed task")
        self.expect(
            "installed IDs may differ from prompt names, including paths with spaces",
            0,
            "1 passed, 0 failed",
            CP,
            "--one",
            f"{R}/installed task/",
        )
        self.expect("missing single prompt", 1, "missing regular SKILL.md", CP, "--one", f"{R}/scripts")
        self.expect("one requires a directory argument", 2, "usage:", CP, "--one")
        self.expect("one rejects extra arguments", 2, "usage:", CP, "--one", R, "extra")
        self.expect("root rejects extra arguments", 2, "usage:", CP, R, "extra")

    def test_one_shares_the_grammar(self) -> None:
        for field in ("description: null", "description: [", "allowed-tools: ["):
            with self.subTest(field=field):
                fresh(self.root)
                skill(self.root, "alpha", "name: alpha", "description: valid", field)
                self.expect(
                    f"one refuses {field} with the shared grammar",
                    1,
                    "FAIL: SKILL.md:",
                    CP,
                    "--one",
                    f"{self.root}/alpha",
                )
        fresh(self.root)
        skill(self.root, "alpha", "name: alpha", "description: valid")
        append(f"{self.root}/alpha/SKILL.md", b"\0")
        self.expect("one retains byte validation", 1, "NUL or invalid UTF-8", CP, "--one", f"{self.root}/alpha")


# --- frontmatter defects -----------------------------------------------------------------------


class FrontmatterTest(Case):
    def test_fences(self) -> None:
        R = self.root
        fresh(R)
        path = f"{R}/alpha/SKILL.md"
        write(path, read(path).split("\n", 1)[1])  # the first line, dropped unconditionally
        self.expect("no opening fence", 1, "alpha/SKILL.md: no YAML frontmatter")
        fresh(R)
        write(f"{R}/beta/SKILL.md", "---\nname: beta\ndescription: unclosed\n\n# beta\n")
        self.expect("no closing fence", 1, "beta/SKILL.md: no YAML frontmatter")
        # The opening fence is the line `---` exactly: a CRLF line end or a trailing blank is not it.
        fresh(R)
        write(f"{R}/alpha/SKILL.md", "---\r\nname: alpha\r\ndescription: CRLF throughout\r\n---\r\n")
        self.expect("a CRLF opening fence is no fence", 1, "alpha/SKILL.md: no YAML frontmatter")
        fresh(R)
        write(f"{R}/alpha/SKILL.md", "--- \nname: alpha\ndescription: a blank after the fence\n---\n")
        self.expect("...nor is one with a trailing blank", 1, "alpha/SKILL.md: no YAML frontmatter")

    def test_required_keys(self) -> None:
        R = self.root
        fresh(R)
        skill(R, "alpha", "description: nameless")
        self.expect("missing name", 1, "alpha/SKILL.md: frontmatter has no 'name:' line")
        fresh(R)
        skill(f"{R}/routines", "weekly", "name: weekly", "description:")
        self.expect("empty description", 1, "weekly/SKILL.md: frontmatter 'description:' has no value")
        fresh(R)
        skill(R, "beta", "name: beta", "name: beta", "description: twice named")
        self.expect("duplicate name", 1, "beta/SKILL.md: frontmatter has 2 'name:' lines")
        # Declarations are counted as keys, not as non-empty values: a blank `name:` beside a
        # populated one is two declarations, and neither the blank one nor the mismatch it could
        # hide gets through.
        fresh(R)
        skill(R, "beta", "name:", "name: alpha", "description: blank beside populated")
        self.expect("a blank duplicate key still counts", 1, "beta/SKILL.md: frontmatter has 2 'name:' lines")

    # Values resolve the way YAML resolves a one-line scalar: the quoted, null and comment-only
    # spellings of empty are empty, and quotes and a trailing comment around real text are not text.
    def test_empty_spellings(self) -> None:
        empties = (
            'description: ""',
            "description: ''",
            "description: null",
            "description: ~",
            "description: # only a comment",
            "description:    ",
        )
        for empty in empties:
            with self.subTest(empty=empty):
                fresh(self.root)
                skill(self.root, "alpha", "name: alpha", empty)
                self.expect(f"'{empty}' is empty", 1, "alpha/SKILL.md: frontmatter 'description:' has no value")

    def test_quoted_values(self) -> None:
        R = self.root
        fresh(R)
        skill(R, "alpha", "name: 'alpha'", 'description: "Quoted, with a # inside." # and a trailing note')
        self.expect("quoted and commented values resolve to their text", 0, clean(R))
        fresh(R)
        skill(R, "alpha", 'name: "beta"', "description: quoted mismatch")
        self.expect(
            "...so a quoted name is still compared to the directory",
            1,
            "name 'beta' does not match its directory 'alpha'",
        )

    # The value grammar is a subset of YAML: whatever it accepts a loader reads as the same string,
    # and whatever a loader might read otherwise -- or reject -- is refused, with the reason. One
    # probe per refusal reason, then the plain-text shapes that must stay accepted.
    REFUSED = (
        ('"unterminated', "a double-quoted value must close"),
        ('"closed" then more', "a double-quoted value must close"),
        ("'unterminated", "a single-quoted value must close"),
        ("'closed' then more", "a single-quoted value must close"),
        ("[]", "starts with the YAML indicator '['"),
        ("{}", "starts with the YAML indicator '{'"),
        ("[a, b]", "starts with the YAML indicator '['"),
        ("&anchor text", "starts with the YAML indicator '&'"),
        ("*alias", "starts with the YAML indicator '*'"),
        ("!!str text", "starts with the YAML indicator '!'"),
        ("`backticked`", "starts with the YAML indicator '`'"),
        ("- a list item", "starts with '- '"),
        ("? a key", "starts with '? '"),
        (": a value", "starts with ': '"),
        ("Runs checks: quickly", "contains ': ' or ends with ':'"),
        ("Ends with a colon:", "contains ': ' or ends with ':'"),
        ("42", "'42' does not start with a letter"),
        ("1e3", "'1e3' does not start with a letter"),
        (".inf", "'.inf' does not start with a letter"),
        ("2001-12-15", "'2001-12-15' does not start with a letter"),
        ("0b1010", "'0b1010' does not start with a letter"),
        ("12:34", "'12:34' does not start with a letter"),
        ("+1_000", "'+1_000' does not start with a letter"),
        ("<< merge", "'<< merge' does not start with a letter"),
        (
            "-x is plain to YAML but outside the grammar",
            "'-x is plain to YAML but outside the grammar' does not start with a letter",
        ),
        ("true", "'true' is a boolean or null"),
        ("Yes", "'Yes' is a boolean or null"),
        ("n", "'n' is a boolean or null"),
    )
    ACCEPTED = (
        "Runs checks:quickly, no space after the colon",
        "v1.2 of 3 things, 100% plain",
        "Text - with - dashes and a trailing note # here",
        "Nothing is 2001-12-15 once a letter leads",
        '"Runs checks: quickly, quoted"',
        "'It''s quoted, with: a colon'",
        "Yes it is text, not a boolean",
        '"2001-12-15, quoted, is text"',
    )

    def test_the_value_grammar(self) -> None:
        for value, reason in self.REFUSED:
            with self.subTest(value=value):
                fresh(self.root)
                skill(self.root, "alpha", "name: alpha", f"description: {value}")
                self.expect(
                    f"'description: {value}' is refused ({reason})",
                    1,
                    f"outside the grammar this check accepts: '{value}' ({reason}",
                )
        for value in self.ACCEPTED:
            with self.subTest(value=value):
                fresh(self.root)
                skill(self.root, "alpha", "name: alpha", f"description: {value}")
                self.expect(f"'description: {value}' is accepted", 0, clean(self.root))

    def test_name_must_match_the_directory(self) -> None:
        fresh(self.root)
        skill(self.root, "alpha", "name: alpah", "description: misspelt")
        self.expect("name must match the directory", 1, "name 'alpah' does not match its directory 'alpha'")

    # A block scalar is refused by its header, whatever indicators or comment follow the `|`/`>`;
    # and its body, like any continued, nested or listed value, is refused as a non-key line, so a
    # value cannot span lines whichever way it is spelled.
    def test_one_line_values(self) -> None:
        R = self.root
        for header in ("description: |", "description: |2-", "description: >+", "description: > # folded"):
            with self.subTest(header=header):
                fresh(R)
                skill(R, "alpha", "name: alpha", header)
                self.expect(f"block scalar header '{header}'", 1, "description is a block scalar")
        fresh(R)
        skill(R, "alpha", "name: alpha", "description: |", "  A block scalar body.")
        self.expect("a block scalar body is a non-key line", 1, "not a top-level 'key: value'")
        fresh(R)
        skill(R, "alpha", "name: alpha", "description: The first line", "  continued on a second.")
        self.expect("a plain scalar continued on the next line", 1, "not a top-level 'key: value'")
        fresh(R)
        skill(R, "alpha", "name: alpha", "description: listed", "allowed-tools:", "  - Bash")
        self.expect("a nested list", 1, "not a top-level 'key: value'")
        fresh(R)
        skill(R, "alpha", "name: alpha", "description: commented", "# a comment line", "", "model: sonnet")
        self.expect("blank and comment lines between keys are fine", 0, clean(R))

    # Double-quoted values admit only `\"` and `\\`: a backslash a loader would reject (`\q`) and one
    # it would turn into a second line (`\n`) are refused alike, and the two admitted ones decode.
    def test_escapes(self) -> None:
        R = self.root
        fresh(R)
        skill(R, "alpha", "name: alpha", r'description: "bad \q escape"')
        self.expect("an escape YAML rejects", 1, r"may escape only \" and \\")
        fresh(R)
        skill(R, "alpha", "name: alpha", r'description: "first\nsecond"')
        self.expect("an escape that would make a second line", 1, r"may escape only \" and \\")
        fresh(R)
        skill(R, "alpha", r'name: "al\"pha"', r'description: "a \"quoted\" word and a \\ backslash"')
        self.expect(
            "the admitted escapes decode before the directory comparison",
            1,
            "name 'al\"pha' does not match its directory 'alpha'",
        )
        fresh(R)
        skill(R, "alpha", "name: alpha", r'description: "a \"quoted\" word and a \\ backslash"')
        self.expect("...and pass where the text is fine", 0, clean(R))

    # A control character anywhere in the frontmatter is refused whole: the tab YAML reads as a
    # separator after `:`, and the carriage return a loader would fold into the value.
    def test_control_characters(self) -> None:
        R = self.root
        fresh(R)
        skill(R, "alpha", "name: alpha", "description: Runs:\tquickly")
        self.expect("a tab in a value", 1, "frontmatter carries a control character")
        fresh(R)
        skill(R, "alpha", "name: alpha", "description: CRLF line\r")
        self.expect("a carriage return", 1, "frontmatter carries a control character")
        # ...found however large the frontmatter.
        fresh(R)
        write(
            f"{R}/alpha/SKILL.md",
            "---\nname: alpha\n# an early tab\there\n" + "# filler\n" * 20000 + "description: late\n---\n",
        )
        self.expect("a tab early in a large frontmatter", 1, "frontmatter carries a control character")

    # A NUL byte never reached a shell variable, and invalid UTF-8 is a loader error: both are
    # refused on the raw file, first.
    def test_bytes(self) -> None:
        R = self.root
        cases = (
            ("a NUL byte", b"---\nname: alpha\ndescription: a NUL \0 inside\n---\n"),
            ("invalid UTF-8", b"---\nname: alpha\ndescription: bad \xff byte\n---\n"),
            # ...and the characters YAML's printable set excludes, by the spec's definition: the C1
            # controls and the two non-characters. Everything else valid UTF-8 encodes is content.
            ("a C1 control (U+0085)", b"---\nname: alpha\ndescription: a C1 control \xc2\x85 inside\n---\n"),
            ("U+FFFE", b"---\nname: alpha\ndescription: a\xef\xbf\xbe non-character\n---\n"),
            (
                "U+2028, a line break to YAML 1.1",
                b"---\nname: alpha\ndescription: a\xe2\x80\xa8b, split by a line separator\n---\n",
            ),
            # ...and read to the end: an early forbidden character in a large frontmatter is found.
            (
                "U+FFFE early in a large frontmatter",
                b"---\nname: alpha\ndescription: a\xef\xbf\xbe early non-character\n" + b"# filler\n" * 5000 + b"---\n",
            ),
        )
        for label, data in cases:
            with self.subTest(label):
                fresh(R)
                write(f"{R}/alpha/SKILL.md", data)
                self.expect(label, 1, "a byte sequence no loader accepts")
        fresh(R)
        write(
            f"{R}/alpha/SKILL.md",
            b"---\nname: alpha\ndescription: fine\n---\n\nA body line\xe2\x80\xa8split by a separator, which is not YAML.\n",
        )
        self.expect("...but only in the frontmatter: the Markdown body is not YAML", 0, clean(R))
        fresh(R)
        write(
            f"{R}/alpha/SKILL.md",
            b"---\nname: alpha\ndescription: fine \xc3\xbcber text \xe2\x80\x94 with a dash\n---\n",
        )
        self.expect("...while valid UTF-8 content passes", 0, clean(R))
        # A Unicode space is content, not whitespace, to YAML and to this check: appended to a name
        # it stays in the name, which then does not match its directory.
        fresh(R)
        write(f"{R}/alpha/SKILL.md", b"---\nname: alpha\xe2\x80\x82\ndescription: en space after the name\n---\n")
        self.expect("a Unicode space is kept in the name", 1, "does not match its directory 'alpha'")

    # Optional keys are held to the same grammar: a loader rejects the whole file on any of them.
    def test_optional_keys(self) -> None:
        R = self.root
        fresh(R)
        skill(R, "alpha", "name: alpha", "description: fine", "allowed-tools: [")
        self.expect("a malformed optional key", 1, "frontmatter 'allowed-tools:' value is outside the grammar")
        fresh(R)
        skill(R, "alpha", "name: alpha", "description: fine", "model:")
        self.expect("an empty optional key", 1, "frontmatter 'model:' has no value")
        fresh(R)
        skill(R, "alpha", "name: alpha", "description: fine", "model: sonnet", "model: opus")
        self.expect("a duplicated optional key", 1, "frontmatter has 2 'model:' lines")


# --- index lookup defects ----------------------------------------------------------------------
# The claim is one lookup per directory: the README that indexes it carries a row whose first cell
# is that directory's name in backticks. Every probe below is at that granularity -- the
# table-syntax probes went with the scanner they exercised (ludics-lite#75).


class IndexTest(Case):
    def test_unindexed_directories(self) -> None:
        R = self.root
        fresh(R)
        skill(R, "gamma", "name: gamma", "description: Unindexed.")
        self.expect("a skill missing from the README", 1, "skill 'gamma' is not indexed")
        fresh(R)
        skill(f"{R}/routines", "monthly", "name: monthly", "description: Unindexed.")
        self.expect("a routine missing from routines/README.md", 1, "routine 'monthly' is not indexed")

    # A row is a row by its FIRST cell, and the name is backticked there: the three ways a README can
    # name a directory and still not index it each fail.
    def test_what_a_row_is(self) -> None:
        rows = (
            ("a row naming the skill without backticks", "| beta | The second, unbackticked. |"),
            (
                "the name backticked in a later cell is not the first cell",
                "| `other` | Backticked in a later cell: `beta`. |",
            ),
            ("a backticked mention that is not a row", "The `beta` skill, described in prose instead of indexed."),
            # The name is matched as text and in full: a longer name containing it is a different
            # directory.
            (
                "a row naming a longer name does not index the directory",
                "| `betas` | A longer name that contains this one. |",
            ),
        )
        for label, row in rows:
            with self.subTest(label):
                fresh(self.root)
                beta_row(self.root, row=row)
                self.expect(label, 1, "skill 'beta' is not indexed")
        # GFM renders a body row without its leading pipe, so one counts here too.
        fresh(self.root)
        beta_row(self.root, row="`beta` | The second, pipeless.")
        self.expect("a pipeless row is a row", 0, clean(self.root))

    # ...and a regex metacharacter in a name is that character.
    def test_a_dot_is_a_dot(self) -> None:
        R = self.root
        fresh(R)
        skill(R, "v1.2", "name: v1.2", "description: A dotted name.")
        row_after_beta(R, row="| `v1x2` | A row the dot must not match. |")
        self.expect("a '.' in a directory name is not a wildcard", 1, "skill 'v1.2' is not indexed")
        fresh(R)
        skill(R, "v1.2", "name: v1.2", "description: A dotted name.")
        row_after_beta(R, row="| `v1.2` | A dotted name, indexed exactly. |")
        self.expect("...while the exact dotted name indexes it", 0, clean(R))

    # A backslash in a name is a backslash, not escape-processed on the way in. Both directions are
    # pinned: an escape-processing lookup would refuse the exactly-indexed name and accept the
    # decoded spelling of a different one.
    @unittest.skipIf(WINDOWS, NO_NAMES)
    def test_a_backslash_is_a_backslash(self) -> None:
        R = self.root
        fresh(R)
        skill(R, r"a\n", r'name: "a\\n"', "description: A literal backslash in the name.")
        append(f"{R}/README.md", "| `a\\n` | A name carrying a backslash. |\n")
        self.expect("a backslash in a directory name is matched literally", 0, clean(R))
        fresh(R)
        skill(R, r"a\tb", r'name: "a\\tb"', "description: A backslash-t in the name.")
        append(f"{R}/README.md", "| `a\tb` | The decoded spelling, which names something else. |\n")
        self.expect("...and what that backslash would decode to is a different name", 1, r"skill 'a\tb' is not indexed")

    def test_index_files(self) -> None:
        R = self.root
        fresh(R)
        os.remove(f"{R}/routines/README.md")
        self.expect("a missing index file", 1, "routines/README.md: missing")
        # With nothing to look up, the README is not thereby judged: the line says so rather than
        # reading as a check that passed.
        fresh(R)
        shutil.rmtree(f"{R}/routines/nightly")
        shutil.rmtree(f"{R}/routines/weekly")
        self.expect(
            "no directories to index says so, instead of passing silently",
            0,
            "no routines/ SKILL.md directory to index",
        )

    # The boundary of the shrunken claim, pinned from the other side so that what the lookup gave up
    # is a decision on record rather than a hole nobody meant (ludics-lite#75). It models no table,
    # so it reads neither a row that outlived its directory nor whether the row renders at all.
    def test_the_lookups_boundary(self) -> None:
        R = self.root
        fresh(R)
        shutil.rmtree(f"{R}/beta")
        self.expect("a row that outlives its directory is no longer read", 0, clean(R))
        fresh(R)
        write(f"{R}/README.md", "```\n" + read(f"{R}/README.md") + "```\n")
        self.expect("...and a fenced README still satisfies the lookup", 0, clean(R))

    def test_every_defect_is_reported(self) -> None:
        # Two defects in one run are both reported: the per-file loop does not stop at the first.
        R = self.root
        fresh(R)
        skill(R, "alpha", "description: nameless")
        skill(f"{R}/routines", "weekly", "name: weekly")
        result = run(CP, R)
        self.check(
            "every defective file is reported, not only the first",
            1,
            result,
            "alpha/SKILL.md: frontmatter has no 'name:' line",
            "weekly/SKILL.md: frontmatter has no 'description:' line",
        )

    def test_annotations(self) -> None:
        # Under Actions each failure is also an annotation on the file.
        R = self.root
        fresh(R)
        skill(R, "alpha", "name: alpah", "description: x")
        self.expect(
            "GitHub annotations name the file", 1, "::error file=alpha/SKILL.md::", env={"GITHUB_ACTIONS": "true"}
        )
        # The bare run reads the suite-wide removal of GITHUB_ACTIONS (ENV).
        self.lacks("...and only under Actions", "::error", run(CP, R))



def unregister(root: str, *, suite: str) -> None:
    """Takes the suite's command out of the README's register, keeping prose and a longer filename
    in its place: neither substitutes for a registered command."""
    map_lines(root, "README.md", edit=lambda line: [f"Mention: {line}", f"{line}.extra"] if suite in line else None)


def unrun(root: str, *, workflow: str, platform: str, suite: str) -> None:
    """Takes the suite's run line out of the jobs on ``platform`` (a runner, less ``-latest``; the
    job keyed git-bash is ``git-bash``), leaving a comment, a name, an echo and a longer filename."""
    job = os_ = ""

    def edit(line: str) -> list[str] | None:
        nonlocal job, os_
        if re.match(r"  [A-Za-z0-9_-]+:", line):
            job = line.split()[0].removesuffix(":")
        if "runs-on:" in line:
            os_ = line.split()[1].removesuffix("-latest")
            if job == "git-bash":
                os_ = "git-bash"
        if os_ == platform and suite in line:
            return [
                f"      # run: {suite}",
                f"      - name: {suite}",
                f"      - run: echo {suite}",
                f"      - run: {suite}.extra",
            ]
        return None

    map_lines(root, workflow, edit=edit)


class FixtureRegisterTest(Case):
    def test_the_register_passes(self) -> None:
        fixture_tree(self.root)
        self.expect("shell, Python, hook and platform-specific register passes", 0, "required CI platforms agree")

    def test_each_suite_owes_a_readme_line(self) -> None:
        for suite in (s for s in FIXTURE_SUITES if s != "ship-pr/scripts/test-pr-review-hostile.py"):
            with self.subTest(suite=suite):
                fixture_tree(self.root)
                unregister(self.root, suite=suite)
                self.expect(f"README refuses missing {suite} command", 1, f"fixture '{suite}' has no command line")

    # ship-pr's shell suites owe a Git Bash leg on Windows as well (ludics-lite#318); the other
    # shell suites do not, which the passing tree above already shows for alpha/scripts/test-shell.sh.
    def test_each_suite_owes_its_platforms(self) -> None:
        for platform in ("ubuntu", "macos", "git-bash"):
            suites = ["ship-pr/scripts/test-shell.sh"]
            if platform != "git-bash":
                suites = [
                    "alpha/scripts/test-shell.sh",
                    "alpha/scripts/test-python.py",
                    "alpha/hooks/test-hook.py",
                    *suites,
                ]
            workflow = WORKFLOW_OF[platform]
            for suite in suites:
                with self.subTest(platform=platform, suite=suite):
                    fixture_tree(self.root)
                    unrun(self.root, workflow=workflow, platform=platform, suite=suite)
                    self.expect(
                        f"{platform} refuses missing {suite} execution",
                        1,
                        f"fixture '{suite}' has no inline run command on {platform}",
                    )

    # The Git Bash leg is windows-git-bash.yml's git-bash JOB, not any Windows runner: the same run
    # line moved into the PowerShell windows-driver job shares the runner and is still refused (PR
    # #321, review round 2), and so is a job keyed git-bash that runs somewhere other than Windows,
    # or one back in skill-scripts.yml, the per-push file it moved out of (ludics-lite#339).
    def test_the_git_bash_leg_is_a_job(self) -> None:
        R = self.root
        want = "fixture 'ship-pr/scripts/test-shell.sh' has no inline run command on git-bash"
        fixture_tree(R)
        write(f"{R}/{GIT_BASH}", "")
        rewrite(
            R,
            SKILL_SCRIPTS,
            pattern=r"^(      - run: \./issue-wave/scripts/test-windows-driver\.ps1)$",
            repl=r"\1" + "\n      - run: ship-pr/scripts/test-shell.sh",
        )
        self.expect("a ship-pr suite run by another Windows job is no Git Bash leg", 1, want)
        fixture_tree(R)
        rewrite(R, GIT_BASH, pattern=r"windows-latest", repl="ubuntu-latest")
        self.expect("...nor is a job keyed git-bash on another runner", 1, want)
        fixture_tree(R)
        append(f"{R}/{SKILL_SCRIPTS}", read(f"{R}/{GIT_BASH}").split("\n", 1)[1])
        os.remove(f"{R}/{GIT_BASH}")
        self.expect("...nor is the git-bash job back in skill-scripts.yml", 1, f"windows-git-bash.yml: {want}")

    # The macOS leg is macos-weekly.yml's, not any macOS runner's: since ludics#974 the macOS
    # suites run weekly, and a macOS job back in skill-scripts.yml, the per-push file they moved out
    # of, does not satisfy the register.
    def test_the_macos_leg_is_the_weekly_workflow(self) -> None:
        R = self.root
        fixture_tree(R)
        append(f"{R}/{SKILL_SCRIPTS}", read(f"{R}/{MACOS_WEEKLY}").split("\n", 1)[1])
        os.remove(f"{R}/{MACOS_WEEKLY}")
        self.expect(
            "a macOS job back in skill-scripts.yml is no macOS leg",
            1,
            "macos-weekly.yml: fixture 'alpha/scripts/test-shell.sh' has no inline run command on macos",
        )

    def test_platform_specific_suites(self) -> None:
        for suite in (
            "scripts/test-workflow-reporters.py",
            "ship-pr/scripts/test-pr-review-hostile.py",
            "issue-wave/scripts/test-windows-driver.ps1",
        ):
            with self.subTest(suite=suite):
                fixture_tree(self.root)
                delete_lines(self.root, SKILL_SCRIPTS, pattern=re.escape(suite))
                self.expect(
                    f"platform-specific {suite} still requires its CI command",
                    1,
                    f"fixture '{suite}' has no inline run command",
                )

    def test_the_registers_reach(self) -> None:
        R = self.root
        fixture_tree(R)
        os.remove(f"{R}/{SKILL_SCRIPTS}")
        self.expect("fixtures require a workflow", 1, "no inline run command on ubuntu")
        fixture_tree(R)
        os.remove(f"{R}/alpha/scripts/test-python.py")
        # The lookup is one-way, as the prompt register is: stale commands require no table model.
        self.expect("a removed fixture leaves no membership obligation", 0, "0 failed")
        # A suite is a .sh, .py or .ps1 file: another `test-*` file is data, and owes no register line.
        fixture_tree(R)
        write(f"{R}/alpha/scripts/test-data.json", "")
        self.expect("a test-* file that is not a suite carries no obligation", 0, "required CI platforms agree")
        # The README's register is its `## Tests` section: the same command line under another
        # heading registers nothing.
        fixture_tree(R)
        rewrite(R, "README.md", pattern=r"^## Tests$", repl="## Notes")
        self.expect(
            "a command line outside the README's Tests section is not in the register",
            1,
            "fixture 'alpha/scripts/test-shell.sh' has no command line",
        )


# --- the real files ------------------------------------------------------------------------------
# The slot, drift, cleanup and real-link probes copy this checkout's own files, for the reason each
# section gives: a probe over invented prose would keep passing while the checker's spellings
# drifted away from the ones the prompts use. Every mutation rewrites a copy; nothing in the
# checkout is touched. What each section reads off the real files is derived here, independently
# of the checker -- a probe that computed its expectation with the code under test would prove
# nothing -- and a reading that finds nothing fails every case that needs it, saying what it needs.


def count_word(root: str, rel: str, *, to: str, box: str = "mac-studio") -> None:
    """Rewrites the count word stated for the default -- the numeral standing before ``on
    mac-studio``, however the sentence around it is phrased and wherever the line wraps -- to
    ``to``, and the box name after it to ``box`` (ludics-lite#263)."""
    w = slots().word
    rewrite(
        root,
        rel,
        pattern=rf"(?<![A-Za-z0-9_-]){w}(\s+on\s+)mac-studio(?![a-z0-9_.-])",
        repl=lambda m: f"{to}{m.group(1)}{box}",
        count=0,
        lines=False,
    )


def slots_assignment(root: str, *, old: str, new: str) -> None:
    """Rewrites ``old`` inside the worker's last ``SLOTS=`` assignment, its default roster."""
    path = os.path.join(root, WORKER)
    text = read(path).split("\n")
    at = max((i for i, line in enumerate(text) if line.startswith("SLOTS=")), default=-1)
    if at < 0:
        raise FixtureMissed(f"{WORKER}: no SLOTS= assignment")
    edit_line(root, WORKER, at=at + 1, pattern=rf"(?<![A-Za-z0-9_.-]){re.escape(old)}(?![0-9])", repl=new)


class SlotCountTest(Case):
    """The mac-studio correctness-slot count the prompts quote, held to the one line of
    fleet-worker.sh it lives in (ludics-lite#160). The tree is the real files, copied, and it is a
    valid root on its own: the real README indexes more skills than it holds, which the index
    lookup allows; its links all have their targets (LINK_TARGETS); and it carries no fixture, so
    no membership obligation comes with it. `native-claude.md` is in it as a file the slot scan
    DISCOVERS rather than requires: it states the count and is held for it."""

    AGREE = "mac-studio correctness slots agree"

    def setUp(self) -> None:
        super().setUp()
        self.s = slots()
        slots_tree(self.root)

    def test_the_prompts_and_the_worker_agree(self) -> None:
        self.expect("the prompts and fleet-worker.sh state one mac-studio slot count", 0, self.AGREE)

    # The script moves and the prose does not: one edit at the source, every file that states the
    # count refused -- the discovered `native-claude.md` among them, not just the required three.
    def test_a_new_default_in_the_script_alone(self) -> None:
        s = self.s
        rewrite(self.root, WORKER, pattern=f"mac-studio={s.want}", repl=f"mac-studio={s.other}", count=0)
        files = (
            "README.md",
            "issue-wave/SKILL.md",
            "issue-wave/references/executions.md",
            "issue-wave/references/native-claude.md",
        )
        self.check(
            "a new default in the script alone leaves every file that states the count refused",
            1,
            run(CP, self.root),
            *(f"FAIL: {f}: " for f in files),
        )

    # ...and each file moving alone, in each spelling the prose uses: `mac-studio=<n>`, and the
    # numeral phrase before `on mac-studio`.
    def test_one_file_moving_alone(self) -> None:
        R, s = self.root, self.s
        rewrite(R, "issue-wave/references/executions.md", pattern=f"mac-studio={s.want}", repl=f"mac-studio={s.other}")
        self.expect("a rewritten mac-studio=<n> is refused", 1, f"states 'mac-studio={s.other}'")
        slots_tree(R)
        count_word(R, "README.md", to=s.stale)
        self.expect(
            "a rewritten count word is refused, wrapped across a line",
            1,
            f"README.md: spells the mac-studio slot count '{s.stale}'",
        )
        slots_tree(R)
        count_word(R, "issue-wave/SKILL.md", to=s.stale)
        self.expect(
            "a rewritten count word is refused in the skill",
            1,
            f"SKILL.md: spells the mac-studio slot count '{s.stale}'",
        )
        # A file nobody listed: the scan holds whatever states the count, which is what keeps a list
        # from going stale behind a new quotation of the number.
        slots_tree(R)
        count_word(R, "issue-wave/references/native-claude.md", to=s.stale)
        self.expect(
            "a discovered reference is held to the count too",
            1,
            f"native-claude.md: spells the mac-studio slot count '{s.stale}'",
        )
        # The whole token, not its prefix: a value the worker would reject must not read as
        # agreement because it starts with the right digit.
        slots_tree(R)
        rewrite(
            R, "issue-wave/references/executions.md", pattern=f"mac-studio={s.want}", repl=f"mac-studio={s.want}oops"
        )
        self.expect("a malformed mac-studio=<n> is not agreement", 1, f"states 'mac-studio={s.want}oops'")

    # The word before `on mac-studio` is read WHOLE and then asked whether it is a count at all. A
    # suffix rule reads `twenty-six` as the `six` it ends with, while a bare vocabulary rule lets
    # `thirteen` state a number no spelling is checked against.
    def test_numeral_phrases(self) -> None:
        R, s = self.root, self.s
        count_word(R, "issue-wave/SKILL.md", to=s.stale_hyphen)
        self.expect(
            "a compound numeral is read whole, not by its suffix",
            1,
            f"SKILL.md: spells the mac-studio slot count '{s.stale_hyphen}'",
        )
        prefix = s.stale_hyphen.split("-")[0]
        slots_tree(R)
        count_word(R, "issue-wave/references/native-claude.md", to=prefix)
        self.expect(
            "a numeral past the default's own spellings is still a count",
            1,
            f"native-claude.md: spells the mac-studio slot count '{prefix}'",
        )
        for to, label in (
            ("twenty six", "a numeral phrase is read whole, spaces and all"),
            # The scale words English joins with `and` are numerals too.
            ("one thousand and six", "a scale word is part of the numeral, not a stop"),
            ("one hundred and six", "a numeral phrase joined by 'and' is read whole"),
        ):
            with self.subTest(label):
                slots_tree(R)
                count_word(R, "issue-wave/references/native-claude.md", to=to)
                self.expect(label, 1, f"native-claude.md: spells the mac-studio slot count '{to}'")
        # `and` joins a numeral phrase only between two numerals: a bare `and` before it leaves the
        # run where it was.
        slots_tree(R)
        count_word(R, "issue-wave/references/native-claude.md", to=f"a slot and {s.word}")
        self.expect("...while a bare 'and' before it joins nothing", 0, self.AGREE)
        # A word carrying punctuation ends the phrase rather than joining it: the `one.` closing a
        # sentence is not part of the `Six` opening the next.
        slots_tree(R)
        count_word(R, "issue-wave/SKILL.md", to=f"the WSL boxes have one. {s.word.capitalize()}")
        self.expect("a numeral across a sentence boundary does not join the phrase", 0, self.AGREE)

    # ...and the justification shape stays scoped to slot prose: an ordinary sentence of that shape
    # states no slot count.
    def test_ordinary_prose(self) -> None:
        R = self.root
        for sentence in ("The cleanup is done on mac-studio.", "Someone on mac-studio noticed."):
            with self.subTest(sentence=sentence):
                slots_tree(R)
                append(f"{R}/README.md", f"\n{sentence}\n")
                self.expect(
                    f"ordinary prose ending in a number word states no count: {sentence.split()[0]}...", 0, self.AGREE
                )
        # The `<N>, not <m>` justification is deliberately not a form this check reads
        # (ludics-lite#202): a window wide enough to catch the real ones reads ordinary comparisons
        # beside the slot paragraph as counts. Both of these are ordinary prose, written right
        # after the README's own count.
        for sentence in ("Choose one, not two modes.", "Eleven, not three, since nothing."):
            with self.subTest(sentence=sentence):
                slots_tree(R)
                w = self.s.word
                rewrite(
                    R,
                    "README.md",
                    pattern=rf"(?<![A-Za-z0-9_-]){w}\s+on\s+mac-studio\S*",
                    repl=lambda m: f"{m.group(0)} {sentence}",
                    lines=False,
                )
                self.expect(
                    f"a numeral comparison beside the slot paragraph states no count: {sentence.split()[0]}...",
                    0,
                    self.AGREE,
                )

    # Punctuation that closes a mention is punctuation, wherever Markdown puts it -- a correct count
    # inside brackets or braces states the default, and only a non-punctuation suffix is malformed.
    def test_punctuation(self) -> None:
        R, s = self.root, self.s
        for wrap in ("[mac-studio=%s]", "{mac-studio=%s}:", '"mac-studio=%s".'):
            with self.subTest(wrap=wrap):
                slots_tree(R)
                append(f"{R}/README.md", f"\nRoster {wrap % s.want} here.\n")
                self.expect(f"a count closed by Markdown punctuation is the count: {wrap}", 0, self.AGREE)
        slots_tree(R)
        append(f"{R}/README.md", f"\nRoster [mac-studio={s.other}] here.\n")
        self.expect("...and a stale one inside brackets is still refused", 1, f"states 'mac-studio={s.other}'")
        slots_tree(R)
        append(f"{R}/README.md", f"\nRoster mac-studio={s.want}oops here.\n")
        self.expect(
            "...while a suffix that is not punctuation is still malformed", 1, f"states 'mac-studio={s.want}oops'"
        )

    # The box name at a token boundary: another box's name ending in it is another box, and a roster
    # that names no mac-studio has no mac-studio default to check the prompts against. A box name
    # may hold `_` and `.` as well as `-`.
    def test_the_box_name_in_the_default(self) -> None:
        R, s = self.root, self.s
        nodefault = f"{WORKER}: SLOTS assignment states no 'mac-studio=<n>' default"
        slots_assignment(R, old=f"mac-studio={s.want}", new=f"not-mac-studio={s.want}")
        self.expect("a box whose name merely ends in mac-studio is another box", 1, nodefault)
        slots_tree(R)
        slots_assignment(R, old=f"mac-studio={s.want}", new=f"not_mac-studio={s.want}")
        self.expect("a box name ending in mac-studio after an underscore is another box", 1, nodefault)

    # The box name ends at a token boundary in the prose too: each of these states a count about
    # another box.
    def test_the_box_name_in_the_prose(self) -> None:
        R = self.root
        count_word(R, "README.md", to="six", box="mac-studio-pro")
        self.expect(
            "a count about a box whose name starts with mac-studio is not this one's",
            1,
            "README.md: states no mac-studio slot count",
        )
        slots_tree(R)
        count_word(R, "README.md", to="six", box="mac-studio_backup")
        self.expect(
            "a count about mac-studio_backup is not this box's either", 1, "README.md: states no mac-studio slot count"
        )

    def test_where_a_mention_is_read(self) -> None:
        R, s = self.root, self.s
        # The box name's far boundary may be the end of the text itself.
        append(f"{R}/README.md", f"\n{s.stale} on mac-studio")
        self.expect(
            "a count phrase ending the file is still read",
            1,
            f"README.md: spells the mac-studio slot count '{s.stale}'",
        )
        # A NUL anywhere makes grep call a file binary, and the greps disagreed about what that
        # prints: the NUL stands BEFORE the mention, in a file nothing requires to state a count.
        slots_tree(R)
        write(f"{R}/notes-with-a-nul.md", f"a stray \0 byte, and then:\n\n{s.stale} on mac-studio, this note says.\n")
        self.expect(
            "a stale count in a file carrying a NUL is still refused",
            1,
            f"notes-with-a-nul.md: spells the mac-studio slot count '{s.stale}'",
        )
        # The box name is matched in lowercase, so a mention that shouts is the same mention.
        slots_tree(R)
        append(f"{R}/README.md", f"\nThe roster sets MAC-STUDIO={s.want} for the Mac.\n")
        self.expect("a mention in capitals is the same statement", 0, self.AGREE)
        slots_tree(R)
        append(f"{R}/README.md", f"\nThe roster sets MAC-STUDIO={s.other} for the Mac.\n")
        self.expect(
            "...and a stale one in capitals is refused as written", 1, f"README.md: states 'MAC-STUDIO={s.other}'"
        )
        # A path with a space in it is scanned, not split.
        slots_tree(R)
        write(f"{R}/issue-wave/references/old notes.md", f"notes\n\nmac-studio={s.other} slots.\n")
        self.expect(
            "a discovered path with a space is scanned, not split", 1, f"old notes.md: states 'mac-studio={s.other}'"
        )
        # The root is read the same spelled with a trailing slash.
        slots_tree(R)
        self.expect("a root spelled with a trailing slash reads the same", 0, self.AGREE, CP, f"{R}/")
        # A prompt that stops stating the count is how the agreement would quietly stop being checked.
        slots_tree(R)
        count_word(R, "README.md", to="as configured")
        self.expect("a prompt that drops the count is refused", 1, "README.md: states no mac-studio slot count")

    def default_moves(self, label: str, *, tail: str) -> None:
        """Appends ``tail`` to the worker, which assigns the other count: the default moves."""
        append(f"{self.root}/{WORKER}", tail)
        self.check(label, 1, run(CP, self.root), f"defaults to mac-studio={self.s.other}")

    def default_stays(self, label: str, *, tail: str, rel: str = WORKER) -> None:
        append(f"{self.root}/{rel}", tail)
        self.expect(label, 0, self.AGREE)

    # Which assignment is the default is read as the shell reads the script: the LAST one at top
    # level that the shell would execute, before a separator or alone on its line.
    def test_which_assignment_is_the_default(self) -> None:
        o = self.s.other
        moves: tuple[tuple[str, str], ...] = (
            ("a later SLOTS assignment is the default the prompts are held to", f"SLOTS=mac-studio={o}\n"),
            # A heredoc-like operator inside quotes, or named in a comment, opens no body.
            (
                "a heredoc-like string in quotes hides nothing after it",
                f"printf %s '<<IGNORED'\nSLOTS=mac-studio={o}\n",
            ),
            ("an assignment before a separator is still the default", f"SLOTS=mac-studio={o} ; export SLOTS\n"),
            (
                "a heredoc named in a comment hides nothing after it",
                f"# example: cat <<IGNORED\nSLOTS=mac-studio={o}\n",
            ),
            # A here-STRING is not a heredoc.
            (
                "...and a here-string opens no body for the next line to hide in",
                f'read -r -a pairs <<<"$SLOTS"\nSLOTS=mac-studio={o}\n',
            ),
            # Past a function body, the script is top level again.
            ("...and one after the body closes is", f"unused_helper() {{\nx=1\n}}\nSLOTS=mac-studio={o}\n"),
            # Once a heredoc body ends, the script is code again.
            ("...and an assignment after the terminator is executed again", f"cat <<A\nx\nA\nSLOTS=mac-studio={o}\n"),
        )
        for label, tail in moves:
            with self.subTest(label):
                slots_tree(self.root)
                self.default_moves(label, tail=tail)
        stays: tuple[tuple[str, str], ...] = (
            # A heredoc body is data the script writes, not code it runs.
            ("a SLOTS line inside a heredoc assigns nothing", f": <<'HD'\nSLOTS=mac-studio={o}\nHD\n"),
            # A blank the shell does not split on does not end the assignment word.
            (
                "an override whose blank is escaped states no default",
                "export FLEET_BOX_CORRECTNESS_SLOTS=testbox=2\\ mac-studio=2\n",
            ),
            # An assignment in front of a command is scoped to that command.
            ("a command-prefix assignment sets no default", f"SLOTS=mac-studio={o} true\n"),
            # A heredoc delimiter is a word, not a shell identifier.
            ("a heredoc delimited by digits is still a heredoc", f": <<123\nSLOTS=mac-studio={o}\n123\n"),
            # Defining a function is not running it.
            (
                "an assignment inside a function body is not the default",
                f"unused_helper() {{\nSLOTS=mac-studio={o}\n}}\n",
            ),
            # A heredoc delimiter may be quoted with a backslash as well as with quotes.
            ("...however the heredoc delimiter is quoted", f"cat <<\\HD\nSLOTS=mac-studio={o}\nHD\n"),
            # One command may declare several heredocs, and their bodies follow in order.
            (
                "a body behind a second delimiter on one line is still a body",
                f"cat <<A <<B\nfirst\nA\nSLOTS=mac-studio={o}\nB\n",
            ),
            # An assignment of the variable is an input, not a claim about the default.
            (
                "an override in front of a command states no default",
                f"FLEET_BOX_CORRECTNESS_SLOTS=mac-studio=2 {WORKER} execution slot -- true\n",
            ),
            ("...and a quoted override states none either", 'export FLEET_BOX_CORRECTNESS_SLOTS="mac-studio=2"\n'),
            # What makes a mention an assignment is standing inside the assignment word, not what
            # the characters before it happen to spell.
            (
                "...and one behind another box's pair states none either",
                'export FLEET_BOX_CORRECTNESS_SLOTS="testbox=2 mac-studio=2"\n',
            ),
        )
        for label, tail in stays:
            with self.subTest(label):
                slots_tree(self.root)
                self.default_stays(label, tail=tail)

    # An example command in a document is an input too, quoted and continued however it is.
    def test_overrides_in_documents(self) -> None:
        execs = "issue-wave/references/executions.md"
        example = '\n    FLEET_BOX_CORRECTNESS_SLOTS="rog-nv-wsl=3 mac-studio=2" fleet-worker.sh ls\n'
        for label in (
            "a quoted override is still an input, not a statement",
            "...and so does one in a document's example command",
        ):
            with self.subTest(label):
                slots_tree(self.root)
                self.default_stays(label, tail=example, rel=execs)
        slots_tree(self.root)
        self.default_stays(
            "an override continued onto the next line is still one assignment",
            tail='\n    FLEET_BOX_CORRECTNESS_SLOTS="rog-nv-wsl=3 \\\n      mac-studio=2" fleet-worker.sh ls\n',
            rel=execs,
        )
        # Positionally, though: prose after an assignment on the same line is still prose.
        slots_tree(self.root)
        o = self.s.other
        append(
            f"{self.root}/README.md",
            f'\nRun FLEET_BOX_CORRECTNESS_SLOTS="mac-studio=2" to halve it; mac-studio={o} is not the default.\n',
        )
        self.expect(
            "a count beside an assignment on one line is still judged", 1, f"README.md: states 'mac-studio={o}'"
        )

    # Prose written in the SHAPE of an assignment, inside a comment, is still prose -- and
    # fleet-worker.sh's header is one of the declarations this check exists to hold in sync.
    def test_comments_are_statements(self) -> None:
        R, s = self.root, self.s
        rewrite(
            R,
            WORKER,
            pattern=rf"^(#.*?)[\"']?mac-studio={s.want}[\"']?",
            repl=rf"\g<1>FLEET_BOX_CORRECTNESS_SLOTS=mac-studio={s.other}",
            lines=False,
        )
        want = f"{WORKER}: states 'mac-studio={s.other}'"
        self.expect("a count in a comment is held even when it is spelled as an assignment", 1, want)
        slots_tree(R)
        append(f"{R}/{WORKER}", f"# was: SLOTS=mac-studio={s.other}\n")
        self.expect("...and a commented-out assignment is a statement, not a setting", 1, want)

    # The default is the assignment's VALUE, read as the worker reads it.
    def test_the_defaults_value(self) -> None:
        R, s = self.root, self.s
        # Prose on the line cannot stand in for a default the script no longer has.
        rewrite(
            R, WORKER, pattern=r"^SLOTS=.*", repl=lambda _: 'SLOTS="${FLEET_BOX_CORRECTNESS_SLOTS-}" # old mac-studio=6'
        )
        self.expect(
            "a default left only in a trailing comment is no default",
            1,
            f"{WORKER}: SLOTS assignment states no 'mac-studio=<n>' default",
        )
        cases: tuple[tuple[str, int, str, Callable[[], None]], ...] = (
            (
                "a malformed default is no default",
                1,
                f"{WORKER}: SLOTS assignment states 'mac-studio={s.want}oops'",
                lambda: slots_assignment(R, old=f"mac-studio={s.want}", new=f"mac-studio={s.want}oops"),
            ),
            (
                "a default behind another box's pair is still the default",
                0,
                self.AGREE,
                lambda: self.set_slots(f'SLOTS="${{FLEET_BOX_CORRECTNESS_SLOTS-testbox=2 mac-studio={s.want}}}"'),
            ),
            # The positivity rule judges the VALUE, so it sees through a leading zero.
            (
                "a zero written with a leading zero is still zero",
                1,
                f"{WORKER}: SLOTS assignment states mac-studio=0",
                lambda: slots_assignment(R, old=f"mac-studio={s.want}", new="mac-studio=00"),
            ),
            # The positive-count rule is the worker's, and it applies to every pair it reads.
            (
                "a zero count for another box refuses the spec too",
                1,
                f"{WORKER}: SLOTS assignment states 'rog-nv-wsl=0'",
                lambda: self.set_slots('SLOTS="rog-nv-wsl=0 mac-studio=6"'),
            ),
            # The count is a NUMBER: `06` is the six the worker reads, on either side.
            (
                "a default written with a leading zero still spells its number",
                0,
                self.AGREE,
                lambda: slots_assignment(R, old=f"mac-studio={s.want}", new=f"mac-studio=0{s.want}"),
            ),
            (
                "...and so does a prompt that writes one",
                0,
                self.AGREE,
                lambda: rewrite(
                    R,
                    "issue-wave/references/executions.md",
                    pattern=f"mac-studio={s.want}",
                    repl=f"mac-studio=0{s.want}",
                ),
            ),
            # A LITERAL pair list is what the worker splits and validates in order, so a malformed
            # pair anywhere in one refuses the spec.
            (
                "another box's malformed pair refuses the whole spec",
                1,
                f"{WORKER}: SLOTS assignment states 'rog-nv-wsl=oops'",
                lambda: self.set_slots('SLOTS="rog-nv-wsl=oops mac-studio=6"'),
            ),
            (
                "...while a list whose pairs are all valid still defaults",
                0,
                self.AGREE,
                lambda: self.set_slots(f'SLOTS="rog-nv-wsl=1 mac-studio={s.want}"'),
            ),
            # Every mac-studio pair in the value is validated, not just the last recognizable one.
            (
                "a malformed pair is refused even with a valid one behind it",
                1,
                f"{WORKER}: SLOTS assignment states 'mac-studio=oops'",
                lambda: self.set_slots('SLOTS="mac-studio=oops mac-studio=6"'),
            ),
            # ...and where every pair is valid, the last one for the box is the default.
            (
                "a box named twice takes its last count",
                0,
                self.AGREE,
                lambda: self.set_slots(f'SLOTS="mac-studio={s.other} mac-studio={s.want}"'),
            ),
            # `box_correctness_slots` refuses a count below one.
            (
                "a zero default is refused, not agreed with",
                1,
                f"{WORKER}: SLOTS assignment states mac-studio=0",
                lambda: slots_assignment(R, old=f"mac-studio={s.want}", new="mac-studio=0"),
            ),
        )
        for label, rc, want, mutate in cases:
            with self.subTest(label):
                slots_tree(R)
                mutate()
                self.expect(label, rc, want)

    def set_slots(self, line: str) -> None:
        rewrite(self.root, WORKER, pattern=r"^SLOTS=.*", repl=lambda _: line)

    # The obligation comes from the script, as the fixtures' comes from a fixture.
    def test_no_worker_no_obligation(self) -> None:
        fresh(self.root)
        self.lacks(f"...and a root without {WORKER} carries no slot obligation", "mac-studio", run(CP, self.root))


# --- the fleet roster's prose lists (#853) ------------------------------------------------------
# The planner's home-box sentence and issue-wave's fleet bullet, held to DEFAULT_BOXES in the
# worker's config.py. The tree is the real files, copied, as the slot tree is: both READMEs for the
# index lookup, LINK_TARGETS for the link check, and no fleet-worker.sh or fixture, so neither of
# those agreements applies.

ROSTER_SOURCE = "lib/ludics/fleetworker/config.py"
PLANNER = "routines/daily-issue-planning/SKILL.md"
FLEET = "issue-wave/SKILL.md"
SPARE = "spare-box"  # a box no roster names


@functools.cache
def roster() -> tuple[str, ...]:
    found = [m.group(1) for line in src_lines(ROSTER_SOURCE) if (m := re.fullmatch(r'DEFAULT_BOXES = "([^"]*)"\s*', line))]
    if len(found) != 1 or not found[0].split():
        raise AssertionError(f'the roster probes need one DEFAULT_BOXES = "..." line in {ROSTER_SOURCE}')
    boxes = tuple(found[0].split())
    if SPARE in boxes:
        raise AssertionError(f"the roster probes use {SPARE} as the box no roster names")
    return boxes


def roster_tree(root: str) -> None:
    shutil.rmtree(root, ignore_errors=True)
    copy_prompts(root, "README.md", "routines/README.md", FLEET, PLANNER, *LINK_TARGETS, ROSTER_SOURCE)


def roster_value(root: str, *, to: str) -> None:
    rewrite(root, ROSTER_SOURCE, pattern=r'^DEFAULT_BOXES = "[^"]*"', repl=f'DEFAULT_BOXES = "{to}"')


class RosterListsTest(Case):
    AGREE = "the planner's home-box list and issue-wave's fleet list name DEFAULT_BOXES"

    def setUp(self) -> None:
        super().setUp()
        self.boxes = roster()
        roster_tree(self.root)

    def test_the_lists_and_the_roster_agree(self) -> None:
        self.expect("both prose lists name the default roster", 0, self.AGREE)

    # The negative control the issue names: a box joins the roster and neither list follows.
    def test_a_roster_with_an_extra_box(self) -> None:
        roster_value(self.root, to=" ".join((*self.boxes, SPARE)))
        result = run(CP, self.root)
        self.check(
            "a box added to DEFAULT_BOXES alone leaves both lists refused",
            1,
            result,
            f"FAIL: {PLANNER}: the home-box sentence leaves out `{SPARE}`",
            f"FAIL: {FLEET}: the fleet bullet leaves out `{SPARE}`",
        )
        self.lacks("...and no agreement is claimed", self.AGREE, result)

    def test_a_box_retired_from_the_roster(self) -> None:
        gone = self.boxes[-1]
        roster_value(self.root, to=" ".join(self.boxes[:-1]))
        self.check(
            "a box retired from DEFAULT_BOXES alone leaves both lists refused",
            1,
            run(CP, self.root),
            f"FAIL: {PLANNER}: the home-box sentence names `{gone}`, which {ROSTER_SOURCE}'s DEFAULT_BOXES",
            f"FAIL: {FLEET}: the fleet bullet names `{gone}`, which",
        )

    def test_a_list_moving_alone(self) -> None:
        R, last = self.root, self.boxes[-1]
        rewrite(R, PLANNER, pattern=rf"`{re.escape(last)}`", repl=f"`{last}`, `{SPARE}`")
        self.expect("an extra box in the planner's list is refused", 1, f"{PLANNER}: the home-box sentence names `{SPARE}`")
        roster_tree(R)
        rewrite(R, FLEET, pattern=rf"`{re.escape(last)}`", repl=f"`{SPARE}`")
        result = self.expect("a box renamed in the fleet bullet is refused", 1, f"{FLEET}: the fleet bullet names `{SPARE}`")
        self.check("...both ways", 1, result, f"{FLEET}: the fleet bullet leaves out `{last}`")

    # Only the spans at parenthesis depth zero, and only inside the sentence, are box names.
    def test_what_is_read(self) -> None:
        R, first = self.root, self.boxes[0]
        rewrite(R, FLEET, pattern=rf"`{re.escape(first)}` \(", repl=f"`{first}` (`{SPARE}`, ")
        self.expect("a code span in parentheses describes a box rather than naming one", 0, self.AGREE)
        roster_tree(R)
        rewrite(R, FLEET, pattern=r"^(- \*\*The fleet\*\*:.*)$", repl=lambda m: f"{m.group(1)} (`{SPARE}`")
        self.expect("an unclosed parenthesis is refused, not read loosely", 1, f"{FLEET}: the fleet bullet cannot be read")
        roster_tree(R)
        rewrite(R, PLANNER, pattern=r"running native Linux\.", repl=f"running native Linux. Not `{SPARE}`.")
        self.expect("a span past the sentence's end is not in the list", 0, self.AGREE)
        # The anchor's words may wrap where the prose wraps.
        roster_tree(R)
        rewrite(R, PLANNER, pattern=r"every item: exactly", repl="every\n    item: exactly")
        self.expect("a wrapped anchor is still the anchor", 0, self.AGREE)

    def test_the_anchors(self) -> None:
        R = self.root
        rewrite(R, PLANNER, pattern=r"exactly one of", repl="one of")
        self.expect("an anchor edited away is refused", 1, f"{PLANNER}: has no 'home-box field on every item: exactly one of'")
        roster_tree(R)
        append(f"{R}/{FLEET}", "\n- **The fleet**: `x`.\n")
        self.expect("a repeated anchor is refused", 1, f"{FLEET}: has 2 of '- **The fleet**:'")
        roster_tree(R)
        os.remove(f"{R}/{PLANNER}")
        self.expect("a missing list is refused", 1, f"{PLANNER}: is missing")

    def test_the_roster_line(self) -> None:
        R = self.root
        rewrite(R, ROSTER_SOURCE, pattern=r"^DEFAULT_BOXES = ", repl="DEFAULT_BOXES: str = ")
        self.expect("a roster in a shape this check does not read is refused", 1, f"FAIL: {ROSTER_SOURCE}: has no one line")
        roster_tree(R)
        append(f"{R}/{ROSTER_SOURCE}", 'DEFAULT_BOXES = "a"\n')
        self.expect("two roster lines are refused", 1, f"FAIL: {ROSTER_SOURCE}: has no one line")

    def test_no_config_no_obligation(self) -> None:
        fresh(self.root)
        self.lacks(f"a root without {ROSTER_SOURCE} carries no roster obligation", "DEFAULT_BOXES", run(CP, self.root))


# --- ship-pr's staged reading list ---------------------------------------------------------------
# ship-pr's "What to read when" paragraph and issue-wave's Landing bullet that points to it, held to
# ship-pr/SKILL.md's headings (post-wave chip of ludics#949). The tree is the real files, copied:
# both READMEs for the index lookup, LINK_TARGETS (ship-pr/SKILL.md among them) for the link check.

SHIP = "ship-pr/SKILL.md"
READ_WHEN_AGREE = f"the reading list and its pointer name are headings of {SHIP}"


def reading_tree(root: str) -> None:
    shutil.rmtree(root, ignore_errors=True)
    copy_prompts(root, "README.md", "routines/README.md", FLEET, *LINK_TARGETS)


def read_when(root: str, *, append_text: str) -> None:
    """Appends ``append_text`` to the last line of ship-pr's What to read when paragraph."""
    rewrite(root, SHIP, pattern=r"(command's output names it\.)$", repl=lambda m: m.group(1) + append_text)


class ReadingListTest(Case):
    def setUp(self) -> None:
        super().setUp()
        reading_tree(self.root)

    # The real files pass, with *The\napproval is one gate; ...* wrapped across a line.
    def test_the_list_and_the_headings_agree(self) -> None:
        self.expect("every section the list names is a heading", 0, READ_WHEN_AGREE)

    # The negative control the task names: a heading renamed, the list left as it was.
    def test_a_renamed_heading(self) -> None:
        rewrite(self.root, SHIP, pattern=r"^### When the loop ends$", repl="### When the loop closes")
        result = run(CP, self.root)
        self.check(
            "a heading renamed under the list is refused",
            1,
            result,
            f"FAIL: {SHIP}: the What to read when paragraph names *When the loop ends*, which is no heading",
        )
        self.lacks("...and no agreement is claimed", READ_WHEN_AGREE, result)

    def test_the_pointer_is_read(self) -> None:
        rewrite(self.root, FLEET, pattern=r"ship-pr's \*Open\*\.", repl="ship-pr's *Opening*.")
        self.expect(
            "a section issue-wave's Landing bullet names is held too", 1, f"FAIL: {FLEET}: the Landing bullet names *Opening*"
        )

    def test_what_is_an_italic_span(self) -> None:
        R = self.root
        read_when(R, append_text=" A **bold** run and `*/SKILL.md` in code name no section.")
        self.expect("bold and a code span's asterisks are not italic", 0, READ_WHEN_AGREE)
        reading_tree(R)
        read_when(R, append_text=" Read *Monitor   again*.")
        self.expect("emphasis in the paragraph is read as a section name", 1, "names *Monitor again*, which is no heading")
        reading_tree(R)
        read_when(R, append_text=" Read *Monitor.")
        self.expect("an unclosed italic span is refused", 1, f"FAIL: {SHIP}: the What to read when paragraph cannot be read")
        # A heading-shaped line inside a fence is not a heading.
        reading_tree(R)
        read_when(R, append_text=" Also *Fenced*.")
        append(f"{R}/{SHIP}", "\n```\n## Fenced\n```\n")
        self.expect("a fenced heading line is no heading", 1, "names *Fenced*, which is no heading")
        reading_tree(R)
        read_when(R, append_text=" Also *Fenced*.")
        append(f"{R}/{SHIP}", "\n## Fenced\n")
        self.expect("...while the same line outside a fence is one", 0, READ_WHEN_AGREE)

    def test_the_lead(self) -> None:
        R = self.root
        rewrite(R, SHIP, pattern=r"^\*\*What to read when\.\*\*", repl="**What to read, when.**")
        self.expect("a lead edited away is refused", 1, f"FAIL: {SHIP}: has no line opening with '**What to read when.**'")
        reading_tree(R)
        append(f"{R}/{SHIP}", "\n**What to read when.** *Open*.\n")
        self.expect("a repeated lead is refused", 1, f"FAIL: {SHIP}: has 2 lines opening with '**What to read when.**'")
        reading_tree(R)
        rewrite(R, SHIP, pattern=r"\*", repl="", count=0, lines=False)
        rewrite(R, SHIP, pattern=r"^What to read when\. ", repl="**What to read when.** ")
        self.expect("an emptied list is refused", 1, f"FAIL: {SHIP}: the What to read when paragraph names no *section*")
        reading_tree(R)
        rewrite(R, FLEET, pattern=r"^- Landing:", repl="- Landing it:")
        self.expect("a pointer bullet edited away is refused", 1, f"FAIL: {FLEET}: has no line opening with '- Landing:'")

    def test_obligations(self) -> None:
        R = self.root
        os.remove(f"{R}/{FLEET}")
        # This case deliberately removes the wave prompt, so the one reference link to it
        # (coordinator-kit.md's pairing paragraph, #1162) is cut from the fixture too: the
        # obligation under test is the shipping reading list alone. Another link to it added later
        # fails this case loudly.
        rewrite(R, "issue-wave/references/coordinator-kit.md", pattern=r"\[Decision gate\]\(\.\./SKILL\.md#[^)]*\)", repl="Decision gate")
        rewrite(R, "issue-wave/references/ab-judging.md", pattern=r"\[Codex model choice\]\(\.\./SKILL\.md#[^)]*\)", repl="Codex model choice")
        self.expect("without issue-wave, the paragraph alone is held", 0, READ_WHEN_AGREE)
        fresh(R)
        self.lacks(f"a root without {SHIP} carries no reading-list obligation", "What to read when", run(CP, R))


# --- the installed-routine drift guard -----------------------------------------------------------
# ludics-lite#199: each routine sync-routines.sh installs opens by running it and reading its own
# drift, and nothing but this check stops that step being edited away. Both READMEs come along
# because the index lookup wants them and LINK_TARGETS because the link check does; no fixture and
# no fleet-worker.sh, so neither of those two agreements applies.




# The invocation line, as the prompts write it: indented, the path alone.
INVOCATION = r"^( *)([^ `]*sync-routines\.sh)$"


class DriftGuardTest(Case):
    OK = "runs it to read its own drift"

    def setUp(self) -> None:
        super().setUp()
        self.d = drift()
        self.prompt = f"routines/{self.d.one}/SKILL.md"
        self.refused = f"{self.prompt}: {self.d.want}"
        drift_tree(self.root)

    def test_every_installed_routine_runs_the_drift_check(self) -> None:
        self.expect("every installed routine's prompt runs the drift check", 0, self.OK)

    def test_edited_away(self) -> None:
        R = self.root
        # The step edited out of a prompt is the drift this check exists for.
        rewrite(R, self.prompt, pattern=r"sync-routines\.sh", repl="the-sync-script", count=0)
        self.expect("a routine that stops naming the sync script is refused", 1, self.refused)
        # The mutation that matters, and the one a filename match would pass: delete the COMMAND and
        # leave every mention of it standing.
        drift_tree(R)
        delete_lines(R, self.prompt, pattern=r"^ {4,}[^`]*sync-routines\.sh\s*$")
        self.expect("a routine that keeps the prose and drops the command is refused", 1, self.refused)
        # A write is not the read: `push` and `pull` install and recover.
        drift_tree(R)
        rewrite(R, self.prompt, pattern=r"^( *[^ `]*sync-routines\.sh)$", repl=r"\1 push")
        self.expect("an invocation that writes instead of reading is refused", 1, self.refused)
        # ...and prose quoting the command is prose, however it is indented.
        drift_tree(R)
        rewrite(R, self.prompt, pattern=INVOCATION, repl=r"\1run `\2`")
        self.expect("an indented line quoting the command is not the command", 1, self.refused)

    # The ways a line can hold the path without running it -- the comment especially, which is how
    # a guard is disabled rather than deleted.
    def test_the_path_not_run(self) -> None:
        shapes = (
            ("a commented-out invocation", r"\1# \2"),
            ("an invocation commented out with no space", r"\1#\2"),
            ("the path as another command's argument", r"\1echo \2"),
            ("...and as cat's", r"\1cat \2"),
            ("the path assigned to a variable", r"\1DRIFT_COMMAND=\2"),
            ("...and assigned with export", r"\1export DRIFT_COMMAND=\2"),
            ("some other file of the same name", r"\1/tmp/sync-routines.sh"),
            ("...and one under a same-named directory elsewhere", r"\1/tmp/scripts/sync-routines.sh"),
        )
        for label, repl in shapes:
            with self.subTest(label):
                drift_tree(self.root)
                rewrite(self.root, self.prompt, pattern=INVOCATION, repl=repl)
                self.expect(f"{label} is not the command", 1, self.refused)

    # `$HOME` names the same path `~` does; and an indented command line is four blanks or more.
    def test_spelling_and_indentation(self) -> None:
        R = self.root
        rewrite(R, self.prompt, pattern=r"^( *)~/([^ `]*sync-routines\.sh)$", repl=r"\1$HOME/\2")
        self.expect("the invocation spelled through $HOME is the same command", 0, self.OK)
        drift_tree(R)
        rewrite(R, self.prompt, pattern=r"^ *([^ `]*sync-routines\.sh)$", repl=r"   \1")
        self.expect("an invocation indented less than four blanks is not the command", 1, self.refused)

    # The path is the README's to state, and the checker reads it from there rather than restating
    # it.
    def test_the_path_comes_from_the_readme(self) -> None:
        R = self.root
        rewrite(
            R,
            "README.md",
            pattern=r"^git clone .*ludics\.git ~/.*$",
            repl="git clone https://example.invalid/x.git",
        )
        self.expect("a README with no clone destination is refused, not passed", 1, "no ")
        drift_tree(R)
        rewrite(R, "README.md", pattern=r"^(git clone .*ludics\.git )~/ludics$", repl=r"\1~/elsewhere")
        self.expect(
            "the checkout path comes from the README, so moving it refuses the old invocation",
            1,
            "~/elsewhere/scripts/sync-routines.sh",
        )

    # Which prompts are held is read off the script, so a name added to LOCAL_ROUTINES arrives
    # obliged -- and one it installs with nothing to install from is refused rather than skipped.
    def test_the_routines_come_from_the_script(self) -> None:
        R = self.root
        shutil.rmtree(f"{R}/routines/{self.d.one}")
        self.expect(
            "a routine the script installs with no prompt here is refused",
            1,
            f"installs '{self.d.one}', but this checkout has no routines/{self.d.one}/SKILL.md",
        )
        drift_tree(R)
        rewrite(
            R,
            "scripts/sync-routines.sh",
            pattern=r"^LOCAL_ROUTINES=.*",
            repl='LOCAL_ROUTINES="a b" # not the one-line shape',
        )
        self.expect(
            "a LOCAL_ROUTINES this reader cannot see is refused, not passed", 1, "has no one-line LOCAL_ROUTINES"
        )

    # The obligation comes from the installer, as the fixtures' comes from a fixture.
    def test_no_installer_no_obligation(self) -> None:
        fresh(self.root)
        self.lacks("...and a root without the sync script carries no drift obligation", "drift", run(CP, self.root))


# --- the post-merge-cleanup option register ------------------------------------------------------
# ludics-lite#276 added `--regenerable` to post-merge-cleanup.sh's usage() and to ship-pr/SKILL.md
# by hand, in the PR that found the prompt's prose about the base-owner gate had been false for two
# PRs already. Both READMEs come along for the index lookup and LINK_TARGETS for the link check;
# no fixture, no worker, no sync script.

CLEANUP_HELPER = "ship-pr/scripts/post-merge-cleanup.sh"
CLEANUP_PROMPT = "ship-pr/SKILL.md"
CLEANUP_AGREE = f"{CLEANUP_PROMPT} and {CLEANUP_HELPER}'s usage() agree"


@dataclass(frozen=True)
class Cleanup:
    usage: str
    rc: int
    line: int  # the prompt's `  --base <b> --regenerable <d>` continuation line, 1-based


@functools.cache
def cleanup() -> Cleanup:
    # The helper in the tree is a STAND-IN that prints what the real helper prints: check-prompts
    # reads the helper's printed usage text and nothing else of it, and since the v2 rewrite
    # (ludics-lite#403) that text comes from a Python package the helper forwards to, which a copy
    # of the one file would not find. So the real helper is run once, here, as check-prompts runs
    # it, and the stand-in replays its stderr and exit status. The probes that mutate the helper
    # mutate that TEXT, which is the whole of what the checker sees, whatever renders it.
    p = subprocess.run(
        [BASH, os.path.join(SRC, CLEANUP_HELPER)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        env=ENV,
        check=False,
    )
    usage = p.stderr.decode("latin-1").rstrip("\n")
    if p.returncode != 2:
        raise AssertionError(f"the real {CLEANUP_HELPER} run with no arguments exited {p.returncode}, not 2: {usage}")
    # The one invocation line the mutations rewrite, read off the prompt rather than restated, so a
    # probe goes stale at the edit that moves it instead of asserting over a line no longer there.
    at = [
        i + 1
        for i, line in enumerate(src_lines(CLEANUP_PROMPT))
        if re.fullmatch(r"  --base \S* --regenerable \S*", line)
    ]
    if not at:
        raise AssertionError(
            f"the cleanup probes need a '  --base <b> --regenerable <d>' continuation line in {CLEANUP_PROMPT}"
        )
    return Cleanup(usage=usage, rc=p.returncode, line=at[0])


def cleanup_tree(root: str) -> None:
    shutil.rmtree(root, ignore_errors=True)
    copy_prompts(root, "README.md", "routines/README.md", CLEANUP_PROMPT, *LINK_TARGETS)
    c = cleanup()
    helper = os.path.join(root, CLEANUP_HELPER)
    write(helper, f"#!/usr/bin/env bash\ncat >&2 <<'CLEANUP_USAGE_TEXT'\n{c.usage}\nCLEANUP_USAGE_TEXT\nexit {c.rc}\n")
    os.chmod(helper, 0o755)


def helper_prelude(root: str, *, lines: str) -> None:
    """Puts shell lines into the stand-in helper, right after its shebang."""
    rewrite(root, CLEANUP_HELPER, pattern=r"\A(#![^\n]*\n)", repl=lambda m: m.group(1) + lines, lines=False)


class CleanupOptionsTest(Case):
    def setUp(self) -> None:
        super().setUp()
        self.c = cleanup()
        cleanup_tree(self.root)

    def fence(self, *lines: str) -> None:
        """Appends a fenced bash block to the prompt."""
        append(f"{self.root}/{CLEANUP_PROMPT}", "\n```bash\n" + "".join(f"{x}\n" for x in lines) + "```\n")

    def add_dry_run(self) -> None:
        """Lists a `--dry-run` flag in the helper's usage text, ahead of `--base`, as the option
        table renders a row with no placeholder -- the one row shape the real table does not carry."""
        rewrite(
            self.root,
            CLEANUP_HELPER,
            pattern=r"^  --base ",
            repl="  --dry-run             Report what cleanup would do and change nothing\n  --base ",
        )

    def test_the_prompt_and_the_helper_agree(self) -> None:
        self.expect("the real prompt and the helper's usage() list the same options", 0, CLEANUP_AGREE)

    def test_drift_both_ways(self) -> None:
        R = self.root
        # The drift ludics-lite#276 was: an option the helper gains that the prompt never names.
        self.add_dry_run()
        self.expect(
            "an option usage() lists that the prompt never names is refused",
            1,
            f"{CLEANUP_PROMPT}: names no '--dry-run'",
        )
        # ...and the other direction, on a CONTINUATION line, which is where the real prompt keeps
        # its options, so this also proves the backslash is followed.
        cleanup_tree(R)
        edit_line(R, CLEANUP_PROMPT, at=self.c.line, pattern="$", repl=" --keep-branch")
        self.expect(
            "an option the prompt passes that usage() does not list is refused",
            1,
            f"{CLEANUP_PROMPT}: passes '--keep-branch' to {CLEANUP_HELPER}",
        )
        # A renamed option fails both ways at once.
        cleanup_tree(R)
        rewrite(R, CLEANUP_PROMPT, pattern="--force-integrated", repl="--force-merged", count=0)
        result = self.expect("a renamed option is refused as missing", 1, "names no '--force-integrated'")
        self.check("...and as passed unlisted", 1, result, "passes '--force-merged'")
        # The token whole: the prompt naming `--base-branch` does not name `--base`.
        cleanup_tree(R)
        rewrite(R, CLEANUP_PROMPT, pattern=r"--base([^-])", repl=r"--base-branch\1", count=0)
        self.expect("a longer option carrying the listed one as a prefix does not name it", 1, "names no '--base'")

    # What is attributed to the helper is its own command line, in a fence. The same `--flag` on
    # another command's line, or in prose, is not, so the register does not grow to cover every tool
    # the prompt mentions.
    def test_what_is_the_helpers(self) -> None:
        R = self.root
        prompt = f"{R}/{CLEANUP_PROMPT}"
        append(prompt, "\n```bash\ngh pr merge --delete-branch --squash\n```\n\nOr pass `--no-such-flag` to nothing.\n")
        self.expect("an option on another command's fenced line, or in prose, is nobody's", 0, CLEANUP_AGREE)
        cleanup_tree(R)
        self.fence("~/.claude/skills/ship-pr/scripts/test-post-merge-cleanup.sh --list")
        self.expect("...and the test runner, whose name ends in the helper's, is another command", 0, CLEANUP_AGREE)
        cleanup_tree(R)
        append(prompt, "\nSome run `post-merge-cleanup.sh a b c --keep-branch` and regret it.\n")
        self.expect("an invocation quoted in prose is not a command line", 0, CLEANUP_AGREE)
        # ...and a continuation is a trailing backslash: without it the next line is its own.
        cleanup_tree(R)
        edit_line(R, CLEANUP_PROMPT, at=self.c.line - 1, pattern=r" \\$", repl="")
        edit_line(R, CLEANUP_PROMPT, at=self.c.line, pattern="$", repl=" --keep-branch")
        self.expect("a line the backslash no longer continues passes nothing", 0, CLEANUP_AGREE)

    # The shell's word boundaries, as far as the reader models them (review rounds 1-4, P2 each).
    # Each is a shape that let an unlisted option through, or refused a valid helper.
    def test_the_word_model(self) -> None:
        refused: tuple[tuple[str, tuple[str, ...]], ...] = (
            (
                "an invocation chained AFTER another command is still read",
                ("gh pr view; ~/.claude/skills/ship-pr/scripts/post-merge-cleanup.sh a b c --keep-branch",),
            ),
            (
                "...and a second invocation of the helper on one line",
                ("~/x/post-merge-cleanup.sh a b c --base main && ~/x/post-merge-cleanup.sh a b c --keep-branch",),
            ),
            (
                "an option after a redirection is still the helper's",
                ("~/x/post-merge-cleanup.sh a b c 2>&1 --keep-branch",),
            ),
            (
                "a quoted helper path is still the helper",
                ('"$HOME/.claude/skills/ship-pr/scripts/post-merge-cleanup.sh" a b c --keep-branch',),
            ),
            ("a quoted option word is the option", ('~/x/post-merge-cleanup.sh a b c "--keep-branch"',)),
            (
                "a bare invocation after a shell operator is the helper",
                ("(post-merge-cleanup.sh a b c --keep-branch)",),
            ),
            ("...and one inside a command substitution", ("out=$(~/x/post-merge-cleanup.sh a b c --keep-branch)",)),
            # A separator inside a quoted or escaped value ends nothing.
            (
                "a separator inside a double-quoted value ends nothing",
                ('~/x/post-merge-cleanup.sh a b c --force-integrated "confirmed; by GitHub" --keep-branch',),
            ),
            (
                "...nor inside a single-quoted one",
                ("~/x/post-merge-cleanup.sh a b c --force-integrated 'a | b' --keep-branch",),
            ),
            (
                "...nor an escaped one",
                ("~/x/post-merge-cleanup.sh a b c --force-integrated confirmed\\; --keep-branch",),
            ),
            (
                "...while a # inside a quoted value is text",
                ('~/x/post-merge-cleanup.sh a b c --force-integrated "not # a comment" --keep-branch',),
            ),
        )
        for label, lines in refused:
            with self.subTest(label):
                cleanup_tree(self.root)
                self.fence(*lines)
                self.expect(label, 1, "passes '--keep-branch'")
        agreed: tuple[tuple[str, tuple[str, ...]], ...] = (
            # The helper's command ends at the first shell separator.
            (
                "an option of a command chained after the helper on its line is that command's",
                (
                    "git fetch origin && ~/.claude/skills/ship-pr/scripts/post-merge-cleanup.sh a b c --base main; gh pr view --json number",
                ),
            ),
            (
                "...and a continuation past a separator is not the helper's either",
                (
                    "~/.claude/skills/ship-pr/scripts/post-merge-cleanup.sh a b c --base main | tee log.txt \\",
                    "  --keep-branch",
                ),
            ),
            # The word after a valued option is its value, whatever it looks like.
            (
                "a valued option's value is its value, however it is spelled",
                ("~/x/post-merge-cleanup.sh a b c --force-integrated --confirmed-by-GitHub --regenerable --cache",),
            ),
            ("...across a continuation too", ("~/x/post-merge-cleanup.sh a b c --base \\", "  --keep-branch")),
            # An unquoted `#` starts a comment the shell passes nothing from.
            (
                "a trailing shell comment passes nothing",
                ("~/x/post-merge-cleanup.sh a b c --base main # never pass --keep-branch here",),
            ),
        )
        for label, lines in agreed:
            with self.subTest(label):
                cleanup_tree(self.root)
                self.fence(*lines)
                self.expect(label, 0, CLEANUP_AGREE)

    def test_fences(self) -> None:
        R = self.root
        prompt = f"{R}/{CLEANUP_PROMPT}"
        # A fence indented up to three blanks is a fence.
        append(prompt, "\n   ```bash\n   ~/x/post-merge-cleanup.sh a b c --keep-branch\n   ```\n")
        self.expect("an indented fence is a fence", 1, "passes '--keep-branch'")
        # A fence closes only on a run as long as its opener.
        cleanup_tree(R)
        append(prompt, "\n````bash\ncat <<X\n```\nX\n~/x/post-merge-cleanup.sh a b c --keep-branch\n````\n")
        self.expect("a three-backtick line inside a four-backtick fence does not close it", 1, "passes '--keep-branch'")

    # The token is the whole word: a suffix the helper's parser refuses is not the listed prefix.
    def test_misspellings(self) -> None:
        R, at = self.root, self.c.line
        edit_line(R, CLEANUP_PROMPT, at=at, pattern="--base main", repl="--base_branch main")
        self.expect(
            "a misspelled option is reported whole, not truncated to its listed prefix", 1, "passes '--base_branch'"
        )
        cleanup_tree(R)
        edit_line(R, CLEANUP_PROMPT, at=at, pattern="--base main", repl="--base=main")
        self.expect("...and so is the = spelling, which the helper does not take", 1, "passes '--base=main'")
        # The listing side uses the same token grammar as the invocation side.
        cleanup_tree(R)
        rewrite(R, CLEANUP_PROMPT, pattern=r"--base([^-A-Za-z0-9_])", repl=r"--base_branch\1", count=0)
        self.expect("a misspelling in prose does not name the listed option", 1, "names no '--base'")

    # ...while an option usage() lists with no <value> placeholder consumes nothing.
    def test_a_flag_consumes_nothing(self) -> None:
        self.add_dry_run()
        append(
            f"{self.root}/{CLEANUP_PROMPT}",
            "\nPass `--dry-run` to rehearse.\n\n```bash\n~/x/post-merge-cleanup.sh a b c --dry-run --keep-branch\n```\n",
        )
        self.expect("a flag option consumes no value, so the word after it is read", 1, "passes '--keep-branch'")

    # The listing side is a mention, verbatim, anywhere in the prompt: the option's command lines
    # deleted and its prose kept still names it. That is the residue this check states rather than
    # hides -- a name present says nothing about whether the prose around it is true.
    def test_a_name_in_prose_names_it(self) -> None:
        delete_lines(self.root, CLEANUP_PROMPT, pattern=r"^  --base \S* --regenerable ")
        self.expect("an option named only in prose is still named", 0, CLEANUP_AGREE)

    # The register is read off the helper's printed usage text, which it renders from the option
    # table its parse loop reads (ludics-lite#332).
    def test_the_usage_text(self) -> None:
        R = self.root
        # A text this reader sees no options in is refused rather than holding the prompt to nothing.
        delete_lines(R, CLEANUP_HELPER, pattern="^  ")
        self.expect(
            "a usage() listing no options is refused, not passed", 1, f"{CLEANUP_HELPER}: usage() lists no options"
        )
        # ...and a run that is not the usage error is no listing at all.
        cleanup_tree(R)
        rewrite(R, CLEANUP_HELPER, pattern="^exit 2$", repl="exit 1")
        self.expect(
            "a helper whose usage error does not exit 2 is refused",
            1,
            f"{CLEANUP_HELPER}: run with no arguments, it printed no usage text",
        )
        # A row's placeholder is both what the text prints and what the parser consumes, so a flag
        # row is listed bare -- and the word after it is read as the next option.
        cleanup_tree(R)
        rewrite(R, CLEANUP_HELPER, pattern=r"^  --regenerable <name>  ", repl="  --regenerable         ")
        self.fence("~/x/post-merge-cleanup.sh a b c --regenerable --keep-branch")
        self.expect(
            "a flag row in the table is listed bare, so the word after it is an option", 1, "passes '--keep-branch'"
        )

    # A helper with no prompt to document it is refused; a root with no helper carries no
    # obligation, as with the sync script and the worker.
    def test_obligations(self) -> None:
        os.remove(f"{self.root}/{CLEANUP_PROMPT}")
        self.expect("a helper without its prompt is refused", 1, f"has no {CLEANUP_PROMPT}")
        fresh(self.root)
        self.lacks(
            "...and a root without the helper carries no option obligation", "post-merge-cleanup", run(CP, self.root)
        )

    # The helper runs with no input, and its usage text is a command substitution's, which drops a
    # NUL (the shell checker's readings, kept by the port).
    def test_how_the_helper_is_run(self) -> None:
        R = self.root
        helper_prelude(R, lines='if [ "$#" -eq 0 ] && read -r _; then echo "usage: stdin was read" >&2; exit 2; fi\n')
        self.expect("the cleanup helper is run with no input", 0, CLEANUP_AGREE, stdin=b"x\n")
        cleanup_tree(R)
        helper_prelude(R, lines="if [ \"$#\" -eq 0 ]; then printf 'usage: x\\n  --base\\000x <b>\\n' >&2; exit 2; fi\n")
        self.expect("a NUL in the usage text is dropped, joining the name around it", 1, "names no '--basex'")




if __name__ == "__main__":
    unittest.main()

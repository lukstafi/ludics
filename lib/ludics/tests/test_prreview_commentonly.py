"""commentonly.py (#861): whether two versions of a file differ in comments and blanks alone,
within its fail-closed allowlist of languages and forms."""

import unittest

from ludics.prreview.commentonly import code_of, language, same_code


class Languages(unittest.TestCase):
    def test_a_file_is_read_by_its_name_and_only_the_allowlist(self) -> None:
        for path, lang in (
            ("a.ml", "ocaml"), ("lib/x/a.mli", "ocaml"), ("dune", "dune"), ("lib/dune", "dune"),
            ("dune-project", "dune"), ("dune-workspace", "dune"),
            ("a.sh", None), ("a.mly", None), ("a.mll", None), ("a.opam", None), ("notes.md", None),
            ("a.ML", None), ("dune.inc", None), ("mydune", None),
        ):
            with self.subTest(path=path):
                self.assertEqual(language(path), lang)

    def test_any_other_file_never_differs_in_comments_only(self) -> None:
        self.assertFalse(same_code("a.sh", "x # one\n", "x # two\n"))
        self.assertFalse(same_code("notes.md", "a\n", "a\n"), "not even unchanged: it is never read")


class OCaml(unittest.TestCase):
    def test_comments_and_blanks_are_no_change(self) -> None:
        old = "let f x =\n  x + 1 (* one *)\n\n(** The doc. *)\nval g : int\n"
        new = "let f x = x + 1\n(* a new\n   comment (* nested *) *)\n(** The doc,\n    reworded. *)\nval g :\n  int\n"
        self.assertTrue(same_code("a.ml", old, new))
        self.assertTrue(same_code("a.mli", "val f : int\n", "(** Added. *)\nval f : int\n"))

    def test_code_is_a_change(self) -> None:
        self.assertFalse(same_code("a.ml", "let x = 1 (* c *)\n", "let x = 2 (* c *)\n"))
        self.assertFalse(same_code("a.ml", "let ab = 1\n", "let a(* c *)b = 1\n"), "a comment splits a token")

    def test_strings_are_kept_whole(self) -> None:
        self.assertFalse(same_code("a.ml", 'let s = "a  b"\n', 'let s = "a b"\n'), "blanks in a string are code")
        self.assertFalse(same_code("a.ml", 'let s = "(* x *)"\n', 'let s = "(* y *)"\n'), "no comment in a string")
        self.assertFalse(same_code("a.ml", "let s = {|(* x *)|}\n", "let s = {|(* y *)|}\n"))
        self.assertFalse(same_code("a.ml", "let s = {id|a |} b|id}\n", "let s = {id|a |} c|id}\n"))
        self.assertTrue(same_code("a.ml", 'let s = "a" (* c *)\n', 'let s = "a"\n'))

    def test_a_string_or_char_inside_a_comment_ends_nothing(self) -> None:
        # The "*)" inside the comment's string does not end it, so the code after is still code.
        self.assertFalse(same_code("a.ml", '(* "*)" *) let x = 1\n', '(* "*)" *) let x = 2\n'))
        self.assertTrue(same_code("a.ml", "(* '\"' *) let x = 1\n", "(* '\"' changed *) let x = 1\n"))
        self.assertTrue(same_code("a.ml", "(* {|*)|} *) let x = 1\n", "let x = 1\n"))

    def test_character_literals_and_primes(self) -> None:
        self.assertEqual(code_of("a.ml", "let c = '\"' (* c *)\n"), "let c = '\"'")
        self.assertEqual(code_of("a.ml", "let x' = 'a' and y = '\\n'\n"), "let x' = 'a' and y = '\\n'")
        self.assertEqual(code_of("a.ml", "type 'a t = 'a list\n"), "type 'a t = 'a list")
        # x' is one identifier, so its quote starts no character literal and the string is code.
        self.assertFalse(same_code("a.ml", "let x' = \"(* a *)\"\n", "let x' = \"(* b *)\"\n"))

    def test_what_it_gives_up_on_is_code(self) -> None:
        for text in (
            "(* unterminated\nlet x = 1\n",
            'let s = "unterminated\n',
            "let s = {id|unterminated|\n",
            "# 1 \"other.ml\"\nlet x = 1\n",
            "  (* c *) #use \"x.ml\"\n",
            "let x = {%ext|q|}\n",
            "let caf\u00e9 = 1\n",
            "(* '\\\"x\" *) let x = 1\n",
            "(* a'\"b\" *) let x = 1\n",
        ):
            with self.subTest(text=text):
                self.assertIsNone(code_of("a.ml", text))
                self.assertFalse(same_code("a.ml", text, text), "never read, so never the same")

    def test_a_method_call_is_not_a_directive(self) -> None:
        self.assertEqual(code_of("a.ml", "let x = o#m (* c *)\n"), "let x = o#m")

    def test_non_ascii_in_comments_and_strings_is_read(self) -> None:
        self.assertTrue(same_code("a.ml", 'let s = "\u00e9" (* caf\u00e9 *)\n', 'let s = "\u00e9" (* th\u00e9 *)\n'))


class Dune(unittest.TestCase):
    def test_line_comments_and_blanks_are_no_change(self) -> None:
        old = "(library\n (name foo) ; the library\n (libraries bar))\n"
        new = "; header\n(library (name foo)\n  (libraries bar)) ; trailing\n"
        self.assertTrue(same_code("lib/dune", old, new))

    def test_a_semicolon_in_a_string_is_code(self) -> None:
        self.assertFalse(same_code("dune", '(rule (action (run x "a;b")))\n', '(rule (action (run x "a;c")))\n'))
        self.assertEqual(code_of("dune", '(x "a ; b") ; c\n'), '(x "a ; b")')

    def test_code_is_a_change(self) -> None:
        self.assertFalse(same_code("dune", "(library (name foo))\n", "(library (name bar))\n"))

    def test_what_it_gives_up_on_is_code(self) -> None:
        for text in ("#| block |#\n(x)\n", "#;(x)\n(y)\n", '(x "\\| verbatim\n)\n', '(x "\\> verbatim\n)\n', '(x "open\n'):
            with self.subTest(text=text):
                self.assertIsNone(code_of("dune", text))


if __name__ == "__main__":
    unittest.main()

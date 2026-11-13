"""Closed lexical call forms, helper propagation and listing refusal."""
import unittest

from ludics.fleetworker.suitecalls import sections_calling


class SuiteCallsTests(unittest.TestCase):
    def test_direct_wrapped_and_continued(self) -> None:
        source = '''section "one" && {
"$FW" log testbox x
"${FWX[@]}" execution conclude --from-run x
"${FWS2[@]}" execution \\
slot -- true
}
section "two" && {
"${FWR[@]}" execution rebind file
}
'''
        self.assertEqual(sections_calling(source, ("log",)), ["one"])
        self.assertEqual(sections_calling(source, ("execution", "slot")), ["one"])
        self.assertEqual(sections_calling(source, ("execution", "conclude", "--from-run")), ["one"])
        self.assertEqual(sections_calling(source, ("execution", "rebind")), ["two"])

    def test_helpers_transitive_and_definitions_not_calls(self) -> None:
        source = '''settle() { "$FW" attach x; "$FW" close x; }
need_worker() {
  "$FW" launch x
  settle x
}
section "one" && {
need_worker x
}
section "two" && {
# need_worker x
"$FW" status x
}
'''
        for verb in ("launch", "attach", "close"):
            self.assertEqual(sections_calling(source, (verb,)), ["one"])
        self.assertEqual(sections_calling(source, ("status",)), ["two"])

    def test_closed_boundary_and_exact_prefix(self) -> None:
        source = '''section "one" && {
$FW log x
"$FW" "$verb" x
"${OTHER[@]}" log x
"$FW" logger x
}
'''
        self.assertEqual(sections_calling(source, ("log",)), [])
        self.assertEqual(sections_calling(source, ("logger",)), ["one"])

    def test_missing_section_is_still_listed_from_suite(self) -> None:
        source = '''section "kept" && { "$FW" log x; }
section "removed-from-map" && { "$FW" log y; }
'''
        self.assertEqual(sections_calling(source, ("log",)), ["kept", "removed-from-map"])

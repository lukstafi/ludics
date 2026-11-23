"""ludics.claude: shared read-only ``claude -p`` argv builder."""

import unittest

from ludics import claude


class ReadonlyArgv(unittest.TestCase):
    def test_builtin_tools_shape_carries_strict_mcp_config_and_no_mcp_config(self) -> None:
        argv = claude.readonly_argv("fable", claude.BuiltinTools("Read,Grep,Glob"), effort="high")
        self.assertEqual(
            argv,
            ["-p", "--model", "fable", "--effort", "high", "--output-format", "json", "--strict-mcp-config",
             "--tools", "Read,Grep,Glob"],
        )
        self.assertNotIn("--mcp-config", argv)
        self.assertNotIn("--no-session-persistence", argv)

    def test_builtin_tools_accepts_empty_spec_with_no_persistence(self) -> None:
        argv = claude.readonly_argv("opus", claude.BuiltinTools(""), persist=False)
        self.assertEqual(
            argv,
            ["-p", "--model", "opus", "--output-format", "json", "--no-session-persistence", "--strict-mcp-config",
             "--tools", ""],
        )
        self.assertNotIn("--mcp-config", argv)

    def test_resume_appends_session_id_keeping_mcp_and_tool_bounds(self) -> None:
        base = claude.readonly_argv("fable", claude.BuiltinTools("Read,Grep,Glob"), effort="high")
        resumed = claude.readonly_argv("fable", claude.BuiltinTools("Read,Grep,Glob"), effort="high", resume="sid-1")
        self.assertEqual(resumed, [*base, "--resume", "sid-1"])

    def test_tool_rules_places_strict_mcp_config_before_variadic_tool_flags(self) -> None:
        argv = claude.readonly_argv(
            "opus",
            claude.ToolRules(["Bash(git -C /r show:*)", "Read"], ["Edit", "Write", "NotebookEdit"]),
            persist=False,
        )
        self.assertEqual(
            argv,
            ["-p", "--model", "opus", "--output-format", "json", "--no-session-persistence", "--strict-mcp-config",
             "--allowedTools", "Bash(git -C /r show:*)", "Read", "--disallowedTools", "Edit", "Write", "NotebookEdit"],
        )
        self.assertLess(argv.index("--strict-mcp-config"), argv.index("--allowedTools"))
        self.assertNotIn("--mcp-config", argv)

    def test_invalid_inputs_are_refused(self) -> None:
        cases: list[tuple[str, dict[str, object]]] = [
            ("empty model", {"model": "", "bound": claude.BuiltinTools("Read")}),
            ("flag model", {"model": "--mcp-config", "bound": claude.BuiltinTools("Read")}),
            ("flag effort", {"model": "opus", "bound": claude.BuiltinTools("Read"), "effort": "--high"}),
            ("resume without persistence", {"model": "opus", "bound": claude.BuiltinTools("Read"), "persist": False, "resume": "sid-1"}),
            ("flag resume", {"model": "opus", "bound": claude.BuiltinTools("Read"), "resume": "--mcp-config"}),
            ("flag tools spec", {"model": "opus", "bound": claude.BuiltinTools("--mcp-config")}),
            ("empty allowed", {"model": "opus", "bound": claude.ToolRules([], ["Edit"])}),
            ("empty disallowed", {"model": "opus", "bound": claude.ToolRules(["Read"], [])}),
            ("empty rule entry", {"model": "opus", "bound": claude.ToolRules(["Read", ""], ["Edit"])}),
            ("flag in allowed", {"model": "opus", "bound": claude.ToolRules(["--mcp-config"], ["Edit"])}),
            ("flag in disallowed", {"model": "opus", "bound": claude.ToolRules(["Read"], ["--mcp-config"])}),
        ]
        for label, kwargs in cases:
            with self.subTest(label), self.assertRaises(ValueError):
                claude.readonly_argv(**kwargs)  # type: ignore[arg-type]


if __name__ == "__main__":
    unittest.main()

"""tests/fake.py's FakeTool: the order script, and the argv routes four suites answer through."""

import os
import shutil
import subprocess
import unittest

from ludics.tests.fake import Answer, FakeTool, When


class Routes(unittest.TestCase):
    def setUp(self) -> None:
        self.tool = FakeTool("tool")
        self.addCleanup(shutil.rmtree, self.tool.dir, True)

    def run_tool(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run([os.path.join(self.tool.dir, "tool"), *args], capture_output=True, text=True,
                              check=False)

    def test_the_order_script_ignores_the_arguments(self) -> None:
        self.tool.script(Answer(stdout="one\n"), Answer(rc=3, stdout="two\n"))
        self.assertEqual(self.run_tool("api", "user").stdout, "one\n")
        self.assertEqual(self.run_tool("issue", "view").returncode, 3)
        self.assertEqual(self.run_tool("anything").stdout, "two\n", "the last answer repeats")

    def test_the_first_route_whose_conditions_all_hold_answers(self) -> None:
        self.tool.route(
            (When(prefix=("api", "user")), Answer(stdout="login\n")),
            (When(prefix=("api",), has=("repos/o/r/pulls/7",)), Answer(stdout="pull\n")),
            (When(text=("--jq .x", "pulls")), Answer(stdout="filtered\n")),
            (When(prefix=("issue",)), Answer(rc=4, stderr="nope\n")),
        )
        self.assertEqual(self.run_tool("api", "user", "--jq", ".login").stdout, "login\n")
        self.assertEqual(self.run_tool("api", "repos/o/r/pulls/7").stdout, "pull\n")
        self.assertEqual(self.run_tool("api", "repos/o/r/pulls/7/reviews", "--jq", ".x").stdout, "filtered\n",
                         "has is one whole argument, not a prefix of one")
        self.assertEqual(self.run_tool("user", "api").returncode, 99, "a prefix is where argv starts")
        done = self.run_tool("issue", "view", "7")
        self.assertEqual((done.returncode, done.stderr), (4, "nope\n"))
        done = self.run_tool("pr", "merge", "7")
        self.assertEqual((done.returncode, done.stderr), (99, "fake tool: no route for: pr merge 7\n"))
        self.assertEqual(self.tool.calls()[0], ["api", "user", "--jq", ".login"])
        self.assertEqual(len(self.tool.calls()), 6)
        self.tool.route(otherwise=Answer(rc=1, stderr="404\n"))
        self.assertEqual(self.tool.calls(), [], "a new script resets the log")
        self.assertEqual(self.run_tool("pr", "merge").returncode, 1)

    def test_a_jq_answer_prints_through_the_calls_filter(self) -> None:
        if shutil.which("jq") is None:
            self.skipTest("no jq")
        self.tool.route((When(), Answer(stdout='{"a": {"b": "x"}}\n', jq=True)))
        self.assertEqual(self.run_tool("api", "e", "--jq", ".a.b").stdout, "x\n")
        self.assertEqual(self.run_tool("api", "e").stdout, '{"a": {"b": "x"}}\n', "no --jq, no filter")
        self.assertNotEqual(self.run_tool("api", "e", "--jq", ".[").returncode, 0, "jq's refusal fails the run")

    def test_through_runs_the_real_binary_when_no_route_answers(self) -> None:
        real = shutil.which("echo")
        assert real is not None
        self.tool.route((When(has=("fail",)), Answer(rc=128, stderr="injected\n")), through=real)
        self.assertEqual(self.run_tool("hello", "there").stdout, "hello there\n")
        self.assertEqual(self.run_tool("please", "fail").returncode, 128)
        self.assertEqual(self.tool.calls(), [["hello", "there"], ["please", "fail"]])
        for bad in ("echo", os.path.join(self.tool.dir, "tool")):
            with self.subTest(through=bad), self.assertRaises(ValueError):
                self.tool.route(through=bad)
        with self.assertRaises(ValueError):
            self.tool.route(otherwise=Answer(), through=real)


if __name__ == "__main__":
    unittest.main()

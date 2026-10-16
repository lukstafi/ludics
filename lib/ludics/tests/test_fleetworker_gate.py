"""``fleet-worker.sh gate``: the reader of the checker's ``--advisory-red`` file (ludics-lite#651).

The gate's whole flow -- the checker's call, the file staged for it, the ADVISORY-RED lines and
every refusal -- is pinned end to end in issue-wave/scripts/test-fleet-worker.sh's "base gate"
section; what is here is the reader's allowlist one input at a time.
"""

import unittest

from ludics.fleetworker.gate import advisory_red_jobs

SHA = "0123456789abcdef0123456789abcdef01234567"


class AdvisoryRedFile(unittest.TestCase):
    def test_the_jobs_and_their_commits_in_the_checkers_order(self) -> None:
        text = (
            '[{"workflow":"skill scripts","sha":"%s","run":"7","job":"bash 3.2 suites, a (macos)","conclusion":"failure"},'
            ' {"job":"bash 3.2 suites, b (macos)","sha":"%s"}]\n' % (SHA, SHA)
        )
        self.assertEqual(
            advisory_red_jobs(text), [("bash 3.2 suites, a (macos)", SHA), ("bash 3.2 suites, b (macos)", SHA)]
        )

    def test_none_is_an_empty_array(self) -> None:
        self.assertEqual(advisory_red_jobs("[]\n"), [])

    def test_anything_else_refuses(self) -> None:
        for text in (
            "",
            "\n",
            "not json",
            "{}",
            "null",
            '["x"]',
            '[{"job":"x"}]',
            '[{"sha":"%s"}]' % SHA,
            '[{"job":"","sha":"%s"}]' % SHA,
            '[{"job":7,"sha":"%s"}]' % SHA,
            '[{"job":"x","sha":"%s"}]' % SHA.upper(),
            '[{"job":"x","sha":"%s"}]' % SHA[:8],
            '[{"job":"x","sha":"%s"}, 1]' % SHA,
        ):
            with self.subTest(text=text):
                self.assertIsNone(advisory_red_jobs(text))


if __name__ == "__main__":
    unittest.main()

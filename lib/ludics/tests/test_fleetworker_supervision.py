"""ludics.fleetworker.supervision: ``prs`` ends a read that printed PRs with one line naming each
of them, so a reader's ``tail`` that cut the first PR line still names that PR (ludics#1050)."""

import contextlib
import io
import json
import os
import shutil
import tempfile
import unittest

from ludics.fleetworker import supervision
from ludics.fleetworker.config import load_config
from ludics.tests import fake
from ludics.tests.fake import Answer, When


def pr(number: int, branch: str) -> dict[str, object]:
    return {"number": number, "title": f"PR {number}", "headRefName": branch, "headRefOid": f"c{number}",
            "createdAt": "2026-11-10T16:48:32Z", "isDraft": False, "isCrossRepository": False,
            "closingIssuesReferences": []}


class PrsTally(unittest.TestCase):
    """The open-PR list, ``rounds``, ``checks`` and the head's date come from a fake pr-review.sh
    in a scratch checkout, run the way ``cmd_prs`` runs it: through the binary."""

    def setUp(self) -> None:
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="ludics-prs-tally."))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.helper = fake.FakeTool("pr-review.sh")
        self.addCleanup(shutil.rmtree, self.helper.dir, ignore_errors=True)
        scripts = os.path.join(self.root, "ship-pr", "scripts")
        os.makedirs(scripts)
        wrapper = os.path.join(scripts, "pr-review.sh")
        with open(wrapper, "w", encoding="utf-8") as f:
            f.write(f'#!/bin/sh\nexec "{os.path.join(self.helper.dir, "pr-review.sh")}" "$@"\n')
        os.chmod(wrapper, 0o755)
        self.cfg = load_config(os.path.join(self.root, "issue-wave", "scripts", "fleet-worker.sh"),
                               {"FLEET_LOCAL_BOX": ""}, host="unmapped")

    def answer(self, listing: list[dict[str, object]]) -> None:
        self.helper.route(
            (When(prefix=("retry", "--read", "pr", "list")), Answer(stdout=json.dumps(listing))),
            (When(prefix=("rounds",)), Answer(stdout="rounds: n=1 threshold=off first=0\n")),
            (When(prefix=("checks",)), Answer(stdout="green\nchecks: verdict=green branch=current\n")),
            (When(prefix=("retry", "--read", "api")), Answer(stdout="2026-11-10T17:10:00Z\n")),
        )

    def prs(self, *args: str) -> tuple[int, list[str]]:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = supervision.cmd_prs(self.cfg, ["o/r", *args])
        return rc, out.getvalue().splitlines()

    def test_the_last_line_names_every_pr_printed_in_order(self) -> None:
        self.answer([pr(1880, "claude/w1110-2036"), pr(1877, "claude/w1110-2027"), pr(1878, "claude/w1110-2102")])
        rc, lines = self.prs()
        self.assertEqual(rc, 0, lines)
        self.assertEqual([line.split(" ")[0] for line in lines[:-1]], ["o/r#1877", "o/r#1878", "o/r#1880"])
        self.assertEqual(lines[-1], "PRS o/r: 3 open PRs listed above: #1877 #1878 #1880")

    def test_a_tail_that_cut_the_first_pr_line_still_names_that_pr(self) -> None:
        """The heartbeat of ludics#1050: read through ``tail``, its first PR line was gone."""
        self.answer([pr(n, f"claude/w1110-{n}") for n in (1877, 1878, 1880, 1881, 1882, 1883)])
        _, lines = self.prs()
        kept = lines[-5:]
        self.assertFalse(any(line.startswith("o/r#1877 ") for line in kept), kept)
        self.assertIn("#1877", kept[-1].split(" "))

    def test_one_pr_is_spelled_in_the_singular(self) -> None:
        self.answer([pr(7, "claude/issue-7")])
        _, lines = self.prs()
        self.assertEqual(lines[-1], "PRS o/r: 1 open PR listed above: #7")

    def test_a_read_with_no_pr_ends_with_its_no_open_prs_line_alone(self) -> None:
        self.answer([])
        rc, lines = self.prs()
        self.assertEqual((rc, lines), (0, ["PRS o/r: no open PRs"]))


if __name__ == "__main__":
    unittest.main()

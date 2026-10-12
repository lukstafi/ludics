"""ludics.prreview.budget: the polling budget's pieces no command line reaches.

ship-pr/scripts/test-pr-review-budget.sh drives the budget through the commands. What is pinned here
is what no command of pr-review.sh can show from outside: the endpoint parse of call shapes the
script never makes itself (a run view whose options precede its id, a job-only view, GH_REPO), the
reap's race, and a write made inside an observer's ceiling (watch's re-request).
"""

import contextlib
import io
import os
import shutil
import tempfile
import unittest
from collections.abc import Sequence
from unittest import mock

from ludics import proc
from ludics.prreview import budget, core
from ludics.prreview.budget import Budget, Hold, endpoint, pause
from ludics.prreview.core import GhOk, GhSession, GhUnanswered

T0 = 1_800_000_000


class FakeClock:
    """Whole seconds; a sleep is recorded and advances the clock."""

    def __init__(self, start: int = T0) -> None:
        self.t = start
        self.slept: list[float] = []

    def now(self) -> int:
        return self.t

    def time(self) -> float:
        return float(self.t)

    def sleep(self, seconds: float, /) -> None:
        self.slept.append(seconds)
        self.t += int(seconds)


class Gh:
    """A gh that records its calls and answers each with the next scripted completion."""

    def __init__(self, *answers: proc.Completed) -> None:
        self.answers = list(answers) or [proc.Completed(0, "", "")]
        self.calls: list[list[str]] = []

    def __call__(self, name: str, args: Sequence[str]) -> proc.Completed:
        self.calls.append([name, *args])
        return self.answers[min(len(self.calls) - 1, len(self.answers) - 1)]


def headers(status: str, *lines: str, body: str = "{}") -> proc.Completed:
    return proc.Completed(0, "\r\n".join([status, *lines]) + "\r\n\r\n" + body + "\n", "")


class Scratch(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = os.path.realpath(tempfile.mkdtemp(prefix="ludics-budget-test."))
        self.clock = FakeClock()
        self.gh = Gh()

    def tearDown(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)

    def budget(self, *, env: dict[str, str] | None = None, alive: bool = False) -> Budget:
        return Budget(self.dir, self.clock, env=env or {}, run=self.gh, pid=4242,
                      alive=lambda _pid: alive)

    def plant(self, until: int, ep: str, length: int, name: str = "planted") -> None:
        holds = os.path.join(self.dir, "quota-holds")
        os.makedirs(holds, exist_ok=True)
        with open(os.path.join(holds, f"{until}.{name}"), "w", encoding="utf-8") as f:
            f.write(f"{ep}\t{length}\tits headers\n")


class Endpoint(unittest.TestCase):
    def test_a_run_view_s_option_values_are_not_its_id(self) -> None:
        self.assertEqual(endpoint(["run", "view", "--json", "status", "123", "--repo", "o/r"]),
                         "repos/o/r/actions/runs/123")
        self.assertEqual(endpoint(["run", "view", "-R", "o/r", "--jq", ".status", "--attempt", "2", "-t",
                                   "x", "456"]), "repos/o/r/actions/runs/456")

    def test_a_job_only_view_reads_the_job(self) -> None:
        self.assertEqual(endpoint(["run", "view", "--job", "456", "--repo", "o/r"]),
                         "repos/o/r/actions/jobs/456")
        self.assertEqual(endpoint(["run", "view", "--job=7", "--repo=o/r"]), "repos/o/r/actions/jobs/7")

    def test_gh_repo_names_the_repository_when_no_flag_does(self) -> None:
        self.assertEqual(endpoint(["run", "view", "123"], "o/r"), "repos/o/r/actions/runs/123")
        self.assertEqual(endpoint(["run", "view", "123", "-R", "github.com/a/b"], "o/r"),
                         "repos/a/b/actions/runs/123")

    def test_an_endpoint_that_cannot_be_told_is_empty(self) -> None:
        self.assertEqual(endpoint(["run", "view", "123"]), "")
        self.assertEqual(endpoint(["api", "-X", "GET"]), "")

    def test_api_and_everything_else(self) -> None:
        self.assertEqual(endpoint(["api", "-H", "Accept: x", "/repos/o/r/pulls/7", "--jq", ".x"]),
                         "repos/o/r/pulls/7")
        self.assertEqual(endpoint(["api", "--paginate", "repos/o/r/issues"]), "repos/o/r/issues")
        self.assertEqual(endpoint(["pr", "merge", "7"]), "graphql")
        self.assertEqual(endpoint(["run", "list"]), "graphql")


class Pause(unittest.TestCase):
    def test_doubling_to_the_cap(self) -> None:
        seq: list[int] = []
        prev: int | None = None
        for _ in range(6):
            prev = pause(60, 600, prev, False)
            seq.append(prev)
        self.assertEqual(seq, [60, 120, 240, 480, 600, 600])
        self.assertEqual(pause(60, 600, 480, True), 60, "a change resets it")
        self.assertEqual(pause(90, 30, 90, False), 90, "a cap under the interval keeps it fixed")


class Classification(unittest.TestCase):
    def test_a_quota_refusal_is_no_answer(self) -> None:
        line = "gh: API rate limit exceeded for user ID 1. (HTTP 403)"
        self.assertTrue(core.quota_failure(line))
        self.assertFalse(core.api_rejection(line))
        self.assertTrue(core.api_rejection("gh: Not Found (HTTP 404)"))
        self.assertTrue(core.quota_failure("GraphQL: API rate limit already exceeded for user ID 1."))
        self.assertTrue(core.quota_failure("You have exceeded a secondary rate limit"))
        self.assertFalse(core.quota_failure("gh: Resource not accessible by integration (HTTP 403)"))


class Probe(Scratch):
    def probe(self, answer: proc.Completed) -> str:
        self.gh = Gh(answer)
        return self.budget().probe("repos/o/r/pulls/7")

    def test_the_answers(self) -> None:
        self.assertEqual(self.probe(headers("HTTP/2.0 429 Too Many", "Retry-After: 30")), f"quota {T0 + 30}")
        self.assertEqual(self.probe(headers("HTTP/2.0 403 Forbidden", "X-Ratelimit-Remaining: 0",
                                            f"X-Ratelimit-Reset: {T0 + 900}")), f"quota {T0 + 900}")
        self.assertEqual(self.probe(headers("HTTP/2.0 200 OK", "X-Ratelimit-Remaining: 0",
                                            f"X-Ratelimit-Reset: {T0 + 5}")), f"quota {T0 + 5}")
        self.assertEqual(self.probe(headers("HTTP/2.0 200 OK", body='{"message":"a secondary rate limit"}')),
                         "quota 0")
        self.assertEqual(self.probe(headers("HTTP/2.0 200 OK", "X-Ratelimit-Remaining: 4999")), "ok")
        self.assertEqual(self.probe(headers("HTTP/2.0 404 Not Found")), "down")
        self.assertEqual(self.probe(headers("HTTP/2.0 404 Not Found", "X-Ratelimit-Remaining: 12")), "ok")
        self.assertEqual(self.probe(headers("HTTP/2.0 502 Bad Gateway")), "down")
        self.assertEqual(self.probe(proc.Completed(1, "", "gh: connection refused")), "down")

    def test_it_names_github_com_and_the_endpoint(self) -> None:
        self.probe(headers("HTTP/2.0 200 OK"))
        self.assertEqual(self.gh.calls[0], ["gh", "api", "-i", "--hostname", "github.com", "repos/o/r/pulls/7"])
        self.gh = Gh(headers("HTTP/2.0 200 OK"))
        self.budget().probe("graphql")
        self.assertEqual(self.gh.calls[0][:6], ["gh", "api", "-i", "--hostname", "github.com", "graphql"])


class Holds(Scratch):
    def test_a_later_refusal_never_shortens_the_hold(self) -> None:
        b = self.budget()
        self.plant(T0 + 3600, "graphql", 3600)
        self.assertTrue(b.hold_set("repos/o/r/pulls/7", f"quota {T0 + 60}"))
        self.assertEqual(b.hold_read(), Hold(T0 + 3600, "graphql", 3600, "its headers"))
        self.assertTrue(b.hold_set("repos/o/r/pulls/7", f"quota {T0 + 5400}"))
        self.assertEqual(b.hold_read(), Hold(T0 + 5400, "repos/o/r/pulls/7", 5400, "its headers"))

    def test_the_backoff_doubles_from_the_last_lift_up_to_an_hour(self) -> None:
        b = self.budget()
        self.assertTrue(b.hold_set("graphql", "down"))
        standing = b.hold_read()
        assert standing is not None
        self.assertEqual((standing.length, standing.src), (60, "the probe got no reading; backing off"))
        self.clock.t = standing.until
        b.hold_lift("graphql", self.clock.t)
        self.assertIsNone(b.hold_read())
        self.assertTrue(b.hold_set("graphql", "ok"))
        again = b.hold_read()
        assert again is not None
        self.assertEqual(again.length, 120)
        self.plant(self.clock.t + 3000, "graphql", 3000, "long")
        self.assertTrue(b.hold_set("graphql", "unprobed"))
        top = b.hold_read()
        assert top is not None
        self.assertEqual(top.length, 3600)

    def test_a_lift_keeps_another_endpoint_and_a_later_entry(self) -> None:
        b = self.budget()
        self.plant(T0 - 5, "graphql", 600, "a")
        self.plant(T0 - 1, "repos/o/r/pulls/7", 600, "b")
        self.plant(T0 + 900, "graphql", 900, "c")
        b.hold_lift("graphql", T0)
        names = sorted(os.listdir(os.path.join(self.dir, "quota-holds")))
        self.assertEqual(names, sorted([f"{T0 + 900}.c", f"{T0 - 1}.b"]))
        with open(os.path.join(self.dir, "quota-last"), encoding="utf-8") as f:
            self.assertEqual(f.read(), f"{T0}\t600\n")

    def test_a_refusal_in_the_lift_doubles_from_the_lifted_hold(self) -> None:
        # ludics-lite#551: the lift removed the last entry before writing quota-last, so a refusal
        # landing in between found neither and held for a minute instead of doubling.
        b = self.budget()
        self.plant(T0 - 1, "graphql", 600)
        landed: list[Hold | None] = []
        real_remove = os.remove

        def remove_then_refuse(path: str) -> None:
            real_remove(path)
            if not landed:
                b.hold_set("repos/o/r/pulls/7", "unprobed")
                landed.append(b.hold_read())

        with mock.patch.object(budget.os, "remove", remove_then_refuse):
            b.hold_lift("graphql", T0)
        self.assertEqual(len(landed), 1)
        refusal = landed[0]
        assert refusal is not None
        self.assertEqual(refusal.length, 1200, "doubled from the hold just lifted")

    def test_quota_hit_says_when_the_hold_cannot_be_recorded(self) -> None:
        with open(os.path.join(self.dir, "quota-holds"), "w", encoding="utf-8"):
            pass
        self.gh = Gh(headers("HTTP/2.0 403 Forbidden", "X-Ratelimit-Remaining: 0", f"X-Ratelimit-Reset: {T0 + 60}"))
        why = self.budget().quota_hit(["api", "repos/o/r/pulls/7"])
        assert why is not None
        self.assertIn("SHIP_PR_STATE_DIR", why)
        self.assertIsNone(self.budget().quota_hit(["run", "view", "5"]), "nothing to record is no error")

    def test_an_entry_this_did_not_write_is_no_hold(self) -> None:
        holds = os.path.join(self.dir, "quota-holds")
        os.makedirs(holds)
        with open(os.path.join(holds, f"{T0 + 60}.x"), "w", encoding="utf-8") as f:
            f.write("graphql\tsixty\tits headers\n")
        self.assertIsNone(self.budget().hold_read())


class Locks(Scratch):
    def test_a_reap_keeps_a_lock_retaken_meanwhile(self) -> None:
        lock = os.path.join(self.dir, "lock")
        os.makedirs(lock)
        with open(os.path.join(lock, "owner"), "w", encoding="utf-8") as f:
            f.write(f"77\n{T0}\n")
        b = self.budget()
        b.lock_reap(lock, "999999")
        with open(os.path.join(lock, "owner"), encoding="utf-8") as f:
            self.assertEqual(f.readline(), "77\n", "a lock judged by another owner is put back")
        b.lock_reap(lock, "77")
        self.assertEqual([n for n in os.listdir(self.dir) if "lock" in n], [],
                         "the judged one is removed, nothing left aside")

    def test_a_lock_that_cannot_be_made_is_status_2_at_once(self) -> None:
        with open(os.path.join(self.dir, "a-file"), "w", encoding="utf-8"):
            pass
        self.assertEqual(self.budget().lock_take(os.path.join(self.dir, "a-file", "lock")).rc, 2)
        self.assertEqual(self.clock.slept, [])

    def test_an_owner_that_cannot_be_written_is_status_2_and_no_lock(self) -> None:
        # A lock left ownerless is reaped by the next claimant a second later, while its taker
        # still acts on it: the take fails instead, and gives the directory back.
        lock = os.path.join(self.dir, "lock")
        real_open = open

        def refuse(path: str, *args: object, **kwargs: object) -> object:
            if path == os.path.join(lock, "owner"):
                raise OSError(28, "No space left on device")
            return real_open(path, *args, **kwargs)  # type: ignore[call-overload]
        with mock.patch("builtins.open", refuse):
            self.assertEqual(self.budget().lock_take(lock).rc, 2)
        self.assertFalse(os.path.exists(lock))

    def test_a_live_holder_is_named_and_a_dead_one_replaced(self) -> None:
        lock = os.path.join(self.dir, "lock")
        os.makedirs(lock)
        with open(os.path.join(lock, "owner"), "w", encoding="utf-8") as f:
            f.write(f"77\n{T0 - 5}\n")
        taken = self.budget(alive=True).lock_take(lock)
        self.assertEqual((taken.rc, taken.holder, taken.since), (1, "77", str(T0 - 5)))
        self.assertEqual(self.budget(alive=False).lock_take(lock).rc, 0)
        with open(os.path.join(lock, "owner"), encoding="utf-8") as f:
            self.assertEqual(f.read(), f"4242\n{T0}\n")

    def test_a_lock_names_the_pid_the_shells_kill_reads(self) -> None:
        # Under Git Bash that is the MSYS pid scripts/py noted, not the interpreter's Windows pid.
        lock = os.path.join(self.dir, "lock")
        with mock.patch.object(proc, "_shell_pid", 2380):
            self.assertEqual(Budget(self.dir, self.clock, env={}, run=self.gh).lock_take(lock).rc, 0)
        with open(os.path.join(lock, "owner"), encoding="utf-8") as f:
            self.assertEqual(f.readline(), "2380\n")

    def test_under_git_bash_only_the_shell_reads_a_pid(self) -> None:
        # MSYS numbers its processes apart from Windows: a Windows process of the lock's number is
        # an unrelated one, and os.kill there would terminate it.
        with (
            mock.patch.object(budget.sys, "platform", "win32"),
            mock.patch.object(budget, "_bash_pid_alive", return_value=False) as bash,
            mock.patch.object(budget.os, "kill") as kill,
        ):
            self.assertFalse(budget.pid_alive(str(os.getpid())))
        bash.assert_called_once_with(str(os.getpid()))
        kill.assert_not_called()


class Session(Scratch):
    def session(self, b: Budget) -> GhSession:
        config = core.load_config({"SHIP_PR_API_ATTEMPTS": "4", "SHIP_PR_API_BACKOFF": "5"})
        return GhSession(config, run=self.gh, sleep=self.clock.sleep, budget=b)

    def test_a_write_never_waits_a_hold_inside_an_observer(self) -> None:
        # The one write an observer makes is watch's re-request, sent with the window's ceiling set.
        b = self.budget()
        b.wait_until = T0 + 7200
        self.plant(T0 + 600, "repos/o/r/pulls/7", 600)
        s = self.session(b)
        with contextlib.redirect_stderr(io.StringIO()):
            result = s.retry("write", ["api", "-X", "POST", "repos/o/r/issues/7/comments", "-f", "body=x"])
        self.assertEqual(result, GhUnanswered())
        self.assertEqual((self.gh.calls, self.clock.slept), ([], []))
        self.assertIn("quota hold until", s.err_line())
        # A read in the same observer waits it out.
        self.gh.answers = [headers("HTTP/2.0 200 OK", "X-Ratelimit-Remaining: 9"), proc.Completed(0, "sha\n", "")]
        with contextlib.redirect_stderr(io.StringIO()):
            read = s.retry("read", ["api", "repos/o/r/pulls/7", "--jq", ".head.sha"])
        self.assertEqual(read, GhOk("sha"))
        self.assertEqual(self.clock.slept, [600])

    def test_a_forwarded_merge_is_still_gated(self) -> None:
        self.plant(T0 + 600, "graphql", 600)
        s = self.session(self.budget())
        args = ["pr", "merge", "7", "--repo", "o/r", "--squash"]
        self.assertEqual(s.retry_caller("write", args, listed=False, budgeted=True), GhUnanswered())
        self.assertEqual(self.gh.calls, [])
        # A retry caller's call is outside the budget: the hold does not stop it.
        self.assertEqual(s.retry_caller("write", args, listed=False), GhOk(""))
        self.assertEqual(len(self.gh.calls), 1)


class Environment(unittest.TestCase):
    def test_the_state_directory(self) -> None:
        self.assertEqual(budget.budget_dir({budget.ENV_BUDGET_DIR: "", "SHIP_PR_STATE_DIR": "/x"}), "")
        self.assertEqual(budget.budget_dir({"SHIP_PR_STATE_DIR": "/x"}), "/x")
        self.assertEqual(budget.budget_dir({"XDG_STATE_HOME": "/s", "HOME": "/h"}), "/s/ship-pr")
        self.assertEqual(budget.budget_dir({"HOME": "/h"}), "/h/.local/state/ship-pr")


if __name__ == "__main__":
    unittest.main()
